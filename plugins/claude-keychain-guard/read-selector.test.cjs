const {test}=require('node:test');
const assert=require('node:assert/strict');
const {adaptedRead,verifyProfile}=require('./read-selector.cjs');
const identity={accountUuid:'dummy-account',organizationUuid:'dummy-org'};
const args=['find-generic-password','-a','andrew','-s','Claude Code-credentials','-w'];
const credential=(label,expiry)=>({claudeAiOauth:{accessToken:`dummy-access-${label}`,refreshToken:`dummy-refresh-${label}`,expiresAt:expiry,scopes:['user:inference','user:mcp_servers']}});
function dependencies(primary=credential('old',100),file=credential('new',200)) {
  return {
    runSecurity:()=>({status:0,stdout:JSON.stringify(primary)+'\n',stderr:''}),
    readFallback:()=>file,readExpectedIdentity:()=>identity,readCurrentIdentity:()=>identity,
    verifyIdentity:async()=>identity,
  };
}
test('successful verified substitution preserves connector fields and full scopes',async()=>{
  const p={...credential('old',100),mcpOAuth:{linear:{token:'dummy-linear'}}};
  const result=await adaptedRead(args,dependencies(p));
  assert.equal(result.status,0);assert.equal(result.selected,'file');
  const doc=JSON.parse(result.stdout);
  assert.equal(doc.claudeAiOauth.accessToken,'dummy-access-new');
  assert.deepEqual(doc.mcpOAuth,p.mcpOAuth);
  assert.deepEqual(doc.claudeAiOauth.scopes,['user:inference','user:mcp_servers']);
});
test('signed-out config and account switches prevent substitution',async()=>{
  for(const current of [null,{...identity,accountUuid:'other'},{...identity,organizationUuid:'other'}]) {
    const deps=dependencies();deps.readCurrentIdentity=()=>current;
    const result=await adaptedRead(args,deps);
    assert.equal(result.stdout,deps.runSecurity().stdout);
    assert.equal(result.refusal,'signed-out-or-account-changed');
  }
});
test('file changes during identity verification are refused',async()=>{
  const deps=dependencies();let changed=false;
  deps.verifyIdentity=async()=>{changed=true;return identity;};
  deps.readFallback=()=>credential(changed?'racing':'new',200);
  const result=await adaptedRead(args,deps);
  assert.equal(result.selected,'keychain');assert.equal(result.refusal,'source-changed');
});
test('logout during identity verification is refused',async()=>{
  const deps=dependencies();let loggedOut=false;
  deps.verifyIdentity=async()=>{loggedOut=true;return identity;};
  deps.readCurrentIdentity=()=>loggedOut?null:identity;
  assert.equal((await adaptedRead(args,deps)).refusal,'source-changed');
});
test('Keychain transport failure and non-target requests preserve transport exactly',async()=>{
  for(const status of [36,44,1]){
    const deps=dependencies();const raw={status,stdout:'',stderr:'dummy-failure'};
    deps.runSecurity=()=>raw;deps.readFallback=()=>assert.fail('must not read');
    assert.deepEqual(await adaptedRead(args,deps),{...raw,selected:'keychain'});
  }
  for(const badArgs of [['find-generic-password','-a','other','-s','Claude Code-credentials','-w'],[...args,'-a','other'],['delete-generic-password','-a','andrew','-s','Claude Code-credentials']]) {
    const deps=dependencies();deps.readFallback=()=>assert.fail('must not read');
    assert.equal((await adaptedRead(badArgs,deps)).selected,'keychain');
  }
});
test('private token-bound identity proof supports later native refresh of expired access',async()=>{
  let proof={};let calls=0;
  const oauth=credential('new',1).claudeAiOauth;
  const deps={readProof:()=>proof,writeProof:value=>{proof=value;},request:async(url,options)=>{
    calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/profile');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer dummy-access-new');
    return {ok:true,json:async()=>({account:{uuid:identity.accountUuid},organization:{uuid:identity.organizationUuid}})};
  }};
  assert.deepEqual(await verifyProfile(oauth,identity,deps),identity);
  assert.deepEqual(await verifyProfile(oauth,identity,{...deps,request:()=>assert.fail('proof should avoid network')}),identity);
  assert.equal(calls,1);
  assert.ok(!JSON.stringify(proof).includes('dummy-access'));
  await verifyProfile({...oauth,refreshToken:'dummy-refresh-changed'},identity,deps);
  assert.equal(calls,2);
});
test('wrong-account profile is neither adopted nor cached',async()=>{
  const actual=await verifyProfile(credential('new',200).claudeAiOauth,identity,{
    readProof:()=>({}),writeProof:()=>assert.fail('must not cache wrong account'),
    request:async()=>({ok:true,json:async()=>({account:{uuid:'other'},organization:{uuid:identity.organizationUuid}})}),
  });
  assert.equal(actual.accountUuid,'other');
});
test('expired unproven token with rejected profile is refused, not assumed refreshable',async()=>{
  const deps=dependencies({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}},credential('expired',1));
  deps.verifyIdentity=oauth=>verifyProfile(oauth,identity,{readProof:()=>({}),request:async()=>({ok:false})});
  const result=await adaptedRead(args,deps);
  assert.equal(result.selected,'keychain');assert.equal(result.refusal,'identity-verification-failed');
});
