#!/usr/bin/env node
'use strict';
// Opt-in diagnostic transport. Raw debug text passes through a private FIFO,
// never a disk file; only fixed classifications and numeric HTTP status persist.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const ROOT='/Users/andrew/.local/state/bb-claude-auth';
const MAX_BYTES=256*1024,MAX_SLOTS=16,MAX_WINDOW=72*60*60*1000;
function permitted(config,now=Date.now()) {
 return Number.isSafeInteger(config?.startedAt)&&Number.isSafeInteger(config?.until)
  &&config.startedAt<=now&&config.until>now&&config.until-config.startedAt<=MAX_WINDOW;
}
function classify(line) {
 if(!/oauth|(?:token.*refresh)|(?:refresh.*token)/i.test(line))return null;
 const status=line.match(/(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:Code| code)?)\s*[:= ]\s*([1-5]\d\d)\b/i);
 const error=['invalid_grant','invalid_client','unauthorized','timeout','ETIMEDOUT','ECONNRESET'].find(x=>line.includes(x));
 const outcome=/fail|error|reject/i.test(line)?'failed':/success|refreshed/i.test(line)?'succeeded':'observed';
 return {kind:'oauth-refresh',outcome,...(status?{httpStatus:Number(status[1])}:{}),...(error?{error}: {})};
}
function collector(fd,{until,now=Date.now,maxBytes=MAX_BYTES}={}) {
 let pending='',discard=false;
 return chunk=>{
  // Bound retained input even if the producer sends an enormous line or secret.
  for(const segment of chunk.toString('utf8').split(/(?<=\n)/)){
   if(!discard&&pending.length+segment.length<=8192)pending+=segment;else{pending='';discard=true;}
   if(!segment.endsWith('\n'))continue;
   if(!discard&&now()<until){
    const row=classify(pending);
    if(row){const output=JSON.stringify({atMs:now(),...row})+'\n';
     if(fs.fstatSync(fd).size+Buffer.byteLength(output)>maxBytes)fs.ftruncateSync(fd,0);
     fs.writeSync(fd,output,fs.fstatSync(fd).size,'utf8');
    }
   }
   pending='';discard=false;
  }
 };
}
function setup(root,until) {
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const st=fs.lstatSync(root);
 if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('unsafe-debug-directory');
 for(let slot=0;slot<MAX_SLOTS;slot++){
  const base=path.join(root,'refresh-'+slot),lock=base+'.lock',fifo=base+'.pipe';let lockFd;
  try{lockFd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')continue;throw e;}
  let pipeFd,logFd,madeFifo=false;
  const cleanup=()=>{
   if(pipeFd!==undefined)fs.closeSync(pipeFd);
   if(logFd!==undefined)fs.closeSync(logFd);
   fs.closeSync(lockFd);
   // Only these exact files created by this invocation, never a directory tree.
   if(madeFifo)try{fs.unlinkSync(fifo);}catch{}
   fs.unlinkSync(lock);
  };
  try{
   const make=cp.spawnSync('/usr/bin/mkfifo',['-m','600',fifo],{timeout:2000});
   if(make.status!==0)throw Error('fifo-unavailable');
   madeFifo=true;
   pipeFd=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
   logFd=fs.openSync(base+'.jsonl',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
   const s=fs.fstatSync(logFd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('unsafe-debug-file');
   fs.ftruncateSync(logFd,0);
   const consume=collector(logFd,{until}),buffer=Buffer.alloc(16384);
   const drain=()=>{
    for(let n=0;n<64;n++)try{const size=fs.readSync(pipeFd,buffer,0,buffer.length,null);if(!size)break;consume(buffer.subarray(0,size));}
    catch(e){if(e.code==='EAGAIN')break;throw e;}
   };
   return {fifo,drain,cleanup};
  }catch(e){cleanup();throw e;}
 }
 throw Error('debug-slot-capacity');
}
function main() {
 const [target,...args]=process.argv.slice(2);if(!path.isAbsolute(target||''))throw Error('invalid-target');
 let capture;
 try{
  const config=JSON.parse(fs.readFileSync(path.join(ROOT,'debug-window.json'),'utf8'));
  if(permitted(config)&&path.basename(target)==='2.1.285')capture=setup(path.join(ROOT,'refresh-debug'),config.until);
 }catch{process.stderr.write('Auth debug capture unavailable; continuing without diagnostics.\n');}
 const child=cp.spawn(target,capture?['--debug-file',capture.fifo,...args]:args,{stdio:'inherit'});
 let timer;
 if(capture)timer=setInterval(()=>{try{capture.drain();}catch{
  // Keep draining/discarding if persistence fails; diagnostics must not kill auth.
 }},25);
 for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
 let finished=false;
 const finish=code=>{if(finished)return;finished=true;clearInterval(timer);if(capture){try{capture.drain();}catch{}capture.cleanup();}process.exitCode=code;};
 child.on('error',()=>finish(127));child.on('exit',(code,signal)=>finish(code??(signal==='SIGINT'?130:143)));
}
module.exports={classify,collector,permitted,setup,MAX_BYTES,MAX_SLOTS};
if(require.main===module)main();
