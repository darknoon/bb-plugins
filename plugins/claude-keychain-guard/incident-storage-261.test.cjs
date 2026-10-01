// Current 2.1.261 embedded source, dummy backends only; no real credential calls.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const source = fs.readFileSync('/Users/andrew/.local/share/claude/versions/2.1.261','utf8');
const end = source.lastIndexOf('function yn(){if(O)return O;return v(E,_)}');
assert.ok(end > 0);
const storage = source.slice(source.lastIndexOf('// Version:',end),end);
function between(text,a,b) {
  const start = text.indexOf(a), finish = text.indexOf(b,start+a.length);
  assert.ok(start >= 0 && finish > start); return text.slice(start,finish);
}
const code = between(storage,'function d(e,t,r){',';return r}var m=')+';return r}';
const clear = between(source,'async function UUe(e,t){','function wZe(');
const read = between(storage,'async function k(){','var h;function Kxn(');
const cred = label => ({claudeAiOauth:{accessToken:'dummy-access-'+label,refreshToken:'dummy-refresh-'+label,expiresAt:100},mcpOAuth:{dummy:{keep:true}}});
const backend = value => ({value,writes:0,name:'dummy',invalidateCache(){},async readAsync(){return this.value;},async readAsyncStrict(){return this.value;},async update(next){this.value=next;this.writes++;return {success:true};},async delete(){this.value=null;return true;}});
function harness(primary,file) {
  const ctx = vm.createContext({Vxn:async f=>f(),hc:Symbol('failed'),y(){},f(){},g(){},i(){},n(){},l:String,Ki:new Set()});
  vm.runInContext(code+'\n'+clear,ctx);
  ctx.yn = () => ctx.v(primary,file);
  return ctx;
}
test('2.1.261 still classifies denied Keychain read as absent',async()=>{
  const ctx = vm.createContext({Sx:()=>'',N5:'',tv:()=>'',m:2000,K:44,W:36,z:JSON.parse,hc:Symbol('failed'),Fe:async()=>({code:36,stdout:''})});
  vm.runInContext(read,ctx);
  assert.equal(await ctx.k(),null);
});
test('2.1.261 still clears a different Keychain token after comparing file token',async()=>{
  const primary=backend(cred('new')),file=backend(cred('old'));
  primary.readAsyncStrict=async()=>null;
  const ctx=harness(primary,file);
  await ctx.UUe('dummy-refresh-old');
  assert.equal(primary.writes,1);
  assert.equal(primary.value.claudeAiOauth.accessToken,'');
  assert.equal(primary.value.claudeAiOauth.refreshToken,'');
  assert.equal(file.value.claudeAiOauth.refreshToken,'dummy-refresh-old');
});
test('2.1.261 normal readable-primary comparison preserves newer credential',async()=>{
  const primary=backend(cred('new')),file=backend(cred('old'));
  await harness(primary,file).UUe('dummy-refresh-old');
  assert.equal(primary.writes,0);
});
test('readable stale Keychain is cleared even when the file holds a newer token: no denied read required',async()=>{
  const primary=backend(cred('old')),file=backend(cred('new'));
  await harness(primary,file).UUe('dummy-refresh-old');
  assert.equal(primary.writes,1);
  assert.equal(primary.value.claudeAiOauth.accessToken,'');
  assert.equal(primary.value.claudeAiOauth.refreshToken,'');
  assert.equal(file.value.claudeAiOauth.refreshToken,'dummy-refresh-new');
  assert.equal(file.writes,0);
});
test('failed primary persistence followed by failed delete leaves independently refreshed copies',async()=>{
  const primary=backend(cred('old')),file=backend(cred('old'));
  primary.update=async()=>({success:false});
  primary.delete=async()=>false;
  const ctx=harness(primary,file);
  const result=await ctx.yn().update(cred('new'));
  assert.equal(result.success,true);
  assert.equal(primary.value.claudeAiOauth.refreshToken,'dummy-refresh-old');
  assert.equal(file.value.claudeAiOauth.refreshToken,'dummy-refresh-new');
});
test('2.1.261 failed strict read aborts clear without touching either store',async()=>{
  const primary=backend(cred('new')),file=backend(cred('old')),ctx=harness(primary,file);
  primary.readAsyncStrict=async()=>ctx.hc;
  await ctx.UUe('dummy-refresh-old');
  assert.equal(primary.writes,0); assert.equal(file.writes,0);
});
test('compiled guard classification blocks the reproduced 2.1.261 wipe end-to-end in dummy storage',async()=>{
  const run=spawnSync('/private/tmp/bb-auth-guard-policy-test',['security','find-generic-password','-a','andrew','-s','Claude Code-credentials']);
  assert.equal(run.status,1);
  const primary=backend(cred('new')),file=backend(cred('old')),ctx=harness(primary,file);
  Object.assign(ctx,{Sx:()=>'',N5:'',tv:()=>'',m:2000,K:44,W:36,z:JSON.parse,Fe:async()=>({code:run.status,stdout:''})});
  vm.runInContext(read,ctx);
  primary.readAsyncStrict=()=>ctx.k();
  await ctx.UUe('dummy-refresh-old');
  assert.equal(primary.writes,0); assert.equal(file.writes,0);
  assert.equal(primary.value.claudeAiOauth.refreshToken,'dummy-refresh-new');
});
