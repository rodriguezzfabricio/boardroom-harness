import {readFile,lstat} from 'node:fs/promises';
import {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client';
import {hash} from './core.mjs';
import {scopedPath,readWorkspace,workspaceDigest} from './workspace.mjs';

export async function selectVisionRoute(llm, parent, preferred, signal) {
  const candidates=[];
  if(preferred)candidates.push(preferred);
  if(llm.listProviders&&llm.listModels){
    for(const provider of llm.listProviders()){
      let models=[];try{models=await llm.listModels(provider.id);}catch{continue;}
      candidates.push(...models.filter(model=>model.inputModalities?.includes('image')).map(model=>({provider:provider.id,model:model.id})));
    }
  }
  if(parent?.provider&&parent?.model)candidates.push({provider:parent.provider,model:parent.model});
  const unique=[...new Map(candidates.map(c=>[c.provider+'/'+c.model,c])).values()];
  const preference=c=>preferred&&c.provider===preferred.provider&&c.model===preferred.model?1000:(/flash|mini|haiku|small|lite/i.test(c.model)?50:0)+(c.provider===parent?.provider?5:0);
  unique.sort((a,b)=>preference(b)-preference(a));
  for(const candidate of unique){
    signal?.throwIfAborted();
    try{
      const info=await llm.resolveModelInfo(candidate.provider,candidate.model,signal);
      if(info.inputModalities?.includes('image'))return {provider:candidate.provider,model:candidate.model,maxTokens:8000};
    }catch(error){if(signal?.aborted)throw error;}
  }
  throw new Error('Visual review needs a configured model that declares image input. Select an image-capable provider/model in Harness; text-only models cannot certify screenshots.');
}

export function installScreenshotTool(ctx,agent,{workspace,artifacts,telemetry}) {
  const tool=createMcpToolDefinition(agent.ctx,{
    name:'screenshot_open',rawName:'screenshot_open',description:'Open an actual screenshot from this worker browser_check as image input. Only current captured images are allowed.',
    inputSchema:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'}}},
    async call({path},exec){
      const check=(telemetry.browserChecks??[]).findLast(check=>check.views.some(view=>view.screenshot===path));
      const view=check?.views.find(view=>view.screenshot===path);
      if(!view)throw new Error('Run browser_check first, then use its exact screenshot path');
      const current=await readWorkspace(workspace,check.entryPath);
      if(current.contentHash!==check.entryHash)throw new Error('Page changed after capture; run browser_check again');
      if(await workspaceDigest(workspace,check.captureArtifactDir)!==check.workspaceHash)throw new Error('Website assets changed after capture; run browser_check again');
      const file=await scopedPath(artifacts,path),stat=await lstat(file);
      if(!stat.isFile()||stat.size>15000000)throw new Error('Unsupported screenshot size');
      const bytes=await readFile(file);if(hash(bytes.toString('base64'))!==view.screenshotHash)throw new Error('Screenshot changed after capture');
      if(!ctx.get('attachments'))throw new Error('Harness attachment storage is required for actual visual review');
      const options=agent.session.requestHeader?.()?.config??agent.options;
      const info=await ctx.llm.resolveModelInfo(options.provider,options.model,exec.signal);
      if(!info.inputModalities?.includes('image'))throw new Error('Current worker model cannot inspect images');
      return {content:[{type:'text',text:JSON.stringify({path,viewport:view.viewport,entryHash:check.entryHash,screenshotHash:view.screenshotHash})},{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]};
    }
  });
  const project=tool.projectContent;
  tool.projectContent=(exec,result)=>{
    const content=project(exec,result);
    if(content?.some(block=>block.type==='image')){
      telemetry.imagesViewed??=[];
      telemetry.imagesViewed.push({path:exec.arguments.path,model:agent.options.model,provider:agent.options.provider});
    }
    return content;
  };
  agent.ctx.tools.register(tool);
}

export async function verifyVisualReview(workspace,telemetry){
  for(const check of telemetry.browserChecks??[]){
    if((await readWorkspace(workspace,check.entryPath)).contentHash!==check.entryHash)continue;
    if(await workspaceDigest(workspace,check.captureArtifactDir)!==check.workspaceHash)continue;
    if(check.views.length>=2&&check.views.every(view=>(telemetry.imagesViewed??[]).some(image=>image.path===view.screenshot))){
      const views=[];
      for(const view of check.views){
        if(hash((await readFile(view.screenshot)).toString('base64'))!==view.screenshotHash)throw new Error('Viewed screenshot changed');
        views.push({path:view.screenshot,viewport:view.viewport,screenshotHash:view.screenshotHash});
      }
      return {entryPath:check.entryPath,entryHash:check.entryHash,views,models:telemetry.imagesViewed};
    }
  }
  throw new Error('Visual review requires actual image admission for both current desktop and mobile screenshots; open them with screenshot_open before completing');
}
