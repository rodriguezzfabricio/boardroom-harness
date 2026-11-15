import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const run=promisify(execFile),require=createRequire(import.meta.url);
export const gwsBin=join(dirname(require.resolve('@googleworkspace/cli/package.json')),'run.js');

// Fixed API operations prevent arbitrary shell execution, sending, and deletion.
const reads={
  files_list:{cmd:['drive','files','list'],keys:['q','pageToken','pageSize','fields'],defaults:{pageSize:30,fields:'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken',q:'trashed = false'}},
  file_metadata:{cmd:['drive','files','get'],keys:['fileId','fields'],required:['fileId'],defaults:{fields:'id,name,mimeType,modifiedTime,webViewLink,description'}},
  document_read:{cmd:['docs','documents','get'],keys:['documentId'],required:['documentId']},
  sheet_read:{cmd:['sheets','spreadsheets','values','get'],keys:['spreadsheetId','range'],required:['spreadsheetId','range']},
  email_search:{cmd:['gmail','users','messages','list'],keys:['q','pageToken','maxResults'],defaults:{userId:'me',maxResults:20}},
  email_read:{cmd:['gmail','users','messages','get'],keys:['id'],required:['id'],defaults:{userId:'me',format:'full'}},
};
function parameters(operation,params){
  if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!operation.keys.includes(key)))throw new Error('Use only the documented parameters for this operation');
  if((operation.required??[]).some(key=>typeof params[key]!=='string'||!params[key]))throw new Error('Missing required parameter: '+operation.required.join(', '));
  for(const [key,value] of Object.entries(params))if(key==='pageSize'||key==='maxResults'){
    if(!Number.isSafeInteger(value)||value<1||value>100)throw new Error('Page size must be 1–100');
  }else if(typeof value!=='string'||value.length>4000)throw new Error('Invalid parameter '+key);
  return {...operation.defaults,...params};
}
export async function runGoogle(args,{signal,runner=run}={}){
  try{
    const {stdout}=await runner(process.execPath,[gwsBin,...args],{signal,timeout:45000,maxBuffer:2000000,env:{...process.env,GWS_LOG:'error'}});
    let value;try{value=JSON.parse(stdout);}catch{throw new Error('Google returned a non-JSON response');}
    if(value.error)throw new Error('Google operation failed: '+(value.error.message??'API error'));
    return value;
  }catch(error){
    if(signal?.aborted)throw error;
    // Never include stderr, env, OAuth URLs or credential material in agent output.
    throw new Error('Google operation failed. Check boardroom_integrations and run npm run connect -- google. Account consent, API enablement or the requested resource may be missing.');
  }
}
export async function googleStatus(options){
  try{
    const value=await runGoogle(['auth','status'],options);
    return {installed:true,clientConfigured:Boolean(value.client_config_exists),credentialPresent:Boolean(value.auth_method&&value.auth_method!=='none'),authenticated:'not verified by local status',nextAction:value.client_config_exists?'npm run connect -- google':'Create a Google Desktop OAuth client, enable Drive/Gmail/Docs/Sheets APIs, save client_secret.json under ~/.config/gws, then run npm run connect -- google'};
  }catch{return {installed:true,statusRead:false,authenticated:'unknown',nextAction:'Google status failed. Run npm ci, then npm run connect -- google'};}
}
export function googleReadActions(){return Object.fromEntries(Object.entries(reads).map(([name,op])=>[name,{parameters:op.keys,required:op.required??[]} ]));}
export async function googleRead({action,params={}},{signal,runner}={}){
  const op=reads[action];if(!op)throw new Error('Unknown Google read action; use '+Object.keys(reads).join(', '));
  return runGoogle([...op.cmd,'--params',JSON.stringify(parameters(op,params))],{signal,runner});
}
export async function googleDraft({to,subject,body},{signal,runner}={}){
  if(typeof to!=='string'||!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)||typeof subject!=='string'||/[\r\n]/.test(subject)||subject.length>500||typeof body!=='string'||body.length>50000)throw new Error('Draft needs one valid recipient, a single-line subject, and a body under 50,000 characters');
  const encodedSubject='=?UTF-8?B?'+Buffer.from(subject).toString('base64')+'?=';
  const raw=Buffer.from(`To: ${to}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}`).toString('base64url');
  const value=await runGoogle(['gmail','users','drafts','create','--params',JSON.stringify({userId:'me'}),'--json',JSON.stringify({message:{raw}})],{signal,runner});
  return {draftId:value.id,messageId:value.message?.id,sent:false};
}
