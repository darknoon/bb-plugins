#!/usr/bin/env node
'use strict';
// Credential-free. Deploy this and the monitor together in the stable repository.
const fs=require('node:fs');
const path=require('node:path');
const {cli,post}=require('./claude-auth-failure-monitor.cjs');
const THREAD='thr_bn2xraubgc';
const PROMPT='Auth alarm verification only: reply AUTH_OK';
const STATE='/Users/andrew/.local/state/bb-claude-auth/freshness-canary.json';
function result(events) {
  const requests=events.filter(e=>e.type==='client/turn/requested');
  if(requests.length!==1||!requests[0].data?.input?.some(i=>i.type==='text'&&i.text.includes(PROMPT)))return null;
  const turn=events.filter(e=>e.seq>requests[0].seq);
  if(turn.some(e=>e.type==='turn/completed'&&e.data?.status!=='completed'))return false;
  if(!turn.some(e=>e.type==='turn/completed'&&e.data?.status==='completed'))return null;
  const messages=turn.filter(e=>e.type==='item/completed'&&e.data?.item?.type==='agentMessage');
  return messages.at(-1)?.data.item.text?.trim()==='AUTH_OK';
}
function eventsAfter(seq,io) {
  const all=[];
  for(let page=0;page<8;page++){
    const rows=JSON.parse(cli(['thread','log',THREAD,'--json','--after-seq',String(seq),'--limit','256'],io));
    if(!Array.isArray(rows))throw Error('invalid-history');
    all.push(...rows);if(rows.length<256)return all;
    if(rows.at(-1).seq<=seq)throw Error('nonadvancing-history');seq=rows.at(-1).seq;
  }
  throw Error('history-bound-exceeded');
}
async function run({previous={},save,send,wait,history,alert,now=Date.now}) {
  let state={...previous};
  const halt=async reason=>{
    state={...state,halted:true,reason};save(state);
    if(!state.alerted){await alert(reason);state.alerted=true;save(state);}return state;
  };
  if(state.halted)return state.alerted?state:halt(state.reason);
  // A crash/timeout after dispatch must not create another request next tick.
  if(state.pending)return halt('previous-request-unconfirmed');
  let baseline;
  try{baseline=await history(state.lastSeq||0);}catch{return halt('history-unavailable');}
  state.lastSeq=baseline.at(-1)?.seq||state.lastSeq||0;
  state.pending=true;state.startedAt=now();save(state);
  try{await send();await wait();}catch{return halt('request-failed-or-timed-out');}
  let rows;
  try{rows=await history(state.lastSeq);}catch{return halt('result-unavailable');}
  const outcome=result(rows);
  state.lastSeq=rows.at(-1)?.seq||state.lastSeq;
  if(outcome!==true)return halt(outcome===false?'non-AUTH_OK':'result-unconfirmed');
  state={lastSeq:state.lastSeq,lastSuccessAt:now(),pending:false,halted:false,alerted:false};save(state);return state;
}
async function main() {
  fs.mkdirSync(path.dirname(STATE),{recursive:true,mode:0o700});
  // Scheduler overlap and manual runs must never dispatch two refresh requests.
  let lock;
  try{lock=fs.openSync(STATE+'.lock','wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    if(Date.now()-fs.statSync(STATE+'.lock').mtimeMs<120000)return;
    // A killed run leaves its lock behind. Page once; never remove the lock
    // automatically and risk a second dispatch from an ambiguous first run.
    const previous=JSON.parse(fs.readFileSync(STATE,'utf8'));
    if(!previous.alerted){
      await post({body:'@codex-rvbx Auth freshness canary stopped: stale execution lock; inspect before manually rearming.'});
      fs.writeFileSync(STATE,JSON.stringify({...previous,halted:true,alerted:true,reason:'stale-lock'})+'\n',{mode:0o600});
    }
    return;
  }
  try{
    let previous={};try{previous=JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const save=s=>{fs.writeFileSync(STATE+'.next',JSON.stringify(s)+'\n',{mode:0o600});fs.renameSync(STATE+'.next',STATE);};
    await run({previous,save,history:seq=>eventsAfter(seq),send:()=>{
      const state=JSON.parse(cli(['thread','show',THREAD,'--json'])).thread;
      if(state.status!=='idle')throw Error('canary-not-idle');
      const r=JSON.parse(cli(['thread','tell',THREAD,PROMPT,'--mode','queue','--json']));
      if(r.delivery==='queued')throw Error('canary-queued');
    },wait:()=>cli(['thread','wait',THREAD,'--status','idle','--timeout','45s','--json'],{
      spawn:(exe,args,opts)=>require('node:child_process').spawnSync(exe,args,{...opts,timeout:50000})
    }),alert:reason=>post({body:'@codex-rvbx Auth freshness canary stopped on mini: '+reason+'; inspect the failed check before explicitly rearming.'})});
  }finally{fs.closeSync(lock);fs.unlinkSync(STATE+'.lock');}
}
module.exports={result,run,eventsAfter,PROMPT};
if(require.main===module)main().catch(()=>{console.error('auth canary delivery/state failure; inspect run without retrying the model request');process.exitCode=1;});
