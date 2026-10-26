#!/opt/homebrew/bin/node
// Exact Claude credential read adapter; raw transport stays private to Claude.
const fs=require('node:fs');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const path=require('node:path');
const {selectVerifiedRead}=require('./read-selection.cjs');
const STATE='/Users/andrew/.local/state/bb-claude-auth';
const FALLBACK='/Users/andrew/.claude/.credentials.json';
const CONFIG='/Users/andrew/.claude.json';
function privateJson(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const st=fs.fstatSync(fd);
    if (!st.isFile() || st.uid!==process.getuid() || (st.mode&0o077)!==0 || st.size>1048576)
      throw new Error('unsafe-file');
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  } finally {fs.closeSync(fd);}
}
function savePrivateJson(file,value) {
  const temporary=path.join(path.dirname(file),`.proof-${crypto.randomUUID()}`);
  let created=false;
  try {
    const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    created=true;
    try {fs.writeFileSync(fd,JSON.stringify(value));} finally {fs.closeSync(fd);}
    fs.renameSync(temporary,file);created=false;
  } finally {if(created)fs.unlinkSync(temporary);}
}
function sameIdentity(a,b) {
  return !!a?.accountUuid && !!a?.organizationUuid && a.accountUuid===b?.accountUuid && a.organizationUuid===b?.organizationUuid;
}
function tokenFingerprint(oauth) {
  // Private cache key only: never printed, logged, or sent over the network.
  return crypto.createHash('sha256').update(JSON.stringify([oauth.accessToken,oauth.refreshToken])).digest('hex');
}
async function verifyProfile(oauth,expected,{request=fetch,readProof=()=>privateJson(path.join(STATE,'identity-proofs.json')),writeProof=value=>savePrivateJson(path.join(STATE,'identity-proofs.json'),value)}={}) {
  const key=tokenFingerprint(oauth);
  let cache={};
  try {cache=readProof();}catch{}
  if(sameIdentity(cache[key],expected))return expected;
  // Expired access tokens need an earlier verified proof; only native Claude,
  // holding its refresh lock, may rotate them. This reader never refreshes.
  const response=await request('https://api.anthropic.com/api/oauth/profile',{
    headers:{Authorization:`Bearer ${oauth.accessToken}`,'Cache-Control':'no-cache'},
    redirect:'error',signal:AbortSignal.timeout(800),
  });
  if(!response.ok)throw new Error('profile-unavailable');
  const body=await response.json();
  const identity={accountUuid:body.account?.uuid,organizationUuid:body.organization?.uuid};
  if(!sameIdentity(identity,expected))return identity;
  // Cache identity, not token validity: Claude still validates/refreshes auth.
  const entries=Object.entries(cache).filter(([,v])=>sameIdentity(v,expected)).slice(-31);
  try {writeProof({...Object.fromEntries(entries),[key]:expected});}catch{}
  return identity;
}
function targetRead(args) {
  if(args[0]!=='find-generic-password' || !args.includes('-w'))return false;
  const account=args.flatMap((a,i)=>a==='-a'?[args[i+1]]:[]);
  const service=args.flatMap((a,i)=>a==='-s'?[args[i+1]]:[]);
  return account.length===1 && account[0]==='andrew' && service.length===1 && service[0]==='Claude Code-credentials';
}
async function adaptedRead(args,deps) {
  const raw=deps.runSecurity(args);
  if(raw.status!==0 || !targetRead(args))return {...raw,selected:'keychain'};
  let primary,fallback,expected,current;
  try {
    primary=JSON.parse(raw.stdout);
    fallback=deps.readFallback();
    expected=deps.readExpectedIdentity();
    current=deps.readCurrentIdentity();
  } catch {return {...raw,selected:'keychain',refusal:'read-input-unavailable'};}
  // A successful logout clears config identity; an account switch requires a
  // deliberate rebind, rather than silently mixing credentials and connectors.
  if(!sameIdentity(current,expected))return {...raw,selected:'keychain',refusal:'signed-out-or-account-changed'};
  const result=await selectVerifiedRead(primary,fallback,{expectedIdentity:expected,verifyIdentity:o=>deps.verifyIdentity(o,expected)});
  if(result.selected!=='file')return {...raw,selected:result.selected,refusal:result.refusal};
  try {
    // Verification may take time; never publish a file/config snapshot that
    // changed during that request. Native write/refresh locks remain in charge.
    if(JSON.stringify(deps.readFallback())!==JSON.stringify(fallback) || !sameIdentity(deps.readCurrentIdentity(),expected))
      return {...raw,selected:'keychain',refusal:'source-changed'};
  } catch {return {...raw,selected:'keychain',refusal:'source-changed'};}
  return {...raw,stdout:JSON.stringify(result.value)+'\n',selected:'file'};
}
function record(result) {
  if(result.selected!=='file' && !result.refusal)return;
  const event={atMs:Date.now(),pid:process.pid,parentPid:process.ppid,selected:result.selected,refusal:result.refusal??null};
  try {
    const fd=fs.openSync(path.join(STATE,'read-selection.jsonl'),fs.constants.O_APPEND|fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try {const st=fs.fstatSync(fd);if(st.isFile()&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<10485760)fs.writeFileSync(fd,JSON.stringify(event)+'\n');}finally{fs.closeSync(fd);}
  } catch {}
}
async function main() {
  const result=await adaptedRead(process.argv.slice(2),{
    runSecurity:args=>cp.spawnSync('/usr/bin/security',args,{encoding:'utf8',timeout:1200,maxBuffer:1048576}),
    readFallback:()=>privateJson(FALLBACK),
    readExpectedIdentity:()=>privateJson(path.join(STATE,'identity.json')),
    readCurrentIdentity:()=>privateJson(CONFIG).oauthAccount,
    verifyIdentity:verifyProfile,
  });
  record(result);
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  process.exitCode=Number.isInteger(result.status)?result.status:1;
}
module.exports={adaptedRead,verifyProfile,sameIdentity,targetRead,privateJson,savePrivateJson};
if(require.main===module)main().catch(()=>{process.stderr.write('Claude credential read adapter failed\n');process.exitCode=1;});
