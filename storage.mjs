import { readFile, mkdir, rename, realpath, open, unlink, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION, hash, normalize, validate } from './core.mjs';

export const CACHE_TTL_MS=86400000;
export async function localDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  if (await realpath(path)!==path) throw new Error(`Directory must not traverse symlinks: ${path}`);
}
export async function readJson(file,maxBytes=200000) {
  const stat=await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>maxBytes) throw new Error(`Invalid or oversized record: ${file}`);
  return JSON.parse(await readFile(file,'utf8'));
}
export async function atomic(file,value) {
  const tmp=`${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle=await open(tmp,'wx',0o600);
    await handle.writeFile(JSON.stringify(value,null,2));
    await handle.sync(); await handle.close();handle=undefined;
    await rename(tmp,file);
    const dir=await open(dirname(file),'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch(e) {
    await handle?.close().catch(()=>{});
    await unlink(tmp).catch(()=>{});
    throw e;
  }
}
export function serialWriter(write) {
  let queue=Promise.resolve();
  return value => {
    const snapshot=structuredClone(value);
    queue=queue.then(()=>write(snapshot));
    return queue;
  };
}
export async function readCache(dir,key) {
  try {
    const c=await readJson(join(dir,key+'.json'),50000);
    if (!c || typeof c!=='object') return null;
    const age=Date.now()-c.createdAt;
    return c.key===key && c.digest===hash(c.value) && age>=0 && age<CACHE_TTL_MS ? c.value : null;
  } catch(e) {
    // A corrupt/missing entry is a miss; permission/disk failures must surface.
    if (e.code==='ENOENT' || e instanceof SyntaxError || e.message.startsWith('Invalid or oversized record')) return null;
    throw e;
  }
}
export async function loadResume({root,runId,project,state,decisions,company,complexRoles=[]}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid run ID');
  const dir=join(root,'runs',runId);
  if (await realpath(dir)!==dir) throw new Error('Resume path must not traverse symlinks');
  const request=await readJson(join(dir,'request.json'));
  if (!['2.0.2','2.1.0','2.2.0','3.0.0',VERSION].includes(request.version) || request.runId!==runId) throw new Error('Unsupported or mismatched saved run');
  const previous=await readJson(join(dir,'result.json'));
  if ((previous.version && previous.version!==request.version) || (previous.stage && previous.stage!==request.input.stage) || (previous.runId && previous.runId!==runId)) throw new Error('Saved request/result identity mismatch');
  const recordedTime=request.createdAt ?? (await lstat(join(dir,'request.json'))).mtimeMs;
  const age=Date.now()-recordedTime;
  if (!Number.isFinite(age) || age<0 || age>=CACHE_TTL_MS) throw new Error('Saved run is older than 24 hours; gather current evidence and start a new run');
  const context=hash({project,state,decisions});
  const compatible=request.context
    ? request.context===context && request.fingerprint===hash({context,input:request.input,version:request.version})
    : request.fingerprint===hash({project,state,decisions,input:request.input,version:request.version});
  if (!compatible || normalize(request.input,company).company!==request.input.company.trim()) throw new Error('Business context changed since the saved run; start a new run with current evidence');
  const input=normalize(request.input,company);
  if (!Array.isArray(complexRoles) || complexRoles.length>5 || complexRoles.some(name=>!input.specialists.some(s=>s.name===name))) throw new Error('complexRoles must name existing specialists');
  for (const s of input.specialists) if (complexRoles.includes(s.name)) s.difficulty='complex';
  const resume={};
  for (const s of input.specialists) {
    if (complexRoles.includes(s.name)||s.research||request.version!==VERSION) continue;
    if((previous.metrics?.trace??[]).some(t=>t.name===s.name&&(t.telemetry?.toolCalls??[]).some(c=>['read','skill','skill_reference','evidence_read','research_read','web_fetch','web_search'].includes(c.name)||c.name.startsWith('mcp__'))))continue;
    const saved=previous.specialists?.find(x=>x.name===s.name);
    if (!saved) continue;
    const {name,...value}=saved;
    const execution=[...(previous.metrics?.trace??[])].reverse().find(t=>t.name===name&&!t.error&&t.key);
    if (execution && !validate(value,s.headings,new Set(['company',...s.evidenceIds]))) resume[name]={value,runId,version:request.version,key:execution.key};
  }
  return {input,resume,resumedFrom:runId};
}
