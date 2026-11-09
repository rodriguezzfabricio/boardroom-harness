import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,executeStage,validate,route,schema,packet,LIMITS,economics} from '../core.mjs';
import {assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';
const raw=(n=2)=>({stage:'01-plan',question:'Which pilot should we test?',specialists:Array.from({length:n},(_,i)=>({name:'role-'+i,persona:'Business specialist',focus:'Assess one risk',headings:['Decision','Evidence']})),evidence:[]});
const valid=headings=>({sections:Object.fromEntries(headings.map(h=>[h,'Uncertain; test the assumption [company].'])),claims:[{text:'The company is a pilot.',kind:'fact',sources:['company']}],uncertainties:['No independent market evidence.']});
const deps=(run,cache=new Map())=>({project:'one',parentOptions:{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'max'},signal:new AbortController().signal,run:run??(async r=>({stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))})),readCache:async k=>cache.get(k),writeCache:async(k,v)=>cache.set(k,v),checkpoint:async()=>{}});
test('schemas are accepted by installed dsh, including heading constraints',()=>{const s=schema(['Decision']);assertObjectJsonSchema(s);assert.deepEqual(validateJsonSchemaValue(s,valid(['Decision']),''),[]);});
test('rejects oversubscription, duplicates, invalid stages and bad evidence before calls',()=>{
 for(const v of [{...raw(6)},{...raw(),stage:'99-delete'},{...raw(),specialists:[raw().specialists[0],raw().specialists[0]]},{...raw(),evidence:[{id:'company',source:'x',excerpt:'x',observedAt:'2026-01-01'}]}]) assert.throws(()=>normalize(v,'pilot'));
});
test('rejects invented sources, missing sections, malformed and oversized results',()=>{
 const v=valid(['Decision']);v.claims[0].sources=['invented'];assert.ok(validate(v,['Decision'],new Set(['company'])));
 assert.ok(validate(valid(['Wrong']),['Decision'],new Set(['company'])));
 assert.ok(validate(null,['Decision'],new Set(['company'])));
 const large=valid(['Decision']);large.sections.Decision='x'.repeat(6001);assert.ok(validate(large,['Decision'],new Set(['company'])));
});
test('valid run has independent challenger and stays at user gate',async()=>{const out=await executeStage(normalize(raw(),'pilot'),deps());assert.equal(out.status,'review-ready');assert.equal(out.metrics.calls,3);assert.equal(out.gate,'awaiting-user');assert.ok(out.challenge);});
test('concurrency is bounded at two, with five independent specialists',async()=>{
 let active=0,peak=0;const d=deps(async r=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,4));active--;return {stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))};});
 const out=await executeStage(normalize(raw(5),'pilot'),d);assert.equal(peak,2);assert.equal(out.metrics.calls,6);
});
test('partial failures are retained, never treated as ready',async()=>{const d=deps(async r=>r.name==='role-0'?{stopReason:'error'}:{stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))});const out=await executeStage(normalize(raw(),'pilot'),d);assert.equal(out.status,'incomplete');assert.deepEqual(out.failed,['role-0']);assert.ok(out.challenge);});
test('repairs are bounded globally even if every result is malformed',async()=>{const out=await executeStage(normalize(raw(5),'pilot'),deps(async()=>({stopReason:'completed',structured:{}})));assert.ok(out.metrics.calls<=LIMITS.calls);assert.equal(out.status,'incomplete');});
test('all-failed stage never starts a challenger',async()=>{const out=await executeStage(normalize(raw(),'pilot'),deps(async()=>({stopReason:'error'})));assert.equal(out.metrics.calls,2);assert.equal(out.challenge,null);});
test('cache avoids repeated calls and cannot leak across projects',async()=>{
 const cache=new Map();const input=normalize(raw(),'pilot');const d=deps(null,cache);
 await executeStage(input,d);assert.equal((await executeStage(input,d)).metrics.calls,0);
 assert.equal((await executeStage(input,{...d,project:'two'})).metrics.calls,3);
});
test('changed evidence invalidates work; invalid cached values are discarded',async()=>{
 const cache=new Map();const d=deps(null,cache);await executeStage(normalize(raw(),'pilot'),d);
 assert.equal((await executeStage(normalize(raw(),'new company'),d)).metrics.calls,3);
 for(const k of cache.keys())cache.set(k,{});
 assert.equal((await executeStage(normalize(raw(),'pilot'),d)).metrics.calls,3);
});
test('routing lowers routine effort without changing non-DeepSeek provider',()=>{
 assert.equal(route({provider:'deepseek-official'}, {name:'cfo',difficulty:'routine'}).model,'deepseek-flash');
 assert.equal(route({provider:'deepseek-official'}, {name:'counsel',difficulty:'routine'}).reasoningEffort,'high');
 assert.equal(route({provider:'venice',model:'selected'}, {name:'cfo'}).model,'selected');
});
test('prompt preflight prevents spending on an oversized packet',async()=>{
 const r=raw();r.evidence=[{id:'price',source:'https://example.com',excerpt:'x'.repeat(4000),observedAt:'2026-01-01'},{id:'cost',source:'https://example.com',excerpt:'x'.repeat(4000),observedAt:'2026-01-01'}];r.specialists[0].evidenceIds=['price','cost'];
 let calls=0;await assert.rejects(executeStage(normalize(r,'x'.repeat(12000)),deps(async()=>{calls++;})),/Prompt budget/);assert.equal(calls,0);
});
test('cancellation stops dispatch and records incomplete result',async()=>{
 const controller=new AbortController();const d=deps(async r=>{controller.abort();return {stopReason:'aborted'};});d.signal=controller.signal;
 const out=await executeStage(normalize(raw(5),'pilot'),d);assert.equal(out.status,'incomplete');assert.ok(out.metrics.calls<=2);
});
test('specialist sees only its evidence; challenger sees contradictions',()=>{
 const r=raw();r.evidence=[{id:'price',source:'https://example.com',excerpt:'SENSITIVE EXCERPT',observedAt:'2026-01-01'}];
 const i=normalize(r,'pilot');assert.ok(!packet(i,i.specialists[0]).includes('SENSITIVE EXCERPT'));
});

test('unit economics catches negative margins, zero price and invalid money inputs',()=>{
 assert.deepEqual(economics({priceCents:10000,variableCostCents:4000,monthlyFixedCostCents:20000,customers:5}),{revenueCents:50000,contributionCents:6000,monthlyProfitCents:10000,grossMarginPercent:60,breakEvenCustomers:4,assumptions:'User-supplied amounts; excludes costs not included in inputs.'});
 assert.equal(economics({priceCents:0,variableCostCents:100,monthlyFixedCostCents:0,customers:1}).breakEvenCustomers,null);
 assert.throws(()=>economics({priceCents:1.1,variableCostCents:0,monthlyFixedCostCents:0,customers:1}));
});

test('checkpoint failure cancels peers and waits for them before releasing control',async()=>{
 let active=0;
 const d=deps(async r=>{active++;try{await new Promise(resolve=>setTimeout(resolve,r.name==='role-0'?1:10));return {stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))};}finally{active--;}});
 d.checkpoint=async()=>{throw new Error('disk full');};
 await assert.rejects(executeStage(normalize(raw(5),'pilot'),d),/disk full/);assert.equal(active,0);
});

test('source ID schema excludes filenames and arbitrary URLs at the model boundary',()=>{
 const s=schema(['Decision'],['company','price']);const v=valid(['Decision']);v.claims[0].sources=['COMPANY.md (user-provided, unverified)'];
 assert.ok(validateJsonSchemaValue(s,v,'').length>0);v.claims[0].sources=['price'];assert.deepEqual(validateJsonSchemaValue(s,v,''),[]);
});

test('reproduces CEO failure with exact uncertainty count, not a vague ledger error',()=>{
 const v=valid(['Thesis','Bets (3)','Kill conditions (3)','Open questions']);v.uncertainties=Array.from({length:9},(_,i)=>'Risk '+i);
 assert.deepEqual(validateJsonSchemaValue(schema(Object.keys(v.sections)),v,''),[]);
 assert.match(validate(v,Object.keys(v.sections),new Set(['company'])),/uncertainties: 9 items; maximum 5/);
 assert.match(schema(['Decision']).properties.uncertainties.description,/At most 5/);
});
test('normalization handles malformed arrays and canonical headings before dispatch',()=>{
 assert.throws(()=>normalize({...raw(),evidence:{}},'pilot'),/Evidence must/);
 const r=raw(1);r.specialists[0].headings=[' x ','x'];assert.throws(()=>normalize(r,'pilot'),/Duplicate/);
 r.specialists[0].headings=['constructor'];assert.throws(()=>normalize(r,'pilot'),/reserved/);
 r.specialists[0].headings=[' x '];assert.deepEqual(normalize(r,'pilot').specialists[0].headings,['x']);
});
test('first attempts reach all five roles before a malformed role consumes repair slots',async()=>{
 const seen=[];const out=await executeStage(normalize(raw(5),'pilot'),deps(async r=>{seen.push(r.name);return {stopReason:'completed',structured:{}};}));
 assert.deepEqual(seen.slice(0,5),['role-0','role-1','role-2','role-3','role-4']);assert.equal(out.metrics.calls,6);
});
test('precise repair feedback retains the complete answer and records actual prompt size',async()=>{
 let tries=0;let repaired;
 const d=deps(async r=>{
  const v=valid(Object.keys(r.schema.properties.sections.properties));
  if(r.name==='role-0' && tries++===0)v.uncertainties=Array(9).fill('Demand is unproven.');
  else if(r.name==='role-0')repaired=r.prompt;
  return {stopReason:'completed',structured:v};
 });
 const out=await executeStage(normalize(raw(1),'pilot'),d);
 assert.equal(out.status,'review-ready');assert.match(repaired,/uncertainties: 9 items; maximum 5/);
 assert.equal(out.metrics.trace.find(t=>t.attempt===2).promptChars,repaired.length);
});
test('checkpoints contain completed answers, not only role names',async()=>{
 const checkpoints=[];const d=deps();d.checkpoint=async x=>checkpoints.push(x);
 await executeStage(normalize(raw(2),'pilot'),d);
 const first=checkpoints.find(x=>x.phase==='specialists');assert.ok(first.specialists.length);assert.ok(first.specialists[0].sections.Decision);
 assert.equal(first.challenge,null);assert.ok(first.failed.length<=1);
});
test('unavailable complex route fails preflight before any paid call',async()=>{
 let calls=0;const d=deps(async()=>{calls++;});d.preflight=async o=>{if(o.model==='deepseek-v4-pro')throw new Error('model unavailable');};
 await assert.rejects(executeStage(normalize(raw(1),'pilot'),d),/model unavailable/);assert.equal(calls,0);
});
test('missing provider counters stay unknown rather than zero-cost claims',async()=>{
 const out=await executeStage(normalize(raw(1),'pilot'),deps());
 assert.deepEqual(out.metrics.usage,{observedTotals:{},measuredAttempts:0,unknownAttempts:2});
});
test('review failures retain all successful specialists and mark the stage incomplete',async()=>{
 const out=await executeStage(normalize(raw(2),'pilot'),deps(async r=>r.name==='challenger'?{stopReason:'error'}:{stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))}));
 assert.equal(out.specialists.length,2);assert.deepEqual(out.failed,['challenger']);assert.equal(out.status,'incomplete');
});
test('child timeout is distinguished from user cancellation and no transport retry is started',async()=>{
 const d=deps(async r=>{if(r.name==='role-0'){await new Promise(resolve=>{r.signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,20);});return {stopReason:'aborted'};}return {stopReason:'completed',structured:valid(Object.keys(r.schema.properties.sections.properties))};});
 d.timeoutMs=5;const out=await executeStage(normalize(raw(2),'pilot'),d);
 assert.equal(out.metrics.trace.find(t=>t.name==='role-0').category,'child-timeout');assert.equal(out.metrics.trace.filter(t=>t.name==='role-0').length,1);assert.equal(out.termination,'finished');
});

test('oversized rejected answers receive bounded regeneration feedback and do not abort successful peers',async()=>{
 let attempt=0,repairSize=0;const d=deps(async r=>{
  const v=valid(Object.keys(r.schema.properties.sections.properties));
  if(r.name==='role-0' && attempt++===0)v.sections.Decision='x'.repeat(30000);
  else if(r.name==='role-0'){repairSize=r.prompt.length;assert.match(r.prompt,/rejectedAnswerOmitted/);}
  return {stopReason:'completed',structured:v};
 });
 const out=await executeStage(normalize(raw(2),'pilot'),d);assert.equal(out.status,'review-ready');assert.ok(repairSize<LIMITS.promptChars+LIMITS.repairChars);
});
