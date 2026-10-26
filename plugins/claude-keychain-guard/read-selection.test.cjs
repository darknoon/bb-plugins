const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectRead,selectVerifiedRead}=require('./read-selection.cjs');
const cred=(label,expiresAt)=>({claudeAiOauth:{accessToken:`dummy-access-${label}`,refreshToken:`dummy-refresh-${label}`,expiresAt,scopes:['user:inference','user:mcp_servers']}});
test('newer Keychain stays authoritative when fallback is stale',()=>{
  const primary=cred('new',200),file=cred('old',100);
  assert.equal(selectRead(primary,file).value,primary);
});
test('newer file is returned without changing either store or Keychain connectors',()=>{
  const primary={...cred('old',100),mcpOAuth:{linear:{accessToken:'dummy-connector'}}};
  const file={...cred('new',200),mcpOAuth:{linear:{accessToken:'do-not-adopt'}}};
  const before=JSON.stringify([primary,file]);
  const result=selectRead(primary,file);
  assert.equal(result.selected,'file');
  assert.equal(result.value.claudeAiOauth.accessToken,'dummy-access-new');
  assert.deepEqual(result.value.claudeAiOauth.scopes,['user:inference','user:mcp_servers']);
  assert.equal(result.value.mcpOAuth,primary.mcpOAuth);
  assert.equal(JSON.stringify([primary,file]),before);
});
test('empty OAuth cannot shadow a complete fallback credential',()=>{
  const primary={claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0},mcpOAuth:{keep:true}};
  assert.equal(selectRead(primary,cred('new',200)).value.claudeAiOauth.accessToken,'dummy-access-new');
});
test('expired access tokens remain available to native locked refresh',()=>{
  assert.equal(selectRead(cred('old',1),cred('new',2)).selected,'file');
});
test('equal expiry and distinct tokens are ambiguous: retain native Keychain preference',()=>{
  const primary=cred('a',200);
  assert.equal(selectRead(primary,cred('b',200)).value,primary);
});
test('invalid/incomplete/missing file never displaces Keychain',()=>{
  const primary=cred('good',100);
  for(const file of [null,{},cred('bad',NaN),{claudeAiOauth:{accessToken:'dummy',expiresAt:200}},cred('bad',-1)])
    assert.equal(selectRead(primary,file).value,primary);
});
test('absent Keychain preserves native missing-store behavior',()=>{
  assert.equal(selectRead(null,cred('good',100)).value,null);
});
test('API-key-only, partial, and different-client records are never replaced',()=>{
  for(const primary of [{apiKey:'dummy'}, {claudeAiOauth:{accessToken:'dummy-inference',refreshToken:null,expiresAt:200}}, {...cred('old',100),claudeAiOauth:{...cred('old',100).claudeAiOauth,clientId:'other-client'}}])
    assert.equal(selectRead(primary,cred('new',200)).value,primary);
});
const expectedIdentity={accountUuid:'dummy-account',organizationUuid:'dummy-org'};
test('live-boundary selection requires a positively verified matching account and organization',async()=>{
  const primary=cred('old',100),file=cred('new',200);
  assert.equal((await selectVerifiedRead(primary,file)).selected,'keychain');
  for(const identity of [null,{...expectedIdentity,accountUuid:'other'},{...expectedIdentity,organizationUuid:'other'}]) {
    const result=await selectVerifiedRead(primary,file,{expectedIdentity,verifyIdentity:async()=>identity});
    assert.equal(result.selected,'keychain'); assert.equal(result.refusal,'identity-mismatch');
  }
  const result=await selectVerifiedRead(primary,file,{expectedIdentity,verifyIdentity:async o=>{
    assert.equal(o.accessToken,'dummy-access-new');return expectedIdentity;
  }});
  assert.equal(result.selected,'file');
});
test('verification failures retain primary and never leak transport error text',async()=>{
  const primary=cred('old',100);
  const result=await selectVerifiedRead(primary,cred('new',200),{expectedIdentity,verifyIdentity:async()=>{throw new Error('DUMMY-SECRET');}});
  assert.equal(result.value,primary);
  assert.equal(result.refusal,'identity-verification-failed');
  assert.ok(!JSON.stringify(result).includes('DUMMY-SECRET'));
});
test('Keychain-newer reads need no remote verification',async()=>{
  const primary=cred('new',200);
  assert.equal((await selectVerifiedRead(primary,cred('old',100),{expectedIdentity,verifyIdentity:()=>assert.fail('unnecessary request')})).value,primary);
});
