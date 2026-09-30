import { ArchiveSchema,RecallSchema,defaults,id,type Model,type Trace } from '../runtime/contracts.js';
import { Repository } from '../storage/repository.js';
export class Memory {
 constructor(readonly repo:Repository,private model:Model){}
 async recall(query:string,trace:Trace){
  const persona=this.repo.persona();if(!persona)throw Error('PERSONA_REQUIRED');
  const candidates=[...this.repo.seeds(),...this.repo.candidates(query,defaults.recallLimit)];
  let remaining=12000;
  const unique=[...new Map(candidates.map(m=>[m.id,m])).values()].filter(m=>{remaining-=m.content.length;return remaining>=0});
  const preferences=this.repo.preferences();
  const result=await this.model.call('memory_recall',{persona,query,preferences,candidates:unique},RecallSchema,trace);
  const known=new Set([...unique,...preferences].map(m=>m.id));
  if([...result.supporting_memories,...result.conflicting_memories].some(x=>!known.has(x)))throw Error('UNKNOWN_MEMORY_REFERENCE');
  this.repo.touch([...result.supporting_memories,...result.conflicting_memories]);
  return {...result,persona,preferences,records:[...new Map([...unique,...preferences].filter(m=>[...result.supporting_memories,...result.conflicting_memories].includes(m.id)).map(m=>[m.id,m])).values()]};
 }
 async consolidate(trace:Trace){
  const pending=this.repo.events('PENDING').slice(0,defaults.archiveLimit);if(!pending.length)return 0;
  const targets=this.repo.candidates(pending.map(e=>e.content).join(' '),20).filter(e=>!e.tier&&e.kind!=='PERSONA_SEED');
  const output=await this.model.call('memory_archive',{persona:this.repo.persona(),pending,merge_targets:targets},ArchiveSchema,trace);
  const ids=new Set(pending.map(e=>e.id));const seen=new Set<string>();const targetMap=new Map(targets.map(t=>[t.id,t]));
  for(const d of output.decisions){
   if(d.source_event_ids.some(e=>!ids.has(e)||seen.has(e)))throw Error('INVALID_ARCHIVE_SOURCES');
   d.source_event_ids.forEach(e=>seen.add(e));const sources=pending.filter(e=>d.source_event_ids.includes(e.id));
   if(sources.some(e=>e.kind!==d.kind))throw Error('ARCHIVE_KIND_CHANGED');
   if(d.operation==='discard'){if(d.content!==null||d.detail_level!==null||sources.some(e=>e.kind==='PREFERENCE'||this.repo.isPinned(e.id)))throw Error('INVALID_DISCARD');}
   else {if(!d.content?.trim()||!d.detail_level)throw Error('ARCHIVE_CONTENT_REQUIRED');
    // Dates and numeric conditions must survive compression verbatim.
    const values=sources.flatMap(e=>e.content.match(/\d+(?:[.年/月日时分:%-]\d*)*/g)??[]);
    if(values.some(v=>!d.content!.includes(v))||d.essential_fields.some(v=>!d.content!.includes(v)))throw Error('ARCHIVE_ESSENTIAL_FIELD_LOST');
   }
   if(d.operation==='merge'&&(!d.merge_target_id||!targetMap.has(d.merge_target_id)||targetMap.get(d.merge_target_id).kind!==d.kind))throw Error('INVALID_MERGE_TARGET');
   const attachments=new Set([...sources.flatMap(s=>s.artifact_id?[s.artifact_id]:[]),...(targetMap.get(d.merge_target_id)?.retained_artifact_ids??[])]);
   if(d.retained_artifact_ids.some(a=>!attachments.has(a)))throw Error('INVALID_ARTIFACT_REFERENCE');
  }
  if(seen.size!==ids.size)throw Error('INCOMPLETE_ARCHIVE_BATCH');
  if(output.cue_candidates.some(c=>c.evidence_ids.some(e=>!ids.has(e)&&!targetMap.has(e))))throw Error('INVALID_CUE_REFERENCE');
  this.repo.transaction(()=>{
   for(const d of output.decisions){const sources=pending.filter(e=>d.source_event_ids.includes(e.id));const previous=targetMap.get(d.merge_target_id);if(d.operation!=='discard'){
    this.repo.putLong({id:d.operation==='merge'?d.merge_target_id:id('memory'),kind:d.kind,content:d.content,source_event_ids:[...new Set([...(previous?.source_event_ids??[]),...d.source_event_ids,...sources.flatMap(e=>e.evidence_ids)])],occurred_at:Math.min(...sources.map(e=>e.occurred_at),previous?.occurred_at??Infinity),latest_at:Math.max(...sources.map(e=>e.occurred_at)),detail_level:d.detail_level,essential_fields:d.essential_fields,retained_artifact_ids:d.retained_artifact_ids,tags:d.tags,original_available:false});
   }for(const eid of d.source_event_ids)this.repo.db.prepare('DELETE FROM memory_events WHERE id=?').run(eid);}
   for(const c of output.cue_candidates){const cue={...c,cue_id:id('cue'),evidence_version:1,expires_at:Date.now()+c.ttl_seconds*1000};this.repo.db.prepare('INSERT OR IGNORE INTO cues VALUES(?,?)').run(c.dedup_key,JSON.stringify(cue));}
  });return pending.length;
 }
 cues(now=Date.now()){return this.repo.db.prepare('SELECT data FROM cues').all().map(r=>JSON.parse(r.data as string)).filter(c=>c.expires_at>now)}
}
