import {
  PerceptionSchema,
  type Observation,
  type Model,
  type Trace,
  type Perception,
} from "../runtime/contracts.js";
export class PerceptionZone {
  constructor(private model: Model) {}
  async perceive(
    inputs: Observation[],
    trace: Trace,
    images: string[] = [],
  ): Promise<Perception> {
    if (!inputs.length) throw Error("EMPTY_OBSERVATION");
    const raw = {
      raw_inputs: inputs,
      original_event_ids: inputs.map((i) => i.event_id),
    };
    if (new Set(inputs.map((i) => i.source)).size === 1)
      return {
        ...raw,
        passthrough: true,
        integrated_observations: [],
        conflicts: [],
        unknowns: [],
      };
    if (new Set(inputs.map((i) => i.task_id)).size !== 1)
      throw Error("UNRELATED_SOURCES");
    const output = await this.model.call(
      "perception",
      { inputs },
      PerceptionSchema,
      trace,
      images,
    );
    if (
      output.integrated_observations.some((o) =>
        o.evidence_ids.some(
          (e) =>
            !inputs.some((i) => i.event_id === e || i.evidence_ids.includes(e)),
        ),
      )
    )
      throw Error("UNKNOWN_EVIDENCE");
    return { ...raw, passthrough: false, ...output };
  }
}
