// Explicit local setup: bind read substitution to the verified current login.
// Writes identity/proof metadata only, never OAuth credentials.
const cp=require('node:child_process');
const {privateJson,savePrivateJson,sameIdentity,verifyProfile}=require('./read-selector.cjs');
const pin='/Users/andrew/.local/state/bb-claude-auth/identity.json';
const config='/Users/andrew/.claude.json';
async function main(){
  const expected=privateJson(config).oauthAccount;
  if(!expected?.accountUuid || !expected?.organizationUuid)throw Error();
  const identity={accountUuid:expected.accountUuid,organizationUuid:expected.organizationUuid};
  let existing;
  try{existing=privateJson(pin);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing&&!sameIdentity(existing,identity))throw Error();
  const result=cp.spawnSync('/usr/bin/security',['find-generic-password','-a','andrew','-s','Claude Code-credentials','-w'],{encoding:'utf8',timeout:2000});
  if(result.status!==0)throw Error();
  const oauth=JSON.parse(result.stdout).claudeAiOauth;
  const verified=await verifyProfile(oauth,identity,{readProof:()=>({})});
  if(!sameIdentity(verified,identity)||!sameIdentity(privateJson(config).oauthAccount,identity))throw Error();
  savePrivateJson(pin,identity);
  process.stdout.write('Bound verified account identity; no credential changes\n');
}
main().catch(()=>{process.stderr.write('Identity binding refused; no credential changes\n');process.exitCode=1;});
