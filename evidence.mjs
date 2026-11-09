import {hash} from './core.mjs';

const wrappers = new WeakMap();
export const EVIDENCE_LIMITS = Object.freeze({sources:12, bodyChars:500000, readChars:16000});

// A preview is never the evidence record. Store exactly the representation
// returned by the native fetcher, without claiming it is the entire webpage.
export class EvidenceStore {
  constructor({ledger=new Map(), persist=async()=>{}, limit=EVIDENCE_LIMITS.sources}={}) {
    this.ledger=ledger; this.persist=persist; this.limit=limit;
    this.historical=0; this.bodies=new Map(); this.pending=new Map(); this.reservations=0;
  }
  get size(){return this.ledger.size;}
  values(){return this.ledger.values();}
  get(id){return this.ledger.get(id);}
  seed(source,content,{historical=false}={}){
    if(hash(content)!==source.contentHash)throw new Error('Evidence content hash mismatch');
    if(historical&&!this.ledger.has(source.id))this.historical++;
    this.ledger.set(source.id,source);this.bodies.set(source.id,content);
  }
  async capture(rawUrl,fetchText){
    const url=new URL(rawUrl);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Use HTTP(S) without embedded credentials');
    const key=url.href;
    if(this.pending.has(key))return this.pending.get(key);
    if(this.size-this.historical+this.reservations>=this.limit)throw new Error(`Run source budget reached (${this.limit} fresh sources); use existing evidence`);
    this.reservations++;
    const pending=Promise.resolve().then(async()=>{
      const content=await fetchText(key);
      if(typeof content!=='string'||!content.trim())throw new Error('Source returned no text');
      if(content.length>EVIDENCE_LIMITS.bodyChars)throw new Error('Source representation exceeds storage budget; request a narrower authoritative source');
      const contentHash=hash(content),id='web-'+hash({url:key,contentHash}).slice(0,24);
      const source={id,source:key,observedAt:new Date().toISOString(),contentHash,characters:content.length,excerpt:content.slice(0,1000),provenance:'Native web_fetch representation; source content and claims require evaluation'};
      await this.persist({...source,content});
      this.seed(source,content);
      return {source,content:content.slice(0,24000),truncated:content.length>24000,nextStart:Math.min(content.length,24000)};
    }).finally(()=>{this.reservations--;this.pending.delete(key);});
    this.pending.set(key,pending);return pending;
  }
  read(id,start=0,length=12000){
    const content=this.bodies.get(id),source=this.get(id);
    if(content===undefined||!source)throw new Error('Evidence snapshot unavailable in this run: '+id);
    if(!Number.isSafeInteger(start)||start<0||start>content.length||!Number.isSafeInteger(length)||length<1||length>EVIDENCE_LIMITS.readChars)throw new Error('Invalid evidence range');
    if(hash(content)!==source.contentHash)throw new Error('Evidence content hash mismatch');
    const end=Math.min(start+length,content.length);
    return {id,source:source.source,contentHash:source.contentHash,start,end,totalCharacters:content.length,text:content.slice(start,end),hasMore:end<content.length};
  }
}
export function evidenceStore(ledger,onSource){
  if(ledger instanceof EvidenceStore)return ledger;
  if(!wrappers.has(ledger))wrappers.set(ledger,new EvidenceStore({ledger,persist:onSource}));
  return wrappers.get(ledger);
}
