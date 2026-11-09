import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../core.mjs';
import {EvidenceStore} from '../evidence.mjs';
import {classifyIntent,calculate,tasksFor,affectedTasks} from '../recipes.mjs';
import {MissionStore,searchContext} from '../mission-store.mjs';
import {MissionEngine,validateTaskResult,taskSchema} from '../mission-engine.mjs';
import {writeWorkspace,readWorkspace,scopedPath,browserCheck,outputSnapshot,seedWorkspace} from '../workspace.mjs';
import {assertObjectJsonSchema} from '@deepseek-ai/dsh-tools';

const value=()=>({summary:'Analysis complete; inputs remain assumptions.',claims:[],artifacts:[],verdict:'complete',issues:[]});
const context={'COMPANY.md':'A synthetic company with monthly price $100.','STATE.md':'stage: 00-brief','DECISIONS.md':'No approved decision.'};
async function fixture(){const project=await realpath(await mkdtemp(join(tmpdir(),'boardroom-mission-')));const base=join(project,'.agents/skills/boardroom');await mkdir(base,{recursive:true});for(const [name,body] of Object.entries(context))await writeFile(join(base,name),body);const store=new MissionStore(project);await store.init();return {project,store};}
const create=(store,opts={})=>store.create({objective:'Compare our operating options',domain:'strategy',context,owner:'owner',...opts});
const engine=(store,execute,prepare=async()=>({skills:[],options:{model:'fixture'}}))=>new MissionEngine({store,prepare,execute:execute??(async()=>({value:value()}))});
const run=(e,id)=>e.run(id,{owner:'owner',signal:new AbortController().signal});

test('E01: evidence beyond the preview remains readable with a stable content hash',async()=>{
 const saved=[];const store=new EvidenceStore({persist:async r=>saved.push(r)}),content='p'.repeat(2000)+'DECISIVE EXCEPTION';
 const result=await store.capture('https://example.org/source',async()=>content);
 assert.equal(result.source.excerpt.includes('EXCEPTION'),false);assert.match(store.read(result.source.id,1900).text,/EXCEPTION/);assert.equal(saved[0].content,content);assert.equal(result.source.contentHash,hash(content));
});
test('E05: concurrent evidence reservations enforce the cap, deduplicate URLs, and release failures',async()=>{
 const store=new EvidenceStore({limit:2});let reads=0;
 const fetch=async()=>{reads++;await new Promise(r=>setTimeout(r,10));return 'Evidence body';};
 const pending=store.capture('https://example.org/a',fetch);const duplicate=store.capture('https://example.org/a',fetch);const second=store.capture('https://example.org/b',fetch);
 await assert.rejects(store.capture('https://example.org/c',fetch),/budget/);await Promise.all([pending,duplicate,second]);assert.equal(store.size,2);assert.equal(reads,2);
 const failed=new EvidenceStore({limit:1});await assert.rejects(failed.capture('https://example.org/fail',async()=>{throw new Error('offline');}));await failed.capture('https://example.org/ok',fetch);assert.equal(failed.size,1);
});
test('E03: a changed page creates a new immutable snapshot without overwriting old evidence',async()=>{
 const store=new EvidenceStore();const a=await store.capture('https://example.org/price',async()=>'$100 monthly');const b=await store.capture('https://example.org/price',async()=>'$120 monthly');assert.notEqual(a.source.id,b.source.id);assert.equal(store.read(a.source.id).text,'$100 monthly');assert.equal(store.size,2);
});
test('E02: facts require an actual quote; structural acceptance is labeled separately from semantic review',()=>{
 const v=value();v.claims=[{text:'Revenue is $999.',kind:'fact',sourceId:'company',quote:'Revenue is $999.'}];assert.match(validateTaskResult(v,{sources:new Map([['company',{content:'Revenue is $100.'}]])}),/quote/);assertObjectJsonSchema(taskSchema);
});
test('E04: empty and oversized source representations do not become evidence',async()=>{
 const store=new EvidenceStore();await assert.rejects(store.capture('https://example.org/empty',async()=>''),/no text/);await assert.rejects(store.capture('https://example.org/large',async()=>'x'.repeat(500001)),/budget/);assert.equal(store.size,0);
});
test('R01/R02: website delivery and conversion diagnosis select different execution modes',()=>{
 assert.deepEqual([classifyIntent('Redesign our company website to improve bookings.').domain,classifyIntent('Redesign our company website to improve bookings.').mode],['website','deliver']);
 assert.equal(classifyIntent('Our site looks fine, but nobody books.').mode,'advice');assert.equal(tasksFor('website','advice').some(t=>t.kind==='implement'),false);
});
test('R03/R04: simple finance questions avoid teams and deterministic calculations preserve units',()=>{
 assert.equal(classifyIntent('We have $12,000 cash and burn $3,000 monthly. What is our runway?').action,'calculate');assert.equal(calculate({operation:'runway',cashCents:1200000,burnCents:300000,period:'month'}).periods,4);
 assert.equal(calculate({operation:'multiply',left:20,right:100}).value,2000);assert.throws(()=>calculate({operation:'divide',left:20,right:0}));assert.equal(calculate({operation:'runway',cashCents:100,burnCents:0}).periods,null);
});
test('R05/R06: corrections attach to the active mission and real ambiguity asks one question',()=>{
 const activeMission={id:'m',domain:'website'};assert.equal(classifyIntent('Keep the structure but make it premium.',{activeMission}).action,'steer');assert.equal(classifyIntent('Help me with finance').action,'clarify');assert.equal(classifyIntent('I am unsure what direction this business should take').domain,'strategy');
});
test('O01/O02: dependencies gate implementation while independent inspection can run in parallel',()=>{
 const tasks=tasksFor('website','deliver');assert.deepEqual(tasks.filter(t=>!t.dependencies.length).map(t=>t.id),['ux','content']);assert.deepEqual(tasks.find(t=>t.id==='implementation').dependencies,['design']);assert.deepEqual([...affectedTasks(tasks,['implementation'])],['implementation','visual','verification']);
});
test('O01: actual scheduler overlaps independent tasks and orders dependent work',async()=>{
 const {store}=await fixture();try{const m=await create(store,{domain:'website',mode:'deliver'});let active=0,peak=0,entered=0,release;const both=new Promise(r=>{release=r;});const done=[];
  const e=engine(store,async(_m,t)=>{peak=Math.max(peak,++active);for(const d of t.dependencies)assert.ok(done.includes(d));if(!t.dependencies.length){if(++entered===2)release();await both;}done.push(t.id);active--;return {value:value()};});
  const result=await run(e,m.id);assert.equal(peak,2);assert.equal(result.status,'review-ready');assert.equal(result.budget.calls,6);
 }finally{await store.close();}
});
test('O03: partial work survives a failed peer and resume retries only necessary tasks',async()=>{
 const {store}=await fixture();try{const m=await create(store,{domain:'website',mode:'deliver'});let fail=true;const seen=[];
  const e=engine(store,async(_m,t)=>{seen.push(t.id);if(t.id==='content'&&fail)throw new Error('provider offline');return {value:value()};});
  assert.equal((await run(e,m.id)).status,'incomplete');assert.equal((await store.read(m.id)).tasks.find(t=>t.id==='ux').status,'complete');fail=false;seen.length=0;assert.equal((await run(e,m.id)).status,'review-ready');assert.ok(!seen.includes('ux'));
 }finally{await store.close();}
});
test('O04: interrupted ownership can recover; a live owner cannot be duplicated',async()=>{
 const {store}=await fixture();try{const m=await create(store);const first=await store.acquire(m.id,'owner');await assert.rejects(store.acquire(m.id,'other'),/already running/);await store.release(m.id,first.token);
  await store.mutate(m.id,m=>{m.lease={pid:2147483647,token:'dead'};m.tasks[0].status='running';m.tasks[0].activeAttempt='old';});assert.equal((await run(engine(store),m.id)).status,'review-ready');
 }finally{await store.close();}
});
test('O05: steering invalidates old in-flight results and preserves one mission identity',async()=>{
 const {store}=await fixture();try{const m=await create(store);let release;const started=new Promise(resolve=>{release=resolve;});let gate;
  const e=engine(store,async(_m,t,{revision,signal})=>{if(revision===1&&t.id==='options'){release();await new Promise(r=>{gate=r;signal.addEventListener('abort',r,{once:true});});}return {value:{...value(),summary:'Revision '+revision}};});
  const pending=run(e,m.id);await started;await store.steer(m.id,{message:'Change the target customer'});e.interrupt(m.id);gate();const out=await pending;
  assert.equal(out.revision,2);assert.equal(out.status,'review-ready');const saved=await store.read(m.id);assert.ok(saved.events.some(e=>e.type==='stale-result-discarded'));assert.equal(saved.tasks[0].result.summary,'Revision 2');
 }finally{await store.close();}
});
test('O06: idempotent starts do not create duplicate missions or accept a changed payload',async()=>{
 const {store}=await fixture();try{const a=await create(store,{requestId:'request-1'}),b=await create(store,{requestId:'request-1'});assert.equal(a.id,b.id);await assert.rejects(create(store,{requestId:'request-1',objective:'Different task'}),/different work/);}finally{await store.close();}
});
test('M01: changing a bound skill invalidates completed work and dependent review',async()=>{
 const {store}=await fixture();try{const m=await create(store);let digest='old';const seen=[];
  const e=engine(store,async(_m,t)=>{seen.push(t.id);return {value:value()};},async()=>({skills:[{name:'skill',digest}],options:{model:'fixture'}}));
  await run(e,m.id);seen.length=0;await run(e,m.id);assert.deepEqual(seen,[]);digest='new';await run(e,m.id);assert.deepEqual(seen,['options','verification']);
 }finally{await store.close();}
});
test('M02/M03: retrieval finds old decisions and returns source locations without overwriting history',()=>{
 const c={...context,'DECISIONS.md':'2025 | pricing | Reject subscriptions\n'+Array(30).fill('Routine unrelated update').join('\n')+'\n2026 | pricing | Supersedes 2025: accept subscriptions'};
 const rows=searchContext(c,'subscriptions');assert.equal(rows.length,2);assert.match(rows[0].text,/2026/);assert.match(rows[1].text,/2025/);
});
test('M04/M05: another store instance recovers durable state, while another project cannot read it',async()=>{
 const a=await fixture(),b=await fixture();let reopened;try{const m=await create(a.store);await run(engine(a.store),m.id);reopened=new MissionStore(a.project);assert.equal((await reopened.read(m.id)).status,'review-ready');await assert.rejects(b.store.read(m.id),/not found/);}finally{await reopened?.close();await a.store.close();await b.store.close();}
});
test('D05: missing usage stays unknown and budget exhaustion preserves partial work',async()=>{
 const {store}=await fixture();try{const m=await create(store,{maxCalls:1});const out=await run(engine(store),m.id);assert.equal(out.status,'incomplete');assert.equal(out.usage.unknownAttempts,1);assert.equal(out.budget.calls,1);assert.deepEqual(out.usage.observed,{});}finally{await store.close();}
});
test('D06: only review-ready work can be accepted; cancellation is a distinct terminal state',async()=>{
 const {store}=await fixture();try{const m=await create(store);await assert.rejects(store.decide(m.id,{decision:'accept',note:'Yes'}),/review-ready/);await run(engine(store),m.id);await store.decide(m.id,{decision:'accept',note:'Accept this draft'});assert.equal((await store.read(m.id)).status,'accepted');await assert.rejects(store.acquire(m.id,'owner'),/closed/);
  const n=await create(store);await store.pause(n.id,true);assert.equal((await store.read(n.id)).status,'cancelled');await assert.rejects(store.pause(n.id),/closed/);await assert.rejects(store.decide(n.id,{decision:'revise',note:'Revise it'}),/closed/);
 }finally{await store.close();}
});
test('M06: proposed lessons are excluded until validated and rejected memories stay out of retrieval',async()=>{
 const {store}=await fixture();try{const m=await create(store);await run(engine(store),m.id);await store.decide(m.id,{decision:'accept',note:'Accept the options report'});const note=await store.remember({sourceMission:m.id,text:'Check subscriptions against the current contract.'});assert.equal((await store.memory('subscriptions')).length,0);await store.validateMemory(note.id,'validate');assert.equal((await store.memory('subscriptions')).length,1);await store.validateMemory(note.id,'reject');assert.equal((await store.memory('subscriptions')).length,0);}finally{await store.close();}
});
test('Saved historical evidence does not consume the next execution’s fresh-source reservations',async()=>{
 const a=new EvidenceStore({limit:1});const original=await a.capture('https://example.org/a',async()=>'$100');const b=new EvidenceStore({limit:1});b.seed(original.source,'$100',{historical:true});const changed=await b.capture('https://example.org/a',async()=>'$120');assert.notEqual(original.source.id,changed.source.id);assert.equal(b.read(original.source.id).text,'$100');await assert.rejects(b.capture('https://example.org/b',async()=>'Another source'),/budget/);
});
test('Reviewer corrections trigger one bounded rework rather than endless debate',async()=>{
 const {store}=await fixture();try{const m=await create(store);const out=await run(engine(store,async(_m,t)=>({value:{...value(),verdict:t.kind==='review'?'changes-requested':'complete',issues:t.kind==='review'?['Unsupported assumption']:[]}})),m.id);assert.equal(out.status,'needs-input');assert.equal(out.budget.calls,4);}finally{await store.close();}
});
test('Workspace writes require current hashes and cannot escape or follow symlinks',async()=>{
 const {store}=await fixture();try{const m=await create(store),root=join(store.path(m.id),'workspace');const initial=await writeWorkspace(root,'index.html','<h1>Hello</h1>');await assert.rejects(writeWorkspace(root,'index.html','replace'),/contentHash/);await writeWorkspace(root,'index.html','<h1>Updated</h1>',initial.contentHash);assert.match((await readWorkspace(root,'index.html')).text,/Updated/);await assert.rejects(writeWorkspace(root,'../outside.html','x'),/escapes/);await assert.rejects(writeWorkspace(root,'.env','secret'),/extension|Protected/);await symlink('/tmp',join(root,'escape'));await assert.rejects(scopedPath(root,'escape/file.html',{create:true}),/symlinks/);}finally{await store.close();}
});
test('D01: a real browser checks desktop/mobile artifacts and reports overflow',async()=>{
 const {store}=await fixture();try{const m=await create(store),root=join(store.path(m.id),'workspace'),artifactDir=join(store.path(m.id),'artifacts');const first=await writeWorkspace(root,'index.html','<!doctype html><html><head><title>Boardroom fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Book a consultation</h1><a href="#contact">Contact</a></main><section id="contact">Call us</section></body></html>');const good=await browserCheck(root,{artifactDir});assert.equal(good.passed,true);assert.equal(good.views.length,2);await writeWorkspace(root,'index.html','<html><body><div style="width:3000px">Overflow test</div></body></html>',first.contentHash);assert.equal((await browserCheck(root,{artifactDir})).passed,false);}finally{await store.close();}
});

test('workspace snapshots detect edited or added files beyond reported artifacts',async()=>{
 const {store}=await fixture();try{const m=await create(store),root=join(store.path(m.id),'workspace');await writeWorkspace(root,'index.html','<h1>Original</h1>');const before=await outputSnapshot(store.path(m.id),[],{workspace:true});await writeWorkspace(root,'style.css','h1 { color: red; }');const after=await outputSnapshot(store.path(m.id),[],{workspace:true});assert.notEqual(before.workspaceHash,after.workspaceHash);}finally{await store.close();}
});
test('interrupted source copying resumes identical files and refuses to overwrite different bytes',async()=>{
 const {project,store}=await fixture();try{const m=await create(store),root=join(store.path(m.id),'workspace'),source=join(project,'site');await mkdir(source);await writeFile(join(source,'index.html'),'<h1>Source</h1>');const first=await seedWorkspace(project,'site',root);assert.deepEqual(await seedWorkspace(project,'site',root),first);await writeFile(join(root,'index.html'),'<h1>Changed locally</h1>');await assert.rejects(seedWorkspace(project,'site',root));assert.equal(await readFile(join(source,'index.html'),'utf8'),'<h1>Source</h1>');}finally{await store.close();}
});
