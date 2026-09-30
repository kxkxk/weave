import { BehaviorSchema,type Model,type Trace } from '../runtime/contracts.js';
export class Behavior {constructor(private model:Model){} run(input:unknown,trace:Trace){return this.model.call('behavior',input,BehaviorSchema,trace)}}
