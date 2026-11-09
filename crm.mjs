import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {lstat,writeFile,chmod} from 'node:fs/promises';
import {localDirectory} from './storage.mjs';

const fields={contacts:['name','email','company','phone','source'],deals:['name','contactId','stage','owner','nextAction','nextDate','amountCents','currency','source'],notes:['contactId','dealId','text','source']};
const stages=['new','qualified','proposal','won','lost'];
function validate(kind,record){
  if(!fields[kind]||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(k=>!fields[kind].includes(k)))throw new Error('Invalid CRM record fields');
  for(const [key,value] of Object.entries(record)){
    if(key==='amountCents'){if(!Number.isSafeInteger(value)||value<0)throw new Error('Deal amount must be nonnegative integer cents');}
    else if(typeof value!=='string'||value.length>(key==='text'?8000:1500))throw new Error('Invalid CRM field: '+key);
  }
  if(kind==='contacts'&&!record.name?.trim())throw new Error('Contact name is required');
  if(record.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email))throw new Error('Invalid email');
  if(kind==='deals'&&(!record.name?.trim()||!stages.includes(record.stage)))throw new Error('Deal needs a name and valid stage');
  if(record.nextDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(record.nextDate)||!Number.isFinite(Date.parse(record.nextDate))||new Date(record.nextDate).toISOString().slice(0,10)!==record.nextDate))throw new Error('Use a valid YYYY-MM-DD nextDate');
  if(record.currency&&!/^[A-Z]{3}$/.test(record.currency))throw new Error('Use a three-letter currency code');
  if(kind==='deals'&&record.amountCents!==undefined&&!record.currency)throw new Error('Deal amount requires a currency');
  if(kind==='notes'&&(!record.text?.trim()||!record.contactId&&!record.dealId))throw new Error('Note needs text and a contact or deal');
  return {...record,...(record.email?{email:record.email.trim().toLowerCase()}:{} )};
}
export class LocalCRM {
  constructor(project){this.root=join(project,'.agents/skills/boardroom/.runtime/crm');}
  async open(){
    await localDirectory(this.root);const file=join(this.root,'crm.sqlite');
    try{const stat=await lstat(file);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Invalid CRM database path');}catch(e){if(e.code!=='ENOENT')throw e;}
    const db=new DatabaseSync(file);await chmod(file,0o600);db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, email TEXT, data TEXT NOT NULL, updated TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS contact_email ON records(email) WHERE kind=\'contacts\' AND email IS NOT NULL;');return db;
  }
  async list({kind='contacts',query='',limit=100}={}){
    if(!fields[kind]||typeof query!=='string'||query.length>1000||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error('Invalid CRM query');
    const db=await this.open();try{
      const rows=db.prepare('SELECT * FROM records WHERE kind=? ORDER BY updated DESC').all(kind).map(row=>({id:row.id,revision:row.revision,updatedAt:row.updated,...JSON.parse(row.data)}));
      const matched=rows.filter(row=>JSON.stringify(row).toLowerCase().includes(query.toLowerCase()));
      return {kind,total:rows.length,matched:matched.length,records:matched.slice(0,limit),more:Math.max(0,matched.length-limit)};
    }finally{db.close();}
  }
  async save({kind,record,id,expectedRevision}){
    record=validate(kind,record);const db=await this.open();
    try{
      db.exec('BEGIN IMMEDIATE');
      const old=id?db.prepare('SELECT * FROM records WHERE id=?').get(id):null;
      if(id&&(!old||old.kind!==kind||old.revision!==expectedRevision))throw new Error('CRM record changed or is missing; read it again before updating');
      for(const [field,target] of [['contactId','contacts'],['dealId','deals']])if(record[field]&&!db.prepare('SELECT id FROM records WHERE id=? AND kind=?').get(record[field],target))throw new Error('Referenced '+field+' does not exist');
      if(!id&&expectedRevision!==undefined)throw new Error('New records cannot have expectedRevision');
      const revision=(old?.revision??0)+1,updatedAt=new Date().toISOString();id??=randomUUID();
      db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,email=excluded.email,data=excluded.data,updated=excluded.updated').run(id,kind,revision,record.email??null,JSON.stringify(record),updatedAt);
      db.exec('COMMIT');return {id,revision,updatedAt,...record};
    }catch(e){try{db.exec('ROLLBACK');}catch{}if(String(e.message).includes('UNIQUE constraint failed: records.email'))throw new Error('Contact email already exists; find and update that record');throw e;}finally{db.close();}
  }
  async export(){
    const files=[];
    const cell=x=>'"'+String(x??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
    for(const [kind,keys] of Object.entries(fields)){
      const {records,more}=await this.list({kind,limit:500});if(more)throw new Error('CSV export supports at most 500 records per kind; narrow the CRM before exporting');
      const columns=['id','revision',...keys,'updatedAt'];const file=join(this.root,kind+'-'+randomUUID()+'.csv');
      await writeFile(file,[columns.join(','),...records.map(row=>columns.map(k=>cell(row[k])).join(','))].join('\n')+'\n',{flag:'wx',mode:0o600});files.push(file);
    }
    return {files,note:'CSV snapshots; the local database remains authoritative.'};
  }
}
