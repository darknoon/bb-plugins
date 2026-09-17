const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {decision,words,filter,VERIFIED_VERSIONS}=require('./write-guard.cjs');
const fresh=()=>({claudeAiOauth:{accessToken:'DUMMY-A',refreshToken:'DUMMY-R',expiresAt:100},mcpOAuth:{figma:{keep:true}}});
const empty=()=>({...fresh(),claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}});
const argv=record=>['add-generic-password','-U','-a','andrew','-s','Claude Code-credentials','-X',Buffer.from(JSON.stringify(record)).toString('hex')];
const stdin=record=>argv(record).map(s=>JSON.stringify(s)).join(' ')+'\n';
function actualFilterTimeout(){
  const program=`require(${JSON.stringify(require.resolve('./write-guard.cjs'))}).filter({version:'2.1.270',args:${JSON.stringify(argv(empty()))},input:null,readPrimary:()=>(${JSON.stringify(fresh())}),delegate:()=>{process.stdout.write('UNEXPECTED_WRITE');return 0;}}).then(code=>process.exit(code));`;
  return spawnSync(process.execPath,['-e',program],{timeout:2000,encoding:'utf8'});
}
test('both native transports block empty replacement without changing inputs',()=>{
  const original=fresh(),before=JSON.stringify(original);
  for(const [args,input] of [[argv(empty()),Buffer.alloc(0)],[['-i'],Buffer.from(stdin(empty()))]])
    assert.equal(decision(args,input,()=>original).block,true);
  assert.equal(JSON.stringify(original),before);
});
test('denied primary read blocks empty write, missing/already-empty primary does not',()=>{
  assert.equal(decision(argv(empty()),null,()=>undefined).block,true);
  for(const value of [null,empty()])assert.equal(decision(argv(empty()),null,()=>value).block,false);
});
test('normal refresh, OAuth removal during re-login, and explicit logout pass unchanged',()=>{
  for(const record of [fresh(),{mcpOAuth:fresh().mcpOAuth}])assert.equal(decision(argv(record),null,()=>{throw Error('unnecessary read');}).block,false);
  assert.equal(decision(['delete-generic-password','-a','andrew','-s','Claude Code-credentials'],null,()=>fresh()).block,false);
});
test('other accounts/services and explicit unrelated Keychains remain untouched',()=>{
  for(const index of [3,5]){const args=argv(empty());args[index]='unrelated';assert.equal(decision(args,null,()=>fresh()).block,false);}
  assert.equal(decision([...argv(empty()),'/tmp/unrelated.keychain'],null,()=>fresh()).block,false);
});
test('interactive batch inspected before any command executes; quoting is literal',()=>{
  assert.equal(decision(['-i'],Buffer.from(stdin(fresh())+stdin(empty())),()=>fresh()).block,true);
  assert.deepEqual(words('one "two three" \'four\' ""'),['one','two three','four','']);
  assert.equal(words('"unterminated'),null);
});
function slice(source,a,b){const p=source.indexOf(a),q=source.indexOf(b,p+a.length);assert.ok(p>=0&&q>p&&q-p<15000);return source.slice(p,q);}
const installed=fs.readdirSync('/Users/andrew/.local/share/claude/versions').filter(s=>/^2\.1\.\d+$/.test(s));
test('every installed Claude version requires explicit review or exclusion',()=>{
  // Retained old release: intentionally unguarded, not a claimed supported version.
  const excluded=new Set(['2.1.258']);
  for(const version of installed)assert.ok(VERIFIED_VERSIONS.has(version)||excluded.has(version),`Unverified installed version ${version}: guard must remain off for this caller`);
});
test('unknown callers delegate without inspecting, rejecting, or delaying their write',async()=>{
  for(const version of [undefined,'2.1.271']){
    let delegated=0;
    assert.equal(await filter({version,args:argv(empty()),input:null,readPrimary:()=>{throw Error('read');},delegate:()=>{delegated++;return 7;}}),7);
    assert.equal(delegated,1);
  }
});
for(const version of installed.filter(v=>VERIFIED_VERSIONS.has(v))){
  const source=fs.readFileSync(`/Users/andrew/.local/share/claude/versions/${version}`,'utf8');
  const marker=source.lastIndexOf('plaintext_fallback_used');
  const storage=source.slice(source.lastIndexOf('// Version:',marker),marker+9000);
  const older=version==='2.1.261';
  const latest=version==='2.1.273';
  const current=version==='2.1.274';
  const composite=slice(storage,older?'function d(e,t,r){':current?'function g(e,r,n){':'function d(e,r,n){',older?'var m=2000':latest?'var f=2000':current?'var p=2000':'var g=2000');
  const at=source.lastIndexOf('tengu_oauth_refresh_token_cleared_on_disk');
  const start=source.lastIndexOf('async function ',at);
  const clear=source.slice(start,source.indexOf('function ',at));
  assert.ok(clear.length<4000);
  const clearName=clear.match(/async function (\w+)\(/)[1];
  const primaryCode=slice(storage,older?'E={name:"keychain"':latest?'N={name:"keychain"':current?'T={name:"keychain"':'I={name:"keychain"',older?';async function k()':latest?';async function b(e)':';async function x(e)');
  function harness(mode){
    const primary={value:fresh(),writes:0,deletes:0,name:'dummy',invalidateCache(){},async readAsync(){return this.value;},async readAsyncStrict(){return this.value;},async delete(){this.deletes++;this.value=null;return true;}};
    const file={...primary,value:{...fresh(),claudeAiOauth:{...fresh().claudeAiOauth,accessToken:'DUMMY-NEW',refreshToken:'DUMMY-NEW-R'}},async update(next){this.writes++;this.value=next;return {success:true};}};
    const cache={cache:{},generation:0};
    const command=async(exe,args,options)=>{
      assert.equal(exe,'security');assert.equal(options.timeout,2000);
      const parsed=args[0]==='-i'?words(options.input):args;
      const result=decision(parsed,null,()=>primary.value);
      if(result.block&&mode==='ordinary')return {exitCode:1,timedOut:false};
      if(result.block&&mode==='transient'){
        const child=actualFilterTimeout();assert.equal(child.stdout,'');assert.equal(child.stderr,'');
        return {exitCode:child.status??1,timedOut:child.error?.code==='ETIMEDOUT'};
      }
      primary.value=JSON.parse(Buffer.from(parsed.at(-1),'hex').toString());primary.writes++;
      return {exitCode:0,timedOut:false};
    };
    const noop=()=>{};
    const ctx=vm.createContext({Buffer,g:2000,m:2000,H:4032,Z:4032,Ki:new Set(),as:new Set(),
      hc:Symbol('failed'),Ha:Symbol('failed'),Vxn:async f=>f(),XBn:async f=>f(),
      y:noop,f:noop,g:2000,i:noop,n:noop,t:noop,l:String,_:noop,p:noop,h:noop,
      DU:()=>cache,Rj:()=>cache,wA:noop,sT:noop,Sx:()=> 'Claude Code-credentials',iH:()=> 'Claude Code-credentials',N5:'',Y7:'',
      tv:()=> 'andrew',Fw:()=> 'andrew',b:JSON.stringify,Bf:command,Rp:command,
      os:new Set(),Za:Symbol('failed'),W8n:async f=>f(),CW:()=>cache,fk:noop,xP:()=> 'Claude Code-credentials',ZQ:'',XE:()=> 'andrew',w:JSON.stringify,ap:command,
      Ei:new Set(),al:Symbol('failed'),YZn:async f=>f(),jz:()=>cache,zk:noop,mI:()=> 'Claude Code-credentials',Bee:'',Cv:()=> 'andrew',Tp:command});
    // The older composite calls g for analytics; its timeout is m, not g.
    if(older)ctx.g=noop;
    if(latest){ctx.f=2000;ctx.m=noop;}
    if(current){ctx.p=2000;ctx.f=noop;}
    vm.runInContext(composite+'\nvar '+primaryCode+';\n'+clear,ctx);
    primary.update=next=>(older?ctx.E:latest?ctx.N:current?ctx.T:ctx.I).update(next);
    const combined=older?ctx.v(primary,file):ctx.k(primary,file);
    ctx[older?'yn':latest?'xn':current?'In':'vn']=()=>combined;
    return {ctx,primary,file,combined,clear:()=>ctx[clearName]('DUMMY-R')};
  }
  test(`${version}: ordinary write refusal overwrites file then deletes primary (unsafe proposal)`,async()=>{
    const h=harness('ordinary');await h.clear();
    assert.equal(h.primary.value,null);assert.equal(h.primary.deletes,1);
    assert.equal(h.file.value.claudeAiOauth.accessToken,'');assert.equal(h.file.writes,1);
  });
  test(`${version}: native transient refusal preserves both stores and connectors`,async()=>{
    const h=harness('transient');const before=JSON.stringify([h.primary.value,h.file.value]);await h.clear();
    assert.equal(JSON.stringify([h.primary.value,h.file.value]),before);
    assert.equal(h.primary.writes+h.primary.deletes+h.file.writes+h.file.deletes,0);
  });
  test(`${version}: unprotected invalid_grant cleanup reproduces successful empty write`,async()=>{
    const h=harness('unprotected');await h.clear();
    assert.equal(h.primary.value.claudeAiOauth.accessToken,'');assert.equal(h.primary.writes,1);
  });
  test(`${version}: full logout still deletes both stores`,async()=>{
    const h=harness('transient');await h.combined.delete();
    assert.equal(h.primary.value,null);assert.equal(h.file.value,null);
  });
}
test('withholding blocked write exceeds native 2s timeout, without a write delegate',()=>{
  const child=actualFilterTimeout();assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  assert.equal(child.error?.code,'ETIMEDOUT');assert.equal(child.signal,'SIGTERM');
});
