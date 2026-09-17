const {test}=require('node:test');
const assert=require('node:assert/strict');
const {outageDecision,lighthouseAuthFailed}=require('./incident-auth-watch.cjs');
const good={keychain:{read:'ok',access:'present',refresh:'present'},lighthouseAuthFailed:false};
test('confirmed auth failure alerts despite latched backup error, once',()=>{
  const bad={...good,lighthouseAuthFailed:true,backup:{exitCode:74}};
  const first=outageDecision({alertKey:'encrypted-backup-failed'},bad,1);
  assert.equal(first.alert,true);
  assert.equal(outageDecision(first,bad,2).alert,false);
});
test('both stores empty cannot evade outage alert by agreeing',()=>{
  const bad={keychain:{read:'ok',access:'empty',refresh:'empty'},sameOAuth:true};
  const a=outageDecision(null,bad,1);
  assert.equal(a.alert,false);
  const b=outageDecision(a,bad,120001);
  assert.equal(b.alert,true);
  assert.equal(outageDecision(b,bad,999999).alert,false);
});
test('normal expiry never alerts; healthy recovery rearms',()=>{
  const expired={...good,keychain:{...good.keychain,expiresAt:0}};
  assert.equal(outageDecision(null,expired,999999).alert,false);
  const reset=outageDecision({outageNotified:true},good,1);
  assert.equal(reset.outageNotified,false);
  assert.equal(outageDecision(reset,{...good,lighthouseAuthFailed:true},2).alert,true);
});
test('unreadable status does not rearm an outage',()=>{
  assert.equal(outageDecision({outageNotified:true},{keychain:{read:'error'},lighthouseAuthFailed:null},1).outageNotified,true);
});
test('only a current error plus exact auth failure matches',()=>{
  for(const [status,log,want] of [['idle','Failed to authenticate: OAuth session expired',false],['error','other failure',false],['error','Failed to authenticate: OAuth session expired and could not be refreshed',true]]){
    const result=lighthouseAuthFailed({env:{BB_CLI:'dummy'},spawn:(_cmd,args)=>({status:0,stdout:args[1]==='show'?JSON.stringify({thread:{status}}):log})});
    assert.equal(result,want);
  }
});
