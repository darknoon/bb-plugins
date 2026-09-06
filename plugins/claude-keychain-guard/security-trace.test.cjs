const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-auth-trace-'));
const exe=path.join(dir,'security');
const fixture=path.join(__dirname,'security-fixture.sh');
fs.chmodSync(fixture,0o700);
const build=spawnSync('clang',['-Wall','-Wextra','-Werror',`-DBB_SECURITY_EXECUTABLE="${fixture}"`,`-DBB_AUTH_LOG_DIRECTORY="${dir}"`,path.join(__dirname,'security-guard.c'),'-o',exe],{encoding:'utf8'});
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
  const record=JSON.parse(log().trim().split('\n').at(-1));
  assert.equal(record.operation,'interactive-write');
  assert.equal(record.originalExit,36); assert.equal(record.returnedExit,36);
  assert.ok(!log().includes('DUMMY'));
});
test('unrelated commands pass through without trace records',()=>{
  const before=log();
  assert.equal(spawnSync(exe,['find-generic-password','-s','other'],{env:{...process.env,DUMMY_EXIT:'36'}}).status,36);
  assert.equal(log(),before);
});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
