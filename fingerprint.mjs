import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './core.mjs';
const root=dirname(fileURLToPath(import.meta.url)),require=createRequire(import.meta.url);
const files=['core.mjs','plugin.mjs','connections.mjs','storage.mjs','evidence.mjs','recipes.mjs','mission-store.mjs','mission-engine.mjs','missions.mjs','workspace.mjs','fingerprint.mjs','capabilities.mjs','authority.mjs','mission-memory.mjs','discovery.mjs','crm.mjs','visual-review.mjs','services.mjs','google-workspace.mjs'];
const runtime=await Promise.all(files.map(async name=>({name,digest:hash(await readFile(join(root,name),'utf8'))})));
const adapters=await Promise.all(['@deepseek-ai/dsh-tools','@deepseek-ai/dsh-subagent','@deepseek-ai/dsh-llm-deepseek','@deepseek-ai/dsh-skill'].map(async name=>{
 try{const path=require.resolve(name);return {name,digest:hash(await readFile(path,'utf8'))};}catch{return {name,available:false};}
}));
export const RUNTIME_FINGERPRINT=hash({runtime,adapters});
