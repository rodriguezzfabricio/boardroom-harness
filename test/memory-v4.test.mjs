import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {VERSION} from '../core.mjs';
import {MissionStore} from '../mission-store.mjs';
import {adoptDecision} from '../mission-memory.mjs';
import {tasksFor} from '../recipes.mjs';

const context={'COMPANY.md':'Company overview.','STATE.md':'stage: 00-brief','DECISIONS.md':'Historical decision remains intact.'};
const brief={outcomes:['Recommend a pilot'],constraints:['Use local files'],acceptance:['Verify assumptions']};
const task=(id,capabilityId,dependencies=[],focus=id)=>({id,capabilityId,dependencies,focus,outcomes:brief.outcomes});
const makePlan=()=>({brief,tasks:[task('options','business-strategy'),task('financial','financial-analysis'),task('review','independent-review',['options','financial'])]});
const create=(store,options={})=>store.create({objective:'Compare pilot options',domain:'strategy',context,owner:'initial-owner',...options});
const adopt=(store,options={})=>store.recordDecision({entity:'pricing',key:'pilot rate',text:'Set pilot rates at $100.',sourceEvent:{id:'user-1',sessionId:'chat-1',text:'Yes, set pilot rates at $100.'},...options});

async function fixture(){
 const project=await realpath(await mkdtemp(join(tmpdir(),'boardroom-v4-memory-')));
 const base=join(project,'.agents/skills/boardroom');
 await mkdir(base,{recursive:true});
 for(const [name,text] of Object.entries(context))await writeFile(join(base,name),text);
 return {project,base,store:new MissionStore(project)};
}

test('v3 database migration preserves lessons and historical acceptance provenance',async()=>{
 const {store,project,base}=await fixture(),id=randomUUID(),at='2026-11-01T10:00:00.000Z';
 const legacyDir=join(store.root,'missions'),legacyMission=join(legacyDir,id),workspace=join(legacyMission,'workspace');
 const legacyArtifact=join(legacyMission,'artifacts','report.md'),targetArtifact=join(store.path(id),'artifacts','report.md');
 const old={id,project,version:'3.0.0',status:'accepted',objective:'Compare pilot options',mode:'advice',domain:'strategy',context,revision:1,
  tasks:tasksFor('strategy'),budget:{maxCalls:12},events:[],decisions:[{decision:'accept',note:'The report is ready',revision:1,at}]};
 old.tasks[0].result={artifactPath:legacyArtifact,artifacts:[{path:join(workspace,'index.html')}]};
 await mkdir(workspace,{recursive:true});await mkdir(join(legacyMission,'artifacts'));
 await writeFile(join(workspace,'index.html'),'<h1>Legacy draft</h1>');
 await writeFile(legacyArtifact,'Legacy report');
 await writeFile(join(legacyMission,'mission.json'),JSON.stringify(old));
 // An earlier interrupted migration copied this artifact before its DB transaction committed.
 await mkdir(join(store.path(id),'artifacts'),{recursive:true});await writeFile(targetArtifact,'Legacy report');
 const db=new DatabaseSync(join(legacyDir,'missions.sqlite'));
 try{
  db.exec('CREATE TABLE missions(id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE memory(id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL);');
  db.prepare('INSERT INTO missions VALUES(?,?)').run(id,JSON.stringify(old));
  const add=db.prepare('INSERT INTO memory VALUES(?,?,?,?,?,?)');
  add.run(id+'-r1','decision','Pilot report accepted',id,'validated',at);
  add.run('lesson-1','lesson','Pilot checklist reviewed',id,'validated',at);
  add.run('lesson-2','lesson','Pilot checklist draft',id,'proposed',at);
 }finally{db.close();}
 try{
  const mission=await store.read(id);
  assert.equal(mission.version,VERSION);assert.equal(mission.planRevision,1);assert.equal(mission.brief,null);
  assert.equal(mission.tasks[0].result.artifactPath,targetArtifact);
  assert.equal(mission.tasks[0].result.artifacts[0].path,join(store.path(id),'workspace','index.html'));
  assert.equal(await readFile(targetArtifact,'utf8'),'Legacy report');
  await writeFile(join(store.path(id),'workspace','index.html'),'<h1>V4 draft</h1>');
  assert.equal(await readFile(join(workspace,'index.html'),'utf8'),'<h1>Legacy draft</h1>');
  assert.deepEqual((await store.memory('pilot')).map(record=>record.id),['lesson-1']);
  const history=await store.memory('pilot',{history:true});
  assert.equal(history.length,3);
  const acceptance=history.find(record=>record.kind==='artifact-acceptance');
  assert.deepEqual(acceptance.sourceEvent,{type:'legacy-artifact-acceptance',missionId:id,text:'The report is ready',at});
  assert.equal(acceptance.revision,1);assert.equal(acceptance.entity,'project');
  await store.mutate(id,record=>{record.note='v4-only export';});
  assert.equal(JSON.parse(await readFile(join(store.path(id),'mission-v4.json'),'utf8')).version,VERSION);
  assert.deepEqual(JSON.parse(await readFile(join(legacyMission,'mission.json'),'utf8')),old);
  for(const [name,text] of Object.entries(context))assert.equal(await readFile(join(base,name),'utf8'),text);
 }finally{await store.close();}
 const unchanged=new DatabaseSync(join(legacyDir,'missions.sqlite'),{readOnly:true});
 try{
  assert.equal(unchanged.prepare("SELECT kind FROM memory WHERE id=?").get(id+'-r1').kind,'decision');
  assert.deepEqual(JSON.parse(unchanged.prepare('SELECT record FROM missions WHERE id=?').get(id).record),old);
 }finally{unchanged.close();}
 const reopened=new MissionStore(project);
 try{
  assert.equal((await reopened.memory('pilot',{history:true})).length,3);
  assert.equal(await readFile(join(reopened.path(id),'workspace','index.html'),'utf8'),'<h1>V4 draft</h1>');
 }
 finally{await reopened.close();}
});

test('explicit adoption supersedes current scoped decisions and fingerprints consumed records',async()=>{
 const {store}=await fixture();
 try{
  const first=await adopt(store);
  const unchanged=await store.consumedMemory('pilot',{entity:'pricing'});
  assert.equal(unchanged.digest,(await store.consumedMemory('rates rates',{entity:'pricing'})).digest);
  await assert.rejects(adopt(store,{supersedes:'incorrect'}),/not the current decision/);
  const next=await adopt(store,{entity:' PRICING ',text:'Set pilot rates at $125.',supersedes:first.id,sourceEvent:{eventId:4,action:'adopt',targetId:'pilot rate',text:'Set pilot rates at $125.'}});
  assert.equal(next.revision,2);assert.equal(next.supersedes,first.id);assert.equal(next.sourceEvent.eventId,4);assert.equal(next.sourceEvent.targetId,'pilot rate');
  const current=await store.consumedMemory('pilot',{entity:'pricing'});
  assert.deepEqual(current.records.map(record=>record.id),[next.id]);assert.notEqual(current.digest,unchanged.digest);
  const history=await store.memory('pilot',{entity:'pricing',key:'pilot rate',history:true});
  const previous=history.find(record=>record.id===first.id);
  assert.equal(previous.status,'superseded');assert.equal(previous.supersededBy,next.id);
  await adopt(store,{entity:'sales',text:'Sales owns its pilot pricing.'});
  assert.equal((await store.consumedMemory('pilot',{entity:'pricing'})).digest,current.digest);
  await assert.rejects(adopt(store,{sourceEvent:undefined}),/source user event/);
 }finally{await store.close();}
});

test('active constraints survive an unrelated query and are separate from artifact acceptance',async()=>{
 const {store}=await fixture();
 try{
  const m=await create(store);
  await store.mutate(m.id,record=>{record.status='review-ready';});
  const sourceEvent={text:'Accept the pilot report',eventId:6,revision:1,action:'accept',targetId:m.id,resultDigest:'a'.repeat(64)};
  await assert.rejects(store.decide(m.id,{decision:'accept',note:sourceEvent.text,sourceEvent:{...sourceEvent,revision:2}}),/does not match/);
  await assert.rejects(store.decide(m.id,{decision:'accept',note:sourceEvent.text,sourceEvent,verifyArtifacts:async()=>false}),/artifacts changed/);
  assert.equal((await store.read(m.id)).status,'review-ready');
  const accepted=await store.decide(m.id,{decision:'accept',note:sourceEvent.text,sourceEvent,verifyArtifacts:async record=>record.id===m.id});
  assert.equal(accepted.decisions[0].sourceEvent.eventId,6);
  assert.equal(accepted.decisions[0].sourceEvent.resultDigest,sourceEvent.resultDigest);
  assert.deepEqual(await store.memory('pilot',{history:true}),[]);
  const note=await store.remember({sourceMission:m.id,text:'Check pilot contract renewal dates.'});
  assert.equal((await store.memory('pilot',{history:true}))[0].status,'proposed');
  assert.deepEqual(await store.memory('pilot'),[]);
  await store.validateMemory(note.id,'validate',{sourceEvent:{text:'Validate this lesson.'}});
  assert.equal((await store.memory('pilot'))[0].sourceEvent.type,'user-lesson-validate');
  await store.validateMemory(note.id,'reject',{sourceEvent:{text:'Reject this lesson.'}});
  assert.equal((await store.memory('pilot',{history:true}))[0].status,'rejected');
  const global=await adopt(store,{kind:'constraint',entity:'project',key:'promotion',text:'Publishing requires approval.'});
  const local=await adopt(store,{kind:'constraint',entity:'pricing',key:'deposits',text:'Protect customer deposits.'});
  await adopt(store,{kind:'constraint',entity:'sales',key:'recordings',text:'Preserve call recordings.'});
  const active=await store.memory('blueberries',{entity:'pricing',limit:1});
  assert.deepEqual(new Set(active.map(record=>record.id)),new Set([global.id,local.id]));
 }finally{await store.close();}
});

test('request deduplication and explicit selection survive a new owner and store',async()=>{
 const {store,project}=await fixture();
 const concurrent=new MissionStore(project);
 let first;
 try{
  const created=await Promise.all([create(store,{requestId:'pilot-start',sessionId:'chat-1'}),create(concurrent,{requestId:'pilot-start',sessionId:'chat-1-retry'})]);
  first=created[0];assert.equal(created[1].id,first.id);
 }finally{await concurrent.close();await store.close();}
 const reopened=new MissionStore(project);
 try{
  const retry=await create(reopened,{requestId:'pilot-start',owner:'new-owner',sessionId:'chat-2'});
  assert.equal(retry.id,first.id);assert.equal(retry.reusedRequest,true);
  assert.equal((await reopened.read(first.id)).reusedRequest,undefined);
  assert.equal((await reopened.activeMission('chat-2',{fallback:false})).id,first.id);
  await assert.rejects(create(reopened,{requestId:'pilot-start',maxCalls:11}),/different work/);
  const second=await create(reopened,{sessionId:'chat-3'});
  assert.equal(await reopened.activeMission('unknown'),null);
  assert.equal(await reopened.latest(),null);
  assert.equal((await reopened.activeMission('chat-3')).id,second.id);
  assert.equal((await reopened.resolveMission({sessionId:'chat-1',missionId:second.id})).id,second.id);
  assert.equal((await reopened.activeMission('chat-1')).id,first.id);
  await reopened.selectMission('chat-1',second.id);
  assert.equal((await reopened.activeMission('chat-1')).id,second.id);
  await reopened.pause(second.id,true);
  assert.equal((await reopened.latest()).id,first.id);
  assert.equal((await reopened.activeMission('chat-1')).id,second.id);
 }finally{await reopened.close();}
});

test('plan patches preserve unaffected results and invalidate changed tasks and their descendants',async()=>{
 const {store}=await fixture();
 try{
  const plan=makePlan(),m=await create(store,{plan,requestId:'planned-start'});
  assert.deepEqual(m.brief,brief);assert.equal(m.planRevision,1);
  await store.mutate(m.id,record=>{
   record.status='review-ready';
   for(const t of record.tasks){t.status='complete';t.result={digest:t.id};t.executionKey=t.id;t.attempts=1;}
  });
  const changed=makePlan();changed.tasks[0].focus='Compare two smaller pilots';
  const patched=await store.patchPlan(m.id,{expectedRevision:1,plan:changed,reason:'User reduced pilot scope'});
  assert.equal(patched.planRevision,2);assert.equal(patched.revision,2);assert.equal(patched.status,'ready');
  assert.deepEqual(patched.tasks.map(t=>[t.id,t.status,t.result?.digest,t.previousResult?.digest]),[
   ['options','pending',undefined,'options'],['financial','complete','financial',undefined],['review','pending',undefined,'review'],
  ]);
  assert.equal((await create(store,{plan,requestId:'planned-start'})).planRevision,2);
  await assert.rejects(store.patchPlan(m.id,{expectedRevision:1,plan:changed,reason:'Stale editor'}),/stale/);
  const broken=makePlan();broken.tasks[0].dependencies=['review'];
  await assert.rejects(store.patchPlan(m.id,{expectedRevision:2,plan:broken,reason:'Cyclic graph'}),/cycle/);
  await store.steer(m.id,{message:'Use only US pipeline records',affected:['options']});
  await assert.rejects(store.patchPlan(m.id,{expectedRevision:2,plan:changed,reason:'Before correction'}),/stale/);
  const afterSteer=await store.patchPlan(m.id,{expectedRevision:3,plan,reason:'Recheck options'});
  assert.deepEqual(afterSteer.tasks[0].instructions,['Use only US pipeline records']);
  await store.pause(m.id,true);
  await assert.rejects(store.patchPlan(m.id,{expectedRevision:4,plan:changed,reason:'Closed editor'}),/Closed/);
  assert.deepEqual((await create(store,{brief})).brief,brief);
 }finally{await store.close();}
});

test('adoption and lesson validation invalidate consumed memory and affected descendants atomically',async()=>{
 const {store}=await fixture();
 try{
  const closed=await create(store);
  await store.mutate(closed.id,record=>{record.status='review-ready';});
  await store.decide(closed.id,{decision:'accept',note:'Accept report'});
  const lesson=await store.remember({sourceMission:closed.id,text:'Track cucumber benchmarks quarterly.'});
  const plan=makePlan();plan.tasks[0].focus='Check cucumber benchmarks';
  const m=await create(store,{plan});
  const reviewed=()=>store.mutate(m.id,record=>{
   record.status='review-ready';
   for(const task of record.tasks){task.status='complete';task.result={digest:task.id};task.memoryDigest=store.currentMemoryDigest(record,task);}
  });
  await reviewed();
  const decision=await adopt(store,{entity:'operations',key:'cucumber',text:'Use the cucumber benchmark.'});
  assert.deepEqual(decision.affectedMissions,[m.id]);
  const afterAdoption=await store.read(m.id);
  assert.equal(afterAdoption.revision,2);assert.equal(afterAdoption.status,'ready');
  assert.deepEqual(afterAdoption.tasks.map(task=>task.status),['pending','complete','pending']);
  assert.equal(afterAdoption.tasks[0].memoryDigest,undefined);
  await reviewed();
  const validated=await store.validateMemory(lesson.id,'validate',{sourceEvent:{text:'Validate this lesson.'}});
  assert.deepEqual(validated.affectedMissions,[m.id]);
  assert.equal((await store.read(m.id)).revision,3);
  assert.equal((await store.read(closed.id)).status,'accepted');
  await reviewed();
  const rejected=await store.validateMemory(lesson.id,'reject',{sourceEvent:{text:'Reject this lesson.'}});
  assert.deepEqual(rejected.affectedMissions,[m.id]);
  assert.equal((await store.read(m.id)).revision,4);
  await reviewed();
  adoptDecision(store.db,{entity:'operations',key:'cucumber',text:'Change the cucumber benchmark.',sourceEvent:{text:'Adopt the new benchmark.'}});
  await assert.rejects(store.decide(m.id,{decision:'accept',note:'Accept report'}),/memory changed/);
 }finally{await store.close();}
});

test('empty explicit correction leaves mission revisions and task state untouched',async()=>{
 const {store}=await fixture();
 try{
  const m=await create(store);
  await assert.rejects(store.steer(m.id,{message:'Record this constraint',affected:[]}),/at least one task/);
  assert.deepEqual(await store.read(m.id),m);
 }finally{await store.close();}
});

test('checkpoint recovery verifies real artifact bytes and rejects stale attempts or escapes',async()=>{
 const {store,project}=await fixture();
 let m,path,checkpoint;
 try{
  m=await create(store);
  await store.acquire(m.id,'first-process');
  await store.mutate(m.id,record=>{record.tasks[0].status='running';record.tasks[0].activeAttempt='attempt-1';});
  path=join(store.path(m.id),'artifacts','notes.txt');await writeFile(path,'Partial pilot notes.');
  const payload={attemptId:'attempt-1',revision:1,summary:'Draft notes saved',artifacts:['notes.txt']};
  await assert.rejects(store.saveCheckpoint(m.id,'options',{...payload,artifacts:[]}),/1–8 artifact/);
  await assert.rejects(store.saveCheckpoint(m.id,'options',{...payload,artifacts:['missing.txt']}),{code:'ENOENT'});
  await assert.rejects(store.saveCheckpoint(m.id,'options',{...payload,artifacts:['../mission.json']}),/escapes/);
  await symlink(path,join(store.path(m.id),'artifacts','linked.txt'));
  await assert.rejects(store.saveCheckpoint(m.id,'options',{...payload,artifacts:['linked.txt']}),/symlink/);
  checkpoint=await store.saveCheckpoint(m.id,'options',payload);
  assert.equal(checkpoint.artifacts[0].path,path);
  await store.mutate(m.id,record=>{record.lease.pid=2147483647;});
 }finally{await store.close();}
 const reopened=new MissionStore(project);
 try{
  await reopened.acquire(m.id,'restarted-process');
  assert.deepEqual(await reopened.readCheckpoint(m.id,'options'),checkpoint);
  assert.equal(await reopened.readCheckpoint(m.id,'nonexistent-task'),null);
  await assert.rejects(reopened.saveCheckpoint(m.id,'options',{attemptId:'attempt-1',revision:1,summary:'Stale',artifacts:[path]}),/no longer current/);
  await writeFile(path,'Changed notes.');
  assert.equal(await reopened.readCheckpoint(m.id,'options'),null);
  await writeFile(path,'Partial pilot notes.');
  await reopened.steer(m.id,{message:'Switch the pilot focus',affected:['options']});
  assert.equal(await reopened.readCheckpoint(m.id,'options'),null);
 }finally{await reopened.close();}
});
