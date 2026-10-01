const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
test('launcher follows symlink at each launch and prepends only the local shim',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-launch-test-'));
 try{
  const current=path.join(dir,'current'), wrapper=path.join(dir,'claude-guarded');
  const source=fs.readFileSync(path.join(__dirname,'claude-guarded'),'utf8');
  assert.ok(!source.includes('versions/2.1.274'));
  fs.writeFileSync(wrapper,source.replace('/Users/andrew/.local/bin/claude',current),{mode:0o700});
  for(const version of ['one','two']){
   const target=path.join(dir,version);
   fs.writeFileSync(target,'#!/bin/sh\nprintf "%s\\n" "'+version+'" "$PATH" "$1"\n',{mode:0o700});
   if(fs.existsSync(current))fs.unlinkSync(current);fs.symlinkSync(target,current);
   const r=cp.spawnSync(wrapper,['dummy argument'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
   assert.equal(r.status,0,r.stderr);
   assert.deepEqual(r.stdout.trim().split('\n'),[version,fs.realpathSync(dir)+'/bin:/usr/bin:/bin','dummy argument']);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
