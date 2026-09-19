// Credential observer + encrypted snapshots; never refreshes or repairs primary credentials.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const DIRECTORY = '/Users/andrew/.local/state/bb-claude-auth';
const FILE = '/Users/andrew/.claude/.credentials.json';
const KEYCHAIN = '/Users/andrew/Library/Keychains/login.keychain-db';
const VAULT = '/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/bin/auth-vault-v2';
const {readBlocks,blockAlert}=require('/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/block-alert.cjs');
const CANARY='thr_bn2xraubgc';
// Observed access-token lifetime; expiry alone is never a failure signal.
const REFRESH_CYCLE_MS = 8 * 60 * 60 * 1000;
const stateOf = value => typeof value !== 'string' ? 'missing' : value.length ? 'present' : 'empty';
function lighthouseAuthFailed({spawn=cp.spawnSync,env=process.env}={}) {
  const cli=env.BB_CLI||'bb';
  const options={encoding:'utf8',timeout:5000,maxBuffer:256*1024};
  const state=spawn(cli,['thread','show','thr_rden4mbx6p','--json'],options);
  try { if(state.status!==0)return null; if(JSON.parse(state.stdout).thread.status!=='error')return false; } catch { return null; }
  const log=spawn(cli,['thread','log','thr_rden4mbx6p','--limit','1'],options);
  if(log.status!==0)return null;
  return /Failed to authenticate: OAuth session expired/.test(log.stdout);
}
function outageDecision(previous,snapshot,now) {
  const missing=snapshot.keychain.read==='ok' && (snapshot.keychain.access!=='present'||snapshot.keychain.refresh!=='present');
  const unavailableSince=missing?(previous?.unavailableSince??now):null;
  const failed=snapshot.lighthouseAuthFailed===true || (missing && now-unavailableSince>=120000);
  // Unknown reads cannot rearm an already-issued outage alert.
  const healthy=snapshot.lighthouseAuthFailed===false && snapshot.keychain.read==='ok' && !missing;
  const notified=failed?true:healthy?false:previous?.outageNotified===true;
  return {unavailableSince,outageNotified:notified,alert:failed&&!previous?.outageNotified};
}
function metadata(raw) {
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    return {read:'ok', access:stateOf(oauth?.accessToken), refresh:stateOf(oauth?.refreshToken),
      expiresAt:Number.isFinite(oauth?.expiresAt) ? oauth.expiresAt : null};
  } catch { return {read:'invalid-json'}; }
}
function classify(snapshot, now) {
  if (snapshot.keychain.read !== 'ok') return 'keychain-unreadable';
  if (snapshot.keychain.access !== 'present' || snapshot.keychain.refresh !== 'present') return 'keychain-empty';
  if (snapshot.keychain.expiresAt === null) return 'keychain-expiry-missing';
  if (snapshot.keychain.expiresAt < now) return 'keychain-expired';
  if (snapshot.sameOAuth === false) return 'stores-differ';
  return 'ok';
}
function decide(previous, snapshot, now) {
  const condition = classify(snapshot, now);
  const changed = !previous || JSON.stringify(previous.snapshot) !== JSON.stringify(snapshot) || previous.condition !== condition;
  const conditionSince = previous?.condition === condition ? (previous.conditionSince ?? now) : now;
  // A stale file is expected after Keychain refresh. A potentially newer file
  // shadowed by the primary must persist for a full cycle before paging.
  // Keep this independent of classify(): crossing expiry must not reset it.
  const completeFile = snapshot.file.read === 'ok' && snapshot.file.access === 'present' && snapshot.file.refresh === 'present';
  const completePrimary = snapshot.keychain.read === 'ok' && snapshot.keychain.access === 'present' && snapshot.keychain.refresh === 'present';
  const staleFile = Number.isFinite(snapshot.file.expiresAt) && Number.isFinite(snapshot.keychain.expiresAt)
    && snapshot.file.expiresAt < snapshot.keychain.expiresAt;
  const divergent = completeFile && (snapshot.sameOAuth === false || !completePrimary)
    && (!completePrimary || !staleFile);
  const divergenceSince = divergent ? (previous?.divergenceSince ?? now) : null;
  const backupFailed = snapshot.backup && snapshot.backup.exitCode !== 0;
  // A single failed bounded capture is not a sustained loss of backup coverage.
  // Keep every result in the log; do not replace the trusted vault executable.
  const backupFailureSince = backupFailed ? (previous?.backupFailureSince ?? now) : null;
  const backupFailureCount = backupFailed ? Math.min((previous?.backupFailureCount ?? 0) + 1, 3) : 0;
  const sustainedBackupFailure = backupFailed && backupFailureCount >= 3 && now - backupFailureSince >= 120000;
  const backupAlertKey = backupFailed && snapshot.backup.exitCode === 78 ? 'encrypted-backup-not-ready'
    : backupFailed && (sustainedBackupFailure || previous?.alertKey === 'encrypted-backup-failed') ? 'encrypted-backup-failed' : null;
  const alertKey = backupAlertKey || (divergent && now - divergenceSince >= REFRESH_CYCLE_MS ? 'credential-divergence-persisted' : null);
  const alert = alertKey !== null && alertKey !== previous?.alertKey;
  // Read failures, expiry and guard interventions remain metadata, not pages.
  return {condition, conditionSince, divergenceSince, backupFailureSince, backupFailureCount, alertKey, changed, alert};
}
function observe() {
  const capture = cp.spawnSync(VAULT, ['checkpoint'], {encoding:'utf8',timeout:2000});
  const backup = {exitCode:capture.status,timedOut:capture.error?.code === 'ETIMEDOUT'};
  const args = ['find-generic-password','-a','andrew','-s','Claude Code-credentials'];
  const secret = cp.spawnSync('/usr/bin/security', [...args,'-w',KEYCHAIN], {encoding:'utf8',timeout:5000});
  const attrs = cp.spawnSync('/usr/bin/security', [...args,KEYCHAIN], {encoding:'utf8',timeout:5000});
  const keychain = secret.status === 0 ? metadata(secret.stdout) : {read:'error',exitCode:secret.status,timedOut:secret.error?.code === 'ETIMEDOUT'};
  // Retain only the UTC modification timestamp, never arbitrary CLI output.
  keychain.modifiedAt = attrs.status === 0 ? (attrs.stdout.match(/"mdat"[^\n]*"(\d{14}Z)/)?.[1] || null) : null;
  let file = {read:'error'}, fileRaw;
  try {
    fileRaw = fs.readFileSync(FILE,'utf8');
    const stat = fs.statSync(FILE);
    file = {...metadata(fileRaw), modifiedAt:stat.mtime.toISOString(),mode:(stat.mode & 0o777).toString(8)};
  } catch { /* No paths, exception messages, or raw contents in records. */ }
  let sameOAuth = null;
  if (keychain.read === 'ok' && file.read === 'ok') {
    const a = JSON.parse(secret.stdout).claudeAiOauth, b = JSON.parse(fileRaw).claudeAiOauth;
    sameOAuth = !!a && !!b && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
  }
  let guard = null;
  const guardPath = path.join(DIRECTORY,'guard.jsonl');
  try {
    const fd = fs.openSync(guardPath,'r');
    try {
      const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size,4096));
      fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));
      const last = JSON.parse(buffer.toString('utf8').trim().split('\n').at(-1));
      if (Number.isInteger(last.at) && Number.isInteger(last.parentPid)) guard = {at:last.at,parentPid:last.parentPid,size};
    } finally { fs.closeSync(fd); }
  } catch { /* Guard log may not exist until the first denied read. */ }
  return {keychain,file,sameOAuth,guard,backup,lighthouseAuthFailed:lighthouseAuthFailed()};
}
async function postAlert(body, {env = process.env, spawn = cp.spawnSync, request = fetch} = {}) {
  // Never fall back to a human CLI identity; keep the plugin token in memory.
  try {
    const token = spawn(env.BB_CLI || 'bb',['plugin','token','whatsagent'],{encoding:'utf8',timeout:5000});
    if (token.status !== 0 || !token.stdout?.trim()) throw new Error();
    const url = new URL('/api/v1/plugins/whatsagent/http/post', env.BB_SERVER_URL || 'http://127.0.0.1:38886');
    const response = await request(url, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{'content-type':'application/json','x-bb-plugin-token':token.stdout.trim()},
      body:JSON.stringify({plugin:'claude-auth-observer',channel:'incident-claude-auth',body}),
    });
    if (!response.ok) throw new Error();
  } catch { throw new Error('alert-delivery-failed'); }
}
function signalCanary({env=process.env,spawn=cp.spawnSync}={}){
  const cli=env.BB_CLI||'bb';
  const state=spawn(cli,['thread','show',CANARY,'--json'],{encoding:'utf8',timeout:5000});
  if(state.status!==0)throw new Error('canary-status-failed');
  let status;try{status=JSON.parse(state.stdout).thread.status;}catch{throw new Error('canary-status-invalid');}
  const command=status==='error'?['thread','retry',CANARY,'--reason','Auth observer: repeated credential-clear attempts','--json']:
    ['thread','tell',CANARY,'Auth alarm verification only: reply AUTH_OK if this request succeeds; do not post, renew watches, or perform other work.','--json'];
  const result=spawn(cli,command,{encoding:'utf8',timeout:10000});
  if(result.status!==0)throw new Error('canary-dispatch-failed');
  // Genuine auth failure on this visible top-level thread reaches the built-in push sender.
}
async function main() {
  fs.mkdirSync(DIRECTORY,{recursive:true,mode:0o700});
  const statePath = path.join(DIRECTORY,'state.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statePath,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('state-unreadable'); }
  const now = Date.now(), snapshot = observe(), decision = decide(previous,snapshot,now);
  const outage=outageDecision(previous,snapshot,now);
  if(outage.alert) {
    // An existing backup error must never suppress a new loss of access.
    await postAlert(snapshot.lighthouseAuthFailed===true
      ? '@codex-rvbx SEV: Lighthouse failed OAuth authentication; recovery needed, credentials unchanged.'
      : '@codex-rvbx Claude primary tokens have been missing for 2m; recovery check needed, credentials unchanged.');
    try { signalCanary(); } catch { /* Board delivery must survive canary dispatch failure. */ }
  }
  const blocks=readBlocks(path.join(DIRECTORY,'security-operations.jsonl'),now);
  const repeatedBlocks=blockAlert(previous?.repeatedBlocks,blocks);
  if(repeatedBlocks.alert && !outage.alert){
    signalCanary();
    await postAlert('@codex-rvbx blocked three credential clears in 30m; testing the visible auth alarm because the token may be revoked.');
  }
  if (decision.changed) {
    // Monthly files are bounded by one sample/minute; no raw debug logs.
    const log = path.join(DIRECTORY,new Date(now).toISOString().slice(0,7)+'.jsonl');
    fs.appendFileSync(log,JSON.stringify({observedAt:new Date(now).toISOString(),condition:decision.condition,snapshot})+'\n',{mode:0o600});
  }
  let lastAlertAt = previous?.lastAlertAt || 0;
  if (decision.alert && !outage.alert) {
    const body = decision.alertKey === 'encrypted-backup-not-ready'
      ? '@codex-rvbx encrypted auth backup is not ready: no tokens available to capture; primary credentials unchanged.'
      : decision.alertKey === 'encrypted-backup-failed'
      ? '@codex-rvbx encrypted backup capture failed repeatedly for 2m; inspect before relying on recovery—primary credentials unchanged.'
      : '@codex-rvbx auth observer: credential divergence persisted for 8h on mini; inspect before recovery—primary credentials unchanged.';
    await postAlert(body);
    lastAlertAt = now;
  }
  const next = {snapshot,unavailableSince:outage.unavailableSince,outageNotified:outage.outageNotified,condition:decision.condition,conditionSince:decision.conditionSince,divergenceSince:decision.divergenceSince,backupFailureSince:decision.backupFailureSince,backupFailureCount:decision.backupFailureCount,alertKey:decision.alertKey,lastAlertAt,repeatedBlocks:{notified:repeatedBlocks.notified},checkedAt:new Date(now).toISOString()};
  const pending = path.join(DIRECTORY,'state.next.json');
  fs.writeFileSync(pending,JSON.stringify(next)+'\n',{mode:0o600});
  fs.renameSync(pending,statePath);
  // Automation treats a quiet exit as a skipped, healthy tick.
}
module.exports = {metadata,classify,decide,postAlert,signalCanary,REFRESH_CYCLE_MS,lighthouseAuthFailed,outageDecision};
if (require.main === module) {
  main().catch(() => { console.error('auth observer failed; inspect automation run'); process.exitCode = 1; });
}
