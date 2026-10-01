const {test}=require('node:test');const assert=require('node:assert/strict');
const {countBlocks,blockAlert,WINDOW_MS}=require('./block-alert.cjs');
const now=WINDOW_MS*4;
const line=atMs=>JSON.stringify({atMs,operation:'write-policy',decision:'blocked-empty-token-write'});
test('three blocks in 30 minutes alert once; ordinary operations and expiry do not',()=>{
  const blocks=countBlocks([line(now-1),line(now-2),line(now-3),'{}','not json'].join('\n'),now);
  assert.equal(blocks.count,3);const first=blockAlert(null,blocks);assert.equal(first.alert,true);
  assert.equal(blockAlert(first,blocks).alert,false);
  assert.equal(countBlocks(line(now-WINDOW_MS-1),now).count,0);
});
test('below threshold stays silent and 30 quiet minutes rearm a future incident',()=>{
  assert.equal(blockAlert(null,{count:2,lastAt:now}).alert,false);
  const quiet=blockAlert({notified:true},{count:0,lastAt:null});assert.equal(quiet.alert,false);
  assert.equal(blockAlert(quiet,{count:3,lastAt:now}).alert,true);
});
test('read failure does not clear notification latch',()=>{
  assert.deepEqual(blockAlert({notified:true},null),{alert:false,notified:true});
});
test('alarm dispatch uses a real visible-canary request, not fabricated failure events',()=>{
  const {signalCanary}=require('./incident-auth-watch.cjs');
  for(const status of ['idle','error']){
    const calls=[];
    signalCanary({env:{},spawn:(exe,args)=>{calls.push(args);return {status:0,stdout:JSON.stringify({thread:{status}})};}});
    assert.equal(calls[1][1],status==='error'?'retry':'tell');
    assert.equal(calls[1][2],'thr_bn2xraubgc');
  }
});
