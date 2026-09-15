const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-write-routing-'));
const delegate=path.join(dir,'delegate');fs.writeFileSync(delegate,'#!/bin/sh\nprintf DELEGATED\n',{mode:0o700});
function build(version){
  const exe=path.join(dir,version);
  const r=spawnSync('clang',['-Wall','-Wextra','-Werror','-DBB_ENABLE_WRITE_GUARD=1',
    `-DBB_TEST_CALLER_PATH="/Users/andrew/.local/share/claude/versions/${version}"`,
    `-DBB_SECURITY_EXECUTABLE="${delegate}"`,'-DBB_WRITE_GUARD="/usr/bin/true"','-DBB_AUTH_VAULT="/usr/bin/true"',
    `-DBB_AUTH_LOG_DIRECTORY="${dir}"`,path.join(__dirname,'security-guard.c'),'-o',exe],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return exe;
}
const known=build('2.1.270'),unknown=build('2.1.999');
const args=['-a','andrew','-s','Claude Code-credentials'];
test('compiled gate filters verified caller writes and leaves unknown versions native',()=>{
  for(const cmd of [['-i'],['add-generic-password',...args,'-X','00']]){
    assert.equal(spawnSync(known,cmd,{input:'',encoding:'utf8'}).stdout,'');
    assert.equal(spawnSync(unknown,cmd,{input:'',encoding:'utf8'}).stdout,'DELEGATED');
  }
});
test('compiled gate leaves logout and unrelated items native',()=>{
  for(const cmd of [['delete-generic-password',...args],['add-generic-password','-a','other','-s','other']])
    assert.equal(spawnSync(known,cmd,{encoding:'utf8'}).stdout,'DELEGATED');
});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
