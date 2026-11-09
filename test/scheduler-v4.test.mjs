import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {MissionEngine,validateTaskResult} from '../mission-engine.mjs';
import {MissionStore,memoryQuery} from '../mission-store.mjs';

const value=()=>({
 summary:'Compare buyer response to two pilot offers before committing to a channel.',
 claims:[{kind:'estimate',text:'A short pilot can expose differences in buyer interest.',sourceId:'',quote:''}],
 artifacts:[],verdict:'complete',issues:[],
});
const task=(id,dependencies=[])=>({id,dependencies,kind:'analyze',focus:id,skills:[],status:'pending',attempts:0});
const binding={skills:[],options:{model:'fixture'}};
const run=(engine,id,signal=new AbortController().signal)=>engine.run(id,{owner:'fixture',signal});

async function fixture(t,tasks,options={}){
 const project=await realpath(await mkdtemp(join(tmpdir(),'boardroom-scheduler-')));
 const store=new MissionStore(project);
 t.after(async()=>{await store.close();await rm(project,{recursive:true,force:true});});
 const mission=await store.create({objective:'Compare pilot offers',domain:'strategy',context:{},owner:'fixture',...options});
 if(tasks)await store.mutate(mission.id,m=>{m.tasks=tasks;});
 return {store,id:mission.id};
}

test('a freed slot starts a ready dependent while an independent worker is still active',{timeout:4000},async t=>{
 const {store,id}=await fixture(t,[task('slow'),task('fast'),task('dependent',['fast'])]);
 const slow=Promise.withResolvers(),dependent=Promise.withResolvers();
 const entered=[];
 const engine=new MissionEngine({store,prepare:async()=>binding,execute:async(_m,worker)=>{
  entered.push(worker.id);
  if(worker.id==='slow')await slow.promise;
  if(worker.id==='dependent')dependent.resolve();
  return {value:value()};
 }});
 const pending=run(engine,id);
 try{
  await dependent.promise;
  assert.ok(entered.includes('slow'));
  const record=await store.read(id);
  assert.equal(record.tasks.find(x=>x.id==='slow').status,'running');
  assert.equal(record.tasks.find(x=>x.id==='fast').status,'complete');
 }finally{slow.resolve();}
 assert.equal((await pending).status,'review-ready');
 assert.equal(entered.filter(x=>x==='slow').length,1);
 assert.equal(entered.filter(x=>x==='fast').length,1);
 assert.equal(entered.filter(x=>x==='dependent').length,1);
});

test('mission deadline releases an uncooperative attempt and ignores its late rejection',{timeout:4000},async t=>{
 const {store,id}=await fixture(t,[task('stuck')]);
 const late=Promise.withResolvers();
 let workerSignal;
 const engine=new MissionEngine({store,deadlineMs:650,prepare:async()=>binding,execute:async(_m,_task,{signal})=>{
  workerSignal=signal;
  return late.promise;
 }});
 const result=await run(engine,id);
 assert.equal(result.status,'interrupted');
 assert.ok(workerSignal.aborted);
 const record=await store.read(id);
 assert.equal(record.lease,null);
 assert.equal(record.tasks[0].activeAttempt,null);
 assert.equal(record.tasks[0].status,'pending');
 assert.equal(record.usage.unknownAttempts,1);
 assert.equal(record.events.find(x=>x.type==='interrupted').reason,'deadline');
 late.reject(new Error('Provider rejected after deadline'));
 await setImmediate();
 assert.deepEqual((await store.read(id)).events,record.events);
});

test('owner cancellation releases an uncooperative attempt and ignores its late success',{timeout:4000},async t=>{
 const {store,id}=await fixture(t,[task('stuck')]);
 const entered=Promise.withResolvers(),late=Promise.withResolvers(),owner=new AbortController();
 const engine=new MissionEngine({store,prepare:async()=>binding,execute:async()=>{
  entered.resolve();
  return late.promise;
 }});
 const pending=run(engine,id,owner.signal);
 await entered.promise;
 owner.abort('Owner stopped');
 assert.equal((await pending).status,'interrupted');
 late.resolve({value:value(),usage:{inputTokens:50}});
 await setImmediate();
 const record=await store.read(id);
 assert.equal(record.tasks[0].status,'pending');
 assert.equal(record.tasks[0].result,undefined);
 assert.equal(record.usage.unknownAttempts,1);
 assert.deepEqual(await readdir(join(store.path(id),'artifacts')),[]);
});

test('attempt deadline fails the stuck task and releases its slot for independent work',{timeout:4000},async t=>{
 const {store,id}=await fixture(t,[task('stuck'),task('independent')]);
 await store.mutate(id,m=>{m.budget.concurrency=1;});
 const engine=new MissionEngine({store,attemptTimeoutMs:100,prepare:async()=>binding,execute:async(_m,worker)=>{
  if(worker.id==='stuck')return new Promise(()=>{});
  return {value:value()};
 }});
 const result=await run(engine,id);
 assert.equal(result.status,'incomplete');
 assert.equal(result.tasks.find(x=>x.id==='stuck').error,'Attempt deadline reached');
 assert.equal(result.tasks.find(x=>x.id==='independent').status,'complete');
 assert.equal(result.budget.calls,2);
});

test('steering while a pending worker is prepared cannot admit its old binding',{timeout:4000},async t=>{
 const {store,id}=await fixture(t,[task('worker')]);
 const preparing=Promise.withResolvers();
 let prepares=0;
 const executions=[];
 const engine=new MissionEngine({store,prepare:async m=>{
  if(m.revision===1&&++prepares===2){
   preparing.resolve();
   return new Promise(()=>{});
  }
  return binding;
 },execute:async(m,worker)=>{
  executions.push([m.revision,worker.instructions]);
  return {value:value()};
 }});
 const pending=run(engine,id);
 await preparing.promise;
 await store.steer(id,{message:'Use the new pilot scope',affected:['worker']});
 engine.interrupt(id);
 assert.equal((await pending).status,'review-ready');
 assert.deepEqual(executions,[[2,['Use the new pilot scope']]]);
 assert.equal((await store.read(id)).budget.calls,1);
});

test('a removed in-flight worker cannot commit, and every new route is preflighted',{timeout:4000},async t=>{
 const brief={outcomes:['Compare pilot offers'],constraints:[],acceptance:['Report the comparison and its limitations']};
 const declared=(id,dependencies=[],capabilityId='business-strategy')=>({id,capabilityId,dependencies,focus:id,outcomes:brief.outcomes});
 const oldPlan={brief,tasks:[declared('removed'),declared('old-review',['removed'],'independent-review')]};
 const {store,id}=await fixture(t,null,{plan:oldPlan});
 const entered=Promise.withResolvers(),late=Promise.withResolvers();
 const calls=[];
 const engine=new MissionEngine({store,prepare:async(m,worker)=>{
  calls.push('prepare '+m.revision+' '+worker.id);
  return binding;
 },execute:async(m,worker)=>{
  calls.push('execute '+m.revision+' '+worker.id);
  if(worker.id==='removed'){
   entered.resolve();
   return late.promise;
  }
  return {value:value()};
 }});
 const pending=run(engine,id);
 await entered.promise;
 await store.patchPlan(id,{
  expectedRevision:1,reason:'Replace the pilot work',plan:{brief,tasks:[declared('first'),declared('second',['first'],'independent-review')]},
 });
 engine.interrupt(id);
 assert.equal((await pending).status,'review-ready');
 late.resolve({value:value()});
 await setImmediate();
 const record=await store.read(id);
 assert.deepEqual(record.tasks.map(x=>x.id),['first','second']);
 assert.ok(record.events.some(x=>x.type==='stale-result-discarded'&&x.taskId==='removed'));
 assert.ok(calls.indexOf('prepare 2 second')<calls.indexOf('execute 2 first'));
 assert.ok(!(await readdir(join(store.path(id),'artifacts'))).some(name=>name.startsWith('removed-')));
});

test('a rejected structured result preserves observed usage and telemetry',async t=>{
 const {store,id}=await fixture(t,[task('worker')]);
 const usage={inputTokens:47,outputTokens:18},telemetry={modelRequests:2};
 const engine=new MissionEngine({store,prepare:async()=>binding,execute:async()=>{
  throw Object.assign(new Error('Complete requires a reviewable artifact or substantive claim'),{usage,telemetry});
 }});
 assert.equal((await run(engine,id)).status,'incomplete');
 const record=await store.read(id);
 assert.deepEqual(record.usage,{observed:usage,unknownAttempts:0});
 const settled=record.events.find(x=>x.type==='attempt-settled');
 assert.deepEqual(settled.usage,usage);
 assert.deepEqual(settled.telemetry,telemetry);
});

test('completed results are invalidated by consumed memory and declarative task changes',async t=>{
 const {store,id}=await fixture(t,[{...task('worker'),capabilityId:'analysis',outcomes:['report'],tools:['artifact_write']}]);
 let memory='first',executions=0;
 const engine=new MissionEngine({store,prepare:async()=>({...binding,memory:{digest:memory}}),execute:async()=>{
  executions++;
  return {value:value()};
 }});
 assert.equal((await run(engine,id)).status,'review-ready');
 await run(engine,id);
 assert.equal(executions,1);
 memory='revised';
 await run(engine,id);
 assert.equal(executions,2);
 await store.mutate(id,m=>{m.tasks[0].outcomes=['pilot measurements'];});
 await run(engine,id);
 assert.equal(executions,3);
});

test('newly adopted relevant memory replaces an old in-flight binding',async t=>{
 const {store,id}=await fixture(t,[task('worker')]);
 const entered=Promise.withResolvers(),late=Promise.withResolvers();
 const memorySeen=[];
 const engine=new MissionEngine({store,prepare:async(m,worker)=>({
  ...binding,memorySnapshot:await store.consumedMemory(memoryQuery(m,worker)),
 }),execute:async(m,_worker,{binding:prepared})=>{
  memorySeen.push(prepared.memorySnapshot.records.map(record=>record.text));
  if(m.revision===1){
   entered.resolve();
   return late.promise;
  }
  return {value:value()};
 }});
 const pending=run(engine,id);
 await entered.promise;
 const adopted=await store.recordDecision({
  entity:'pilot',key:'pilot offer',text:'Compare pilot offers for small retailers.',
  sourceEvent:{id:'user-pilot',sessionId:'fixture',text:'Compare pilot offers for small retailers.'},
 });
 assert.deepEqual(adopted.affectedMissions,[id]);
 engine.interrupt(id);
 assert.equal((await pending).status,'review-ready');
 late.resolve({value:value()});
 await setImmediate();
 assert.deepEqual(memorySeen,[[],[adopted.text]]);
 const record=await store.read(id);
 assert.equal(record.tasks[0].memoryDigest,(await store.consumedMemory(memoryQuery(record,record.tasks[0]))).digest);
 assert.equal(record.events.filter(event=>event.type==='task-completed').length,1);
});

test('a retry receives the verified artifact checkpoint from its interrupted predecessor',async t=>{
 const {store,id}=await fixture(t,[task('worker')]);
 const artifact=join(store.path(id),'artifacts','partial.md');
 let first=true;
 const engine=new MissionEngine({store,prepare:async()=>binding,execute:async(_m,worker,{attemptId,revision,checkpoint})=>{
  if(first){
   first=false;
   assert.equal(checkpoint,null);
   await writeFile(artifact,'Pilot criteria drafted');
   await store.saveCheckpoint(id,worker.id,{attemptId,revision,summary:'Pilot criteria drafted',artifacts:[artifact]});
   throw new Error('Provider disconnected');
  }
  assert.equal(checkpoint.summary,'Pilot criteria drafted');
  assert.equal(checkpoint.artifacts[0].path,artifact);
  return {value:value()};
 }});
 assert.equal((await run(engine,id)).status,'incomplete');
 assert.equal((await run(engine,id)).status,'review-ready');
});

test('structured results require a deliverable or a clear decision and facts cite root evidence',()=>{
 const empty={...value(),summary:'Done',claims:[]};
 assert.match(validateTaskResult(empty),/reviewable/);
 assert.match(validateTaskResult({...empty,verdict:'needs-input'}),/question or issue/);
 assert.equal(validateTaskResult({...empty,verdict:'needs-input',issues:['Which customer segment should the pilot target?']}),null);

 const quote='The pilot includes twelve companies.';
 const sources=new Map([['peer',{kind:'task',content:quote}],['company',{kind:'business',content:quote}]]);
 const fact=sourceId=>({...value(),claims:[{kind:'fact',text:quote,sourceId,quote}]});
 assert.match(validateTaskResult(fact('peer'),{sources}),/root evidence/);
 assert.equal(validateTaskResult(fact('company'),{sources}),null);
});
