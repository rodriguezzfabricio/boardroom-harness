import {readFile,writeFile,mkdir,readdir,realpath,lstat,rename,access} from 'node:fs/promises';
import {join,resolve,relative,dirname,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {hash} from './core.mjs';

const excluded=new Set(['.git','.agents','.depth-engine','node_modules','.env','.DS_Store']);
export async function scopedPath(root,path,{create=false}={}){
 if(typeof path!=='string'||!path||path.includes('\0')||path.length>500)throw new Error('Invalid workspace path');
 const absolute=resolve(root,path),rel=relative(root,absolute);
 if(rel==='..'||rel.startsWith('../')||resolve(root)===absolute&&create)throw new Error('Path escapes workspace');
 if(rel.split('/').some(x=>excluded.has(x)||x.startsWith('.env')||x.endsWith('.pem')||x.endsWith('.key')))throw new Error('Protected workspace path');
 const canonical=await realpath(root);if(canonical!==resolve(root))throw new Error('Workspace root must be canonical');
 let cursor=root;
 for(const part of rel.split('/').filter(Boolean)){
  cursor=join(cursor,part);
  try{if((await lstat(cursor)).isSymbolicLink())throw new Error('Workspace symlinks are not followed');}
  catch(e){if(e.code!=='ENOENT')throw e;if(!create)throw e;}
 }
 return absolute;
}
export async function listFiles(root,path='.',limit=150){
 const base=await scopedPath(root,path),out=[];
 async function visit(dir,depth){
  if(depth>8||out.length>=limit)return;
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(out.length>=limit)break;
   if(excluded.has(entry.name)||entry.name.startsWith('.env')||entry.isSymbolicLink())continue;
   const file=join(dir,entry.name);
   if(entry.isDirectory())await visit(file,depth+1);else out.push(relative(root,file));
  }
 }
 await visit(base,0);return {files:out,limited:out.length>=limit};
}
export async function readWorkspace(root,path,start=0,length=16000){
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<1||length>32000)throw new Error('Invalid file range');
 const file=await scopedPath(root,path),stat=await lstat(file);if(!stat.isFile()||stat.size>1000000)throw new Error('File is not supported text or exceeds 1 MB');
 const text=await readFile(file,'utf8');if(text.includes('\0'))throw new Error('Binary file: use an appropriate artifact reader');
 return {path,contentHash:hash(text),start,end:Math.min(text.length,start+length),characters:text.length,text:text.slice(start,start+length)};
}
export async function writeWorkspace(root,path,content,expectedHash){
 if(typeof content!=='string'||content.length>200000)throw new Error('Write must contain at most 200,000 characters');
 if(!/\.(html?|css|js|mjs|cjs|jsx|tsx|ts|json|md|txt|svg|csv)$/i.test(path))throw new Error('Use a supported website or report artifact extension');
 const file=await scopedPath(root,path,{create:true});
 let prior=null;try{prior=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(prior!==null&&expectedHash!==hash(prior))throw new Error('Read the current file and supply its contentHash before replacing it');
 if(prior===null&&expectedHash)throw new Error('File disappeared since it was read');
 await mkdir(dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,content,{mode:0o600,flag:'wx'});await rename(tmp,file);
 return {path,absolutePath:file,contentHash:hash(content),characters:content.length};
}

export async function outputSnapshot(missionRoot,artifacts,{workspace=false}={}){
 const roots={workspace:join(missionRoot,'workspace'),artifacts:join(missionRoot,'artifacts')};
 let bytes=0;
 const digest=async(root,path)=>{const file=await scopedPath(root,path),stat=await lstat(file);bytes+=stat.size;if(!stat.isFile()||stat.size>10000000||bytes>100000000)throw new Error('Output verification exceeds file/100 MB budget');return hash((await readFile(file)).toString('base64'));};
 const reported=[];
 for(const artifact of [...artifacts].sort((a,b)=>a.path.localeCompare(b.path))){const root=artifact.path.startsWith(roots.workspace+'/')?roots.workspace:roots.artifacts;reported.push({path:artifact.path,digest:await digest(root,artifact.path)});}
 let workspaceHash=null;
 if(workspace){const listing=await listFiles(roots.workspace,'.',1001);if(listing.limited)throw new Error('Workspace exceeds 1,000-file verification budget');const files=[];for(const path of listing.files.sort())files.push({path,digest:await digest(roots.workspace,path)});workspaceHash=hash(files);}
 return {reported,workspaceHash};
}

export async function seedWorkspace(project,sourcePath,workspace){
 const source=await scopedPath(project,sourcePath);
 const listing=await listFiles(source,'.',301);if(listing.limited)throw new Error('Source contains too many files; choose a narrower website directory');
 const files=[];let bytes=0;
 for(const path of listing.files){
  if(!/\.(html?|css|js|mjs|cjs|jsx|tsx|ts|json|md|txt|svg|csv|png|jpe?g|webp|ico|woff2?)$/i.test(path))continue;
  const file=await scopedPath(source,path),stat=await lstat(file);bytes+=stat.size;
  if(stat.size>2000000||bytes>20000000)throw new Error('Source exceeds 20 MB seed budget; choose a narrower website directory');
  files.push({path,content:await readFile(file)});
 }
 // Retry safely after interruption: already-copied bytes must be identical.
 for(const item of files){const dest=await scopedPath(workspace,item.path,{create:true});await mkdir(dirname(dest),{recursive:true});try{await writeFile(dest,item.content,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||!(await readFile(dest)).equals(item.content))throw e;}}
 return {sourcePath,files:files.map(x=>({path:x.path,digest:hash(x.content.toString('base64'))})),bytes};
}

const browserStepFields={
 click:['selector'],
 fill:['selector','value'],
 press:['selector','key'],
 'assert-visible':['selector'],
 'assert-text':['selector','text'],
 'assert-value':['selector','value'],
 'assert-url':['path'],
};

export function validateBrowserSteps(steps=[]){
 if(!Array.isArray(steps)||steps.length>12)throw new Error('Browser journey accepts at most 12 steps');
 return Array.from(steps,(step,i)=>{
  const fields=step&&typeof step==='object'&&typeof step.action==='string'&&Object.hasOwn(browserStepFields,step.action)?browserStepFields[step.action]:null;
  if(!fields||Object.keys(step).length!==fields.length+1||fields.some(field=>!Object.hasOwn(step,field))){
   throw new Error('Unsupported browser journey step or fields at step '+(i+1));
  }
  for(const field of fields){
   const value=step[field];
   const mayBeEmpty=field==='value';
   const maxLength={selector:500,value:1000,text:1000,key:40,path:500}[field];
   if(typeof value!=='string'||value.length>maxLength||(!mayBeEmpty&&!value.trim())||value.includes('\0')){
    throw new Error('Invalid '+field+' at browser journey step '+(i+1));
   }
  }
  if(step.action==='assert-url'&&(!/^\/(?!\/)/.test(step.path)||/[\\\x00-\x20]/.test(step.path))){
   throw new Error('Browser URL assertion requires a local absolute path');
  }
  return {action:step.action,...Object.fromEntries(fields.map(field=>[field,step[field]]))};
 });
}

async function waitForLocatorValue(read,accepts,description,timeout,signal){
 const deadline=performance.now()+timeout;
 do{
  signal.throwIfAborted();
  const value=await read(Math.max(1,Math.floor(deadline-performance.now())));
  if(accepts(value))return;
  const wait=Math.min(50,deadline-performance.now());
  if(wait<=0)break;
  await delay(wait,undefined,{signal});
 }while(performance.now()<deadline);
 throw new Error(description);
}

async function runBrowserStep(page,step,origin,timeout,signal){
 if(step.action==='assert-url'){
  const expected=new URL(step.path,origin).href;
  await page.waitForURL(url=>url.href===expected,{timeout,waitUntil:'commit'});
  return;
 }
 const locator=page.locator(step.selector);
 switch(step.action){
  case 'click':await locator.click({timeout});return;
  case 'fill':await locator.fill(step.value,{timeout});return;
  case 'press':await locator.press(step.key,{timeout});return;
  case 'assert-visible':await locator.waitFor({state:'visible',timeout});return;
  case 'assert-text':
   await waitForLocatorValue(ms=>locator.innerText({timeout:ms}),text=>text.includes(step.text),'Expected text did not appear in the matched element',timeout,signal);
   return;
  case 'assert-value':
   await waitForLocatorValue(ms=>locator.inputValue({timeout:ms}),value=>value===step.value,'Expected value did not appear in the matched input',timeout,signal);
 }
}

export async function browserExecutable(chromium) {
 const executablePath=process.env.BOARDROOM_BROWSER_EXECUTABLE||chromium.executablePath();
 try{await access(executablePath);}catch(error){
  throw new Error('Chromium is unavailable. Run npm run browser:install or set BOARDROOM_BROWSER_EXECUTABLE.',{cause:error});
 }
 return executablePath;
}

export async function browserCheck(root,{entry='index.html',artifactDir,signal:ownerSignal,steps}={}){
 steps=validateBrowserSteps(steps);
 if(typeof artifactDir!=='string'||!artifactDir)throw new Error('Browser check requires an artifact directory');
 ownerSignal?.throwIfAborted();
 const entryFile=await scopedPath(root,entry);
 const entryUrl=relative(root,entryFile).split('/').map(encodeURIComponent).join('/');
 const {chromium}=await import('playwright');
 const executablePath=await browserExecutable(chromium);
 const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.svg':'image/svg+xml','.json':'application/json'};
 const server=createServer(async(req,res)=>{
  try{
   const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||entry;
   const file=await scopedPath(root,path);
   res.setHeader('Content-Type',mime[extname(file)]??'text/plain');
   res.end(await readFile(file));
  }catch{res.writeHead(404);res.end('Not found');}
 });
 const deadline=new AbortController(),endsAt=performance.now()+60000;
 const timeout=setTimeout(()=>deadline.abort(new Error('Browser check exceeded 60 seconds')),60000);
 const signal=ownerSignal?AbortSignal.any([ownerSignal,deadline.signal]):deadline.signal;
 const remaining=limit=>{
  signal.throwIfAborted();
  return Math.min(limit,Math.max(1,Math.floor(endsAt-performance.now())));
 };
 let browser,closingBrowser,closingServer;
 const closeBrowser=()=>closingBrowser??=browser?.close();
 const closeServer=()=>{
  if(!server.listening)return closingServer;
  closingServer??=new Promise(resolve=>server.close(resolve));
  server.closeAllConnections();
  return closingServer;
 };
 const stop=()=>{void closeBrowser()?.catch(()=>{});void closeServer();};
 signal.addEventListener('abort',stop,{once:true});
 try{
  signal.throwIfAborted();
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  browser=await chromium.launch({executablePath,headless:true,timeout:remaining(15000)});
  signal.throwIfAborted();
  const origin='http://127.0.0.1:'+server.address().port;
  const views=[],errors=[],blockedNavigations=[];
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   signal.throwIfAborted();
   const context=await browser.newContext({viewport,serviceWorkers:'block'});
   try{
    const page=await context.newPage();
    let errorCount=0,navigationBlocks=0;
    const isLocal=url=>url.startsWith(origin+'/');
    const recordBlocked=url=>{
     navigationBlocks++;
     const target=new URL(url);
     if(blockedNavigations.length<20)blockedNavigations.push({viewport:viewport.width,url:target.origin==='null'?target.protocol:target.origin});
    };
    await context.route('**/*',route=>{
     const request=route.request(),target=request.url();
     if(isLocal(target))return route.continue();
     if(request.isNavigationRequest())recordBlocked(target);
     return route.abort();
    });
    page.on('framenavigated',frame=>{
     const url=frame.url();
     if(frame===page.mainFrame()&&url!=='about:blank'&&!isLocal(url))recordBlocked(url);
    });
    page.on('pageerror',error=>{
     errorCount++;
     if(errors.length<20)errors.push(error.message.slice(0,1000));
    });
    const response=await page.goto(origin+'/'+entryUrl,{waitUntil:'networkidle',timeout:remaining(15000)});
    const inspection=await page.evaluate(()=>({title:document.title,bodyText:document.body.innerText.slice(0,8000),headings:[...document.querySelectorAll('h1,h2')].map(x=>x.textContent),links:[...document.querySelectorAll('a')].map(x=>({text:x.textContent,href:x.getAttribute('href')})),overflow:document.documentElement.scrollWidth>innerWidth+2,inputs:[...document.querySelectorAll('input')].map(x=>({type:x.type,name:x.name,accessibleName:x.getAttribute('aria-label')||x.labels?.[0]?.textContent||null}))}));
    const screenshot=join(artifactDir,`browser-${viewport.width}-${randomUUID()}.png`);
    await page.screenshot({path:screenshot,fullPage:true,timeout:remaining(10000)});
    const renderErrors=errorCount;
    const renderPassed=Boolean(response?.ok()&&renderErrors===0&&navigationBlocks===0&&isLocal(page.url())&&!inspection.overflow&&inspection.bodyText.trim());
    const journey={requestedSteps:steps.length,passed:steps.length?false:null,steps:[]};
    for(const [index,step] of steps.entries()){
     const record={index:index+1,action:step.action,passed:false};
     const priorErrors=errorCount,priorBlocks=navigationBlocks;
     try{
      await runBrowserStep(page,step,origin,remaining(5000),signal);
      signal.throwIfAborted();
      if(navigationBlocks>priorBlocks||!isLocal(page.url()))throw new Error('Browser journey attempted navigation outside the local server');
      if(errorCount>priorErrors)throw new Error('Browser journey triggered a JavaScript error');
      record.passed=true;
     }catch(error){
      signal.throwIfAborted();
      record.error=(error.message??String(error)).split('\n')[0].slice(0,500);
     }
     journey.steps.push(record);
     if(!record.passed)break;
    }
    if(steps.length)journey.passed=journey.steps.length===steps.length&&journey.steps.every(step=>step.passed)&&navigationBlocks===0&&errorCount===renderErrors;
    views.push({viewport,...inspection,screenshot,status:response?.status(),renderPassed,journey});
   }finally{await context.close();}
  }
  const renderPassed=views.every(view=>view.renderPassed);
  const journeyPassed=steps.length>0&&views.every(view=>view.journey.passed);
  const functionalVerified=renderPassed&&journeyPassed&&steps.some(step=>['click','fill','press'].includes(step.action))&&steps.some(step=>step.action.startsWith('assert-'));
  return {entryPath:entryFile,entryHash:hash(await readFile(entryFile,'utf8')),status:views[0].status,passed:renderPassed&&(!steps.length||journeyPassed),renderPassed,functionalVerified,errors,blockedNavigations,views,scope:'Local rendering and declared interactions at two viewport sizes. Screenshots require visual review. Each assertion covers only the supplied step.'};
 }catch(error){
  signal.throwIfAborted();
  throw error;
 }finally{
  clearTimeout(timeout);
  signal.removeEventListener('abort',stop);
  await Promise.all([closeBrowser(),closeServer()]);
 }
}
