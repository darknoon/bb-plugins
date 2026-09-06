// Read-only credential observer: metadata only, never refreshes or repairs.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const DIRECTORY = '/Users/andrew/.local/state/bb-claude-auth';
const FILE = '/Users/andrew/.claude/.credentials.json';
const KEYCHAIN = '/Users/andrew/Library/Keychains/login.keychain-db';
const stateOf = value => typeof value !== 'string' ? 'missing' : value.length ? 'present' : 'empty';
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
  // An older file after a successful Keychain refresh is not an outage.
  // A newer/differently-versioned file is worth investigating once, not hourly.
  const staleFile = condition === 'stores-differ' && snapshot.file.expiresAt < snapshot.keychain.expiresAt;
  const expiryPending = condition === 'keychain-expired' && now - conditionSince < 120000;
  const actionable = condition !== 'ok' && !staleFile && !expiryPending;
  const guardChanged = !!snapshot.guard && JSON.stringify(snapshot.guard) !== JSON.stringify(previous?.snapshot?.guard);
  const previousAlertKey = previous?.alertKey;
  // Only operational state transitions page the owner; timestamps alone do not.
  const alertKey = actionable ? condition : null;
  const alert = guardChanged || (alertKey !== null && alertKey !== previousAlertKey);
  return {condition, conditionSince, alertKey, changed, alert,...(guardChanged ? {reason:'guard-blocked-denied-read'} : {})};
}
function observe() {
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
  return {keychain,file,sameOAuth,guard};
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
async function main() {
  fs.mkdirSync(DIRECTORY,{recursive:true,mode:0o700});
  const statePath = path.join(DIRECTORY,'state.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statePath,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('state-unreadable'); }
  const now = Date.now(), snapshot = observe(), decision = decide(previous,snapshot,now);
  if (decision.changed) {
    // Monthly files are bounded by one sample/minute; no raw debug logs.
    const log = path.join(DIRECTORY,new Date(now).toISOString().slice(0,7)+'.jsonl');
    fs.appendFileSync(log,JSON.stringify({observedAt:new Date(now).toISOString(),condition:decision.condition,snapshot})+'\n',{mode:0o600});
  }
  let lastAlertAt = previous?.lastAlertAt || 0;
  if (decision.alert) {
    const body = '@codex-rvbx auth observer: '+(decision.reason || decision.condition)+' on mini; inspect before recovery—this check changed no credentials.';
    await postAlert(body);
    lastAlertAt = now;
  }
  const next = {snapshot,condition:decision.condition,conditionSince:decision.conditionSince,alertKey:decision.alertKey,lastAlertAt,checkedAt:new Date(now).toISOString()};
  const pending = path.join(DIRECTORY,'state.next.json');
  fs.writeFileSync(pending,JSON.stringify(next)+'\n',{mode:0o600});
  fs.renameSync(pending,statePath);
  // Automation treats a quiet exit as a skipped, healthy tick.
}
module.exports = {metadata,classify,decide,postAlert};
if (require.main === module) {
  main().catch(() => { console.error('auth observer failed; inspect automation run'); process.exitCode = 1; });
}
