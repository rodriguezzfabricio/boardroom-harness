import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {renderSkillContent,isModelInvocable} from '@deepseek-ai/dsh-skill';
import {hash,economics,LIMITS} from './core.mjs';
import {evidenceStore} from './evidence.mjs';
import {readdir,readFile,realpath,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {readWorkspace} from './workspace.mjs';
import {searchRecords,discoveryResult} from './discovery.mjs';

async function resourceDigest(resourceBase){
 if(resourceBase?.kind!=='directory')return null;
 const base=await realpath(resourceBase.path),rows=[];let bytes=0;
 async function visit(path,depth){
  if(depth>8)throw new Error('Skill resources exceed the fingerprint depth budget');
  for(const item of (await readdir(join(base,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(item.isSymbolicLink()||['node_modules','.git'].includes(item.name))continue;
   const name=join(path,item.name);
   if(item.isDirectory()){await visit(name,depth+1);continue;}
   const stat=await lstat(join(base,name));bytes+=stat.size;
   if(rows.length>=200||bytes>8000000)throw new Error('Skill resource fingerprint budget exceeded; select a narrower installed skill');
   rows.push({name,digest:hash((await readFile(join(base,name))).toString('base64'))});
  }
 }
 await visit('',0);return hash(rows);
}

const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export const ROLE_SKILLS={ceo:['pm-business-model'],cfo:['financial-analyst'],counsel:['kwp-legal-compliance-check'],legal:['kwp-legal-compliance-check'],product:['pm-north-star-metric'],pm:['pm-north-star-metric'],marketing:['customer-research'],cmo:['customer-research'],sales:['kwp-sales-account-research'],challenger:['pm-strategy-red-team'],research:['customer-research']};
export function recommendedSkills(text,explicit=[]){
 if(explicit.length)return [...new Set(explicit)].slice(0,2);
 const role=text.match(/^Role ([a-z][a-z0-9-]*):/m)?.[1];
 if(role&&ROLE_SKILLS[role])return ROLE_SKILLS[role];
 if(/\bCAN-SPAM\b|\blegal\b|\bcompliance\b|\bpreemption\b/i.test(text))return ROLE_SKILLS.legal;
 if(/\bpricing\b/i.test(text))return ['pricing-strategist'];
 if(/website|landing page|web design|redesign|booking conversion/i.test(text))return ['frontend-design','cro'];
 if(/cash flow|cash runway|profit margin|unit economics|cash burn/i.test(text))return ROLE_SKILLS.cfo;
 if(/\bstrategy duel\b|\bred.team\b|\bchallenger\b/i.test(text))return ROLE_SKILLS.challenger;
 if(/\bmarket research\b|\btrend researcher\b|\bcompetitor\b/i.test(text))return ROLE_SKILLS.research;
 if(/\bbusiness model\b/i.test(text))return ROLE_SKILLS.ceo;
 return [];
}
export async function resolveSkills(ctx,agent,names,signal){
 const loaded=[],missing=[];
 for(const name of names){
  const s=await ctx.skills.get(name,{cwd:agent.session.header.cwd,scope:agent,signal});
  if(!s||!isModelInvocable(s)){missing.push({name,reason:'Unavailable for model invocation'});continue;}
  const content=renderSkillContent(s);
  if(content.length>32000){missing.push({name,reason:'Exceeds automatic 32,000-character limit; read relevant sections from its resource path',resourceBase:s.resourceBase});continue;}
  loaded.push({name:s.name,content,digest:hash({content,resources:await resourceDigest(s.resourceBase)}),resourceBase:s.resourceBase});
 }
 return {loaded,missing};
}
export function installConnections(ctx,agent,{rankSkills,boardroom=false,telemetry={},ids,ledger,onSource,references=new Map(),advisory=true,assignedSkills,allowedTools}={}){
 telemetry.skillsLoaded??=[];telemetry.toolCalls??=[];telemetry.missingSkills??=[];
 const lookup=exec=>({cwd:agent.session.header.cwd,scope:agent,signal:exec.signal});
 const record=s=>{if(!telemetry.skillsLoaded.some(x=>x.name===s.name&&x.digest===s.digest))telemetry.skillsLoaded.push({name:s.name,digest:s.digest,method:'full-instructions'});};
 agent.ctx.tools.register(defineTool({name:'skill',description:'Load the full instructions of one installed skill. A skill is a workflow; external account access is separate.',parameters:{name:{type:'string',required:true}},output,async execute(args,exec){
  const {loaded,missing}=await resolveSkills(ctx,agent,[args.name],exec.signal);
  if(!loaded.length)throw new Error(JSON.stringify(missing));
  record(loaded[0]);return {name:loaded[0].name,instructions:loaded[0].content};
 }}));
 agent.ctx.tools.register(defineTool({name:'skill_search',description:'Find up to five installed skills by topic or exact name. Load relevant full instructions with skill.',parameters:{query:{type:'string',required:true}},output,async execute(args,exec){
  if(!args.query.trim()||args.query.length>200)throw new Error('Query must contain 1–200 characters');
  return rankSkills((await ctx.skills.list(lookup(exec))).filter(isModelInvocable),args.query);
 }}));
 agent.ctx.tools.register(defineTool({name:'skill_reference',description:'Read a reference or script inside an installed skill directory. Paths are relative to that skill; this reads instructions/code and does not execute scripts.',parameters:{skill:{type:'string',required:true},path:{type:'string',required:true},start:{type:'integer'},length:{type:'integer'}},output,async execute(args,exec){
  const {loaded,missing}=await resolveSkills(ctx,agent,[args.skill],exec.signal);const selected=loaded[0];
  if(!selected||selected.resourceBase?.kind!=='directory')throw new Error('Local skill resources unavailable: '+JSON.stringify(missing));
  record(selected);return readWorkspace(await realpath(selected.resourceBase.path),args.path,args.start??0,args.length??16000);
 }}));
 agent.ctx.tools.register(defineTool({name:'agent_connections',description:'Inspect skills loaded into this agent and search the actual tools available to it. Tool visibility does not prove account authentication. Use before claiming a plugin is missing or used.',parameters:{query:{type:'string'}},output,async execute(args,exec){
  const schemas=ctx.tools.schemas(agent).map(t=>({name:t.name,description:t.description.slice(0,240)})),matches=searchRecords(schemas,args.query);
  const installed=(await ctx.skills.list(lookup(exec))).filter(isModelInvocable);
  return {...discoveryResult(schemas,matches,args.query,20),loadedSkills:telemetry.skillsLoaded,installedSkillCount:installed.length,missingSkills:telemetry.missingSkills,availableToolCount:schemas.length,matchingTools:matches.slice(0,20).map(t=>({name:t.name,description:t.description.slice(0,240)})),successfulCalls:telemetry.toolCalls.filter(t=>!t.isError).map(t=>t.name),note:'Loaded skills records this agent usage, not installation. Only successful calls establish execution. Inspect list_experts for the current Agency roster; generic defaults do not describe its state.'};
 }}));
 if(boardroom){
  if(allowedTools===undefined||allowedTools.includes('boardroom_economics'))agent.ctx.tools.register(defineTool({name:'boardroom_economics',description:'Calculate unit economics from explicit assumed integer-cent inputs.',parameters:Object.fromEntries(['priceCents','variableCostCents','monthlyFixedCostCents','customers'].map(k=>[k,{type:'integer',required:true}])),output,execute:async args=>economics(args)}));
  const store=evidenceStore(ledger,onSource);
  agent.ctx.tools.register(defineTool({name:'evidence_read',description:'Read an immutable saved evidence span. Source previews are incomplete; inspect material passages before reviewing claims.',parameters:{id:{type:'string',required:true},start:{type:'integer'},length:{type:'integer'}},output,async execute(args){
   if(references.has(args.id)){
    const item=references.get(args.id),start=args.start??0,length=args.length??12000;
    if(!Number.isSafeInteger(start)||start<0||start>item.content.length||!Number.isSafeInteger(length)||length<1||length>16000)throw new Error('Invalid evidence range');
    return {id:args.id,source:item.source,contentHash:hash(item.content),start,end:Math.min(start+length,item.content.length),totalCharacters:item.content.length,text:item.content.slice(start,start+length)};
   }
   return store.read(args.id,args.start??0,args.length??12000);
  }}));
  if((allowedTools===undefined||allowedTools.includes('research_read'))&&ctx.tools.get('web_fetch',agent))agent.ctx.tools.register(defineTool({name:'research_read',description:'Fetch a source through native web_fetch, preserve its representation, and return an immutable source ID. Use evidence_read for later spans. Failed fetches never become evidence.',parameters:{url:{type:'string',required:true}},output,async execute(args,exec){
   const result=await store.capture(args.url,async url=>{
    const fetched=await ctx.tools.execute({name:'web_fetch',arguments:{url},callId:exec.callId+'-fetch',rootCallId:exec.rootCallId,parent:exec.token,agent,signal:exec.signal});
    for(const context of fetched.additionalContexts??[])exec.deferContext?.(context);
    if(fetched.isError)throw new Error('Source fetch failed: '+JSON.stringify(fetched.content).slice(0,1500));
    const text=fetched.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const status=text.match(/^Fetched [^\n]+ \(HTTP (\d{3})\)/)?.[1];
    if(status&&(Number(status)<200||Number(status)>=300))throw new Error('Source returned HTTP '+status+'; no evidence ID assigned');
    return text;
   });
   ids.add(result.source.id);return result;
  }}));
 }
 agent.ctx.on('tools/result',(exec,result)=>{
  if(telemetry.toolCalls.length<100)telemetry.toolCalls.push({name:exec.name,isError:Boolean(result.isError)});
 });
 if(agent.session.header.parentSession){
  let initialized=false;
  agent.ctx.on('agent/pre-step',async({messages,signal},next)=>{
   const decision=await next();
   if(initialized||decision.kind==='reject'||!decision.messages.length)return decision;
   const text=messages.flatMap(m=>m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
   let explicit=assignedSkills??[];if(assignedSkills===undefined){const match=text.match(/^Assigned skills: (\[[^\n]*\])$/m);if(match)explicit=JSON.parse(match[1]);}
   const {loaded,missing}=await resolveSkills(ctx,agent,recommendedSkills(text,explicit),signal);
   loaded.forEach(record);telemetry.missingSkills.push(...missing);initialized=true;
   const notices=[createUserMessage({source:{kind:'agent-connections'},content:[{type:'text',text:'This agent has its own installed-skill loader and actual tool discovery. Relevant full skill instructions follow. Use skill_search and skill for other explicitly named or clearly relevant skills. Use agent_connections to inspect available tools; call the relevant tool for live evidence, calculations, or files. Report unavailable accounts honestly; never claim a plugin ran because its skill was loaded. '+(boardroom?'Use research_read for fresh source IDs; cite those IDs in facts. The structured output contract and '+(advisory?'analysis-only':'assigned-task')+' boundary take precedence over workflow output headings or requests to write/send.':'')+ (missing.length?' Missing skills: '+JSON.stringify(missing):'')}]}),...loaded.map(s=>createUserMessage({source:{kind:'skill-invocation',name:s.name,form:'instructions'},content:[{type:'text',text:s.content}]}))];
   const assembled=[...decision.messages,...notices];
   const contextChars=JSON.stringify(assembled).length+JSON.stringify(ctx.tools.schemas(agent)).length;
   telemetry.initialContextChars=contextChars;
   if(contextChars>LIMITS.assembledChars)throw new Error('Assembled skill/context budget exceeded before inference; narrow the task or select fewer skills');
   return {...decision,messages:assembled};
  });
 }
 return telemetry;
}
