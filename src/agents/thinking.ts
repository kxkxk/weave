import { ThinkSchema,type Model,type Trace } from '../runtime/contracts.js';
export class Thinking {constructor(private model:Model){} run(input:unknown,trace:Trace,images:string[]=[]){if(++trace.thinkRounds>2)throw Error('THINK_ROUND_LIMIT');return this.model.call('thinking',input,ThinkSchema,trace,images)}}
