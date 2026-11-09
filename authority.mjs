// Deliberately narrow: ambiguous natural language remains a controller question.
// This binds a decision to the complete current user event, not a selected word.
export function assertUserDecision(agent,note,{action,targetId,revision}={}){
 if(typeof note!=='string'||!note.trim()||note.length>8000)throw new Error('Quote the complete actual user decision');
 const event=[...(agent.session.snapshotEvents?.()??[])].reverse().find(e=>e.type==='user/message'&&e.data?.source?.kind==='user');
 if(action&&event?.seq!=null&&agent.session.isOwnSeq&&!agent.session.isOwnSeq(event.seq))throw new Error('The decision must come from this conversation, not inherited history');
 const text=(event?.data?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
 if(!text||text!==note.trim())throw new Error('The decision must quote the complete latest actual user message, not an agent result, substring or memory');
 const normalized=text.toLowerCase().replace(/[’‘]/g,"'");
 if(action&&(/[?？]/.test(text)||/^(?:did|does|do|have|has|had|is|are|was|were|what|which|when|why|how|would|could|should)\b/.test(normalized)))throw new Error('A question is not an explicit decision');
 if(action==='adopt'&&/\b(?:example|hypothetical|hypothetically|do not adopt|don't adopt|do not remember|don't remember)\b/.test(normalized))throw new Error('An example or explicitly unadopted suggestion is not a decision');
 const affirmative=['accept','validate'].includes(action);
 if(affirmative&&/\b(?:not|no|never|don't|doesn't|didn't|cannot|can't|won't|reject|rejected|unless|if|maybe|might|hypothetically)\b/.test(normalized))throw new Error('Ambiguous, conditional or negated decision; no affirmative state change recorded');
 const signals={accept:/^(?:please\s+)?(?:yes[,!]?\s+)?(?:i\s+)?(?:accept|approve)(?:\s+(?:it|this|that|the|current|latest|final|draft|report|result|artifact|revision|mission))*[.!\s]*$/,validate:/^(?:please\s+)?(?:i\s+)?(?:validate|approve)(?:\s+(?:it|this|that|the|current|lesson|memory|record))*[.!\s]*$/,reject:/\b(?:reject|discard|remove|no)\b/,adopt:/^(?:please\s+)?(?:remember|set|use|adopt|i(?:'ve| have)? decided|our decision is|we (?:decided|choose|will use))\b/,revise:/\b(?:revise|change|redo|fix|instead)\b/,stop:/\b(?:stop|cancel|end)\b/};
 if(action&&(!signals[action]||!signals[action].test(normalized)))throw new Error('Latest user message does not explicitly express the requested decision');
 return {text,sessionId:agent.session.header?.id??agent.id,eventId:event.id??event.sequence??event.seq??null,action:action??null,targetId:targetId??null,revision:revision??null};
}
