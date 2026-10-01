const fs=require('node:fs');
const WINDOW_MS=30*60*1000;
function countBlocks(lines,now){
  const times=[];
  for(const line of lines.split('\n')){
    try{const r=JSON.parse(line);
      if(r.operation==='write-policy'&&r.decision==='blocked-empty-token-write'&&Number.isFinite(r.atMs)&&r.atMs<=now&&r.atMs>=now-WINDOW_MS)times.push(r.atMs);
    }catch{}
  }
  return {count:times.length,lastAt:times.length?Math.max(...times):null};
}
function readBlocks(file,now){
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077))return null;
    const bytes=Buffer.alloc(Math.min(s.size,256*1024));
    fs.readSync(fd,bytes,0,bytes.length,Math.max(0,s.size-bytes.length));
    return countBlocks(bytes.toString('utf8'),now);
  }catch(e){return e.code==='ENOENT'?{count:0,lastAt:null}:null;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function blockAlert(previous,blocks){
  const bad=blocks!==null&&blocks.count>=3;
  const notified=blocks!==null&&blocks.count===0?false:!!previous?.notified;
  return {alert:bad&&!notified,notified:notified||bad};
}
module.exports={countBlocks,readBlocks,blockAlert,WINDOW_MS};
