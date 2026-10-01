const {test}=require('node:test');
const assert=require('node:assert/strict');
const {observe,providerFailure,tick,canary,post,intervention,readInterventions}=require('./claude-auth-failure-monitor.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
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
test('matches provider authentication and model version errors, not arbitrary HTTP/tool failures',()=>{
 for(const line of ['authentication_error: invalid token','OAuth refresh failed','invalid_grant','API Error: 401 Unauthorized','Anthropic request failed: HTTP 401','HTTP 400: model requires Claude Code 2.1.280 or newer','API Error: 400 unsupported model'])assert.equal(providerFailure(line),true,line);
 for(const line of ['Tool error: HTTP 401','curl returned HTTP 400','Tool result: authentication failed','HTTP 400: invalid input','API Error: 429 rate limited','Build failed'])assert.equal(providerFailure(line),false,line);
});
test('repeated unavailable or malformed bb reads stay unknown and do not throw',()=>{
 for(let i=0;i<4;i++){
  assert.equal(observe({spawn:()=>({status:1,stdout:''})}),null);
  assert.equal(observe({spawn:()=>({status:0,stdout:'not-json'})}),null);
 }
});
test('CLI observation failure exits zero so scheduler will not pause detection',()=>{
 const run=spawnSync(process.execPath,[require.resolve('./claude-auth-failure-monitor.cjs'),'--check'],{env:{...process.env,BB_CLI:'/nonexistent-bb-monitor-test'},encoding:'utf8'});
 assert.equal(run.status,0);assert.equal(run.stderr,'');assert.equal(JSON.parse(run.stdout).lighthouseAuthFailed,null);
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
test('shim alarms classify only fixed metadata, not credential contents',()=>{
 assert.equal(intervention({operation:'write-policy',decision:'blocked-empty-token-write'}),'empty-write-withheld');
 assert.equal(intervention({operation:'read',originalExit:36,returnedExit:1}),'denied-read-remapped');
 assert.equal(intervention({operation:'read',phase:'unverified-caller'}),'caller-unverified');
 assert.equal(intervention({operation:'read',phase:'timeout'}),'read-timed-out');
 assert.equal(intervention({operation:'read',originalExit:0,returnedExit:0}),null);
});
test('metadata tail skips history on first install and handles append/rotation without Keychain reads',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-monitor-')),file=path.join(dir,'trace');
 try{
  const line=JSON.stringify({operation:'write-policy',decision:'blocked-empty-token-write'})+'\n';
  fs.writeFileSync(file,line);const baseline=readInterventions({},file);assert.deepEqual(baseline.reasons,[]);
  fs.appendFileSync(file,line);const next=readInterventions(baseline,file);assert.deepEqual(next.reasons,['empty-write-withheld']);
  assert.deepEqual(readInterventions(next,file).reasons,[]);
  fs.unlinkSync(file);fs.writeFileSync(file,line);assert.deepEqual(readInterventions(next,file).reasons,['empty-write-withheld']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
