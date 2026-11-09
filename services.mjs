import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir,access,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {googleStatus} from './google-workspace.mjs';
import {localDirectory,readJson,atomic} from './storage.mjs';
const require=createRequire(import.meta.url);
export const connectionsHome=()=>resolve(process.env.BOARDROOM_CONNECTIONS_HOME??join(homedir(),'.config/boardroom-connections'));
export const serviceNames=['stripe','quickbooks','xero'];
const urls={stripe:'https://mcp.stripe.com',xero:'https://api.xero.com/mcp/v1'};
export async function connectionSettings(service){
  if(!serviceNames.includes(service))throw new Error('Choose stripe, quickbooks or xero');
  const root=connectionsHome();await localDirectory(root);
  try{return await readJson(join(root,service+'.json'),30000);}catch(e){if(e.code==='ENOENT')return {};throw e;}
}
export async function markConnected(service,tools){
  const settings=await connectionSettings(service);await atomic(join(connectionsHome(),service+'.json'),{...settings,enabled:true,toolsVerifiedAt:new Date().toISOString(),toolCount:tools.length});
}
export async function serviceCommand(service,{interactive=false}={}){
  const settings=await connectionSettings(service),root=connectionsHome();
  if(!interactive&&!settings.enabled)throw new Error('Connection is not enabled. Run npm run connect -- '+service+' to complete setup and sign-in.');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&!/KEY|PASSWORD|SECRET|TOKEN|^DSH_/i.test(key)));
  if(service==='quickbooks'){
    const tokenPath=join(root,'quickbooks.env');
    try{const stat=await lstat(tokenPath);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Invalid credential file');}catch(e){if(e.code==='ENOENT')throw new Error('QuickBooks needs an Intuit app and quickbooks.env; run npm run connect -- quickbooks --setup');throw e;}
    return {command:process.execPath,args:[require.resolve('@qboapi/qbo-mcp-server')],env:{...env,QUICKBOOKS_TOKEN_STORE_PATH:tokenPath},stderr:'pipe'};
  }
  const proxy=join(dirname(require.resolve('mcp-remote/package.json')),'dist/proxy.js');
  const args=[proxy,urls[service],'--transport','http-only','--auth-timeout',interactive?'300':'10','--headers-timeout','30','--body-timeout','45'];
  if(service==='xero'){
    const client=join(root,'xero-client.json');
    try{const info=await readJson(client);if(typeof info.client_id!=='string'||!info.client_id)throw new Error('Missing Xero client id');}catch{throw new Error('Xero needs a PKCE app client ID in xero-client.json; run npm run connect -- xero --setup');}
    args.splice(2,0,'48132');
    args.push('--static-oauth-client-info','@'+client);
  }
  return {command:process.execPath,args,env:{...env,MCP_REMOTE_CONFIG_DIR:join(root,'oauth',service)},stderr:'pipe'};
}
const stripeReads=['stripe_api_search','stripe_api_details','stripe_api_read','stripe_implementation_planner'];
export const serviceToolMutates=name=>!stripeReads.includes(name)&&!(/^(?:get|list|search|read|retrieve|fetch|find|ping)[_-]/i.test(name));
export function serviceToolAllowed(name){
  return stripeReads.includes(name)||/^(?:get|list|search|read|retrieve|fetch|find|ping)[_-]/i.test(name)||['stripe_api_write','create_customer','create_product','create_price','create_payment_link','create_invoice','create_invoice_item'].includes(name);
}
export function validateStripeWrite(name,args,schema){
  if(name!=='stripe_api_write')return;
  if(schema){
    const fields=schema.properties??{};
    if(Object.keys(args).some(key=>!Object.hasOwn(fields,key)))throw new Error('Unexpected Stripe arguments; inspect the current tool schema.');
    if(!['api_method','operation','operationId'].some(key=>Object.hasOwn(fields,key))&&!(Object.hasOwn(fields,'method')&&['path','endpoint'].some(key=>Object.hasOwn(fields,key))))throw new Error('Stripe write selector is not supported by this adapter yet; reads remain available.');
  }
  if(['api_method','operation','operationId'].filter(key=>Object.hasOwn(args,key)).length>1||(['api_method','operation','operationId'].some(key=>Object.hasOwn(args,key))&&['method','path','endpoint'].some(key=>Object.hasOwn(args,key))))throw new Error('Conflicting Stripe operation selectors');
  // The current remote server groups all HTTP writes into one tool. Never
  // mistake its name for permission to refund, charge, send, or delete.
  const method=args.api_method??args.operation??args.operationId;
  const allowedPaths=new Set(['/v1/customers','/v1/products','/v1/prices','/v1/payment_links','/v1/invoices','/v1/invoiceitems']);
  const operationIds=new Set(['PostCustomers','PostProducts','PostPrices','PostPaymentLinks','PostInvoices','PostInvoiceitems']);
  let allowed=typeof method==='string'&&(operationIds.has(method)||(/^POST\s+\/v1\/[a-z_]+$/i.test(method)&&allowedPaths.has(method.split(/\s+/)[1])));
  if(!method&&typeof args.method==='string'&&args.method.toUpperCase()==='POST'&&allowedPaths.has(args.path??args.endpoint))allowed=true;
  if(!allowed)throw new Error('Only creating customers/products/prices/payment links/draft invoices is enabled. Use stripe_api_search and stripe_api_details to inspect the current selector/schema. Unknown selector formats stay blocked; sending, refunds and charges are not allowed.');
  const parameters=args.parameters??args.params??args.body;
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw new Error('Stripe write parameters must be an object; inspect stripe_api_details first.');
  if(parameters.auto_advance===true||parameters.auto_advance==='true')throw new Error('Automatic invoice finalization is not enabled; create a draft with auto_advance false.');
}
export class ServiceConnections {
  constructor(){this.clients=new Map();this.pending=new Map();}
  async connect(service,{interactive=false,signal,onAuthOutput}={}){
    if(this.clients.has(service))return this.clients.get(service);
    if(this.pending.has(service))return this.pending.get(service);
    const pending=(async()=>{
      const command=await serviceCommand(service,{interactive});
      const transport=new StdioClientTransport(command),client=new Client({name:'boardroom-harness',version:'4.1.0'},{capabilities:{}});
      if(transport.stderr)transport.stderr.on('data',chunk=>{if(interactive&&onAuthOutput)onAuthOutput(chunk.toString());});
      try{
        await client.connect(transport,{timeout:interactive?330000:45000,signal});
        const rows=[];let cursor;
        do{const page=await client.listTools(cursor?{cursor}:undefined,{signal,timeout:45000});rows.push(...page.tools);cursor=page.nextCursor;if(rows.length>500)throw new Error('Connector catalog exceeds 500 tools');}while(cursor);
        const value={client,transport,tools:rows.filter(tool=>serviceToolAllowed(tool.name)&&(service==='stripe'||!serviceToolMutates(tool.name)))};this.clients.set(service,value);return value;
      }catch(error){await client.close().catch(()=>{});throw new Error(service+' connection failed. Run npm run connect -- '+service+' and complete account setup/sign-in.');}
    })();this.pending.set(service,pending);
    try{return await pending;}finally{this.pending.delete(service);}
  }
  async list(service,options){const {tools}=await this.connect(service,options);return {service,tools:tools.map(({name,description,inputSchema})=>({name,description,inputSchema})),note:'Tools were listed; a successful account-data read is still needed to prove access to the intended company.'};}
  async call(service,name,args,{signal}={}){
    const {client,tools}=await this.connect(service,{signal});
    if(!tools.some(tool=>tool.name===name))throw new Error('Tool is not exposed by this minimal connector; inspect boardroom_service_tools');
    if(service==='stripe')validateStripeWrite(name,args,tools.find(tool=>tool.name===name).inputSchema);
    const value=await client.callTool({name,arguments:args},undefined,{signal,timeout:60000});
    if(value.isError)throw new Error('The '+service+' operation failed; review account permissions and the requested record.');
    return value;
  }
  async close(){await Promise.allSettled([...this.clients.values()].map(x=>x.client.close()));this.clients.clear();}
}
export async function integrationStatus(){
  const services={};
  for(const name of serviceNames){
    const settings=await connectionSettings(name);let packageInstalled=true;
    try{require.resolve(name==='quickbooks'?'@qboapi/qbo-mcp-server':'mcp-remote/package.json');}catch{packageInstalled=false;}
    services[name]={packageInstalled,enabled:Boolean(settings.enabled),toolsVerifiedAt:settings.toolsVerifiedAt??null,accountAccess:'not checked by this status call',nextAction:'npm run connect -- '+name};
  }
  return {google:await googleStatus(),services,localCRM:{loginRequired:false},note:'Installed, configured, consented and successful account operations are different states. No credentials are included.'};
}
