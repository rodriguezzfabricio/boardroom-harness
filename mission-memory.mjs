import {randomUUID} from 'node:crypto';
import {hash} from './core.mjs';

const decisionKinds=['decision','constraint'];
const scope=(value,label)=>{
 if(typeof value!=='string'||!value.trim()||value.length>120||/[\x00-\x1f\x7f]/.test(value))throw new Error(`Invalid memory ${label}`);
 return value.trim().toLowerCase();
};
const boundedText=(text,message)=>{
 if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error(message);
 return text.trim();
};
const rowRecord=row=>row?{...row,sourceEvent:JSON.parse(row.sourceEvent)}:null;
const termsFor=query=>[...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(term=>term.length>2))];
const order=(a,b)=>a===b?0:a<b?-1:1;

export function userEvent(event,type,missionId=null){
 if(!event||typeof event!=='object'||Array.isArray(event))throw new Error('A source user event is required');
 if(typeof event.text!=='string'||!event.text.trim()||event.text.length>8000)throw new Error('Provide the source user event text');
 for(const field of ['sessionId','action','targetId'])if(event[field]!=null&&(typeof event[field]!=='string'||!event[field].trim()||event[field].length>200))throw new Error(`Invalid source user event ${field}`);
 const eventId=event.eventId??event.id??null;
 if(eventId!==null&&!(typeof eventId==='string'&&eventId.trim()&&eventId.length<=200)&&!Number.isSafeInteger(eventId))throw new Error('Invalid source user event ID');
 if(event.revision!=null&&(!Number.isSafeInteger(event.revision)||event.revision<1))throw new Error('Invalid source user event revision');
 if(event.resultDigest!=null&&(typeof event.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(event.resultDigest)))throw new Error('Invalid source user event result digest');
 return {type,text:event.text.trim(),missionId,eventId,sessionId:event.sessionId??null,action:event.action??null,targetId:event.targetId??null,revision:event.revision??null,resultDigest:event.resultDigest??null,...type==='user-supplied-fact'?{callId:event.callId,questionId:event.questionId,question:event.question,answer:event.answer}:{},at:new Date().toISOString()};
}

export function migrateMemory(db){
 db.exec(`CREATE TABLE IF NOT EXISTS memory(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
  status TEXT NOT NULL, createdAt TEXT NOT NULL, entity TEXT NOT NULL, key TEXT NOT NULL,
  revision INTEGER NOT NULL, sourceEvent TEXT NOT NULL, supersedes TEXT, supersededBy TEXT
 );`);
 db.exec(`CREATE INDEX IF NOT EXISTS memory_scope ON memory(kind,entity,key,revision);
  CREATE UNIQUE INDEX IF NOT EXISTS memory_current ON memory(kind,entity,key)
   WHERE status='validated' AND supersededBy IS NULL;`);
}

export function copyLegacyMemory(db,legacy){
 const mission=legacy.prepare('SELECT record FROM missions WHERE id=?');
 const add=db.prepare('INSERT INTO memory(id,kind,text,source,status,createdAt,entity,key,revision,sourceEvent) VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(const row of legacy.prepare('SELECT * FROM memory').iterate()){
  const acceptance=row.kind==='decision';
  const record=acceptance?JSON.parse(mission.get(row.source)?.record??'null'):null;
  const revision=Number(row.id.split('-r').at(-1));
  const accepted=record?.decisions?.find(d=>d.decision==='accept'&&d.revision===revision);
  const event={type:acceptance?'legacy-artifact-acceptance':'legacy-lesson-'+row.status,missionId:row.source,text:accepted?.note??null,at:accepted?.at??row.createdAt};
  add.run(row.id,acceptance?'artifact-acceptance':row.kind,row.text,row.source,row.status,row.createdAt,'project',row.id,1,JSON.stringify(event));
 }
}

function current(db,{kind,entity,key}){
 return db.prepare("SELECT * FROM memory WHERE kind=? AND entity=? AND key=? AND status='validated' AND supersededBy IS NULL").get(kind,entity,key);
}

function replaceCurrent(db,previous,nextId){
 if(previous)db.prepare("UPDATE memory SET status='superseded',supersededBy=? WHERE id=?").run(nextId,previous.id);
}

function insert(db,{kind,entity,key,text,sourceEvent,status,supersedes=null,id=randomUUID()}){
 const revision=db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM memory WHERE kind=? AND entity=? AND key=?').get(kind,entity,key).revision;
 const createdAt=new Date().toISOString(),source=sourceEvent.missionId??sourceEvent.sessionId??'project';
 const record={id,kind,text,source,status,createdAt,entity,key,revision,sourceEvent,supersedes,supersededBy:null};
 db.prepare('INSERT INTO memory(id,kind,text,source,status,createdAt,entity,key,revision,sourceEvent,supersedes,supersededBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id,kind,text,source,status,createdAt,entity,key,revision,JSON.stringify(sourceEvent),supersedes,null);
 return record;
}

export function adoptDecision(db,{entity='project',key,text,kind='decision',sourceEvent,sourceMission,supersedes}){
 if(!decisionKinds.includes(kind))throw new Error('Use decision or constraint memory');
 const input={kind,entity:scope(entity,'entity'),key:scope(key,'key')};
 text=boundedText(text,'Provide a bounded user-adopted decision');
 const event=userEvent(sourceEvent,'user-adopted-decision',sourceMission);
 const previous=current(db,input);
 if(supersedes!==undefined&&supersedes!==(previous?.id??null))throw new Error('The specified memory is not the current decision in this scope');
 const id=randomUUID();
 replaceCurrent(db,previous,id);
 return insert(db,{...input,id,text,sourceEvent:event,status:'validated',supersedes:previous?.id??null});
}

export function recordSuppliedFact(db,{entity='project',key,text,sourceEvent,sourceMission,supersedes}){
 const input={kind:'fact',entity:scope(entity,'entity'),key:scope(key,'key')};
 text=boundedText(text,'Provide a bounded user-supplied fact');
 if(sourceEvent?.action!=='supply-fact'||!sourceEvent.callId||!sourceEvent.questionId||!sourceEvent.question||!sourceEvent.answer)throw new Error('A recorded questionnaire answer is required');
 const event=userEvent(sourceEvent,'user-supplied-fact',sourceMission);
 const previous=current(db,input);
 if(supersedes!==undefined&&supersedes!==(previous?.id??null))throw new Error('The specified memory is not the current fact in this scope');
 const id=randomUUID();
 replaceCurrent(db,previous,id);
 return insert(db,{...input,id,text,sourceEvent:event,status:'validated',supersedes:previous?.id??null});
}

export function proposeLesson(db,{text,entity='project',key},mission){
 const id=randomUUID();
 text=boundedText(text,'Provide a bounded proposed lesson');
 const accepted=mission.decisions.findLast(d=>d.decision==='accept');
 const sourceEvent={...accepted?.sourceEvent,type:'lesson-proposed-from-artifact',missionId:mission.id,text:accepted?.note??null,at:accepted?.at??null};
 return {...insert(db,{id,kind:'lesson',entity:scope(entity,'entity'),key:scope(key??id,'key'),text,sourceEvent,status:'proposed'}),note:'Excluded from default retrieval until the user validates it.'};
}

export function reviewLesson(db,id,decision,{sourceEvent}={}){
 if(!['validate','reject'].includes(decision))throw new Error('Choose validate or reject');
 const row=rowRecord(db.prepare('SELECT * FROM memory WHERE id=?').get(id));
 if(!row||row.kind!=='lesson')throw new Error('Lesson not found');
 if(row.status==='superseded')throw new Error('Superseded lesson cannot be changed');
 const status=decision==='validate'?'validated':'rejected';
 if(row.status===status)return row;
 const event=sourceEvent===undefined?row.sourceEvent:userEvent(sourceEvent,'user-lesson-'+decision,row.source);
 const previous=status==='validated'?current(db,row):null;
 if(previous&&previous.revision>row.revision)throw new Error('A newer lesson is already validated in this scope');
 replaceCurrent(db,previous,id);
 const supersedes=previous?.id??row.supersedes;
 db.prepare('UPDATE memory SET status=?,sourceEvent=?,supersedes=? WHERE id=?').run(status,JSON.stringify(event),supersedes,id);
 return {...row,status,sourceEvent:event,supersedes};
}

export function retrieveMemory(db,query,{entity,key,history=false,limit=10}={}){
 if(typeof query!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('Invalid memory query or limit');
 const terms=termsFor(query),entityFilter=entity===undefined?null:scope(entity,'entity'),keyFilter=key===undefined?null:scope(key,'key');
 const rows=db.prepare(`SELECT * FROM memory WHERE (? IS NULL OR entity IN ('project',?)) AND (? IS NULL OR key=?)
  AND (? OR (status='validated' AND supersededBy IS NULL AND kind IN ('decision','constraint','lesson','fact')))`)
  .all(entityFilter,entityFilter,keyFilter,keyFilter,history===true?1:0);
 const constraints=[],matches=[];
 for(const row of rows){
  const haystack=`${row.entity} ${row.key} ${row.text}`.toLowerCase();
  const record={...rowRecord(row),score:terms.reduce((n,term)=>n+Number(haystack.includes(term)),0)};
  if(record.kind==='constraint'&&record.status==='validated'&&!record.supersededBy)constraints.push(record);
  else if(record.score||!terms.length)matches.push(record);
 }
 const rank=(a,b)=>b.score-a.score||order(b.createdAt,a.createdAt)||order(a.id,b.id);
 return [...constraints.sort(rank),...matches.sort(rank).slice(0,limit)];
}

export function digestMemory(records){
 return hash(records.map(({score,...record})=>record).sort((a,b)=>order(a.id,b.id)));
}
