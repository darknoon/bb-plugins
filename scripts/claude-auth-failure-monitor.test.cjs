const {test}=require('node:test');
const assert=require('node:assert/strict');
const {observe,tick,canary,post}=require('./claude-auth-failure-monitor.cjs');
function fake(status,log=''){
 const calls=[];
 return {calls,env:{BB_CLI:'/dummy/bb'},spawn:(exe,args)=>{
  assert.equal(exe,'/dummy/bb');calls.push(args);
  return {status:0,stdout:args[1]==='log'?log:JSON.stringify({thread:{status}})};
 }};
}
test('health checks execute only bb thread reads, no credential helpers',()=>{
 for(const [state,log,want] of [['idle','',false],['active','',null],['error','other failure',null],['error','Failed to authenticate: OAuth session expired and could not be refreshed',true]]){
  const io=fake(state,log);assert.equal(observe(io),want);
  assert.ok(io.calls.every(a=>a[0]==='thread'&&['show','log'].includes(a[1])));
 }
});
test('healthy ticks are silent and sustained outage sends one board alert and one canary',async()=>{
 let previous,posts=0,checks=0;
 const run=failed=>tick({previous,failed,save:s=>{previous={...s};},post:async()=>posts++,canary:async()=>checks++});
 await run(false);assert.equal(posts+checks,0);
 await run(true);await run(true);await run(null);await run(true);
 assert.equal(posts,1);assert.equal(checks,1);
 await run(false);await run(true);assert.equal(posts,2);assert.equal(checks,2);
});
test('one delivery failure cannot prevent the other route; retry does not repeat successful delivery',async()=>{
 let previous,posts=0,checks=0;
 const save=s=>{previous={...s};};
 await assert.rejects(tick({previous,failed:true,save,post:async()=>{throw Error('offline');},canary:async()=>checks++}),/board/);
 await tick({previous,failed:true,save,post:async()=>posts++,canary:async()=>checks++});
 assert.equal(posts,1);assert.equal(checks,1);
});
test('busy canary is not interrupted; error canary retries',()=>{
 assert.throws(()=>canary(fake('active')),/busy/);
 const io=fake('error');canary(io);assert.equal(io.calls[1][1],'retry');
});
test('board alert uses plugin identity and refuses redirects',async()=>{
 const io={env:{BB_CLI:'/dummy/bb',BB_SERVER_URL:'http://127.0.0.1:38886'},spawn:()=>({status:0,stdout:'DUMMY-PLUGIN-TOKEN'}),request:async(url,options)=>{
  assert.equal(new URL(url).pathname,'/api/v1/plugins/whatsagent/http/post');
  assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).plugin,'claude-auth-observer');return {ok:true};
 }};await post(io);
});
