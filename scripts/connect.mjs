import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,lstat,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {connectionsHome,ServiceConnections,markConnected,integrationStatus} from '../services.mjs';
import {gwsBin,googleStatus,googleRead} from '../google-workspace.mjs';
import {localDirectory} from '../storage.mjs';
const require=createRequire(import.meta.url);

async function template(file,text){
  await localDirectory(dirname(file));
  try{await writeFile(file,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe credential destination');}
}
export async function prepare(service){
  const root=connectionsHome();await localDirectory(root);
  if(service==='google')return {service,next:'Create a Desktop OAuth client in your Google Cloud project; enable Drive, Gmail, Docs and Sheets APIs. Download its JSON to ~/.config/gws/client_secret.json. Then run npm run connect -- google.',guide:'https://github.com/googleworkspace/cli#authentication'};
  if(service==='stripe')return {service,next:'Run npm run connect -- stripe and approve the official Stripe browser sign-in. Choose the intended account and test/live mode.',guide:'https://docs.stripe.com/mcp'};
  if(service==='xero'){
    await template(join(root,'xero-client.json'),JSON.stringify({client_id:'',token_endpoint_auth_method:'none'},null,2)+'\n');
    return {service,file:join(root,'xero-client.json'),next:'Create a Xero PKCE app. Register http://localhost:48132/oauth/callback and put its client ID in this file. Then run npm run connect -- xero. Real organizations currently need Developer Core or above; Starter is limited to the demo company.',guide:'https://developer.xero.com/faq'};
  }
  if(service==='quickbooks'){
    await template(join(root,'quickbooks.env'),'# Keep this file private. Sandbox uses a demo company.\nQUICKBOOKS_CLIENT_ID=\nQUICKBOOKS_CLIENT_SECRET=\nQUICKBOOKS_ENVIRONMENT=sandbox\nQUICKBOOKS_REDIRECT_URI=http://localhost:8000/callback\nQUICKBOOKS_REFRESH_TOKEN=\nQUICKBOOKS_REALM_ID=\n');
    return {service,file:join(root,'quickbooks.env'),next:'Create an Intuit app and enter its client ID/secret. For a sandbox demo, register http://localhost:8000/callback, then run npm run connect -- quickbooks. A real company requires production credentials and an Intuit-approved HTTPS OAuth callback; use Intuit OAuth Playground as documented upstream to obtain the company refresh token/realm ID. No hosting is installed here.',guide:'https://github.com/intuit/quickbooks-online-mcp-server#production-setup'};
  }
  throw new Error('Choose google, stripe, xero or quickbooks');
}
function child(command,args,{env=process.env,quiet=false,timeout=330000}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(command,args,{env,stdio:quiet?'ignore':'inherit'}),timer=setTimeout(()=>{p.kill('SIGTERM');reject(new Error('Sign-in timed out; run the command again.'));},timeout);
    p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('Sign-in did not complete. Check the setup guide and retry.'));});
  });
}
export async function connect(service){
  if(service==='google'){
    const status=await googleStatus();if(!status.clientConfigured)throw new Error((await prepare(service)).next);
    const scopes=['drive.readonly','documents.readonly','spreadsheets.readonly','gmail.readonly','gmail.compose'].map(s=>'https://www.googleapis.com/auth/'+s).join(',');
    await child(process.execPath,[gwsBin,'auth','login','--scopes',scopes]);
    await googleRead({action:'files_list',params:{pageSize:1}});
    await googleRead({action:'email_search',params:{maxResults:1}});
    return {service,verified:['Drive list','Gmail search'],note:'No messages sent. Document-specific access is checked when requested.'};
  }
  if(service==='quickbooks'){
    await prepare(service);const file=join(connectionsHome(),'quickbooks.env');
    const values=(await import('dotenv')).default.parse(await readFile(file));
    if(!values.QUICKBOOKS_CLIENT_ID||!values.QUICKBOOKS_CLIENT_SECRET)throw new Error('Fill the Intuit app credentials in '+file+' first.');
    if(values.QUICKBOOKS_ENVIRONMENT==='production'&&(!values.QUICKBOOKS_REFRESH_TOKEN||!values.QUICKBOOKS_REALM_ID))throw new Error('Production needs a company refresh token and realm ID from the documented HTTPS OAuth flow. See docs/connections.md.');
    await chmod(file,0o600);
    // Upstream logs callback URLs and raw OAuth errors. Keep those out of transcripts.
    console.log('Opening QuickBooks authorization if needed. Complete the browser window.');
    await child(process.execPath,[join(dirname(require.resolve('@qboapi/qbo-mcp-server')),'auth-server.js')],{env:{...process.env,QUICKBOOKS_TOKEN_STORE_PATH:file},quiet:true});
  }
  const broker=new ServiceConnections();
  try{
    const {tools}=await broker.list(service,{interactive:true,onAuthOutput:text=>{if(/https?:\/\//.test(text)&&!/token|secret|callback\?/i.test(text))process.stderr.write(text);}});
    await markConnected(service,tools);
    // Listing schemas alone is not a successful account read.
    const proof=tools.find(t=>['get_stripe_account_info','get_connected_tenants','list_customers','search_customers','list-contacts','list_contacts'].includes(t.name));
    let accountRead=false;
    if(proof){try{await broker.call(service,proof.name,proof.name==='search_customers'?{params:{limit:1}}:proof.name==='list_customers'?{limit:1}:{});accountRead=true;}catch{}}
    return {service,enabled:true,availableTools:tools.length,accountReadVerified:accountRead,next:accountRead?'Return to Boardroom and ask for the records you need.':'Connection enabled. Ask Boardroom to read the intended company and verify access before relying on it.'};
  }finally{await broker.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [service,flag]=process.argv.slice(2);
    if(service==='--status')console.log(JSON.stringify(await integrationStatus(),null,2));
    else if(service==='--help'||!service)console.log('npm run connect -- google|stripe|quickbooks|xero [--setup]\nnpm run connect -- --status\n--setup creates private templates/instructions; it does not start login.');
    else if(flag&&flag!=='--setup')throw new Error('Only --setup is supported after the service name.');
    else console.log(JSON.stringify(flag==='--setup'?await prepare(service):await connect(service),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
