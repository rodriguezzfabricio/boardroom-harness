import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {hash,VERSION} from './core.mjs';
import {atomic} from './storage.mjs';
import {affectedTasks,RECIPE_VERSION} from './recipes.mjs';
import {missionSummary} from './mission-store.mjs';

export const taskSchema={type:'object',additionalProperties:false,required:['summary','claims','artifacts','verdict','issues'],properties:{
 summary:{type:'string',description:'Concise summary, at most 4000 characters; store detailed work with artifact_write.'},
 claims:{type:'array',items:{type:'object',additionalProperties:false,required:['text','kind','sourceId','quote'],properties:{text:{type:'string'},kind:{type:'string',enum:['fact','estimate','question']},sourceId:{type:'string'},quote:{type:'string',description:'For a fact, an exact supporting passage from root evidence via evidence_read. Peer reports can guide review.'}}}},
 artifacts:{type:'array',items:{type:'object',additionalProperties:false,required:['path','description'],properties:{path:{type:'string'},description:{type:'string'}}}},
 verdict:{type:'string',enum:['complete','needs-input','changes-requested']},
 issues:{type:'array',items:{type:'string'}},
}};
export function validateTaskResult(value,{sources=new Map(),allowSummaryOnly=false}={}){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='artifacts,claims,issues,summary,verdict')return 'Return exactly summary, claims, artifacts, verdict, issues';
 if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>4000||JSON.stringify(value).length>16000)return 'Summary/result exceeds its budget';
 if(!['complete','needs-input','changes-requested'].includes(value.verdict))return 'Invalid verdict';
 if(!Array.isArray(value.claims)||value.claims.length>20||!Array.isArray(value.artifacts)||value.artifacts.length>12||!Array.isArray(value.issues)||value.issues.length>5)return 'Too many claims, artifacts, or issues';
 if(value.issues.some(x=>typeof x!=='string'||!x.trim()||x.length>1500))return 'Invalid issue';
 for(const c of value.claims){
  if(!c||typeof c.text!=='string'||!c.text.trim()||c.text.length>1500||!['fact','estimate','question'].includes(c.kind)||typeof c.sourceId!=='string'||typeof c.quote!=='string')return 'Invalid claim';
  if(c.kind==='fact'){
   const source=sources.get(c.sourceId);
   if(!source||typeof source.content!=='string')return 'Fact references unavailable evidence: '+c.sourceId;
   if(source.kind==='task'||c.sourceId.startsWith('task-'))return 'Fact requires root evidence rather than a peer task report: '+c.sourceId;
   if(c.quote.length<8||c.quote.length>1500||!source.content.includes(c.quote))return 'Fact quote is not present in its immutable evidence: '+c.sourceId;
  }
 }
 for(const a of value.artifacts)if(!a||typeof a.path!=='string'||!a.path||a.path.length>500||typeof a.description!=='string'||!a.description.trim()||a.description.length>1000)return 'Invalid artifact';
 if(value.verdict==='needs-input'&&!value.issues.length&&!value.claims.some(c=>c.kind==='question'))return 'Needs-input requires a concrete question or issue';
 if(value.verdict==='changes-requested'&&!value.issues.length)return 'Changes-requested requires a concrete issue';
 if(value.verdict==='complete'&&!value.artifacts.length&&!value.claims.some(c=>c.kind!=='question')){
  const substantiveSummary=allowSummaryOnly&&(value.summary.match(/[\p{L}\p{N}]/gu)?.length??0)>=24;
  if(!substantiveSummary)return 'Complete requires a reviewable artifact or substantive claim';
 }
 return null;
}
const keyFor=(m,t,binding)=>hash({
 version:VERSION,recipe:RECIPE_VERSION,project:m.project,objective:m.objective,domain:m.domain,mode:m.mode,
 context:m.contextHash,brief:m.brief??null,sourcePath:m.sourcePath??null,
 task:{
  id:t.id,kind:t.kind,focus:t.focus,skills:t.skills,research:t.research,difficulty:t.difficulty,
  generation:t.generation??1,instructions:t.instructions??[],
  capabilityId:t.capabilityId,capability:t.capability,outcomes:t.outcomes,tools:t.tools,writesWorkspace:t.writesWorkspace,
 },
 dependencies:t.dependencies.map(id=>({id,digest:m.tasks.find(d=>d.id===id)?.result?.digest})),
 binding,
});
const ownsRun=(m,token,revision)=>m.lease?.token===token&&m.status==='running'&&(revision===undefined||m.revision===revision);
const isReady=(m,t)=>t.status==='pending'&&t.dependencies.every(id=>m.tasks.find(d=>d.id===id)?.status==='complete');
const memoryMatches=(store,m,t,digest)=>digest===undefined||store.currentMemoryDigest(m,t)===digest;

function invalidateResult(task){
 task.previousResult=task.result??task.previousResult;
 delete task.result;
 delete task.executionKey;
 delete task.checkpoint;
 delete task.memoryDigest;
 delete task.error;
 task.status='pending';
 task.activeAttempt=null;
 task.generation=(task.generation??1)+1;
}

function untilAborted(signal,operation){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const aborted=()=>reject(signal.reason);
  signal.addEventListener('abort',aborted,{once:true});
  // Keep handlers on the operation after abort. The scheduler can release the
  // attempt even when the provider is slow to cancel or rejects later.
  Promise.resolve().then(()=>{
   signal.throwIfAborted();
   return operation();
  }).then(
   value=>{signal.removeEventListener('abort',aborted);resolve(value);},
   error=>{signal.removeEventListener('abort',aborted);reject(error);},
  );
 });
}

export class MissionEngine {
 constructor({store,prepare,execute,validateResult=async()=>true,deadlineMs=900000,attemptTimeoutMs=240000}){
  this.store=store;
  this.prepare=prepare;
  this.execute=execute;
  this.validateResult=validateResult;
  this.deadlineMs=deadlineMs;
  this.attemptTimeoutMs=attemptTimeoutMs;
  this.active=new Map();
 }
 interrupt(id){
  for(const controller of this.active.get(id)??[])controller.abort(new Error('Mission was steered or stopped'));
 }
 async run(id,{owner,signal,onProgress=()=>{}}){
  const {token}=await this.store.acquire(id,owner);
  const deadline=new AbortController();
  const deadlineTimer=setTimeout(()=>deadline.abort(new Error('Mission deadline reached')),this.deadlineMs);
  const runSignal=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  const controllers=new Set(),inflight=new Map();
  this.active.set(id,controllers);
  let preparedRevision,failure,finalRecord;
  try{
   while(!runSignal.aborted){
    const m=await this.store.read(id);
    if(!ownsRun(m,token)||runSignal.aborted)break;

    for(const [taskId,attempt] of inflight){
     const task=m.tasks.find(t=>t.id===taskId);
     if(!task||m.revision!==attempt.revision||task.generation!==attempt.generation){
      attempt.controller.abort(new Error('Task definition changed'));
     }
    }
    if(preparedRevision!==m.revision){
     const controller=new AbortController();
     controllers.add(controller);
     const preflightSignal=AbortSignal.any([runSignal,controller.signal]);
     try{
      const current=await this.preflight(m,token,preflightSignal,preparedRevision===undefined);
      if(current)preparedRevision=m.revision;
     }catch(error){
      if(!preflightSignal.aborted)throw error;
     }finally{controllers.delete(controller);}
     continue;
    }

    const slots=Math.max(0,m.budget.concurrency-inflight.size);
    const ready=m.tasks.filter(t=>!inflight.has(t.id)&&isReady(m,t)).slice(0,slots);
    if(ready.length){
     onProgress(m.tasks.filter(t=>t.status==='complete').length+'/'+m.tasks.length+' tasks complete — '+ready.map(t=>t.id).join(', '));
     for(const task of ready){
      const controller=new AbortController();
      controllers.add(controller);
      const attemptSignal=AbortSignal.any([runSignal,controller.signal]);
      const settled=this.runTask(m,task,token,attemptSignal).then(
       ()=>({taskId:task.id}),error=>({taskId:task.id,error}),
      ).finally(()=>controllers.delete(controller));
      inflight.set(task.id,{settled,controller,revision:m.revision,generation:task.generation});
     }
    }
    if(inflight.size){
     const settled=await Promise.race([...inflight.values()].map(attempt=>attempt.settled));
     inflight.delete(settled.taskId);
     if('error' in settled)throw settled.error;
     continue;
    }

    const finished=await this.store.mutate(id,current=>{
     if(!ownsRun(current,token,m.revision)||runSignal.aborted)return false;
     if(current.tasks.every(t=>t.status==='complete')){
      current.status='review-ready';
      this.store.event(current,'review-ready',{revision:current.revision});
     }else if(!current.tasks.some(t=>isReady(current,t))){
      current.status='incomplete';
      this.store.event(current,'blocked',{reason:'Failed task or unresolved dependency'});
     }else return false;
     return true;
    });
    if(finished)break;
   }
  }catch(error){failure=error instanceof Error?error:new Error(String(error));}
  finally{
   clearTimeout(deadlineTimer);
   this.interrupt(id);
   await Promise.all([...inflight.values()].map(attempt=>attempt.settled));
   this.active.delete(id);
   try{
    if(runSignal.aborted||failure)await this.store.mutate(id,m=>{
     if(m.lease?.token!==token)return;
     for(const task of m.tasks)if(task.status==='running'){
      task.interruptedAttempt=task.activeAttempt;
      task.activeAttempt=null;
      task.status='pending';
     }
     if(m.status!=='running')return;
     if(runSignal.aborted){
      m.status='interrupted';
      this.store.event(m,'interrupted',{reason:deadline.signal.aborted?'deadline':'owner cancellation'});
     }else{
      m.status='incomplete';
      this.store.event(m,'execution-error',{message:failure.message});
     }
    });
   }finally{finalRecord=await this.store.release(id,token);}
  }
  if(failure&&!runSignal.aborted)throw failure;
  return missionSummary(finalRecord??await this.store.read(id));
 }
 async preflight(snapshot,token,signal,initial){
  const invalid=await untilAborted(signal,async()=>{
   const invalid=[];
   for(const task of snapshot.tasks){
    signal.throwIfAborted();
    const binding=await this.prepare(snapshot,task,signal);
    signal.throwIfAborted();
    if(task.status==='complete'&&((initial&&task.research)||task.executionKey!==keyFor(snapshot,task,binding)||!await this.validateResult(snapshot,task)))invalid.push(task.id);
   }
   return invalid;
  });
  if(!invalid.length)return !signal.aborted;
  return this.store.mutate(snapshot.id,m=>{
   if(signal.aborted||!ownsRun(m,token,snapshot.revision))return false;
   const changed=affectedTasks(m.tasks,invalid);
   for(const task of m.tasks)if(changed.has(task.id))invalidateResult(task);
   this.store.event(m,'dependencies-invalidated',{tasks:[...changed]});
   return true;
  });
 }
 async runTask(snapshot,task,token,signal){
  const {id,revision}=snapshot,taskId=task.id;
  let binding;
  try{binding=await untilAborted(signal,()=>this.prepare(snapshot,task,signal));}
  catch(error){
   if(signal.aborted||!ownsRun(await this.store.read(id),token,revision))return;
   throw error;
  }
  const key=keyFor(snapshot,task,binding),attemptId=randomUUID(),memoryDigest=binding.memorySnapshot?.digest;
  const admitted=await this.store.mutate(id,m=>{
   const t=m.tasks.find(t=>t.id===taskId);
   if(signal.aborted||!t||!ownsRun(m,token,revision)||!isReady(m,t)||keyFor(m,t,binding)!==key||!memoryMatches(this.store,m,t,memoryDigest))return false;
   if(m.budget.calls>=m.budget.maxCalls||t.attempts>=m.budget.maxAttemptsPerTask){
    t.status='failed';t.error='Attempt budget exhausted';return false;
   }
   t.status='running';
   t.attempts++;
   t.activeAttempt=attemptId;
   t.memoryDigest=memoryDigest;
   m.budget.calls++;
   this.store.event(m,'task-started',{taskId,attemptId,revision});
   return true;
  });
  if(!admitted)return;

  const timeout=new AbortController();
  const timer=setTimeout(()=>timeout.abort(new Error('Attempt deadline reached')),this.attemptTimeoutMs);
  const childSignal=AbortSignal.any([signal,timeout.signal]);
  const started=Date.now();
  let outcome,failure,errorMessage;
  try{
   outcome=await untilAborted(childSignal,async()=>{
    const checkpoint=await this.store.readCheckpoint?.(id,taskId)??null;
    childSignal.throwIfAborted();
    return this.execute(snapshot,task,{signal:childSignal,attemptId,revision,binding,checkpoint});
   });
  }catch(error){failure=error;errorMessage=error?.message||String(error);}
  finally{clearTimeout(timer);}

  await this.store.mutate(id,async m=>{
   const t=m.tasks.find(t=>t.id===taskId);
   const usage=outcome?.usage??failure?.usage;
   const telemetry=outcome?.telemetry??failure?.telemetry;
   const error=errorMessage??null;
   const observed=Object.entries(usage??{}).filter(([,value])=>Number.isFinite(value)&&value>=0);
   if(observed.length){
    for(const [counter,value] of observed)m.usage.observed[counter]=(m.usage.observed[counter]??0)+value;
   }else m.usage.unknownAttempts++;
   this.store.event(m,'attempt-settled',{
    taskId,attemptId,revision,elapsedMs:Date.now()-started,error:error??(signal.aborted?signal.reason?.message??'Attempt interrupted':null),
    usage:usage??null,route:binding.options,skills:binding.skills,telemetry:telemetry??null,
   });
   const discard=()=>{
    if(t?.activeAttempt===attemptId){
     if(t.status==='running')t.status='pending';
     t.activeAttempt=null;
    }
    this.store.event(m,'stale-result-discarded',{taskId,attemptId,revision});
   };
   if(signal.aborted||!ownsRun(m,token,revision)||t?.activeAttempt!==attemptId||t.status!=='running'||keyFor(m,t,binding)!==key||!memoryMatches(this.store,m,t,memoryDigest)){
    discard();
    return;
   }
   if(error){
    t.activeAttempt=null;
    t.status='failed';
    t.error=error;
    return;
   }
   const value=outcome.value,path=join(this.store.path(id),'artifacts',`${taskId}-r${revision}-${attemptId}.json`);
   await atomic(path,{taskId,revision,attemptId,value,verification:outcome.verification??null});
   if(signal.aborted){
    await unlink(path);
    discard();
    return;
   }
   t.activeAttempt=null;
   t.result={artifactPath:path,digest:hash(value),summary:value.summary,claims:value.claims,artifacts:value.artifacts,verdict:value.verdict,issues:value.issues,verification:outcome.verification??null};
   t.executionKey=key;
   delete t.error;
   if(value.verdict==='needs-input'){t.status='needs-input';m.status='needs-input';return;}
   if(value.verdict==='changes-requested'){
    if(t.kind==='review'&&(t.repairCount??0)<1&&t.dependencies.length){
     t.repairCount=(t.repairCount??0)+1;
     const affected=affectedTasks(m.tasks,t.dependencies);
     for(const item of m.tasks)if(affected.has(item.id)){
      invalidateResult(item);
      item.instructions=[...(item.instructions??[]),'Review correction: '+value.issues.join('; ')];
     }
     this.store.event(m,'review-correction',{taskId,affected:[...affected]});
    }else{t.status='needs-input';m.status='needs-input';}
    return;
   }
   t.status='complete';
   this.store.event(m,'task-completed',{taskId,attemptId,revision});
  });
 }
}
