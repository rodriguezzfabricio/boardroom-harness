// Optional paid real-controller check using synthetic data only.
import {mkdtemp,realpath,mkdir,symlink,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {configure} from './setup.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const project=await realpath(await mkdtemp(join(tmpdir(),'boardroom-specialists-')));
await configure({projects:[project]}, {outputDir:join(project,'config')});
await writeFile(join(project,'.agents/skills/boardroom/COMPANY.md'),'Synthetic test. Two unnamed owners are considering an LLC. Jurisdiction, ownership split and tax elections have not been supplied. No live business or external actions.');
await mkdir(join(root,'validation'),{recursive:true});
const patch=join(project,'candidate.patch.yml');
await writeFile(patch,JSON.stringify([{insert:[{id:'boardroom-candidate',name:join(root,'plugin.mjs'),config:{projects:[project]}}]},{id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low',maxTokens:2500}}]));
const prompt='/boardroom Prepare two short handoff checklists for this synthetic company: what facts are missing for an LLC operating agreement, and what facts are missing for sales-tax registration. Use the installed legal and tax specialists and an independent reviewer. Do not give jurisdiction-specific legal or tax advice, research current laws, assume an equity split, or ask me questions; put missing facts in the checklists. Run the mission in the foreground and wait for its reports, with at most three worker attempts. Return the mission ID and real status. Do not modify company decisions or call external accounts.';
const child=spawn(join(root,'node_modules/.bin/dsh'),['headless','--patch',patch,prompt],{cwd:project,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const started=Date.now();
const timer=setTimeout(()=>child.kill('SIGTERM'),360000);const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
await writeFile(join(root,'validation/live-specialists-output.txt'),stdout+'\n'+stderr,{mode:0o600});
const path=join(project,'.agents/skills/boardroom/.runtime/missions-v4');let missions=[];
try{for(const entry of await readdir(path)){if(/^[a-f0-9-]{36}$/.test(entry))try{missions.push(JSON.parse(await readFile(join(path,entry,'mission-v4.json'))));}catch{}}}catch{}
const m=missions.at(-1),attempts=m?.events.filter(e=>e.type==='attempt-settled').map(e=>({task:e.taskId,route:e.route,skills:e.telemetry?.skillsLoaded,tools:e.telemetry?.toolCalls,error:e.error}));
const record={exitCode,seconds:(Date.now()-started)/1000,project,missionId:m?.id,status:m?.status,attempts,usage:m?.usage};
await writeFile(join(root,'validation/live-specialists.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(record,null,2));
process.exitCode=exitCode===0&&m?.status==='review-ready'&&m.tasks.some(t=>t.skills.includes('boardroom-corporate-legal'))&&m.tasks.some(t=>t.skills.includes('boardroom-tax-preparation'))?0:1;
