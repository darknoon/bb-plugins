#!/opt/homebrew/bin/node
'use strict';
// Scope: extracted, tested native cleanup paths, including 2.1.285; not logout.
// Never report ordinary failure for this write: native fallback would erase both stores.
const fs=require('node:fs');
const cp=require('node:child_process');
const LIMIT=1024*1024;
const VERIFIED_VERSIONS=new Set(['2.1.261','2.1.270','2.1.273','2.1.274','2.1.285']);
function words(line){
  const out=[];let word='',quote=null,started=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(quote){if(c===quote)quote=null;else if(c==='\\'&&quote==='"'){if(++i===line.length)return null;word+=line[i];}else word+=c;started=true;}
    else if(c==='"'||c==="'"){quote=c;started=true;}
    else if(/\s/.test(c)){if(started){out.push(word);word='';started=false;}}
    else if(c==='\\'){if(++i===line.length)return null;word+=line[i];started=true;}
    else {word+=c;started=true;}
  }
  if(quote)return null;if(started)out.push(word);return out;
}
function inspect(args){
  if(args?.[0]!=='add-generic-password'||!args.includes('-U'))return null;
  let account,service,value,encoding;const paths=[];
  for(let i=1;i<args.length;i++){
    const k=args[i];
    if(k==='-U')continue;
    if(['-a','-s','-X','-w'].includes(k)){
      if(i+1===args.length)return null;
      const v=args[++i];
      if(k==='-a'){if(account!==undefined)return null;account=v;}
      if(k==='-s'){if(service!==undefined)return null;service=v;}
      if(k==='-X'||k==='-w'){if(value!==undefined)return null;value=v;encoding=k;}
    }else if(k.startsWith('-'))return null;
    else paths.push(k);
  }
  if(account!=='andrew'||service!=='Claude Code-credentials'||value===undefined||paths.length>1)return null;
  if(paths.length&&paths[0]!=='/Users/andrew/Library/Keychains/login.keychain-db')return null;
  try{
    if(value.length>LIMIT*2)return null;
    if(encoding==='-X'&&(!/^(?:[a-fA-F0-9]{2})+$/.test(value)))return null;
    const record=JSON.parse(encoding==='-X'?Buffer.from(value,'hex').toString('utf8'):value);
    const o=record?.claudeAiOauth;
    return {empty:o?.accessToken===''&&o?.refreshToken===''&&o?.expiresAt===0,
      payloadHasTokens:typeof o?.accessToken==='string'&&o.accessToken.length>0&&typeof o?.refreshToken==='string'&&o.refreshToken.length>0,
      paths};
  }catch{return null;}
}
function decision(args,input,readPrimary){
  const commands=args.length===1&&args[0]==='-i'?input.toString('utf8').split(/\r?\n/).map(words):[args];
  let inspected=false,payloadHasTokens=false;
  for(const command of commands){
    const info=inspect(command);if(!info)continue;inspected=true;payloadHasTokens||=info.payloadHasTokens;
    if(info.empty){
      // A read failure cannot justify destruction; protect without inventing a credential.
      const primary=readPrimary(info.paths);
      const o=primary?.claudeAiOauth;
      if(primary===undefined || (typeof o?.accessToken==='string'&&o.accessToken.length>0&&typeof o?.refreshToken==='string'&&o.refreshToken.length>0))
        return {block:true,payloadHasTokens:false,primaryReadable:primary!==undefined,primaryHadTokens:primary!==undefined};
    }
  }
  const mentionsClaude=args.join(' ').includes('Claude Code-credentials') || input?.includes('Claude Code-credentials');
  return {block:false,inspected,payloadHasTokens,uninspected:!!mentionsClaude&&!inspected};
}
function log(result){
  const file='/Users/andrew/.local/state/bb-claude-auth/security-operations.jsonl';
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
    const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.size>20*1024*1024)return;
    fs.writeSync(fd,JSON.stringify({atMs:Date.now(),pid:process.pid,parentPid:process.ppid,operation:'write-policy',
      decision:result.block?'blocked-empty-token-write':result.uninspected?'uninspected-claude-credential-write':'allow',payloadHasTokens:result.payloadHasTokens,
      ...(result.block?{primaryReadable:result.primaryReadable,primaryHadTokens:result.primaryHadTokens}:{})})+'\n');
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}
}
async function filter({args,input,version,readPrimary,recordDecision=()=>{},delegate}){
  if(!VERIFIED_VERSIONS.has(version))return delegate();
  const result=decision(args,input,readPrimary);
  if(result.block||result.inspected||result.uninspected)recordDecision(result);
  if(result.block){
    // Every verified native version times out at 2000ms and marks it transient.
    // Do not delegate, fake success, substitute tokens, or touch either credential store.
    await new Promise(r=>setTimeout(r,3000));return 1;
  }
  return delegate();
}
async function main(){
  const args=process.argv.slice(2),interactive=args.length===1&&args[0]==='-i';
  let input=Buffer.alloc(0);
  if(interactive){for await(const chunk of process.stdin){
    if(input.length+chunk.length>LIMIT){
      log({block:false,uninspected:true,payloadHasTokens:false});
      // Preserve unrelated oversized batches; stream the buffered prefix then the rest.
      const child=cp.spawn('/usr/bin/security',args,{stdio:['pipe','inherit','inherit']});
      child.stdin.on('error',()=>{});child.stdin.write(input);child.stdin.write(chunk);
      for await(const rest of process.stdin)if(!child.stdin.destroyed)child.stdin.write(rest);
      if(!child.stdin.destroyed)child.stdin.end();
      return await new Promise(resolve=>{child.on('error',()=>resolve(127));child.on('exit',code=>resolve(code??1));});
    }
    input=Buffer.concat([input,chunk]);
  }}
  return filter({args,input,version:process.env.BB_VERIFIED_CLAUDE_CALLER,recordDecision:log,readPrimary:paths=>{
    const r=cp.spawnSync('/usr/bin/security',['find-generic-password','-a','andrew','-s','Claude Code-credentials','-w',...paths],{encoding:'utf8',timeout:300,maxBuffer:LIMIT});
    if(r.status===44)return null;
    if(r.status!==0)return undefined;
    try{return JSON.parse(r.stdout);}catch{return undefined;}
  },delegate:()=>new Promise(resolve=>{
    const child=cp.spawn('/usr/bin/security',args,{stdio:[interactive?'pipe':'inherit','inherit','inherit']});
    for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
    child.on('error',()=>resolve(127));child.on('exit',(code,signal)=>resolve(code??(signal==='SIGINT'?130:143)));
    if(interactive){child.stdin.on('error',()=>{});child.stdin.end(input);}
  })});
}
module.exports={words,inspect,decision,filter,VERIFIED_VERSIONS};
if(require.main===module)main().then(code=>{process.exitCode=code;},()=>{process.exitCode=1;});
