const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-vault-read-'));
const fixture=path.join(dir,'security-fixture');
const exe=path.join(dir,'reader');
const runner=path.join(dir,'reader.m');
fs.writeFileSync(runner,`#define main vault_main\n#include ${JSON.stringify(path.join(__dirname,'auth-vault-v2.m'))}\n#undef main\nint main(void){@autoreleasepool{int result;NSData *data=readPrimary(&result);printf("%d %lu\\n",result,(unsigned long)data.length);return 0;}}\n`);
const build=spawnSync('clang',['-fobjc-arc','-fblocks','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-framework','Foundation','-framework','Security',`-DBB_PRIMARY_SECURITY="${fixture}"`,runner,'-o',exe],{encoding:'utf8'});
assert.equal(build.status,0,build.stderr);
function run(script){
  fs.writeFileSync(fixture,`#!/bin/sh\n${script}\n`,{mode:0o700});
  const result=spawnSync(exe,[],{encoding:'utf8',timeout:2000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  return result.stdout.trim();
}
test('primary read captures secret in memory without emitting it',()=>{
  assert.equal(run('printf DUMMY-SECRET'),'0 12');
});
test('missing item differs from authentication denied',()=>{
  assert.equal(run('exit 44'),'0 0');
  assert.equal(run('printf DUMMY-SECRET; exit 36'),'74 0');
});
test('child stderr never exposes credentials',()=>{
  assert.equal(run('printf DUMMY-SECRET >&2; exit 1'),'74 0');
});
test('stalled child is killed and reaped within checkpoint budget',()=>{
  const before=Date.now();assert.equal(run('exec /bin/sleep 5'),'74 0');
  assert.ok(Date.now()-before<1000);
});
test('oversized primary data fails closed',()=>{
  assert.equal(run('exec /usr/bin/head -c 1048577 /dev/zero'),'74 0');
});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
