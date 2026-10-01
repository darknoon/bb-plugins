// Execute extracted 2.1.285 storage/cleanup against memory-only dummy stores.
// No installed Claude process, Keychain operation, or network request is launched.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {decision,words,filter}=require('./write-guard.cjs');
const source=fs.readFileSync('/Users/andrew/.local/share/claude/versions/2.1.285','utf8');
function slice(start,end,from=0){const a=source.indexOf(start,from),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const marker=source.lastIndexOf('plaintext_fallback_used');
const storageStart=source.lastIndexOf('function d(e,r,n){return OWr',marker);
const composite=slice('function d(e,r,n){return OWr','var p=2000',storageStart);
const primary=slice('I={name:"keychain",osGuarded:!0', ';async function x(e,r)',marker);
const read=slice('async function x(e,r){','var h;function DWr()',marker);
const clear=slice('async function A4n(e,n){','function F$t()',marker);
const fresh=()=>({claudeAiOauth:{accessToken:'DUMMY-A',refreshToken:'DUMMY-R',expiresAt:100},mcpOAuth:{figma:{keep:true}}});
function harness(mode){
  const calls=[];
  const keychain={name:'dummy',value:fresh(),invalidateCache(){},async readAsync(){return this.value;},async readAsyncStrict(){return this.value;},async delete(){calls.push('primary-delete');this.value=null;}};
  const file={name:'dummy-file',value:fresh(),async readAsync(){return this.value;},async update(next){calls.push('file-write');this.value=next;return {success:true};},async delete(){calls.push('file-delete');this.value=null;}};
  const cache={cache:{},generation:0,keychainHoldsItem:true};
  const noop=()=>{};
  const context=vm.createContext({Buffer,Date,Symbol,p:2000,te:4032,M:36,F:44,La:Symbol('failure'),Q:Symbol('legs'),
    OWr:async f=>f(),W6:()=>cache,rP:noop,wN:()=> 'Claude Code-credentials',Zde:'',BT:()=> 'andrew',S:JSON.stringify,J:JSON.parse,
    i:noop,t:noop,f:noop,y:noop,m:noop,l:String,oi:new Set(),eBt:noop,
    rm:async(exe,args,options)=>{
      assert.equal(exe,'security');assert.equal(options.timeout,2000);
      const command=args[0]==='-i'?words(options.input):args;
      const result=decision(command,null,()=>keychain.value);
      if(result.block&&mode==='withhold')return {exitCode:143,timedOut:true};
      if(result.block&&mode==='ordinary')return {exitCode:1,timedOut:false};
      calls.push('primary-write');keychain.value=JSON.parse(Buffer.from(command.at(-1),'hex').toString());return {exitCode:0,timedOut:false};
    },qe:async()=>({code:1,stdout:''})});
  vm.runInContext(composite+'\nvar '+primary+';\n'+read+'\n'+clear,context);
  keychain.update=next=>context.I.update(next);
  const combined=context.b(keychain,file);context.Wn=()=>combined;
  return {context,keychain,file,calls,combined,clear:()=>context.A4n('DUMMY-R')};
}
test('2.1.285 native cleanup without guard writes the exact empty record',async()=>{
  const h=harness('allow');await h.clear();
  assert.equal(h.keychain.value.claudeAiOauth.refreshToken,'');
  assert.equal(h.keychain.value.claudeAiOauth.accessToken,'');
  assert.equal(h.keychain.value.claudeAiOauth.expiresAt,0);
  assert.deepEqual(h.calls,['primary-write']);
});
test('2.1.285 timeout preserves both records and connectors',async()=>{
  const h=harness('withhold'),before=JSON.stringify([h.keychain.value,h.file.value]);await h.clear();
  assert.equal(JSON.stringify([h.keychain.value,h.file.value]),before);assert.deepEqual(h.calls,[]);
});
test('2.1.285 ordinary refusal would erase fallback and delete primary',async()=>{
  const h=harness('ordinary');await h.clear();assert.equal(h.keychain.value,null);
  assert.equal(h.file.value.claudeAiOauth.refreshToken,'');assert.deepEqual(h.calls,['file-write','primary-delete']);
});
test('2.1.285 normal populated writes pass; logout still deletes',async()=>{
  const h=harness('withhold');await h.combined.update(fresh());assert.deepEqual(h.calls,['primary-write']);
  await h.combined.delete();assert.equal(h.keychain.value,null);assert.equal(h.file.value,null);
});
test('2.1.285 stale cleanup cannot erase a different refresh generation',async()=>{
  const h=harness('allow');h.keychain.value.claudeAiOauth.refreshToken='DUMMY-NEW';await h.clear();assert.deepEqual(h.calls,[]);
});
test('2.1.285 maps remapped exit 1 to failure sentinel, not absence',async()=>{
  const h=harness('allow');h.context.qe=async()=>({code:36,stdout:''});assert.equal(await h.context.x({generation:0}),null);
  h.context.qe=async()=>({code:1,stdout:''});assert.equal(await h.context.x({generation:0}),h.context.La);
});
test('2.1.285 filter does not delegate the cleanup write',async()=>{
  let delegated=false;
  const empty={claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}};
  const r=await filter({version:'2.1.285',args:['add-generic-password','-U','-a','andrew','-s','Claude Code-credentials','-w',JSON.stringify(empty)],input:null,readPrimary:fresh,delegate:()=>{delegated=true;return 0;}});
  assert.equal(r,1);assert.equal(delegated,false);
});
