#!/usr/bin/env node
'use strict';
// Only bb thread status/log reads: no Claude process, credential file, Keychain,
// backup helper, or authentication refresh is used to decide whether to alert.
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const LIGHTHOUSE='thr_rden4mbx6p', CANARY='thr_bn2xraubgc';
const STATE='/Users/andrew/.local/state/bb-claude-auth/request-failure-state.json';
function cli(args,{spawn=cp.spawnSync,env=process.env}={}) {
  const result=spawn(env.BB_CLI||'bb',args,{encoding:'utf8',timeout:10000,maxBuffer:256*1024});
  if(result.status!==0)throw new Error('bb-command-failed');
  return result.stdout;
}
function providerFailure(log) {
  return log.split('\n').some(line=>{
    // Do not page on arbitrary HTTP failures from a tool or shell command.
    if(/^\s*(?:tool(?: error| result)?|curl|wget)\b/i.test(line))return false;
    if(/Failed to authenticate|authentication[_ ](?:error|failed)|OAuth[^\n]*(?:expired|failed|invalid|could not)|invalid_grant/i.test(line))return true;
    if(/\bAPI Error:\s*401\b|\b(?:Anthropic|model request)[^\n]*\b401\b/i.test(line))return true;
    return /\b(?:HTTP\s*|API Error:\s*)400\b/i.test(line)
      && /\b(?:model|Claude|CLI|version)\b/i.test(line)
      && /requires?|unsupported|not support|not available|upgrade|minimum/i.test(line);
  });
}
function observe(io) {
  try {
    const state=JSON.parse(cli(['thread','show',LIGHTHOUSE,'--json'],io)).thread.status;
    if(state==='idle')return false;
    if(state!=='error')return null;
    const log=cli(['thread','log',LIGHTHOUSE,'--limit','1'],io);
    return providerFailure(log)?true:null;
  } catch {
    // Unknown is not healthy and must not clear deduplication or auto-pause
    // the automation after three temporary CLI/read failures.
    return null;
  }
}
function decision(previous,failed) {
  if(failed===false)return {boardSent:false,canarySent:false};
  return {boardSent:previous?.boardSent===true,canarySent:previous?.canarySent===true};
}
async function tick({previous,failed,save,post,canary}) {
  const state=decision(previous,failed);save(state);
  if(failed!==true)return state;
  const errors=[];
  if(!state.boardSent)try{await post();state.boardSent=true;save(state);}catch{errors.push('board');}
  if(!state.canarySent)try{await canary();state.canarySent=true;save(state);}catch{errors.push('canary');}
  if(errors.length)throw new Error('auth-alarm-delivery-failed: '+errors.join(','));
  return state;
}
async function post({env=process.env,request=fetch,...io}={}) {
  const token=cli(['plugin','token','whatsagent'],{env,...io}).trim();
  if(!token)throw new Error('missing-plugin-token');
  const response=await request(new URL('/api/v1/plugins/whatsagent/http/post',env.BB_SERVER_URL||'http://127.0.0.1:38886'),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{'content-type':'application/json','x-bb-plugin-token':token},
    body:JSON.stringify({plugin:'claude-auth-observer',channel:'incident-claude-auth',body:'@codex-rvbx SEV: Lighthouse has an authentication or model-compatibility failure; checking the canary, with no credential repair attempted.'})
  });
  if(!response.ok)throw new Error('board-delivery-failed');
}
function canary(io) {
  const status=JSON.parse(cli(['thread','show',CANARY,'--json'],io)).thread.status;
  if(!['idle','error'].includes(status))throw new Error('canary-busy');
  cli(status==='error'
    ?['thread','retry',CANARY,'--reason','Lighthouse OAuth failure alarm','--json']
    :['thread','tell',CANARY,'Auth alarm check only: reply AUTH_OK; do not post, change credentials, renew watches, or perform other work.','--json'],io);
}
async function main() {
  const failed=observe();
  if(process.argv.includes('--check')){console.log(JSON.stringify({lighthouseAuthFailed:failed}));return;}
  let previous;
  try{previous=JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('monitor-state-unreadable');}
  const save=state=>{
    fs.mkdirSync(path.dirname(STATE),{recursive:true,mode:0o700});
    fs.writeFileSync(STATE+'.next',JSON.stringify(state)+'\n',{mode:0o600});
    fs.renameSync(STATE+'.next',STATE);
  };
  await tick({previous,failed,save,post,canary});
}
module.exports={observe,providerFailure,decision,tick,post,canary};
if(require.main===module)main().catch(e=>{console.error(e.message.startsWith('auth-alarm-delivery-failed')?e.message:'auth failure monitor failed; inspect automation run');process.exitCode=1;});
