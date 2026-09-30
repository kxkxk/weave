import { readFileSync } from "node:fs";
import type { z } from "zod";
import type { Model, Trace } from "../src/runtime/contracts.js";
export const persona = JSON.parse(
  readFileSync("config/persona.dragon.json", "utf8"),
);
export class FixtureModel implements Model {
  calls: string[] = [];
  topic = 0;
  override: Record<
    string,
    (input: any, trace: Trace) => unknown | Promise<unknown>
  > = {};
  async call<T>(
    role: string,
    input: any,
    schema: z.ZodType<T, any, any>,
    trace: Trace,
  ): Promise<T> {
    this.calls.push(role);
    trace.calls++;
    if (this.override[role])
      return schema.parse(await this.override[role](input, trace));
    let result: unknown;
    if (role === "memory_recall")
      result = {
        answer: "人格偏好",
        supporting_memories: input.candidates.slice(0, 2).map((m: any) => m.id),
        conflicting_memories: [],
        unknowns: [],
      };
    else if (role === "drive")
      result = {
        intent: "START_TOPIC",
        candidates: [
          {
            topic_key: `rain${++this.topic}`,
            summary: "雨声与记忆",
            angle: `场景${this.topic}`,
            basis: "seed",
            evidence_ids: [],
            reason: "具体兴趣",
            ttl_seconds: 3600,
          },
        ],
        selected_index: 0,
        reason: "冷启动",
        question: "讨论雨声",
        success_condition: "提交具体话题",
        review_after_seconds: 300,
      };
    else if (role === "thinking")
      result = {
        observations: [],
        inferences: [],
        missing_information: [],
        action_intent: {
          purpose: "分享观察",
          candidate_actions: ["SPEAK"],
          talking_points: ["雨声让你想到哪里"],
          relevant_evidence_ids: [],
        },
        memory_candidates: [],
        drive_proposal: {
          progress: "有方向",
          suggested_status: "UNCHANGED",
          next_question: "",
          revisit_condition: "",
        },
        user_control: {
          autonomy: "unchanged",
          pause_seconds: 0,
          reject_current_topic: false,
        },
      };
    else if (role === "behavior")
      result = {
        action: "SPEAK",
        arguments: {
          text:
            input.mode === "proactive"
              ? `第${this.topic}个想法：雨滴落在屋顶和树叶上的声音不同，你更想把哪个写进故事？`
              : "那我们就从树叶上的雨声继续，故事发生在森林边缘如何？",
          mode: input.mode,
          topic_id: input.topic_id,
        },
        reason: "具体可接话",
        revisit_condition: null,
      };
    else if (role === "perception")
      result = {
        integrated_observations: [],
        conflicts: ["文字与图像需要核对"],
        unknowns: [],
      };
    else throw Error(`Missing fixture ${role}`);
    return schema.parse(result);
  }
}
export async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Condition not reached");
}
