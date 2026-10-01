const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {classify,collector,permitted,setup}=require('./debug-launch.cjs');
test('debug activation expires in at most 72h and cannot move its start into the future',()=>{
 assert.equal(permitted({startedAt:100,until:200},150),true);
 for(const config of [{startedAt:100,until:200},{startedAt:100,until:1e12},{startedAt:400,until:500},{}])assert.equal(permitted(config,300),false);
});
test('only fixed OAuth classifications and numeric status survive',()=>{
 assert.deepEqual(classify('OAuth refresh failed status=400 invalid_grant bearer SECRET'),{kind:'oauth-refresh',outcome:'failed',httpStatus:400,error:'invalid_grant'});
 assert.equal(classify('user prompt SECRET or Authorization: SECRET'),null);
});
test('collector bounds records, drops oversized/raw lines and stops persisting at deadline',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'debug-collect-')),file=path.join(dir,'log'),fd=fs.openSync(file,'w+',0o600);let now=1;
 try{
  const consume=collector(fd,{until:10,now:()=>now,maxBytes:1024});
  for(let i=0;i<200;i++)consume(Buffer.from('OAuth refresh failed HTTP 401 SECRET\n'));
  consume(Buffer.from('OAuth SECRET '+ 'x'.repeat(20000)+'\n'));
  const before=fs.readFileSync(file,'utf8');assert.ok(Buffer.byteLength(before)<=1024);assert.ok(!before.includes('SECRET'));assert.ok(!before.includes('xxxxx'));
  now=11;consume(Buffer.from('OAuth HTTP 500 failed\n'));assert.equal(fs.readFileSync(file,'utf8'),before);
 }finally{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true});}
});
test('private FIFO drains a dummy debug writer without storing raw text',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'debug-fifo-'));fs.chmodSync(dir,0o700);let capture;
 try{
  capture=setup(dir,Date.now()+10000);
  fs.appendFileSync(capture.fifo,'OAuth refresh failed HTTP 400 invalid_grant SECRET\n');capture.drain();
  const log=fs.readFileSync(path.join(dir,'refresh-0.jsonl'),'utf8');assert.ok(log.includes('400'));assert.ok(!log.includes('SECRET'));
  assert.equal(fs.statSync(path.join(dir,'refresh-0.jsonl')).mode&0o777,0o600);
 }finally{capture?.cleanup();fs.rmSync(dir,{recursive:true,force:true});}
});
