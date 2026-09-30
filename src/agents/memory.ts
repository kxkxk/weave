import { RecallSchema,defaults,type Model,type Trace } from '../runtime/contracts.js';
import { Repository } from '../storage/repository.js';
export class Memory {
 constructor(readonly repo:Repository,private model:Model){}
 async recall(query:string,trace:Trace){const persona=this.repo.persona();if(!persona)throw Error('PERSONA_REQUIRED');const candidates=[...this.repo.long().filter(m=>m.kind==='PERSONA_SEED'),...this.repo.candidates(query,defaults.recallLimit)];const unique=[...new Map(candidates.map(m=>[m.id,m])).values()];const result=await this.model.call('memory_recall',{persona,query,candidates:unique},RecallSchema,trace);const known=new Set(unique.map(m=>m.id));if([...result.supporting_memories,...result.conflicting_memories].some(x=>!known.has(x)))throw Error('UNKNOWN_MEMORY_REFERENCE');this.repo.touch([...result.supporting_memories,...result.conflicting_memories]);return {...result,persona,records:unique.filter(m=>[...result.supporting_memories,...result.conflicting_memories].includes(m.id))}}
}
