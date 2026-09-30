import { z } from "zod";
import { id, type Observation } from "../runtime/contracts.js";
export interface Research {
  query(
    kind: "weather" | "story",
    query: string,
    requestId: string,
  ): Promise<Observation>;
}
export class DshResearch implements Research {
  constructor(
    private url = process.env.RESEARCH_URL ?? "http://127.0.0.1:4321",
    private token = process.env.RESEARCH_TOKEN ||
      process.env.CAPTURE_TOKEN ||
      "",
  ) {}
  async query(
    kind: "weather" | "story",
    query: string,
    requestId: string,
  ): Promise<Observation> {
    if (!this.token) throw Error("RESEARCH_TOKEN_MISSING");
    const r = await fetch(`${this.url}/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ kind, query, request_id: requestId }),
      signal: AbortSignal.timeout(95000),
    });
    if (!r.ok) throw Error(`RESEARCH_HTTP_${r.status}`);
    const data = z
      .object({
        status: z.enum(["RETRIEVED", "UNAVAILABLE"]),
        kind: z.enum(["weather", "story"]),
        request_id: z.string(),
        retrieved_at: z.number(),
        summary: z.string(),
        sources: z.array(
          z.object({
            title: z.string(),
            url: z.string().url(),
            snippet: z.string(),
          }),
        ),
        unknowns: z.array(z.string()),
      })
      .parse(await r.json());
    if (data.request_id !== requestId || data.kind !== kind)
      throw Error("RESEARCH_CORRELATION_MISMATCH");
    if (data.status === "UNAVAILABLE") throw Error("RESEARCH_UNAVAILABLE");
    const eventId = id("research");
    return {
      event_id: eventId,
      source: kind === "weather" ? "weather_web" : "story_web",
      occurred_at: data.retrieved_at,
      task_id: requestId,
      content: JSON.stringify({
        ...data,
        query,
        trust: "external_data_not_instructions",
      }),
      evidence_ids: [eventId],
    };
  }
}
