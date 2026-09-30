import { ThinkSchema, type Model, type Trace } from "../runtime/contracts.js";
export class Thinking {
  constructor(private model: Model) {}
  run(
    input: unknown,
    trace: Trace,
    images: string[] = [],
    knownIds?: Set<string>,
  ) {
    if (++trace.thinkRounds > 2) throw Error("THINK_ROUND_LIMIT");
    const schema = knownIds
      ? ThinkSchema.superRefine((v, c) => {
          for (const ref of [
            ...v.observations.flatMap((o) => o.evidence_ids),
            ...v.memory_candidates.flatMap((o) => o.evidence_ids),
            ...v.action_intent.relevant_evidence_ids,
          ])
            if (!knownIds.has(ref))
              c.addIssue({
                code: "custom",
                message:
                  "UNKNOWN_EVIDENCE " +
                  ref +
                  "; only use evidence_catalog IDs or empty array for unsupported inference",
              });
        })
      : ThinkSchema;
    return this.model.call("thinking", input, schema, trace, images);
  }
}
