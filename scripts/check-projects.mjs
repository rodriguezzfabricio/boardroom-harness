// Read-only installation check against the real Harness tool/skill registries.
import {realpath,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as Filesystem from '@deepseek-ai/dsh-skill-filesystem';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import {createScope,scopeTarget} from '@deepseek-ai/dsh-scope';
import {apply} from '../plugin.mjs';
import {resolveSkills} from '../connections.mjs';
import {capabilityInventory} from '../capabilities.mjs';
import {root} from './setup.mjs';
const projects=await Promise.all(process.argv.slice(2).map(p=>realpath(p)));
if(!projects.length)throw new Error('Pass the project folders to check.');
const results=[];
for(const cwd of projects){
 const ctx=new Context(),fibers=[];let agent,scope;
 for(const plugin of [SystemPrompt,Tools,SkillRegistry]){const fiber=ctx.plugin(plugin,{});await fiber.await();fibers.push(fiber);}
 ctx.provide('llm',{resolveCallConfig:async x=>x});ctx.provide('subagents',{start:async()=>{throw new Error('Read-only check cannot launch paid agents');}});
 const owner=ctx.plugin({inject:['tools','skills','llm','subagents'],apply(ownerCtx){
  agent={id:'install-check',options:{provider:'deepseek-official',model:'deepseek-flash'},session:{header:{cwd,id:'install-check'},surface:{nodes:[]},seq:0,requestHeader:()=>undefined}};
  scope=createScope(ownerCtx,agent);agent.ctx=scope.ctx;SkillTool.apply(ownerCtx,{});Filesystem.apply(ownerCtx,{watch:false});apply(ownerCtx,{projects});
 }});await owner.await();fibers.push(owner);
 try{
  await ctx.serial(scopeTarget(agent,agent),'agent/created',{agent,source:'startup'});
  const exec={agent,signal:new AbortController().signal},call=(name,args)=>ctx.tools.get(name,agent).execute(args,exec);
  const toolNames=['boardroom_route','boardroom_start','boardroom_capabilities','boardroom_crm_list','boardroom_crm_save','boardroom_crm_export','boardroom_integrations','boardroom_google_read','boardroom_email_draft','boardroom_service_tools','boardroom_service_call'];
  for(const name of toolNames)if(!ctx.tools.get(name,agent))throw new Error('Missing '+name+' in '+cwd);
  const skills=await resolveSkills(ctx,agent,[...new Set(capabilityInventory().flatMap(c=>c.skills))],exec.signal);if(skills.missing.length)throw new Error(JSON.stringify(skills.missing));
  const catalog=await call('boardroom_capabilities',{query:'list'}),connections=await call('agent_connections',{query:'list loaded skills and tools'});
  if(catalog.filtered||catalog.matches.length!==capabilityInventory().length||connections.availableToolCount===0||connections.installedSkillCount<skills.loaded.length)throw new Error('Discovery regression');
  await call('boardroom_memory',{query:'company context'});
  const legal=await call('boardroom_route',{message:'Draft an operating agreement for our LLC'}),tax=await call('boardroom_route',{message:'Help with sales tax registration'});
  if(!legal.suggestedPlan.tasks.some(t=>t.capabilityId==='corporate-legal')||!tax.suggestedPlan.tasks.some(t=>t.capabilityId==='tax-preparation'))throw new Error('Specialist routing regression');
  results.push({project:cwd,pass:true,capabilities:catalog.totalAvailable,installedSkills:connections.installedSkillCount,requiredSkillsResolved:skills.loaded.length,tools:toolNames,legalAndTaxDelegationPlan:true,scope:'Fresh real registry and skill binding; no model calls or account access.'});
 }finally{await scope?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();}
}
await mkdir(join(root,'validation'),{recursive:true});await writeFile(join(root,'validation/project-entrypoints.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
