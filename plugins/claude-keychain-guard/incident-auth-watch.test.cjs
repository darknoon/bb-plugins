const {test} = require('node:test');
const assert = require('node:assert/strict');
const {metadata,classify,decide,postAlert,REFRESH_CYCLE_MS} = require('./incident-auth-watch.cjs');
const now = 10000000;
const good = {keychain:{read:'ok',access:'present',refresh:'present',expiresAt:now+100000},file:{read:'ok'},sameOAuth:true};
test('alerts use explicit plugin identity with no thread or human fallback',async()=>{
  await postAlert('dummy alert',{
    env:{BB_CLI:'/test/bb',BB_SERVER_URL:'http://127.0.0.1:1234'},
    spawn:(command,args)=>{
      assert.equal(command,'/test/bb');
      assert.deepEqual(args,['plugin','token','whatsagent']);
      return {status:0,stdout:'DUMMY-TOKEN\n'};
    },
    request:async(url,options)=>{
      assert.equal(String(url),'http://127.0.0.1:1234/api/v1/plugins/whatsagent/http/post');
      assert.equal(options.headers['x-bb-plugin-token'],'DUMMY-TOKEN');
      assert.equal(options.redirect,'error');
      assert.deepEqual(JSON.parse(options.body),{plugin:'claude-auth-observer',channel:'incident-claude-auth',body:'dummy alert'});
      return {ok:true};
    },
  });
});
test('token lookup failure never posts as a human or exposes output',async()=>{
  await assert.rejects(postAlert('dummy',{
    env:{},spawn:()=>({status:1,stdout:'PRIVATE'}),
    request:()=>assert.fail('must not post'),
  }),{message:'alert-delivery-failed'});
});
test('HTTP failure is redacted without a CLI posting fallback',async()=>{
  await assert.rejects(postAlert('dummy',{
    env:{},spawn:()=>({status:0,stdout:'PRIVATE'}),
    request:async()=>{throw new Error('PRIVATE');},
  }),{message:'alert-delivery-failed'});
});
test('redaction allowlist excludes token values and arbitrary metadata',()=>{
  const result = metadata(JSON.stringify({claudeAiOauth:{accessToken:'SECRET-A',refreshToken:'SECRET-B',email:'PRIVATE',expiresAt:123},mcpOAuth:{private:'SECRET-C'}}));
  assert.deepEqual(result,{read:'ok',access:'present',refresh:'present',expiresAt:123});
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('blank readable Keychain is not treated as healthy fallback',()=>{
  assert.equal(classify({...good,keychain:{read:'ok',access:'empty',refresh:'empty',expiresAt:0}},now),'keychain-empty');
});
test('unreadable Keychain is distinct from missing tokens',()=>{
  assert.equal(classify({...good,keychain:{read:'error',exitCode:36}},now),'keychain-unreadable');
});
test('populated divergent stores are classified without assuming either token invalid',()=>{
  assert.equal(classify({...good,sameOAuth:false},now),'stores-differ');
});
test('healthy unchanged tick stays silent',()=>{
  assert.deepEqual(decide({snapshot:good,condition:'ok'},good,now),{condition:'ok',conditionSince:now,divergenceSince:null,backupFailureSince:null,backupFailureCount:0,alertKey:null,changed:false,alert:false});
});
test('expiry crossing is noticed even without storage changes',()=>{
  const result = decide({snapshot:good,condition:'ok'},good,now+100001);
  assert.equal(result.condition,'keychain-expired'); assert.ok(result.changed); assert.equal(result.alert,false);
});
test('same mismatch does not post hourly reminders',()=>{
  const bad = {...good,sameOAuth:false};
  bad.keychain={...good.keychain,expiresAt:now+86400000};
  const previous = {snapshot:bad,condition:'stores-differ',alertKey:'stores-differ',lastAlertAt:now};
  assert.equal(decide(previous,bad,now+60000).alert,false);
  assert.equal(decide(previous,bad,now+3600000).alert,false);
});
test('older file after Keychain refresh is logged but does not page',()=>{
  const snapshot={...good,sameOAuth:false,file:{read:'ok',expiresAt:now-1}};
  const result=decide({snapshot:good,condition:'ok'},snapshot,now);
  assert.equal(result.changed,true); assert.equal(result.alert,false);
});
const newerFile = () => ({...good,sameOAuth:false,file:{read:'ok',access:'present',refresh:'present',expiresAt:now+200000}});
test('newer file pages once only after a full refresh cycle despite primary expiry',()=>{
  const snapshot=newerFile();
  const first=decide({snapshot:good,condition:'ok'},snapshot,now);
  assert.equal(first.alert,false);
  const previous={...first,snapshot};
  assert.equal(decide(previous,snapshot,now+REFRESH_CYCLE_MS-1).alert,false);
  const page=decide(previous,snapshot,now+REFRESH_CYCLE_MS);
  assert.equal(page.alert,true);
  assert.equal(page.alertKey,'credential-divergence-persisted');
  assert.equal(decide({...page,snapshot},snapshot,now+2*REFRESH_CYCLE_MS).alert,false);
});
test('expiry alone never pages even after several idle refresh cycles',()=>{
  const snapshot={...good,keychain:{...good.keychain,expiresAt:now-1}};
  const first=decide(null,snapshot,now);
  assert.equal(first.alert,false);
  const second=decide({...first,snapshot},snapshot,now+120000);
  assert.equal(second.alert,false);
  assert.equal(decide({...second,snapshot},snapshot,now+3*REFRESH_CYCLE_MS).alert,false);
});
test('expiry then a successful refresh stays silent regardless of idle duration',()=>{
  const snapshot={...good,keychain:{...good.keychain,expiresAt:now-1}};
  const first=decide(null,snapshot,now);
  assert.equal(decide({...first,snapshot},good,now+60000).alert,false);
});
test('self-healed divergence resets the timer and later recurrence waits a full cycle',()=>{
  const broken=newerFile();
  const first=decide(null,broken,now);
  assert.equal(first.alert,false);
  const recovery=decide({...first,snapshot:broken},good,now+1);
  assert.equal(recovery.divergenceSince,null);
  const recurrence=decide({...recovery,snapshot:good},broken,now+2);
  assert.equal(recurrence.alert,false);
  assert.equal(recurrence.divergenceSince,now+2);
  assert.equal(decide({...recurrence,snapshot:broken},broken,now+2+REFRESH_CYCLE_MS).alert,true);
});
test('read failure without evidence of persistent divergence is logged only',()=>{
  const bad = {...good,keychain:{read:'error'}};
  assert.equal(decide({snapshot:good,condition:'stores-differ',lastAlertAt:now},bad,now+1).alert,false);
});
test('invalid JSON never leaks content',()=>{
  assert.deepEqual(metadata('TOKEN MALFORMED'),{read:'invalid-json'});
});
test('guard intervention is logged without paging when credentials remain healthy',()=>{
  const snapshot = {...good,guard:{at:123,parentPid:456,size:100}};
  const result = decide({snapshot:good,condition:'ok',lastAlertAt:now},snapshot,now+1);
  assert.equal(result.changed,true);
  assert.equal(result.alert,false);
  assert.equal(decide({snapshot,condition:'ok',lastAlertAt:now},snapshot,now+2).alert,false);
});
test('empty primary with a complete file alerts only after sustained divergence',()=>{
  const snapshot={...newerFile(),keychain:{read:'ok',access:'empty',refresh:'empty',expiresAt:0}};
  const first=decide(null,snapshot,now);
  assert.equal(first.alert,false);
  assert.equal(decide({...first,snapshot},snapshot,now+REFRESH_CYCLE_MS).alert,true);
});
test('old observer expiry state migrates silently',()=>{
  const snapshot={...good,keychain:{...good.keychain,expiresAt:now-1}};
  const result=decide({snapshot,condition:'keychain-expired',alertKey:'keychain-expired',conditionSince:0},snapshot,now);
  assert.equal(result.alert,false);assert.equal(result.alertKey,null);
});
test('backup capture failure needs three failures over two minutes, alerts once, then resets',()=>{
  const snapshot={...good,backup:{exitCode:74,timedOut:false}};
  const first=decide(null,snapshot,now);
  assert.equal(first.alert,false);
  const second=decide({...first,snapshot},snapshot,now+60000);
  assert.equal(second.alert,false);
  const third=decide({...second,snapshot},snapshot,now+120000);
  assert.equal(third.alert,true);assert.equal(third.alertKey,'encrypted-backup-failed');
  assert.equal(decide({...third,snapshot},snapshot,now+180000).alert,false);
  const healthy={...good,backup:{exitCode:0,timedOut:false}};
  const reset=decide({...third,snapshot},healthy,now+180000);
  assert.equal(reset.alert,false);assert.equal(reset.backupFailureSince,null);assert.equal(reset.backupFailureCount,0);
  assert.equal(decide({...reset,snapshot:healthy},snapshot,now+240000).alert,false);
});
test('isolated capture errors and timeouts never page when the next tick succeeds',()=>{
  const healthy={...good,backup:{exitCode:0,timedOut:false}};
  let previous=null;
  for(let i=0;i<10;i++){
    const snapshot={...good,backup:i%2?{exitCode:null,timedOut:true}:{exitCode:74,timedOut:false}};
    const bad=decide(previous,snapshot,now+i*120000);
    assert.equal(bad.alert,false);
    const recovery=decide({...bad,snapshot},healthy,now+i*120000+60000);
    assert.equal(recovery.alert,false);
    previous={...recovery,snapshot:healthy};
  }
});
test('three rapid failures cannot bypass the minimum duration',()=>{
  const snapshot={...good,backup:{exitCode:74}};
  let previous=null;
  for(let i=0;i<5;i++){
    const result=decide(previous,snapshot,now+i);
    assert.equal(result.alert,false);
    previous={...result,snapshot};
  }
  assert.equal(decide(previous,snapshot,now+120000).alert,true);
});
test('a long gap with only two failures does not satisfy three attempts',()=>{
  const snapshot={...good,backup:{exitCode:74}};
  const first=decide(null,snapshot,now);
  assert.equal(decide({...first,snapshot},snapshot,now+3600000).alert,false);
});
test('already announced backup failure stays latched through migration',()=>{
  const snapshot={...good,backup:{exitCode:74}};
  const result=decide({snapshot,alertKey:'encrypted-backup-failed'},snapshot,now);
  assert.equal(result.alert,false);assert.equal(result.alertKey,'encrypted-backup-failed');
});
test('transient backup errors cannot hide sustained credential divergence',()=>{
  const snapshot={...newerFile(),backup:{exitCode:74}};
  const result=decide({divergenceSince:now-REFRESH_CYCLE_MS},snapshot,now);
  assert.equal(result.alert,true);assert.equal(result.alertKey,'credential-divergence-persisted');
});
test('empty initial backup is explicitly not ready, never reported protected',()=>{
  const result=decide(null,{...good,backup:{exitCode:78,timedOut:false}},now);
  assert.equal(result.alert,true);assert.equal(result.alertKey,'encrypted-backup-not-ready');
});
test('stale file stays silent over multiple Keychain expiry and refresh cycles',()=>{
  let previous=null;
  for(let cycle=0;cycle<4;cycle++) {
    const t=now+cycle*REFRESH_CYCLE_MS*2;
    const expired={...good,sameOAuth:false,keychain:{...good.keychain,expiresAt:t-1},file:{read:'ok',access:'present',refresh:'present',expiresAt:1}};
    const a=decide(previous,expired,t);
    const b=decide({...a,snapshot:expired},expired,t+REFRESH_CYCLE_MS);
    const refreshed={...expired,keychain:{...expired.keychain,expiresAt:t+2*REFRESH_CYCLE_MS}};
    const c=decide({...b,snapshot:expired},refreshed,t+REFRESH_CYCLE_MS+1);
    assert.equal(a.alert||b.alert||c.alert,false);
    previous={...c,snapshot:refreshed};
  }
});
