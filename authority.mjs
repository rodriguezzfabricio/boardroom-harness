// Deliberately narrow: ambiguous natural language remains a controller question.
// This binds a decision to the complete current user event, not a selected word.
export function assertUserDecision(agent,note,{action,targetId,revision,capture=false}={}){
 const event=[...(agent.session.snapshotEvents?.()??[])].reverse().find(e=>e.type==='user/message'&&e.data?.source?.kind==='user');
 if(action&&event?.seq!=null&&agent.session.isOwnSeq&&!agent.session.isOwnSeq(event.seq))throw new Error('The decision must come from this conversation, not inherited history');
 const text=(event?.data?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
 if(note===undefined&&capture)note=text;
 if(typeof note!=='string'||!note.trim()||note.length>8000)throw new Error('Quote the complete actual user decision');
 if(!text||text!==note.trim())throw new Error('note must quote the complete latest actual user message verbatim; it is not a summary. For boardroom_record_decision omit note to capture it automatically. Questionnaire facts use boardroom_record_fact with callId and questionId; do not retry altered quotes.');
 const normalized=text.replace(/^\/boardroom(?:\s+|$)/i,'').toLowerCase().replace(/[’‘]/g,"'");
 if(action&&(/[?？]/.test(text)||/^(?:did|does|do|have|has|had|is|are|was|were|what|which|when|why|how|would|could|should)\b/.test(normalized)))throw new Error('A question is not an explicit decision');
 if(action==='adopt'&&/\b(?:example|hypothetical|hypothetically|do not adopt|don't adopt|do not remember|don't remember)\b/.test(normalized))throw new Error('An example or explicitly unadopted suggestion is not a decision');
 const affirmative=['accept','validate'].includes(action);
 if(affirmative&&/\b(?:not|no|never|don't|doesn't|didn't|cannot|can't|won't|reject|rejected|unless|if|maybe|might|hypothetically)\b/.test(normalized))throw new Error('Ambiguous, conditional or negated decision; no affirmative state change recorded');
 const signals={accept:/^(?:please\s+)?(?:yes[,!]?\s+)?(?:i\s+)?(?:accept|approve)(?:\s+(?:it|this|that|the|current|latest|final|draft|report|result|artifact|revision|mission))*[.!\s]*$/,validate:/^(?:please\s+)?(?:i\s+)?(?:validate|approve)(?:\s+(?:it|this|that|the|current|lesson|memory|record))*[.!\s]*$/,reject:/\b(?:reject|discard|remove|no)\b/,adopt:/^(?:please\s+)?(?:remember|set|use|adopt|i(?:'ve| have)? decided|our decision is|we (?:decided|choose|will use))\b/,revise:/\b(?:revise|change|redo|fix|instead)\b/,stop:/\b(?:stop|cancel|end)\b/};
 if(action&&(!signals[action]||!signals[action].test(normalized)))throw new Error('Latest user message does not explicitly express the requested decision');
 return {text,sessionId:agent.session.header?.id??agent.id,eventId:event.id??event.sequence??event.seq??null,action:action??null,targetId:targetId??null,revision:revision??null};
}

const contentText=content=>(content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');

// Only the native ask-user result paired with its recorded call is human input.
// Never infer a human answer from a generic tool result or model-written JSON.
export function latestHumanInput(agent){
 const events=agent.session.snapshotEvents?.()??[];
 return [...events].reverse().find(event=>event.type==='user/message'&&event.data?.source?.kind==='user'||
  event.type==='tool/result'&&events.some(call=>call.type==='tool/call'&&call.data?.name==='ask_user_question'&&call.data.callId===event.data?.message?.toolCallId));
}

export function suppliedQuestionFact(agent,{callId,questionId}){
 if(typeof callId!=='string'||!callId||typeof questionId!=='string'||!questionId)throw new Error('Provide the recorded ask_user_question callId and questionId');
 const events=agent.session.snapshotEvents?.()??[];
 const call=events.find(e=>e.type==='tool/call'&&e.data?.callId===callId&&e.data.name==='ask_user_question');
 const event=latestHumanInput(agent),message=event?.data?.message;
 if(!call||event?.type!=='tool/result'||message?.toolCallId!==callId)throw new Error('Use the latest actual questionnaire answer, not a stale call, agent result or memory');
 if(!agent.session.isOwnSeq||![call,event].every(e=>Number.isSafeInteger(e.seq)&&agent.session.isOwnSeq(e.seq)))throw new Error('The answer must come from this conversation, not inherited history');
 if(call.seq>=event.seq||message.role!=='tool'||message.source?.kind!=='tool'||message.source.callId!==callId||message.isError)throw new Error('A successful native question result is required');
 let request,response;
 try{request=JSON.parse(call.data.arguments);response=JSON.parse(contentText(message.content));}catch{throw new Error('Recorded questionnaire payload is not valid JSON');}
 const questions=request.questions?.filter(q=>q.id===questionId),answers=response.answers?.filter(a=>a.id===questionId);
 if(response.pending||questions?.length!==1||answers?.length!==1)throw new Error('The question has no submitted answer; pending or skipped questions are not facts');
 const question=questions[0],answer=answers[0];
 if(!Array.isArray(answer.selected)||answer.selected.some(value=>typeof value!=='string'||!question.options?.some(o=>o.label===value))||answer.custom!==undefined&&typeof answer.custom!=='string')throw new Error('Answer does not match the recorded question');
 const text=[...answer.selected,...answer.custom===undefined?[]:[answer.custom]].filter(value=>value.trim()).join('\n');
 if(!text)throw new Error('The question was skipped; no fact was supplied');
 return {text,sourceEvent:{text:contentText(message.content),sessionId:agent.session.header?.id??agent.id,eventId:event.seq,action:'supply-fact',callId,questionId,question,answer}};
}
