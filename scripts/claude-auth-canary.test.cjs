const {test}=require('node:test');
const assert=require('node:assert/strict');
const {run,result,PROMPT}=require('./claude-auth-canary.cjs');
const events=text=>[
 {seq:2,type:'client/turn/requested',data:{input:[{type:'text',text:PROMPT}]}},
 {seq:3,type:'item/completed',data:{item:{type:'agentMessage',text}}},
 {seq:4,type:'turn/completed',data:{status:'completed'}}];
test('only a fresh matching completed turn with exact AUTH_OK passes',()=>{
 assert.equal(result(events('AUTH_OK')),true);assert.equal(result(events('sorry')),false);
 assert.equal(result(events('AUTH_OK').slice(1)),null);
 assert.equal(result(events('AUTH_OK').slice(0,2)),null);
 assert.equal(result([...events('AUTH_OK'),{seq:5,type:'client/turn/requested'}]),null);
});
test('successful cycles are silent; failure permanently halts sends until explicit reset',async()=>{
 let state={},sends=0,alerts=0,output='AUTH_OK';
 const tick=()=>run({previous:state,save:s=>state={...s},history:async seq=>seq===1?events(output):[{seq:1}],send:async()=>sends++,wait:async()=>{},alert:async()=>alerts++});
 await tick();assert.equal(sends,1);assert.equal(alerts,0);
 state={};output='not AUTH_OK';await tick();await tick();await tick();
 assert.equal(sends,2);assert.equal(alerts,1);assert.equal(state.halted,true);
});
test('interrupted dispatch is never retried, even if alert delivery needs retry',async()=>{
 let state={pending:true},attempts=0;
 const tick=alert=>run({previous:state,save:s=>state={...s},send:()=>assert.fail(),alert});
 await assert.rejects(tick(async()=>{attempts++;throw Error('offline');}));
 await tick(async()=>attempts++);await tick(()=>assert.fail());assert.equal(attempts,2);
});
test('wait timeout halts rather than interpreting old AUTH_OK as health',async()=>{
 let state={},alerts=0;
 await run({save:s=>state=s,history:async()=>[{seq:1}],send:async()=>{},wait:()=>{throw Error('timeout');},alert:async()=>alerts++});
 assert.equal(state.halted,true);assert.equal(alerts,1);
});
