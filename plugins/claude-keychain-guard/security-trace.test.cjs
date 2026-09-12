const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-auth-trace-'));
const exe=path.join(dir,'security');
const fixture=path.join(dir,'security-fixture.sh');
fs.copyFileSync(path.join(__dirname,'security-fixture.sh'),fixture);
fs.chmodSync(fixture,0o700);
const build=spawnSync('clang',['-Wall','-Wextra','-Werror',`-DBB_SECURITY_EXECUTABLE="${fixture}"`,'-DBB_ENABLE_READ_SELECTOR=1','-DBB_READ_SELECTOR="/usr/bin/true"','-DBB_AUTH_VAULT="/usr/bin/true"',`-DBB_AUTH_LOG_DIRECTORY="${dir}"`,path.join(__dirname,'security-guard.c'),'-o',exe],{encoding:'utf8'});
assert.equal(build.status,0,build.stderr);
const args=['find-generic-password','-a','andrew','-s','Claude Code-credentials'];
const log=()=>fs.readFileSync(path.join(dir,'security-operations.jsonl'),'utf8');
test('native delegate preserves transport output but records only metadata',()=>{
  const result=spawnSync(exe,args,{encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(result.stdout,'DUMMY-PRIVATE-OUTPUT\n');
  assert.equal(result.stderr,'DUMMY-PRIVATE-ERROR\n');
  assert.ok(!log().includes('DUMMY'));
  const records=log().trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).operation,'read');
  assert.equal(records.at(-1).originalExit,0);
  assert.equal(records.at(-1).phase,'finish');
  assert.equal(fs.statSync(path.join(dir,'security-operations.jsonl')).mode&0o777,0o600);
});
test('denied read records original exit and mapping without credential contents',()=>{
  const result=spawnSync(exe,args,{env:{...process.env,DUMMY_EXIT:'36'}});
  assert.equal(result.status,1);
  const record=JSON.parse(log().trim().split('\n').at(-1));
  assert.equal(record.originalExit,36); assert.equal(record.returnedExit,1);
});
test('failed interactive write is visible and its exit is not rewritten',()=>{
  const result=spawnSync(exe,['-i'],{env:{...process.env,DUMMY_EXIT:'36'},input:'DUMMY-CREDENTIAL-STDIN'});
  assert.equal(result.status,36);
  const record=log().trim().split('\n').map(JSON.parse).filter(x=>x.operation==='interactive-write').at(-1);
  assert.equal(record.operation,'interactive-write');
  assert.equal(record.originalExit,36); assert.equal(record.returnedExit,36);
  assert.ok(!log().includes('DUMMY'));
});
test('write commands checkpoint encrypted history before and after the delegate',()=>{
  const before=log().trim().split('\n').length;
  const result=spawnSync(exe,['-i'],{input:'DUMMY-PRIVATE',encoding:'utf8'});
  assert.equal(result.status,0);
  const records=log().trim().split('\n').slice(before).map(JSON.parse);
  assert.equal(records[0].operation,'backup');assert.equal(records[0].phase,'before-write');
  assert.equal(records.at(-1).operation,'backup');assert.equal(records.at(-1).phase,'after-write');
  assert.ok(records.filter(r=>r.operation==='backup').every(r=>r.originalExit===0));
  assert.ok(!JSON.stringify(records).includes('DUMMY'));
});
test('unrelated commands pass through without trace records',()=>{
  const before=log();
  assert.equal(spawnSync(exe,['find-generic-password','-s','other'],{env:{...process.env,DUMMY_EXIT:'36'}}).status,36);
  assert.equal(log(),before);
});
test('canary opt-in routes only exact secret reads to the selector executable',()=>{
  const env={...process.env,BB_CLAUDE_AUTH_READ_SELECTION:'verified'};
  const selected=spawnSync(exe,[...args,'-w'],{encoding:'utf8',env});
  assert.equal(selected.status,0);assert.equal(selected.stdout,'');
  // Metadata reads, other accounts and every write must still use security.
  for(const command of [args,['find-generic-password','-a','other','-s','Claude Code-credentials','-w'],['-i'],['delete-generic-password','-a','andrew','-s','Claude Code-credentials']]) {
    const result=spawnSync(exe,command,{encoding:'utf8',env});
    assert.equal(result.stdout,'DUMMY-PRIVATE-OUTPUT\n');
  }
  assert.equal(spawnSync(exe,[...args,'-w'],{encoding:'utf8',env:{...env,BB_CLAUDE_AUTH_READ_SELECTION:'off'}}).stdout,'DUMMY-PRIVATE-OUTPUT\n');
});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
