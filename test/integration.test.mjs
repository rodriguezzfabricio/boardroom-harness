import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,access,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {defineTool} from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as Filesystem from '@deepseek-ai/dsh-skill-filesystem';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import {createScope,scopeTarget} from '@deepseek-ai/dsh-scope';
import {apply,rankSkills} from '../plugin.mjs';
const project=process.cwd();
const dummy=name=>defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_a,x)=>[{type:'text',text:x}]},execute:async()=>''});
async function setup(cwd=project, childRun){
 const ctx=new Context();const fibers=[ctx.plugin(SystemPrompt,{}),ctx.plugin(Tools,{}),ctx.plugin(SkillRegistry,{}),ctx.plugin(LocalAttachmentStore,{dshHome:join(cwd,'.test-attachments')})];for(const fiber of fibers)await fiber.await();
 let agent,scope;
 ctx.provide('llm',{resolveCallConfig:async x=>x,listProviders:()=>[{id:'test-vision'}],listModels:async()=>[{id:'vision-mini',inputModalities:['text','image']}],resolveModelInfo:async(provider)=>({inputModalities:provider==='test-vision'?['text','image']:['text']})});ctx.provide('subagents',{start:childRun});
 const owner=ctx.plugin({inject:['tools','skills','llm','subagents'],apply(ownerCtx){
  agent={id:'parent',session:{header:{cwd,id:'parent'},seq:0,surface:{nodes:[]},requestHeader:()=>undefined}};
  scope=createScope(ownerCtx,agent);agent.ctx=scope.ctx;agent.options={provider:'deepseek-official',model:'deepseek-v4-pro'};
  SkillTool.apply(ownerCtx,{});ownerCtx.tools.register(dummy('bash'));ownerCtx.tools.register(dummy('workflow'));
  Filesystem.apply(ownerCtx,{watch:false});
  apply(ownerCtx,{projects:[cwd]});
 }});await owner.await();fibers.push(owner);
 await ctx.serial(scopeTarget(agent,agent),'agent/created',{agent,source:'startup'});
 return {ctx,agent,scope,stop:async()=>{for(const fiber of fibers.reverse())await fiber.dispose();}};
}
test('real tool registry shadows skill only inside managed project and hides child tools',async()=>{
 const {ctx,agent,scope,stop}=await setup();
 try {
  assert.notEqual(ctx.tools.get('skill',agent),ctx.tools.get('skill'));
  assert.ok(ctx.tools.get('skill_search',agent));assert.ok(ctx.tools.get('boardroom_run',agent));
  const child={id:'child'};const childScope=createScope(agent.ctx,child,{parent:agent});
  childScope.ctx.tools.restrict({allow:[]});childScope.ctx.tools.presentAs('native');childScope.ctx.tools.register(dummy('structured_output'));
  for(const n of ['skill','skill_search','bash','workflow','boardroom_run'])assert.equal(ctx.tools.get(n,child),undefined,n);
  assert.ok(ctx.tools.get('structured_output',child));await childScope.dispose();
 }finally{await scope.dispose();await stop();}
});
test('upstream catalog middleware emits zero catalog messages for scoped lead',async()=>{
 const {ctx,agent,scope,stop}=await setup();
 try{
  // Waterfall must reach a terminal step decision just as the agent loop does.
  const result=await ctx.waterfall(scopeTarget(agent,agent),'agent/pre-step',{agent,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}));
  assert.equal(result.messages.length,0);
 }finally{await scope.dispose();await stop();}
});
test('bounded search ranks exact names first',()=>{const skills=Array.from({length:601},(_,i)=>({name:'skill-'+i,description:'Business pricing analysis'}));const result=rankSkills(skills,'skill-500');assert.equal(result.length,5);assert.equal(result[0].name,'skill-500');assert.ok(JSON.stringify(result).length<2000);});

async function fixture(){
 await mkdir(join(process.cwd(),'work'),{recursive:true});
 const cwd=await mkdtemp(join(process.cwd(),'work/boardroom-fixture-'));
 const base=join(cwd,'.agents/skills/boardroom');await mkdir(base,{recursive:true});
 for(const name of ['boardroom-visual-review','boardroom-corporate-legal','boardroom-tax-preparation','boardroom-local-crm','kwp-smb-contract-review','financial-analyst','kwp-legal-compliance-check','pm-strategy-red-team','pm-business-model','pm-north-star-metric','frontend-design','cro','copywriting'])await symlink(fileURLToPath(new URL('../skills/'+name,import.meta.url)),join(cwd,'.agents/skills',name));
 for(const [file,text] of Object.entries({'COMPANY.md':'Company test, unverified','STATE.md':'stage: 0','DECISIONS.md':'No decision yet'}))await writeFile(join(base,file),text);
 return {cwd,base};
}
const request={stage:'01-plan',question:'Which assumption needs testing?',specialists:[{name:'cfo',persona:'Assess costs',focus:'Assess cost assumptions',headings:['Assumptions']}],evidence:[]};
test('controller persists results, keeps state unchanged, disposes children and reuses checkpoints',async()=>{
 const {cwd,base}=await fixture();let called=0,disposed=0;
 const {ctx,agent,scope,stop}=await setup(cwd,async(provider,req)=>{
  called++;assert.equal(provider,'spawn');assert.deepEqual(req.toolFilter,{allow:['skill']});assert.equal(req.maxDepth,1);
  assert.ok(req.signal instanceof AbortSignal);assert.ok(req.agentOptions.maxTokens<=10000);
  return {result:Promise.resolve({stopReason:'completed',structured:{sections:Object.fromEntries(Object.keys(req.outputSchema.properties.sections.properties).map(h=>[h,'Unknown [estimate]'])),claims:[],uncertainties:['No evidence']}}),dispose:async()=>{disposed++;}};
 });
 try{
  const tool=ctx.tools.get('boardroom_run',agent),exec={agent,signal:new AbortController().signal};
  const first=await tool.execute(request,exec);assert.equal(first.status,'review-ready');assert.equal(called,2);assert.equal(disposed,2);
  const record=JSON.parse(await readFile(first.record));assert.equal(record.metrics.trace.length,2);
  const second=await tool.execute(request,exec);assert.equal(second.metrics.calls,0);assert.equal(called,2);
  assert.equal(await readFile(join(base,'STATE.md'),'utf8'),'stage: 0');
  assert.equal(await readFile(join(base,'DECISIONS.md'),'utf8'),'No decision yet');
  await assert.rejects(access(join(base,'.runtime/run.lock')));
  await writeFile(join(base,'STATE.md'),'stage: 1');await tool.execute(request,exec);assert.equal(called,4);
 }finally{await scope.dispose();await stop();}
});
test('controller refuses duplicate process locks without spawning',async()=>{
 const {cwd,base}=await fixture();await mkdir(join(base,'.runtime'));await writeFile(join(base,'.runtime/run.lock'),'existing lock');
 const {ctx,agent,scope,stop}=await setup(cwd,async()=>{assert.fail('must not spawn');});
 try{await assert.rejects(ctx.tools.get('boardroom_run',agent).execute(request,{agent,signal:new AbortController().signal}),/run is active/);assert.equal(await readFile(join(base,'.runtime/run.lock'),'utf8'),'existing lock');}finally{await scope.dispose();await stop();}
});

test('explicit /boardroom gesture still loads instructions with no catalog',async()=>{
 const {cwd,base}=await fixture();await writeFile(join(base,'SKILL.md'),'---\nname: boardroom\ndescription: Test entry\nuser-invocable: true\n---\nBOARDROOM TEST INSTRUCTIONS');
 const {ctx,agent,scope,stop}=await setup(cwd);
 try{
  const messages=[{source:{kind:'user'},content:[{type:'text',text:'/boardroom'}]}];
  const result=await ctx.waterfall(scopeTarget(agent,agent),'agent/pre-step',{agent,messages,signal:new AbortController().signal},async()=>({kind:'enter',messages}));
  assert.equal(result.messages.filter(m=>m.source.kind==='skill-catalog').length,0);
  assert.equal(result.messages.filter(m=>m.source.kind==='skill-invocation').length,1);
  assert.ok(result.messages.some(m=>m.content.some(c=>c.text?.includes('BOARDROOM TEST INSTRUCTIONS'))));
 }finally{await scope.dispose();await stop();}
});

import { attachContractGuard, collectTelemetry } from '../plugin.mjs';
import { normalize, schema, hash, VERSION } from '../core.mjs';
import { atomic, serialWriter, loadResume, readCache } from '../storage.mjs';
const answer=headings=>({sections:Object.fromEntries(headings.map(h=>[h,'Unproven [estimate].'])),claims:[],uncertainties:['Demand untested.']});
const goodChild=async(_provider,req)=>({result:Promise.resolve({stopReason:'completed',structured:answer(Object.keys(req.outputSchema.properties.sections.properties))}),dispose:async()=>{}});

test('real tool execution rejects nine uncertainties before terminal capture, accepts corrected answer',async()=>{
 const {ctx,agent,scope,stop}=await setup();let captured=0;
 const child={id:'guard-child'},childScope=createScope(agent.ctx,child,{parent:agent});child.ctx=childScope.ctx;
 const contract=schema(['Decision']);
 child.ctx.tools.register({name:'structured_output',description:'Final answer',parameters:contract,output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>{captured++;return true;}});
 const telemetry=attachContractGuard(child,contract);
 try {
  const bad=answer(['Decision']);bad.uncertainties=Array(9).fill('Demand');
  const rejected=await ctx.tools.execute({callId:'bad',name:'structured_output',arguments:bad,agent:child,signal:new AbortController().signal});
  assert.equal(rejected.isError,true);assert.equal(captured,0);assert.match(JSON.stringify(rejected),/9 items; maximum 5/);
  const accepted=await ctx.tools.execute({callId:'good',name:'structured_output',arguments:answer(['Decision']),agent:child,signal:new AbortController().signal});
  assert.ok(!accepted.isError);assert.equal(captured,1);assert.equal(telemetry.contractErrors.length,1);
 } finally {await childScope.dispose();await scope.dispose();await stop();}
});
test('request-step guard never admits a ninth provider request',async()=>{
 const {ctx,agent,scope,stop}=await setup();const telemetry=attachContractGuard(agent,schema(['Decision']));let admitted=0;
 try {
  for(let i=0;i<8;i++)await ctx.waterfall(scopeTarget(agent,agent),'agent/request',{agent},async()=>{admitted++;return {};});
  await assert.rejects(ctx.waterfall(scopeTarget(agent,agent),'agent/request',{agent},async()=>{admitted++;return {};}),/request-step budget/);
  assert.equal(admitted,8);assert.equal(telemetry.modelRequests,8);
 }finally{await scope.dispose();await stop();}
});
test('changing one role preserves other cached roles and invalidates the assembled review',async()=>{
 const {cwd}=await fixture();const seen=[];const {ctx,agent,scope,stop}=await setup(cwd,async(p,r)=>{seen.push(r.label);return goodChild(p,r);});
 try{
  const two={...request,specialists:[...request.specialists,{...request.specialists[0],name:'pm'}]};
  const tool=ctx.tools.get('boardroom_run',agent),exec={agent,signal:new AbortController().signal};
  await tool.execute(two,exec);seen.length=0;
  const changed=structuredClone(two);changed.specialists[0].focus='A different finance task';
  const out=await tool.execute(changed,exec);
  assert.ok(seen.includes('boardroom:cfo'));assert.ok(!seen.includes('boardroom:pm'));
  // In this deterministic fixture the changed CFO answer is identical, so reuse
  // of the identical assembled review is correct. A new reviewer focus invalidates it.
  assert.equal(out.metrics.cacheHits,2);
  seen.length=0;await tool.execute({...changed,reviewFocus:'Check demand'},exec);assert.deepEqual(seen,['boardroom:challenger']);
 }finally{await scope.dispose();await stop();}
});
test('resume retains the full roster and completed peers, then reviews the assembled result',async()=>{
 const {cwd,base}=await fixture();let broken=true;const seen=[];
 const {ctx,agent,scope,stop}=await setup(cwd,async(p,r)=>{seen.push(r.label);if(broken&&r.label==='boardroom:ceo')return {result:Promise.resolve({stopReason:'aborted'}),dispose:async()=>{}};return goodChild(p,r);});
 try{
  const exec={agent,signal:new AbortController().signal};
  const first=await ctx.tools.get('boardroom_run',agent).execute({...request,specialists:[...request.specialists,{...request.specialists[0],name:'ceo'}]},exec);
  assert.deepEqual(first.failed,['ceo']);broken=false;seen.length=0;
  const result=await ctx.tools.get('boardroom_resume',agent).execute({runId:first.runId},exec);
  assert.equal(result.status,'review-ready');assert.deepEqual(result.specialists.map(s=>s.name),['cfo','ceo']);
  assert.deepEqual(seen,['boardroom:ceo','boardroom:challenger']);assert.equal(result.metrics.resumedRoles,1);
  assert.equal(result.resumedFrom,first.runId);
  await writeFile(join(base,'STATE.md'),'stage: changed');
  await assert.rejects(ctx.tools.get('boardroom_resume',agent).execute({runId:first.runId},exec),/context changed/);
 }finally{await scope.dispose();await stop();}
});
test('legacy 2.0.2 resume requires matching project state, preserves explicit origin and rejects stale work',async()=>{
 const {cwd,base}=await fixture();const root=join(base,'.runtime');const runId='12345678-1234-1234-1234-123456789abc';const dir=join(root,'runs',runId);await mkdir(dir,{recursive:true});
 const company='Company test, unverified',state='stage: 0',decisions='No decision yet';
 const input={...normalize(request,company),version:'2.0.2'};
 const saved={runId,version:'2.0.2',input,fingerprint:hash({project:cwd,state,decisions,input,version:'2.0.2'})};
 await atomic(join(dir,'request.json'),saved);await atomic(join(dir,'result.json'),{specialists:[{name:'cfo',...answer(['Assumptions'])}]});
 const resumed=await loadResume({root,runId,project:cwd,state,decisions,company});assert.equal(Object.keys(resumed.resume).length,0); // New connections require fresh work, not a tool-less legacy answer.
 assert.equal(Object.keys((await loadResume({root,runId,project:cwd,state,decisions,company,complexRoles:['cfo']})).resume).length,0);
 await assert.rejects(loadResume({root,runId,project:cwd,state:'different',decisions,company}),/context changed/);
 await atomic(join(dir,'request.json'),{...saved,createdAt:Date.now()-86400001});
 await assert.rejects(loadResume({root,runId,project:cwd,state,decisions,company}),/older than 24 hours/);
});
test('preflight failure persists an incomplete latest record and releases the lock',async()=>{
 const {cwd,base}=await fixture();const {ctx,agent,scope,stop}=await setup(cwd,async()=>assert.fail('no spawn'));
 ctx.llm.resolveCallConfig=async()=>{throw new Error('missing provider route');};
 try{
  await assert.rejects(ctx.tools.get('boardroom_run',agent).execute(request,{agent,signal:new AbortController().signal}),/missing provider route/);
  const latest=JSON.parse(await readFile(join(base,'.runtime/latest.json')));assert.equal(latest.status,'incomplete');
  const saved=JSON.parse(await readFile(latest.record));assert.equal(saved.termination,'runtime-error');assert.match(saved.error.message,/missing provider/);
  await assert.rejects(access(join(base,'.runtime/run.lock')));
 }finally{await scope.dispose();await stop();}
});
test('serialized checkpoints cannot overwrite a newer result with a slower old write',async()=>{
 const seen=[];const write=serialWriter(async x=>{await new Promise(r=>setTimeout(r,x.n===1?10:0));seen.push(x.n);});
 const old={n:1};const first=write(old);old.n=99;await Promise.all([first,write({n:2})]);assert.deepEqual(seen,[1,2]);
});
test('cache rejects corrupt, expired and future entries without treating them as completed work',async()=>{
 const {base}=await fixture(),dir=join(base,'cache');await mkdir(dir);
 for(const value of [null,{key:'k',value:{},digest:'wrong',createdAt:Date.now()},{key:'k',value:{},digest:hash({}),createdAt:Date.now()-86400001},{key:'k',value:{},digest:hash({}),createdAt:Date.now()+60000}]){
  await atomic(join(dir,'k.json'),value);assert.equal(await readCache(dir,'k'),null);
 }
});
test('telemetry reports actual resolved route, visible tools and known token counters',()=>{
 const x=collectTelemetry([{type:'request/header',data:{header:{config:{provider:'deepseek-official',model:'deepseek-flash'},tools:[{name:'structured_output'}]}}},{type:'assistant/message',data:{usage:{totalTokens:123}}},{type:'step/start',data:{}}]);
 assert.equal(x.telemetry.resolvedRequests[0].model,'deepseek-flash');assert.deepEqual(x.telemetry.resolvedRequests[0].tools,['structured_output']);assert.equal(x.usage.totalTokens,123);assert.equal(x.telemetry.loggedSteps,1);
});

test('resume refuses edited saved requests even when business context is unchanged',async()=>{
 const {cwd,base}=await fixture();const {ctx,agent,scope,stop}=await setup(cwd,goodChild);
 try{
  const exec={agent,signal:new AbortController().signal},first=await ctx.tools.get('boardroom_run',agent).execute(request,exec);
  const file=join(base,'.runtime/runs',first.runId,'request.json');const saved=JSON.parse(await readFile(file));saved.input.question='An unrelated decision';await atomic(file,saved);
  await assert.rejects(ctx.tools.get('boardroom_resume',agent).execute({runId:first.runId},exec),/context changed/);
 }finally{await scope.dispose();await stop();}
});

import {installConnections,recommendedSkills,resolveSkills} from '../connections.mjs';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
test('ordinary delegated legal agent receives full installed instructions before its first request',async()=>{
 const {cwd}=await fixture();const {ctx,agent,scope,stop}=await setup(cwd);
 const child={id:'ordinary-researcher',session:{header:{cwd,parentSession:'parent'},surface:{nodes:[]}}};
 const cs=createScope(agent.ctx,child,{parent:agent});child.ctx=cs.ctx;
 try{
  await ctx.serial(scopeTarget(child,child),'agent/created',{agent:child,source:'subagent'});
  const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Research CAN-SPAM preemption using primary sources.'}]})];
  const out=await ctx.waterfall(scopeTarget(child,child),'agent/pre-step',{agent:child,messages,signal:new AbortController().signal},async()=>({kind:'enter',messages}));
  const loaded=out.messages.filter(x=>x.source?.kind==='skill-invocation');
  assert.equal(loaded.length,1);assert.equal(loaded[0].source.name,'kwp-legal-compliance-check');assert.ok(loaded[0].content[0].text.length>1000);
  assert.equal(out.messages.filter(x=>x.source?.kind==='skill-catalog').length,0);
  const connections=await ctx.tools.get('agent_connections',child).execute({}, {agent:child});assert.ok(connections.loadedSkills.some(x=>x.name==='kwp-legal-compliance-check'));
 }finally{await cs.dispose();await scope.dispose();await stop();}
});
test('fresh research traverses native guards, creates citeable evidence only on success, and records tools separately from skill loading',async()=>{
 const {ctx,agent,scope,stop}=await setup();let shouldFail=false,captured=0,blockedPage=false;
 ctx.tools.register(defineTool({name:'web_fetch',description:'Test native fetch',parameters:{url:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,x)=>[{type:'text',text:x}]},execute:async()=>{if(shouldFail)throw new Error('unavailable');return blockedPage?'Fetched https://example.org/blocked-page (HTTP 403)\nAccess denied':'Primary source text for test';}}));
 const child={id:'fresh-researcher',session:{header:{cwd:project,parentSession:'parent'}}},cs=createScope(agent.ctx,child,{parent:agent});child.ctx=cs.ctx;
 const ids=new Set(['company']),ledger=new Map(),contract=schema(['Finding'],['company'],true),telemetry=attachContractGuard(child,contract,ids);
 child.ctx.tools.restrict({allow:['skill','web_fetch']});
 installConnections(ctx,child,{rankSkills,boardroom:true,telemetry,ids,ledger});
 child.ctx.tools.register({name:'structured_output',description:'Final',parameters:contract,output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>{captured++;return true;}});
 const run=(name,args)=>ctx.tools.execute({name,arguments:args,agent:child,callId:'test-'+Math.random(),signal:new AbortController().signal});
 try{
  const fake=answer(['Finding']);fake.claims=[{text:'Invented citation',kind:'fact',sources:['web-invented']}];assert.equal((await run('structured_output',fake)).isError,true);assert.equal(captured,0);
  const fetched=await run('research_read',{url:'https://example.org/source'});assert.ok(!fetched.isError);assert.equal(ledger.size,1);
  const source=[...ledger.values()][0];assert.ok(ids.has(source.id));const valid=answer(['Finding']);valid.claims=[{text:'Test source exists',kind:'fact',sources:[source.id]}];assert.ok(!(await run('structured_output',valid)).isError);assert.equal(captured,1);
  shouldFail=true;assert.equal((await run('research_read',{url:'https://example.org/failure'})).isError,true);assert.equal(ledger.size,1);
  const disposeGuard=child.ctx.tools.guard(exec=>exec.name==='web_fetch'?'Native policy blocks this fetch':undefined);
  shouldFail=false;assert.equal((await run('research_read',{url:'https://example.org/blocked'})).isError,true);assert.equal(ledger.size,1);disposeGuard();
  blockedPage=true;assert.equal((await run('research_read',{url:'https://example.org/blocked-page'})).isError,true);assert.equal(ledger.size,1);
  assert.ok(telemetry.toolCalls.some(x=>x.name==='web_fetch'&&!x.isError));assert.equal(telemetry.skillsLoaded.length,0);assert.equal(ctx.tools.get('bash',child),undefined);
 }finally{await cs.dispose();await scope.dispose();await stop();}
});

test('unknown specialist requires an explicit installed skill before any paid child starts',async()=>{
 const {cwd}=await fixture();const {ctx,agent,scope,stop}=await setup(cwd,async()=>assert.fail('must not spend before skill selection'));
 try{await assert.rejects(ctx.tools.get('boardroom_run',agent).execute({...request,specialists:[{...request.specialists[0],name:'special-domain'}]},{agent,signal:new AbortController().signal}),/Select at least one relevant installed skill/);}
 finally{await scope.dispose();await stop();}
});

test('mission workers receive actual scoped tools and loaded skills; website delivery requires a real browser check',async()=>{
 const {cwd}=await fixture();let host;const seen=[];
 host=await setup(cwd,async(_provider,req)=>{
  const taskId=req.label.split(':')[2];seen.push(taskId);
  const child={id:'mission-'+taskId,options:req.agentOptions,session:{header:{cwd,parentSession:'parent'},surface:{nodes:[]},snapshotEvents:()=>[],requestHeader:()=>undefined}};
  const cs=createScope(host.agent.ctx,child,{parent:host.agent});child.ctx=cs.ctx;child.ctx.tools.restrict(req.toolFilter);
  child.ctx.tools.register({name:'structured_output',description:'Final',parameters:req.outputSchema,output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>true});
  await host.ctx.serial(scopeTarget(child,child),'agent/created',{agent:child,source:'subagent'});
  const messages=[createUserMessage({source:{kind:'user'},content:req.prompt})];
  const enriched=await host.ctx.waterfall(scopeTarget(child,child),'agent/pre-step',{agent:child,messages,signal:req.signal},async()=>({kind:'enter',messages}));
  assert.ok(enriched.messages.some(x=>x.source?.kind==='skill-invocation'));
  assert.ok(host.ctx.tools.get('evidence_read',child));assert.equal(Boolean(host.ctx.tools.get('workspace_write',child)),taskId==='implementation');
  const call=async(name,args)=>{const result=await host.ctx.tools.execute({name,arguments:args,agent:child,callId:taskId+'-'+name,signal:req.signal});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const artifacts=[];
  if(taskId==='ux'){const saved=await call('artifact_write',{name:'ux-report.md',content:'The decisive UX finding is beyond the summary and must remain inspectable.'});artifacts.push({path:saved.path,description:'Full UX report'});}
  if(taskId==='design'){
   const text=req.prompt[0].text;const match=text.match(/"path":"([^\"]+ux-report\.md)"/);assert.ok(match);
   const report=await call('artifact_read',{path:match[1]});assert.match(report.text,/decisive UX finding/);
  }
  if(taskId==='implementation'){
   const listing=await call('workspace_list',{}),expectedHash=listing.files.includes('index.html')?(await call('workspace_read',{path:'index.html'})).contentHash:undefined;
   const written=await call('workspace_write',{path:'index.html',content:'<!doctype html><html><head><title>Mission test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Book a visit</h1><a href="#contact">Contact</a><p id="contact">Test artifact</p></body></html>',...expectedHash?{expectedHash}:{}});artifacts.push({path:written.absolutePath,description:'Actual generated HTML'});
  }
  if(taskId==='visual'){const check=await call('browser_check',{});for(const view of check.views){const opened=await host.ctx.tools.execute({name:'screenshot_open',arguments:{path:view.screenshot},agent:child,callId:'open-'+view.viewport.width,signal:req.signal});assert.ok(!opened.isError,JSON.stringify(opened));assert.ok(opened.content.some(block=>block.type==='image'),'Actual image must enter the child context');}}
  if(taskId==='verification'){const result=await call('browser_check',{});assert.equal(result.passed,true);}
  if(!artifacts.length){const report=await call('artifact_write',{name:'report.md',content:'Fixture task '+taskId+' inspected the supplied brief and recorded the outcome for independent review.'});artifacts.push({path:report.path,description:'Reviewable fixture report'});}
  const value={summary:'Completed the assigned task with actual tools.',claims:[],artifacts,verdict:'complete',issues:[]};
  const accepted=await host.ctx.tools.execute({name:'structured_output',arguments:value,agent:child,callId:taskId+'-final',signal:req.signal});assert.ok(!accepted.isError);
  return {localAgent:child,result:Promise.resolve({stopReason:'completed',structured:value}),dispose:()=>cs.dispose()};
 });
 try{
  const out=await host.ctx.tools.get('boardroom_start',host.agent).execute({objective:'Redesign our website to improve bookings',background:false},{agent:host.agent,signal:new AbortController().signal});
  assert.equal(out.status,'review-ready');assert.deepEqual(seen.slice(0,2).sort(),['content','ux']);assert.ok(seen.indexOf('implementation')>seen.indexOf('design'));assert.equal(host.ctx.tools.get('workspace_write',host.agent),undefined);
  const saved=JSON.parse(await readFile(out.record));assert.ok(saved.tasks.find(t=>t.id==='verification').result.verification.browserChecks[0].passed);assert.equal(saved.tasks.find(t=>t.id==='visual').result.verification.visualReview.views.length,2);
  seen.length=0;
  await host.ctx.tools.get('boardroom_continue',host.agent).execute({missionId:out.missionId,background:false},{agent:host.agent,signal:new AbortController().signal});assert.deepEqual(seen,[]);
  await writeFile(saved.tasks.find(t=>t.id==='ux').result.artifacts[0].path,'Changed after the review.');
  const resumed=await host.ctx.tools.get('boardroom_continue',host.agent).execute({missionId:out.missionId,background:false},{agent:host.agent,signal:new AbortController().signal});
  assert.equal(resumed.status,'review-ready');assert.deepEqual(seen,['ux','design','implementation','visual','verification']);
 }finally{await host.scope.dispose();await host.stop();}
});

test('installed skill references are readable in scope and edits change the bound skill digest',async()=>{
 const {cwd}=await fixture(),base=join(cwd,'.agents/skills/reference-test');await mkdir(join(base,'references'),{recursive:true});
 await writeFile(join(base,'SKILL.md'),'---\nname: reference-test\ndescription: Resource test\n---\nRead references/guide.md.');
 await writeFile(join(base,'references/guide.md'),'Original reference instruction.');
 const host=await setup(cwd);
 try{
  const signal=new AbortController().signal,first=(await resolveSkills(host.ctx,host.agent,['reference-test'],signal)).loaded[0];
  const tool=host.ctx.tools.get('skill_reference',host.agent),exec={agent:host.agent,signal};
  assert.equal((await tool.execute({skill:'reference-test',path:'references/guide.md'},exec)).text,'Original reference instruction.');
  await assert.rejects(tool.execute({skill:'reference-test',path:'../../../outside.md'},exec),/escapes/);
  await writeFile(join(base,'references/guide.md'),'Corrected reference instruction.');
  const next=(await resolveSkills(host.ctx,host.agent,['reference-test'],signal)).loaded[0];assert.notEqual(first.digest,next.digest);
 }finally{await host.scope.dispose();await host.stop();}
});

test('background mission returns before workers settle and reports durable completion through job hooks',async()=>{
 const {cwd}=await fixture();let release,started;const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});
 const {ctx,agent,scope,stop}=await setup(cwd,async()=>{started();await gate;return {result:Promise.resolve({stopReason:'completed',structured:{summary:'Bounded advice based on the supplied brief.',claims:[{text:'A bounded pilot is a provisional recommendation requiring validation.',kind:'estimate',sourceId:'',quote:''}],artifacts:[],verdict:'complete',issues:[]}}),dispose:async()=>{}};});
 const jobs=[];ctx.provide('jobs',{start(spec){assert.equal(spec.owner,agent.id);const hooks=spec.run({updateProgress(){},append(){}});jobs.push(hooks);return 'workflow-test';}});
 try{
  const exec={agent,signal:new AbortController().signal};const out=await ctx.tools.get('boardroom_start',agent).execute({objective:'Compare our business options',domain:'strategy'},exec);
  assert.equal(out.status,'queued');assert.equal(out.jobId,'workflow-test');await began;const status=await ctx.tools.get('boardroom_status',agent).execute({missionId:out.missionId},exec);assert.equal(status.status,'running');release();const settled=await jobs[0].done;assert.equal(settled.status,'completed');assert.equal(JSON.parse(settled.result).status,'review-ready');
 }finally{release();await scope.dispose();await stop();}
});

import {assertUserDecision} from '../missions.mjs';
test('agent statements and memories cannot impersonate the latest user decision',()=>{
 const agent={session:{snapshotEvents:()=>[{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Please revise the copy.'}]}},{type:'user/message',data:{source:{kind:'agent'},content:[{type:'text',text:'Accept it.'}]}}]}};
 assert.throws(()=>assertUserDecision(agent,'Accept it.'),/actual user/);assert.doesNotThrow(()=>assertUserDecision(agent,'Please revise the copy.'));
});

test('legacy stage resume invalidates completed roles after full skill instructions change',async()=>{
 const {cwd,base}=await fixture();await mkdir(join(cwd,'.agents/skills/audit-binding'));await writeFile(join(cwd,'.agents/skills/audit-binding/SKILL.md'),'---\nname: audit-binding\ndescription: Test binding\n---\nOriginal instructions.');
 const seen=[];const host=await setup(cwd,async(p,r)=>{seen.push(r.label);return goodChild(p,r);});
 try{
  const exec={agent:host.agent,signal:new AbortController().signal};const args={...request,specialists:[{...request.specialists[0],skills:['audit-binding']}]};
  const first=await host.ctx.tools.get('boardroom_run',host.agent).execute(args,exec);
  await writeFile(join(cwd,'.agents/skills/audit-binding/SKILL.md'),'---\nname: audit-binding\ndescription: Test binding\n---\nCorrected financial instructions.');
  seen.length=0;const next=await host.ctx.tools.get('boardroom_resume',host.agent).execute({runId:first.runId},exec);assert.ok(seen.includes('boardroom:cfo'));assert.equal(next.metrics.resumedRoles,0);
 }finally{await host.scope.dispose();await host.stop();}
});

test('adaptive tools bind actual skills, limit reviewer tools, reuse starts, and accept only unchanged presented artifacts',async()=>{
 const {cwd}=await fixture();let host;const seen=[];
 const events=[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Inspect our website.'}]}}];
 const plan={brief:{outcomes:['Website diagnosis'],constraints:[],acceptance:['A reviewed diagnosis grounded in the brief']},tasks:[{id:'inspection',capabilityId:'website-inspect',dependencies:[],focus:'Diagnose the supplied website brief.',outcomes:['Website diagnosis']},{id:'review',capabilityId:'independent-review',dependencies:['inspection'],focus:'Review diagnosis and evidence.',outcomes:['Website diagnosis']}]};
 host=await setup(cwd,async(_provider,req)=>{
  const id=req.label.split(':')[2];seen.push(id);
  for(const name of req.toolFilter.allow)assert.ok(host.ctx.tools.get(name),'Only global names belong in inherited tool filters: '+name);
  const child={id:'adaptive-'+id,options:req.agentOptions,session:{header:{cwd,parentSession:'parent'},surface:{nodes:[]},snapshotEvents:()=>[],requestHeader:()=>undefined}};
  const cs=createScope(host.agent.ctx,child,{parent:host.agent});child.ctx=cs.ctx;child.ctx.tools.restrict(req.toolFilter);
  child.ctx.tools.register({name:'structured_output',description:'Final',parameters:req.outputSchema,output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>true});
  await host.ctx.serial(scopeTarget(child,child),'agent/created',{agent:child,source:'subagent'});
  const messages=[createUserMessage({source:{kind:'user'},content:req.prompt})];
  const enriched=await host.ctx.waterfall(scopeTarget(child,child),'agent/pre-step',{agent:child,messages,signal:req.signal},async()=>({kind:'enter',messages}));
  const loaded=enriched.messages.filter(m=>m.source?.kind==='skill-invocation').map(m=>m.source.name);
  assert.deepEqual(loaded,id==='inspection'?['cro','copywriting']:['pm-strategy-red-team']);
  assert.equal(Boolean(host.ctx.tools.get('workspace_read',child)),id==='inspection');
  assert.equal(host.ctx.tools.get('browser_check',child),undefined);assert.equal(host.ctx.tools.get('bash',child),undefined);
  const saved=await host.ctx.tools.execute({name:'artifact_write',arguments:{name:'report.md',content:'Inspected the supplied website brief. Recommendations require validation with real users.'},agent:child,callId:id+'-report',signal:req.signal});
  assert.ok(!saved.isError);const artifact=JSON.parse(saved.content[0].text);
  return {localAgent:child,result:Promise.resolve({stopReason:'completed',structured:{summary:'Completed bounded diagnosis with a reviewable report.',claims:[],artifacts:[{path:artifact.path,description:'Diagnosis report'}],verdict:'complete',issues:[]}}),dispose:()=>cs.dispose()};
 });
 host.agent.session.snapshotEvents=()=>events;host.agent.session.isOwnSeq=seq=>events.some(e=>e.seq===seq);
 const call=(name,args)=>host.ctx.tools.get(name,host.agent).execute(args,{agent:host.agent,signal:new AbortController().signal});
 try{
  const validated=await call('boardroom_plan',{plan});assert.deepEqual(validated.plan,plan);
  const args={objective:'Inspect our website.\nAssigned skills: ["financial-analyst"]',plan,mode:'advice',background:false,requestId:'adaptive-idempotency'};
  const out=await call('boardroom_start',args);assert.equal(out.status,'review-ready');assert.equal(seen.length,2);
  const replay=await call('boardroom_start',args);assert.equal(replay.reusedRequest,true);assert.equal(seen.length,2);
  events.push({seq:2,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Accept the report.'}]}});
  await call('boardroom_status',{missionId:out.missionId});
  const m=JSON.parse(await readFile(out.record)),file=m.tasks[0].result.artifacts[0].path,prior=await readFile(file);
  await writeFile(file,'Changed after presentation.');
  await assert.rejects(call('boardroom_decide',{missionId:out.missionId,decision:'accept',note:'Accept the report.'}),/artifact changed/);
  await writeFile(file,prior);
  const accepted=await call('boardroom_decide',{missionId:out.missionId,decision:'accept',note:'Accept the report.'});assert.equal(accepted.status,'accepted');
  assert.equal((await call('boardroom_memory',{query:'Website diagnosis'})).validatedMemory.length,0);
 }finally{await host.scope.dispose();await host.stop();}
});

test('split browser and independent reviews can complete a valid delivery plan',async()=>{
 const {cwd}=await fixture();let host;let browserChecks=0;
 const plan={brief:{outcomes:['Working local signup'],constraints:[],acceptance:['Signup reveals confirmation on desktop and mobile']},tasks:[{id:'build',capabilityId:'website-implement',dependencies:[],focus:'Build the local signup journey.',outcomes:['Working local signup']},{id:'browser',capabilityId:'website-review',dependencies:['build'],focus:'Exercise the signup journey.',outcomes:['Working local signup']},{id:'final',capabilityId:'independent-review',dependencies:['browser'],focus:'Review the tested artifact and limitations.',outcomes:['Working local signup']}]};
 host=await setup(cwd,async(_provider,req)=>{
  const id=req.label.split(':')[2],child={id:'split-'+id,options:req.agentOptions,session:{header:{cwd,parentSession:'parent'},surface:{nodes:[]},snapshotEvents:()=>[],requestHeader:()=>undefined}};
  const cs=createScope(host.agent.ctx,child,{parent:host.agent});child.ctx=cs.ctx;child.ctx.tools.restrict(req.toolFilter);
  child.ctx.tools.register({name:'structured_output',description:'Final',parameters:req.outputSchema,output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>true});
  await host.ctx.serial(scopeTarget(child,child),'agent/created',{agent:child,source:'subagent'});
  const call=async(name,args)=>{const result=await host.ctx.tools.execute({name,arguments:args,agent:child,callId:id+'-'+name,signal:req.signal});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  let artifact;
  if(id==='build'){const saved=await call('workspace_write',{path:'index.html',content:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signup</title></head><body><h1>Join the pilot</h1><button onclick="document.getElementById(\'confirmation\').hidden=false">Sign up</button><p id="confirmation" hidden>Request received</p></body></html>'});artifact={path:saved.absolutePath,description:'Signup page'};}
  else{if(id==='browser'){const checked=await call('browser_check',{steps:[{action:'click',selector:'button'},{action:'assert-visible',selector:'#confirmation'}]});assert.equal(checked.functionalVerified,true);browserChecks++;}else assert.equal(host.ctx.tools.get('browser_check',child),undefined);const saved=await call('artifact_write',{name:'review.md',content:'The local signup journey was checked. External delivery and backend persistence are outside this fixture.'});artifact={path:saved.path,description:'Independent review'};}
  return {localAgent:child,result:Promise.resolve({stopReason:'completed',structured:{summary:'Completed assigned build or review with evidence.',claims:[],artifacts:[artifact],verdict:'complete',issues:[]}}),dispose:()=>cs.dispose()};
 });
 try{const out=await host.ctx.tools.get('boardroom_start',host.agent).execute({objective:'Build a working local signup',plan,mode:'deliver',background:false},{agent:host.agent,signal:new AbortController().signal});assert.equal(out.status,'review-ready');assert.equal(browserChecks,1);}finally{await host.scope.dispose();await host.stop();}
});

test('lead tools record questionnaire facts and capture literal decisions without quote guessing',async()=>{
 const {cwd}=await fixture();const host=await setup(cwd);
 const events=[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'/boardroom Set the pilot price to $100.'}]}}];
 host.agent.session.snapshotEvents=()=>events;host.agent.session.isOwnSeq=()=>true;
 const call=(name,args)=>host.ctx.tools.get(name,host.agent).execute(args,{agent:host.agent,signal:new AbortController().signal});
 try{
  const tool=host.ctx.tools.get('boardroom_record_decision',host.agent);
  assert.deepEqual(tool.parameters.properties.kind.enum,['decision','constraint']);
  assert.ok(!tool.parameters.required.includes('note'));
  const decision=await call('boardroom_record_decision',{key:'pilot-price',text:'Set the pilot price to $100.'});
  assert.equal(decision.sourceEvent.text,'/boardroom Set the pilot price to $100.');
  const callId='owners-call',answer='Jamie Rivera and Morgan Lee  just us two';
  events.push({seq:2,type:'tool/call',data:{name:'ask_user_question',callId,arguments:JSON.stringify({questions:[{id:'owners',question:'Who are the owners?'}]})}});
  events.push({seq:3,type:'tool/result',data:{message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:JSON.stringify({answers:[{id:'owners',selected:[],custom:answer}]})}]}}});
  await assert.rejects(call('boardroom_record_decision',{key:'owners',text:answer,kind:'ownership-structure'}),/kind.*must be one of/);
  await assert.rejects(call('boardroom_record_decision',{key:'owners',text:answer,note:'User clarified the owners'}),/boardroom_record_fact/);
  const fact=await call('boardroom_record_fact',{key:'owners',entity:'ownership',callId,questionId:'owners'});
  assert.equal(fact.kind,'fact');assert.equal(fact.text,answer);
  const memory=await call('boardroom_memory',{query:'ownership'});
  assert.equal(memory.validatedMemory[0].sourceEvent.question.question,'Who are the owners?');
 }finally{await host.scope.dispose();await host.stop();}
});
