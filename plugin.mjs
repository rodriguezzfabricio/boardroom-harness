import { readFile, realpath, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { VERSION, LIMITS, normalize, executeStage, hash, economics, validate, route } from './core.mjs';
import { atomic, localDirectory, readCache, serialWriter, loadResume } from './storage.mjs';
import {installConnections,resolveSkills,recommendedSkills} from './connections.mjs';
import {EvidenceStore} from './evidence.mjs';
import {RUNTIME_FINGERPRINT} from './fingerprint.mjs';
import {installMissionRuntime} from './missions.mjs';
export { atomic } from './storage.mjs';
export const name='boardroom-runtime';
export const inject=['agents','tools','skills','subagents','llm'];
const jsonOutput={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export function rankSkills(skills,query) {
  const q=query.toLowerCase().trim(), terms=[...new Set(q.split(/[^a-z0-9]+/).filter(Boolean))];
  return skills.map(s=>({s,score:s.name.toLowerCase()===q?1000:terms.reduce((n,t)=>n+(s.name.toLowerCase().includes(t)?10:0)+(s.description.toLowerCase().includes(t)?1:0),0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.s.name.localeCompare(b.s.name)).slice(0,5)
    .map(({s})=>({name:s.name,description:s.description.replace(/\s+/g,' ').slice(0,160)}));
}
// Runs before the native tool captures its terminal result. A denied tool call
// returns the exact error to the same child; it does not start another agent.
export function attachContractGuard(agent,outputSchema,sourceIds) {
  const headings=Object.keys(outputSchema.properties.sections.properties);
  const ids=sourceIds??new Set(outputSchema.properties.claims.items.properties.sources.items.enum??outputSchema.properties.claims.items.properties.sources.items.examples);
  const telemetry={modelRequests:0,contractErrors:[]};
  agent.ctx.tools.guard(exec=>{
    if (exec.name!=='structured_output') return undefined;
    const error=validate(exec.arguments,headings,ids);
    if (error) {
      if (telemetry.contractErrors.length<10) telemetry.contractErrors.push(error);
      return `Boardroom output contract: ${error}. Resubmit the complete object, not a patch.`;
    }
    return undefined;
  });
  agent.ctx.on('agent/request',async(_payload,next)=>{
    if (telemetry.modelRequests>=LIMITS.maxSteps) throw new Error('Boardroom child exceeded its request-step budget');
    telemetry.modelRequests++;
    return next();
  });
  return telemetry;
}
export function collectTelemetry(events,guard={}) {
  const usage={},types={},routes=[];
  let systemChars=0;
  for(const event of events) {
    types[event.type]=(types[event.type]??0)+1;
    if (['assistant/message','assistant/attempt'].includes(event.type)) {
      for(const [key,value] of Object.entries(event.data.usage ?? {})) if(Number.isFinite(value)&&value>=0) usage[key]=(usage[key]??0)+value;
    }
    if(event.type==='request/header') {
      const {provider,model,reasoningEffort,maxTokens}=event.data.header?.config ?? {};
      routes.push({provider,model,reasoningEffort,maxTokens,tools:(event.data.header?.tools??[]).map(t=>t.name)});
    }
    if(event.type==='system/message') systemChars+=JSON.stringify(event.data).length;
  }
  return {usage:Object.keys(usage).length?usage:undefined,telemetry:{...guard,loggedSteps:types['step/start']??0,providerAttempts:(types['assistant/message']??0)+(types['assistant/attempt']??0),systemRecordChars:systemChars,resolvedRequests:routes}};
}
const runParameters={
  stage:{type:'string',required:true},question:{type:'string',required:true},reviewFocus:{type:'string'},
  specialists:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{name:{type:'string',required:true},persona:{type:'string',required:true},focus:{type:'string',required:true},headings:{type:'array',required:true,items:{type:'string'}},evidenceIds:{type:'array',items:{type:'string'}},difficulty:{type:'string',enum:['routine','complex']},skills:{type:'array',items:{type:'string'}},research:{type:'boolean'}}}},
  evidence:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string',required:true},source:{type:'string',required:true},excerpt:{type:'string',required:true},observedAt:{type:'string',required:true}}}},
};
export function apply(ctx,config={}) {
  const projects=new Set((config.projects??[]).map(x=>resolve(x))), active=new Map(), childTelemetry=new WeakMap();
  const missions=installMissionRuntime(ctx,{...config,projects:[...projects]},{rankSkills,collectTelemetry});
  ctx.on('dispose',()=>missions.dispose());
  ctx.on('agent/created', async ({agent})=>{
    if (!agent.session.header.cwd) return;
    const project=await realpath(agent.session.header.cwd);
    if (!projects.has(project)) return;
    if (agent.session.header.parentSession) {
      if(await missions.created(agent,project))return;
      const run=active.get(agent.session.header.parentSession), output=ctx.tools.get('structured_output',agent);
      const boardroom=Boolean(run && output?.parameters?.properties?.claims && output.parameters.properties.sections);
      if(boardroom){
        agent.ctx.tools.presentAs('native');
        const items=output.parameters.properties.claims.items.properties.sources.items;
        const ids=new Set(items.enum??items.examples??[]);
        const telemetry=attachContractGuard(agent,output.parameters,ids);
        installConnections(ctx,agent,{rankSkills,boardroom:true,telemetry,ids,ledger:run.ledger,onSource:run.onSource});
        childTelemetry.set(agent,telemetry);
      }else if(ctx.tools.get('skill',agent)){
        installConnections(ctx,agent,{rankSkills});
      }
      return;
    }
    if (!ctx.tools.get('skill',agent)) return;
    installConnections(ctx,agent,{rankSkills});
    agent.ctx.tools.register(defineTool({name:'boardroom_economics',description:'Calculate unit economics. Currency amounts are nonnegative integer cents; customers is a nonnegative integer. Inputs remain assumptions.',parameters:Object.fromEntries(['priceCents','variableCostCents','monthlyFixedCostCents','customers'].map(k=>[k,{type:'integer',required:true}])),output:jsonOutput,execute:async args=>economics(args)}));
    async function runStage(args,exec,resumeRequest) {
      if(!exec.agent||exec.agent.id!==agent.id) throw new Error('Boardroom controller requires the project lead');
      const base=join(project,'.agents/skills/boardroom');
      if(await realpath(base)!==base) throw new Error('Project boardroom directory must be local, not a symlink');
      const [company,state,decisions]=await Promise.all(['COMPANY.md','STATE.md','DECISIONS.md'].map(f=>readFile(join(base,f),'utf8')));
      const root=join(base,'.runtime');await localDirectory(root);
      const saved=resumeRequest ? await loadResume({root,...resumeRequest,project,state,decisions,company}) : undefined;
      const input=saved?.input ?? normalize(args,company), parentOptions=parentAgentOptionsForDelegation(agent);
      const bindings=new Map();
      for(const role of [...input.specialists,{name:'challenger',skills:[]}]){
        const names=recommendedSkills('Role '+role.name+':',role.skills);
        if(!names.length)throw new Error('Select at least one relevant installed skill for '+role.name+' using skill_search, and pass it in skills.');
        const resolved=await resolveSkills(ctx,agent,names,exec.signal);
        if(resolved.missing.length)throw new Error('Required skills unavailable for '+role.name+': '+JSON.stringify(resolved.missing));
        bindings.set(role.name,{runtime:RUNTIME_FINGERPRINT,loaded:resolved.loaded.map(x=>({name:x.name,digest:x.digest})),missing:resolved.missing,tools:hash(ctx.tools.schemas(agent)),route:route(parentOptions,role)});
        if(resolved.loaded.reduce((n,x)=>n+x.content.length,0)+LIMITS.reviewChars>LIMITS.assembledChars)throw new Error('Assembled context budget exceeded');
      }
      let ledger;
      const lockPath=join(root,'run.lock');let lock;
      try {lock=await open(lockPath,'wx',0o600);} catch(e) {
        if(e.code==='EEXIST') throw new Error('A Boardroom run is active or was interrupted. Inspect .runtime/run.lock before recovering; no duplicate work started.');throw e;
      }
      const runId=randomUUID(),createdAt=Date.now(),runDir=join(root,'runs',runId),cacheDir=join(root,'cache');
      const record=join(runDir,'result.json');
      let latest={version:VERSION,stage:input.stage,status:'in-progress',gate:'awaiting-user',specialists:[],challenge:null,failed:input.specialists.map(s=>s.name)};
      const persist=serialWriter(async value=>{
        latest={...value,runId,createdAt,updatedAt:Date.now(),...saved ? {resumedFrom:saved.resumedFrom} : {}};
        await atomic(record,latest);
        await atomic(join(root,'latest.json'),{runId,status:value.status,record});
      });
      let ready=false;
      try {
        await lock.writeFile(JSON.stringify({pid:process.pid,runId,startedAt:new Date(createdAt).toISOString()}));await lock.sync();
        ledger=new EvidenceStore({persist:source=>atomic(join(runDir,source.id+'.json'),source)});
        active.set(agent.id,{ledger});
        await localDirectory(runDir);await localDirectory(cacheDir);
        const context=hash({project,state,decisions});
        await atomic(join(runDir,'request.json'),{runId,createdAt,context,fingerprint:hash({context,input,version:VERSION}),input,parentOptions,version:VERSION,...saved ? {resumedFrom:saved.resumedFrom} : {}});
        ready=true;await persist(latest);
        const result=await executeStage(input,{
          project:context,parentOptions,signal:exec.signal,resume:saved?.resume,
          bindingKey:name=>bindings.get(name),sources:()=>[...ledger.values()],
          preflight:async(options,signal)=>{const resolved=await ctx.llm.resolveCallConfig(options,signal);for(const binding of bindings.values())if(hash(binding.route)===hash(options))binding.route=resolved;return resolved;},
          readCache:key=>readCache(cacheDir,key),
          writeCache:(key,value)=>atomic(join(cacheDir,key+'.json'),{key,value,digest:hash(value),createdAt:Date.now()}),
          checkpoint:persist,
          recordAttempt:value=>atomic(join(runDir,`${value.name}-attempt-${value.attempt}.json`),value),
          run:async req=>{
            const options=await ctx.llm.resolveCallConfig(req.options,req.signal);
            const allow=['skill','read',...(req.research?['web_search','web_fetch']:[])].filter(name=>ctx.tools.get(name,agent));
            const child=await ctx.subagents.start('spawn',{parent:agent,label:`boardroom:${req.name}`,prompt:[{type:'text',text:req.prompt}],signal:req.signal,agentOptions:options,maxDepth:1,toolFilter:{allow},persona:'You are a business-analysis specialist. Use loaded skills and the relevant available tools. Distinguish supplied assumptions from actual research. No sending, publishing, purchases or other external changes. Follow the structured output contract.',outputSchema:req.schema});
            try {
              const result=await child.result;
              const observed=collectTelemetry(child.localAgent?.session.snapshotEvents()??[],childTelemetry.get(child.localAgent));
              // Never store reasoning. The provider's normal session owns its history.
              if(observed.telemetry.contractErrors?.length) await atomic(join(runDir,`${req.name}-${child.localAgent.id}-contract.json`),observed.telemetry);
              return {...result,...observed,sources:[...ledger.values()]};
            } finally {childTelemetry.delete(child.localAgent);await child.dispose();}
          },
        });
        const {trace,...summaryMetrics}=result.metrics;
        return {...result,metrics:summaryMetrics,runId,record,...saved ? {resumedFrom:saved.resumedFrom} : {}};
      } catch(e) {
        if(ready) {
          const missing=input.specialists.filter(s=>!latest.specialists.some(x=>x.name===s.name)).map(s=>s.name);
          if(!latest.challenge) missing.push('challenger');
          const failed={...latest,failed:missing,status:'incomplete',termination:exec.signal?.aborted?'cancelled':'runtime-error',error:{name:e.name,message:e.message}};
          // Bypass a rejected write queue only after every worker has settled.
          try {await atomic(record,failed);await atomic(join(root,'latest.json'),{runId,status:'incomplete',record});} catch { /* Preserve the primary failure; disk recovery may be required. */ }
        }
        throw e;
      } finally {active.delete(agent.id);await lock.close();await unlink(lockPath);}
    }
    agent.ctx.tools.register(defineTool({name:'boardroom_run',timeoutMs:LIMITS.stageMs+30000,description:'Run one authorized Boardroom stage with 1–5 specialists and independent challenge. Supply narrow roles and selected evidence. Each child loads relevant full skills and receives reference/calculation tools. Set research:true for current-source lookup; legal and market/research roles default to true. Fresh-research roles bypass cache. Optional skills selects up to two exact installed names. Reuses unchanged roles; never advances business state. To recover a partial stage use boardroom_resume with its ORIGINAL full-stage run ID.',parameters:runParameters,output:jsonOutput,execute:(args,exec)=>runStage(args,exec)}));
    await missions.created(agent,project);
    agent.ctx.tools.register(defineTool({name:'boardroom_resume',timeoutMs:LIMITS.stageMs+30000,description:'Resume the full roster from a saved run in this project within 24 hours. Reuse validated completed specialists only if company, state and decisions are unchanged. Always independently review the assembled full roster. Optional complexRoles reruns named roles on the complex route. Never approves a gate.',parameters:{runId:{type:'string',required:true},complexRoles:{type:'array',items:{type:'string'}}},output:jsonOutput,execute:(args,exec)=>runStage(undefined,exec,args)}));
  });
}
