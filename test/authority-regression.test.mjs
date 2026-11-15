import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertUserDecision,suppliedQuestionFact} from '../authority.mjs';
import {MissionStore} from '../mission-store.mjs';

const owner='Jamie Rivera and Morgan Lee  just us two';
const input={callId:'question-call',questionId:'owners'};
function fixture(){
 const response={answers:[{id:'owners',selected:[],custom:owner},{id:'scope',selected:['Yes, proceed (Recommended)']}]};
 const events=[
  {seq:17,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'/boardroom Start this business.'}]}},
  {seq:79,type:'tool/call',data:{callId:input.callId,name:'ask_user_question',arguments:JSON.stringify({questions:[{id:'owners',question:'Who are the co-owners, equity split and managing member?'},{id:'scope',question:'Prepare local drafts?',options:[{label:'Yes, proceed (Recommended)'}]}]})}},
  {seq:80,type:'tool/result',data:{message:{role:'tool',source:{kind:'tool',callId:input.callId},toolCallId:input.callId,isError:false,content:[{type:'text',text:JSON.stringify(response)}]}}},
 ];
 return {id:'chat',session:{header:{id:'chat'},snapshotEvents:()=>events,isOwnSeq:seq=>[17,79,80].includes(seq)},events,response};
}
function setResponse(agent,response){agent.events[2].data.message.content[0].text=JSON.stringify(response);}

test('questionnaire ownership correction is captured verbatim with full question and answer provenance',()=>{
 const fact=suppliedQuestionFact(fixture(),input);
 assert.equal(fact.text,owner);
 assert.equal(fact.sourceEvent.action,'supply-fact');
 assert.equal(fact.sourceEvent.eventId,80);
 assert.equal(fact.sourceEvent.question.id,'owners');
 assert.equal(fact.sourceEvent.answer.custom,owner);
 assert.ok(fact.sourceEvent.text.includes('scope'));
 assert.ok(!fact.text.includes('50/50'));
});

test('questionnaire references fail closed for missing, failed, inherited, stale or impersonated results',()=>{
 const mutations=[
  a=>{a.events[1].data.name='research_read';},
  a=>{a.events[2].data.message.isError=true;},
  a=>{a.session.isOwnSeq=()=>false;},
  a=>{delete a.session.isOwnSeq;},
  a=>{a.events[2].data.message.source.kind='agent';},
  a=>{a.events[2].data.message.source.callId='forged';},
  a=>{a.events.push({seq:81,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Actually, there are three owners.'}]}});},
  a=>{a.events[1].data.arguments='not JSON';},
  a=>{a.events[2].seq=78;},
 ];
 for(const mutate of mutations){const agent=fixture();mutate(agent);assert.throws(()=>suppliedQuestionFact(agent,input));}
 assert.throws(()=>suppliedQuestionFact(fixture(),{...input,questionId:'unknown'}));
 assert.throws(()=>suppliedQuestionFact(fixture(),{...input,callId:'unknown'}));
});

test('pending, skipped, duplicate or invented option answers cannot become facts',()=>{
 for(const response of [{pending:true},{answers:[{id:'owners',selected:[]}]},{answers:[{id:'owners',selected:['Invented approval']}]},{answers:[{id:'owners',selected:[],custom:owner},{id:'owners',selected:[],custom:'Other'}]}]){
  const agent=fixture();setResponse(agent,response);assert.throws(()=>suppliedQuestionFact(agent,input));
 }
});

test('selected options and custom qualifications remain together and are facts only',()=>{
 const agent=fixture();agent.response.answers[1].custom='Only after I review the draft';setResponse(agent,agent.response);
 const result=suppliedQuestionFact(agent,{...input,questionId:'scope'});
 assert.equal(result.text,'Yes, proceed (Recommended)\nOnly after I review the draft');
 assert.equal(result.sourceEvent.action,'supply-fact');
 assert.throws(()=>assertUserDecision(agent,result.text,{action:'accept'}));
});

test('adoption can capture the source automatically; prefix preserved; wrong notes and non-decisions still rejected',()=>{
 const agent=fixture();agent.events.length=1;
 const text='/boardroom Set the pilot price to $100.';
 agent.events[0].data.content=[{type:'file',attachment:{name:'brief.pdf'}},{type:'text',text}];
 assert.equal(assertUserDecision(agent,undefined,{action:'adopt',capture:true}).text,text);
 assert.throws(()=>assertUserDecision(agent,'Pricing summary',{action:'adopt',capture:true}),/note must quote/);
 agent.events[0].data.content=[{type:'text',text:'Who should be the owners?'}];
 assert.throws(()=>assertUserDecision(agent,undefined,{action:'adopt',capture:true}),/question/);
});

test('supplied facts persist, supersede facts, invalidate consumed work and never become adopted decisions',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'boardroom-fact-regression-')));
 const store=new MissionStore(dir);t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
 const fact=suppliedQuestionFact(fixture(),input);
 const first=await store.recordFact({entity:'ownership',key:'co-owners',...fact});
 assert.equal(first.kind,'fact');assert.equal(first.sourceEvent.type,'user-supplied-fact');
 assert.equal(first.sourceEvent.questionId,'owners');assert.equal(first.sourceEvent.answer.custom,owner);
 const mission=await store.create({domain:'strategy',objective:'Assess ownership and co-owners',owner:'test',context:{}});
 const snapshot=await store.consumedMemory('ownership');
 await store.mutate(mission.id,async m=>{m.tasks[0].status='complete';m.tasks[0].memoryDigest=snapshot.digest;m.tasks[0].result={summary:'Old owners'};});
 const second=await store.recordFact({entity:'ownership',key:'co-owners',...fact,supersedes:first.id});
 assert.equal(second.supersedes,first.id);assert.ok(second.affectedMissions.includes(mission.id));
 const rows=await store.memory('ownership');assert.equal(rows.length,1);assert.equal(rows[0].kind,'fact');
 assert.equal((await store.memory('ownership',{history:true})).length,2);
});
