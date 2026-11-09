import {readFile,lstat,readdir,realpath,writeFile,rename,unlink,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,localDirectory} from './storage.mjs';
import {hash,VERSION} from './core.mjs';
import {RECIPE_VERSION,tasksFor,affectedTasks} from './recipes.mjs';
import {compilePlan,normalizeBrief} from './capabilities.mjs';
import {migrateMemory,copyLegacyMemory,adoptDecision,recordSuppliedFact,proposeLesson,reviewLesson,retrieveMemory,digestMemory,userEvent} from './mission-memory.mjs';
import {outputSnapshot} from './workspace.mjs';

export const isAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const queues=new Map();
function enqueue(dir,work){
 const prior=queues.get(dir)??Promise.resolve();
 const result=prior.catch(()=>{}).then(work);
 queues.set(dir,result);
 return result;
}
const identifier=id=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid mission ID');return id;};
const isClosed=m=>['accepted','cancelled'].includes(m.status);
export const memoryQuery=(m,task)=>[m.objective,task.focus,...(task.instructions??[])].join(' ');
const emptyMemoryDigest=digestMemory([]);
const openMissions="SELECT id,record FROM missions WHERE json_extract(record,'$.status') NOT IN ('accepted','cancelled')";
const sessionKey=id=>{
 if(typeof id!=='string'||!id.trim()||id.length>200||/[\x00-\x1f\x7f]/.test(id))throw new Error('Invalid session ID');
 return 'session:'+id;
};
const setMetadata=(db,key,value)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
const taskSpec=({id,capabilityId,dependencies,focus,outcomes})=>({id,capabilityId,dependencies,focus,outcomes});
const taskBinding=({kind,skills,tools,difficulty,research,writesWorkspace})=>({kind,skills,tools,difficulty,research,writesWorkspace});
const taskDigest=task=>hash([taskSpec(task),taskBinding(task)]);
const compiledMissionPlan=({tasks,brief})=>({tasks:tasks.map(taskSpec),brief});
const requestDigest=({objective,domain,mode,maxCalls,sourcePath,plan,brief})=>hash({objective,domain,mode,maxCalls,sourcePath:sourcePath??null,plan:plan??null,brief:brief??null});

function normalizeMission(m,project,id){
 if(m.project!==project||m.id!==id||![VERSION,'3.0.0'].includes(m.version))throw new Error('Mission identity/version mismatch');
 const recordFile=m.version===VERSION?m.recordFile??'mission-v4.json':'mission.json';
 return {...m,version:VERSION,recordFile,requestDigest:m.requestDigest??requestDigest({...m,maxCalls:m.budget.maxCalls}),brief:m.brief??null,plan:m.plan??null,planRevision:m.planRevision??1,sessionId:m.sessionId??null};
}

function invalidateTask(task){
 task.status='pending';task.generation=(task.generation??1)+1;
 task.previousResult=task.result??task.previousResult;task.repairCount=0;
 task.attempts=0;task.activeAttempt=null;
 delete task.result;delete task.executionKey;delete task.memoryDigest;delete task.error;delete task.checkpoint;
}

const fileStat=path=>lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});

async function readLegacyFile(path,stat){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 const unchanged=current=>current.isFile()&&current.dev===stat.dev&&current.ino===stat.ino&&current.size===stat.size&&current.mtimeMs===stat.mtimeMs;
 const changed=()=>new Error('Legacy mission file changed during migration: '+path);
 try{
  if(!unchanged(await handle.stat()))throw changed();
  const content=Buffer.allocUnsafe(stat.size);
  for(let offset=0;offset<content.length;){
   const {bytesRead}=await handle.read(content,offset,content.length-offset,offset);
   if(!bytesRead)throw changed();
   offset+=bytesRead;
  }
  if(!unchanged(await handle.stat()))throw changed();
  return content;
 }finally{await handle.close();}
}

async function copyLegacyMission(source,target,staging){
 let entries=0,bytes=0;
 async function visit(from,to,depth){
  if(depth>16)throw new Error('Legacy mission directory exceeds migration depth budget');
  if(await realpath(from)!==from)throw new Error('Legacy mission directory must be canonical');
  await localDirectory(to);
  for(const name of await readdir(from)){
   if(++entries>5000)throw new Error('Legacy mission exceeds 5,000-entry migration budget');
   const old=join(from,name),copy=join(to,name),stat=await lstat(old);
   if(stat.isDirectory()){await visit(old,copy,depth+1);continue;}
   if(!stat.isFile())throw new Error('Legacy mission contains a symlink or unsupported file: '+old);
   bytes+=stat.size;
   if(stat.size>25000000||bytes>200000000)throw new Error('Legacy mission exceeds migration file or 200 MB budget');
   const content=await readLegacyFile(old,stat);
   const existing=await fileStat(copy);
   if(existing){
    if(!existing.isFile()||existing.size!==stat.size||!(await readLegacyFile(copy,existing)).equals(content))throw new Error('Conflicting v4 mission file during migration: '+copy);
    continue;
   }
   const temporary=join(staging,randomUUID());
   try{await writeFile(temporary,content,{mode:0o600|(stat.mode&0o100),flag:'wx'});await rename(temporary,copy);}
   finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
 }
 await visit(source,target,0);
}

function migrateReferences(value,source,target){
 if(typeof value==='string'&&(value===source||value.startsWith(source+sep)))return target+value.slice(source.length);
 if(Array.isArray(value))return value.map(item=>migrateReferences(item,source,target));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,migrateReferences(item,source,target)]));
 return value;
}

async function copyLegacyStore(db,path,sourceDir,targetDir,project){
 const legacy=new DatabaseSync(path,{readOnly:true});
 try{
  legacy.exec('BEGIN');
  const staging=join(targetDir,'.migration-tmp');await localDirectory(staging);
  const add=db.prepare('INSERT INTO missions(id,record) VALUES(?,?)');
  for(const row of legacy.prepare('SELECT id,record FROM missions').iterate()){
   const source=join(sourceDir,identifier(row.id)),target=join(targetDir,row.id);
   await copyLegacyMission(source,target,staging);
   for(const name of ['evidence','artifacts','workspace'])await localDirectory(join(target,name));
   const record=normalizeMission(JSON.parse(row.record),project,row.id);
   record.tasks=migrateReferences(record.tasks,source,target);
   record.events=migrateReferences(record.events,source,target);
   record.recordFile='mission-v4.json';
   await atomic(join(target,record.recordFile),record);
   add.run(row.id,JSON.stringify(record));
  }
  if(legacy.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory'").get())copyLegacyMemory(db,legacy);
  legacy.exec('COMMIT');
 }finally{legacy.close();}
}

export class MissionStore {
 constructor(project){this.project=project;this.root=join(project,'.agents/skills/boardroom/.runtime');this.dir=join(this.root,'missions-v4');}
 async init(){
  if(!this.initializing)this.initializing=enqueue(this.dir,async()=>{
   await localDirectory(this.root);await localDirectory(this.dir);
   const legacyDir=join(this.root,'missions'),legacyPath=join(legacyDir,'missions.sqlite');
   const legacyStat=await fileStat(legacyPath);
   this.db=new DatabaseSync(join(this.dir,'missions-v4.sqlite'));
   try{
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
     CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY, record TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS missions_request ON missions(json_extract(record,'$.requestId'));`);
    migrateMemory(this.db);
    if(!this.db.prepare('SELECT value FROM metadata WHERE key=?').get('v3-migration')){
     if(legacyStat){
      if(!legacyStat.isFile()||await realpath(legacyDir)!==legacyDir)throw new Error('Invalid v3 mission database');
      await copyLegacyStore(this.db,legacyPath,legacyDir,this.dir,this.project);
     }
     setMetadata(this.db,'v3-migration','complete');
    }
    this.db.exec('COMMIT');
   }catch(error){this.db.close();this.db=undefined;throw error;}
  });
  await this.initializing;
 }
 path(id){return join(this.dir,identifier(id));}
 async locked(fn){
  const initialized=this.init();
  return enqueue(this.dir,async()=>{
   await initialized;this.db.exec('BEGIN IMMEDIATE');
   try{const value=await fn();this.db.exec('COMMIT');return value;}
   catch(e){this.db.exec('ROLLBACK');throw e;}
  });
 }
 async read(id){
  await this.init();identifier(id);
  const row=this.db.prepare('SELECT record FROM missions WHERE id=?').get(id);
  if(!row)throw Object.assign(new Error('Mission not found in this project'),{code:'ENOENT'});
  return normalizeMission(JSON.parse(row.record),this.project,id);
 }
 async save(m){
  m.recordFile='mission-v4.json';m.updatedAt=new Date().toISOString();const record=JSON.stringify(m);
  if(record.length>2000000)throw new Error('Mission record budget exceeded');
  this.db.prepare('INSERT INTO missions(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(m.id,record);
  // SQLite is authoritative. This atomic JSON export is for human inspection.
  await atomic(join(this.path(m.id),m.recordFile),m);
 }
 async close(){await (queues.get(this.dir)??Promise.resolve()).catch(()=>{});this.db?.close();}
 async mutate(id,fn){return this.locked(async()=>{const m=await this.read(id);const value=await fn(m);await this.save(m);return value===undefined?m:value;});}
 event(m,type,data={}){m.events.push({sequence:m.events.length+1,at:new Date().toISOString(),type,...data});if(m.events.length>1000)throw new Error('Mission event limit reached; start a new mission');}
 async create({objective,domain,mode='advice',maxCalls=12,context,owner,sessionId,requestId,sourcePath,plan,brief}){
  if(typeof objective!=='string'||!objective.trim()||objective.length>8000)throw new Error('Invalid objective');
  if(!['advice','deliver'].includes(mode)||!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>24)throw new Error('Invalid mission mode or call budget');
  if(requestId!==undefined&&requestId!==null&&(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)))throw new Error('Invalid request ID');
  const selection=sessionId==null?null:sessionKey(sessionId);
  const compiled=plan==null?null:compilePlan({...plan,brief:brief??plan.brief},{mode});
  const tasks=compiled?.tasks??tasksFor(domain,mode,objective);
  const canonicalPlan=compiled?compiledMissionPlan(compiled):null;
  const missionBrief=compiled?.brief??(brief==null?null:normalizeBrief(brief));
  const digest=requestDigest({objective,domain,mode,maxCalls,sourcePath,plan:canonicalPlan,brief:missionBrief});
  return this.locked(async()=>{
   if(requestId){
    const existing=this.db.prepare("SELECT id,record FROM missions WHERE json_extract(record,'$.requestId')=? LIMIT 2").all(requestId);
    if(existing.length>1)throw new Error('Request ID identifies multiple legacy missions; select a mission ID explicitly');
    if(existing.length){
     const {id,record}=existing[0],old=normalizeMission(JSON.parse(record),this.project,id);
     if(old.requestDigest!==digest)throw new Error('Request ID was already used for different work');
     if(selection)setMetadata(this.db,selection,id);
     return {...old,reusedRequest:true};
    }
   }
   const id=randomUUID();await localDirectory(this.path(id));
   for(const folder of ['evidence','artifacts','workspace'])await localDirectory(join(this.path(id),folder));
   const m={id,version:VERSION,recipeVersion:RECIPE_VERSION,project:this.project,owner,sessionId:sessionId??null,requestId:requestId??null,requestDigest:digest,sourcePath:sourcePath??null,objective,domain,mode,revision:1,planRevision:1,plan:canonicalPlan,brief:missionBrief,status:'ready',context,contextHash:hash(context),tasks,decisions:[],corrections:[],events:[],lease:null,budget:{maxCalls,calls:0,maxAttemptsPerTask:3,concurrency:2},usage:{observed:{},unknownAttempts:0},createdAt:new Date().toISOString()};
   this.event(m,'created',{revision:1});await this.save(m);
   if(selection)setMetadata(this.db,selection,id);
   return m;
  });
 }
 async selectMission(sessionId,id){
  const selection=sessionKey(sessionId);
  return this.locked(async()=>{const m=await this.read(id);setMetadata(this.db,selection,id);return m;});
 }
 async activeMission(sessionId,{fallback=true}={}){
  await this.init();
  if(sessionId!=null){const selected=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(sessionKey(sessionId));if(selected)return this.read(selected.value);}
  if(!fallback)return null;
  const open=this.db.prepare(openMissions+' LIMIT 2').all();
  return open.length===1?normalizeMission(JSON.parse(open[0].record),this.project,open[0].id):null;
 }
 async resolveMission({sessionId,missionId,fallback=true}={}){return missionId==null?this.activeMission(sessionId,{fallback}):this.read(missionId);}
 async latest(){return this.activeMission();}
 async listMissions(){
  await this.init();
  return this.db.prepare("SELECT id,json_extract(record,'$.objective') AS objective,json_extract(record,'$.status') AS status,json_extract(record,'$.revision') AS revision FROM missions ORDER BY json_extract(record,'$.updatedAt') DESC,id LIMIT 50").all().map(({id,...row})=>({missionId:id,...row}));
 }
 async patchPlan(id,{expectedRevision,plan,reason}){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new Error('Provide the expected plan revision');
  if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('Provide a bounded reason for the plan patch');
  return this.mutate(id,m=>{
   if(isClosed(m))throw new Error('Closed mission cannot be replanned');
   if(m.planRevision!==expectedRevision)throw new Error('Plan revision is stale; read the current plan');
   const compiled=compilePlan(plan,{mode:m.mode});
   const before=new Map(m.tasks.map(task=>[task.id,task]));
   const specsChanged=compiled.tasks.filter(task=>!before.has(task.id)||taskDigest(before.get(task.id))!==taskDigest(task)).map(task=>task.id);
   const briefChanged=hash(m.brief)!==hash(compiled.brief);
   const affected=affectedTasks(compiled.tasks,briefChanged?undefined:specsChanged);
   const removed=m.tasks.map(task=>task.id).filter(taskId=>!compiled.tasks.some(task=>task.id===taskId));
   m.tasks=compiled.tasks.map(task=>{
    const old=before.get(task.id);
    if(!old||!affected.has(task.id))return old??task;
    const next={...old,...task};
    invalidateTask(next);
    return next;
   });
   m.brief=compiled.brief;m.plan=compiledMissionPlan(compiled);m.planRevision++;m.revision++;
   m.status=m.lease?'running':'ready';
   this.event(m,'plan-patched',{revision:m.revision,planRevision:m.planRevision,reason,affected:[...affected],removed});
   return m;
  });
 }
 async acquire(id,owner){return this.mutate(id,m=>{
  if(m.lease&&isAlive(m.lease.pid))throw new Error('Mission is already running; use status or steer');
  if(isClosed(m))throw new Error('Mission is closed; create a new mission');
  const token=randomUUID();m.lease={token,pid:process.pid,owner,startedAt:new Date().toISOString()};
  for(const t of m.tasks)if(t.status==='running'||(t.status==='failed'&&t.attempts<m.budget.maxAttemptsPerTask)){t.status='pending';t.interruptedAttempt=t.activeAttempt;t.activeAttempt=null;}
  m.status='running';this.event(m,'execution-started',{revision:m.revision});return {token,mission:m};
 });}
 async release(id,token){return this.mutate(id,m=>{if(m.lease?.token===token){m.lease=null;if(m.status==='running')m.status='interrupted';this.event(m,'execution-settled',{status:m.status});}});}
 async steer(id,{message,affected,context}){
  if(typeof message!=='string'||!message.trim()||message.length>8000)throw new Error('Provide a concrete correction');
  if(affected!==undefined&&(!Array.isArray(affected)||!affected.length))throw new Error('Affected tasks must name at least one task or be omitted');
  return this.mutate(id,m=>{
   if(isClosed(m))throw new Error('Closed mission cannot be steered');
   const changed=affectedTasks(m.tasks,affected);m.revision++;m.planRevision++;
   m.corrections.push({revision:m.revision,message,at:new Date().toISOString()});
   if(context){m.context=context;m.contextHash=hash(context);}
   for(const t of m.tasks)if(changed.has(t.id)){invalidateTask(t);t.instructions=[...(t.instructions??[]),message];}
   m.status=m.lease?'running':'ready';this.event(m,'steered',{revision:m.revision,planRevision:m.planRevision,affected:[...changed],message});return m;
  });
 }
 async pause(id,cancel=false){return this.mutate(id,m=>{if(isClosed(m))throw new Error('Mission is closed; create a new mission');m.status=cancel?'cancelled':'paused';m.revision++;this.event(m,cancel?'cancelled':'paused',{revision:m.revision});});}
 async memory(query,options){await this.init();return retrieveMemory(this.db,query,options);}
 async consumedMemory(query,options){const records=await this.memory(query,options);return {records,digest:digestMemory(records)};}
 currentMemoryDigest(m,task){return digestMemory(retrieveMemory(this.db,memoryQuery(m,task)));}
 async updateMemory(change){
  return this.locked(async()=>{
   const open=this.db.prepare(openMissions).all().map(row=>normalizeMission(JSON.parse(row.record),this.project,row.id));
   const before=open.map(m=>m.tasks.map(task=>this.currentMemoryDigest(m,task)));
   const record=await change(),affectedMissions=[];
   for(const [index,m] of open.entries()){
    const changed=m.tasks.filter((task,i)=>{
     const current=this.currentMemoryDigest(m,task);
     return current!==before[index][i]||(task.memoryDigest!==undefined&&current!==task.memoryDigest);
    }).map(task=>task.id);
    if(!changed.length)continue;
    const affected=affectedTasks(m.tasks,changed);
    for(const task of m.tasks)if(affected.has(task.id))invalidateTask(task);
    m.revision++;
    if(m.status!=='paused')m.status=m.lease?'running':'ready';
    this.event(m,'memory-invalidated',{revision:m.revision,memoryId:record.id,affected:[...affected]});
    await this.save(m);
    affectedMissions.push(m.id);
   }
   return {...record,affectedMissions};
  });
 }
 async remember({sourceMission,...input}){
  return this.locked(async()=>{const m=await this.read(sourceMission);if(m.status!=='accepted')throw new Error('Lessons must reference a user-accepted mission');return proposeLesson(this.db,input,m);});
 }
 async validateMemory(id,decision,options){return this.updateMemory(()=>reviewLesson(this.db,id,decision,options));}
 async recordFact(input){
  return this.updateMemory(async()=>{if(input.sourceMission!=null)await this.read(input.sourceMission);return recordSuppliedFact(this.db,input);});
 }
 async recordDecision(input){
  return this.updateMemory(async()=>{if(input.sourceMission!=null)await this.read(input.sourceMission);return adoptDecision(this.db,input);});
 }
 async decide(id,{decision,note,sourceEvent,verifyArtifacts}){
  if(!['accept','revise','stop'].includes(decision)||typeof note!=='string'||!note.trim()||note.length>2000)throw new Error('Record the user decision and its text');
  if(verifyArtifacts!==undefined&&typeof verifyArtifacts!=='function')throw new Error('Invalid artifact verifier');
  return this.mutate(id,async m=>{
   if(isClosed(m))throw new Error('Mission is closed; create a new mission');
   if(decision==='accept'&&m.status!=='review-ready')throw new Error('Only a verified review-ready mission can be accepted');
   if(decision==='accept'&&m.tasks.some(task=>task.status==='complete'&&(task.memoryDigest??emptyMemoryDigest)!==this.currentMemoryDigest(m,task)))throw new Error('Mission memory changed; continue and review updated artifacts before accepting');
   const event=sourceEvent===undefined?null:userEvent(sourceEvent,'user-artifact-'+decision,id);
   if(event&&(event.text!==note.trim()||(event.action&&event.action!==decision)||(event.targetId&&event.targetId!==id)||(event.revision&&event.revision!==m.revision)))throw new Error('Source user event does not match the current mission decision');
   if(decision==='accept'&&verifyArtifacts&&await verifyArtifacts(m)===false)throw new Error('Review artifacts changed; continue and review updated artifacts before accepting');
   const record={decision,note,revision:m.revision,at:new Date().toISOString()};
   if(event)record.sourceEvent=event;
   m.decisions.push(record);
   if(decision==='accept')m.status='accepted';else if(decision==='stop'){m.status='cancelled';m.revision++;}else m.status='needs-input';
   this.event(m,'user-decision',{decision,revision:m.revision});
  });
 }
 async saveCheckpoint(id,taskId,{attemptId,revision,summary,artifacts}){
  if(typeof summary!=='string'||!summary.trim()||summary.length>2000||!Array.isArray(artifacts)||!artifacts.length||artifacts.length>8)throw new Error('Checkpoint requires a short summary and 1–8 artifact references');
  return this.mutate(id,async m=>{
   const task=m.tasks.find(t=>t.id===taskId);
   if(!attemptId||m.revision!==revision||m.status!=='running'||task?.status!=='running'||task.activeAttempt!==attemptId)throw new Error('Checkpoint attempt is no longer current');
   const root=this.path(id);
   const refs=artifacts.map(input=>{
    const {path,description=''}=typeof input==='string'?{path:input}:input??{};
    if(typeof path!=='string'||!path||path.length>500||typeof description!=='string'||description.length>500)throw new Error('Invalid checkpoint artifact reference');
    const prefix=path.startsWith('workspace/')||path.startsWith('artifacts/')?root:join(root,'artifacts');
    return {path:resolve(prefix,path),description};
   });
   if(new Set(refs.map(ref=>ref.path)).size!==refs.length)throw new Error('Duplicate checkpoint artifact references');
   const snapshot=await outputSnapshot(root,refs);
   task.checkpoint={attemptId,revision,generation:task.generation??1,summary:summary.trim(),artifacts:refs,snapshot,at:new Date().toISOString()};
   this.event(m,'checkpoint-saved',{taskId,attemptId,revision,artifactCount:refs.length});
   return task.checkpoint;
  });
 }
 async readCheckpoint(id,taskId){
  const m=await this.read(id),task=m.tasks.find(t=>t.id===taskId),checkpoint=task?.checkpoint;
  if(!checkpoint||checkpoint.generation!==(task.generation??1))return null;
  try{return hash(checkpoint.snapshot)===hash(await outputSnapshot(this.path(id),checkpoint.artifacts))?checkpoint:null;}
  catch{return null;}
 }
}

export async function businessContext(project,query=''){
 const base=join(project,'.agents/skills/boardroom');
 const files=await Promise.all(['COMPANY.md','STATE.md','DECISIONS.md'].map(async name=>({name,text:await readFile(join(base,name),'utf8')})));
 if(files.some(x=>x.text.length>500000))throw new Error('Business context file exceeds supported size');
 return Object.fromEntries(files.map(x=>[x.name,x.text]));
}
export function searchContext(context,query,limit=5){
 const terms=[...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(x=>x.length>2))];
 const rows=[];
 for(const [name,text] of Object.entries(context))for(const [i,line]of text.split('\n').entries()){
  const score=terms.reduce((n,t)=>n+(line.toLowerCase().includes(t)?1:0),0);
  if(score)rows.push({source:name,line:i+1,text:line.slice(0,2000),score});
 }
 return rows.sort((a,b)=>b.score-a.score||b.line-a.line).slice(0,limit);
}
export function missionSummary(m){return {missionId:m.id,objective:m.objective,domain:m.domain,mode:m.mode,revision:m.revision,planRevision:m.planRevision,brief:m.brief,status:m.status,tasks:m.tasks.map(t=>({id:t.id,status:t.status,attempts:t.attempts,artifact:t.result?.artifactPath??null,error:t.error??null})),budget:m.budget,usage:m.usage,pendingDecision:m.status==='review-ready'?'Review the artifacts; accept or request a revision':m.status==='needs-input'?'Resolve the recorded missing input':null,record:join(m.project,'.agents/skills/boardroom/.runtime/missions-v4',m.id,m.recordFile??'mission-v4.json')};}
