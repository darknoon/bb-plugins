import {test} from 'node:test';
import assert from 'node:assert/strict';
import plugin from './dist/server.js';
test('built provider contribution omits removed secret field and keeps selection disabled',async()=>{
  let resolve;
  plugin({settings:{define:()=>({get:async()=>({allThreads:true,canaryThread:'dummy',readSelectionCanary:false,readSelectionAll:false})})},providers:{experimental_contributeEnv:(id,fn)=>{assert.equal(id,'claude-code');resolve=fn;}}});
  const entries=await resolve({hostId:'host_5e5sg5gdn4',threadId:'dummy',projectId:'dummy'});
  assert.equal(entries.length,1);
  assert.equal(entries[0].name,'BB_CLAUDE_CODE_EXECUTABLE');
  assert.deepEqual(Object.keys(entries[0]).sort(),['name','reason','value']);
  assert.deepEqual(await resolve({hostId:'other',threadId:'dummy',projectId:'dummy'}),[]);
});
