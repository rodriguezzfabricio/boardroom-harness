import {Context} from '@deepseek-ai/cordis';
import SkillRegistry,{isModelInvocable,escapeText} from '@deepseek-ai/dsh-skill';
import * as Filesystem from '@deepseek-ai/dsh-skill-filesystem';
import {rankSkills} from './plugin.mjs';
const ctx=new Context();const reg=ctx.plugin(SkillRegistry,{});await reg.await();const fs=ctx.plugin(Filesystem,{watch:false});await fs.await();
try{
 const rows=[];
 for(const cwd of process.argv.slice(2)){
  const list=(await ctx.skills.list({cwd})).filter(isModelInvocable);
  const lines=list.map(s=>{const d=s.description.replace(/\s+/g,' ').trim();return `- \`${s.name}\`: ${escapeText(d.length<=500?d:d.slice(0,497)+'...')}`;}).join('\n');
  rows.push({project:cwd,catalogSkills:list.length,catalogEntryChars:lines.length,estimatedTokens:Math.ceil(lines.length/4),estimateMethod:'characters / 4; not provider tokenizer',optimizedCatalogEntryChars:0,pricingSearch:rankSkills(list,'pricing'),searchResultChars:JSON.stringify(rankSkills(list,'pricing')).length});
 }
 console.log(JSON.stringify(rows,null,2));
}finally{await fs.dispose();await reg.dispose();}
