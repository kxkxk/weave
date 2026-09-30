import { randomUUID } from "node:crypto";
import { z } from "zod";
export const id = (prefix = "evt") => `${prefix}_${randomUUID()}`;
const text = z.string().trim().min(1).max(12000);
const strings = z.array(text);
export const PersonaSchema = z.object({
  persona_id: text,
  identity: text,
  traits: strings.min(1),
  expression_style: text,
  base_memories: z
    .array(z.object({ content: text, kind: z.literal("PERSONA_SEED") }))
    .min(1),
  interests: strings.min(1),
  likes: strings.min(1),
  dislikes: strings.min(1),
  intrinsic_motives: strings.min(1),
});
export type Persona = z.infer<typeof PersonaSchema> & { version: number };
export type Kind =
  | "PERSONA_SEED"
  | "OBSERVATION"
  | "INFERENCE"
  | "INTENTION"
  | "ACTION_RESULT"
  | "PREFERENCE";
export interface Envelope<T> {
  message_id: string;
  type: string;
  trace_id: string;
  causation_id: string | null;
  topic_id: string | null;
  source: string;
  occurred_at: number;
  context_revision: number;
  evidence_ids: string[];
  payload: T;
}
export const envelope = <T>(
  type: string,
  payload: T,
  revision: number,
  trace = id("trace"),
  source = "self",
  cause: string | null = null,
): Envelope<T> => ({
  message_id: id("msg"),
  type,
  trace_id: trace,
  causation_id: cause,
  topic_id: null,
  source,
  occurred_at: Date.now(),
  context_revision: revision,
  evidence_ids: [],
  payload,
});
export interface Observation {
  event_id: string;
  source: "user_chat" | "desktop_screen" | "weather_web" | "story_web";
  occurred_at: number;
  task_id: string;
  content: string;
  artifact_id?: string;
  evidence_ids: string[];
}
export interface Perception {
  passthrough: boolean;
  raw_inputs: Observation[];
  original_event_ids: string[];
  integrated_observations: Claim[];
  conflicts: string[];
  unknowns: string[];
}
const claim = z.object({ claim: text, evidence_ids: strings });
export type Claim = z.infer<typeof claim>;
export const PerceptionSchema = z.object({
  integrated_observations: z.array(claim),
  conflicts: strings,
  unknowns: strings,
});
export const RecallSchema = z.object({
  answer: z.string(),
  supporting_memories: strings,
  conflicting_memories: strings,
  unknowns: strings,
});
export const CandidateSchema = z.object({
  topic_key: text,
  summary: text,
  angle: text,
  basis: z.enum(["seed", "memory", "screen", "general"]),
  evidence_ids: strings,
  reason: text,
  ttl_seconds: z.number().int().min(60).max(604800),
});
export const DriveSchema = z
  .object({
    intent: z.enum([
      "START_TOPIC",
      "CONTINUE_TOPIC",
      "OBSERVE",
      "REFLECT",
      "WAIT",
    ]),
    candidates: z.array(CandidateSchema).max(3),
    selected_index: z.number().int().min(0).max(2).nullable(),
    reason: text,
    question: z.string(),
    success_condition: z.string(),
    review_after_seconds: z.number().min(10).max(3600),
  })
  .superRefine((v, c) => {
    if (
      v.intent !== "WAIT" &&
      (!v.question.trim() || !v.success_condition.trim())
    )
      c.addIssue({ code: "custom", message: "Finite task required" });
    if (
      v.intent === "START_TOPIC" &&
      (v.selected_index === null || !v.candidates[v.selected_index])
    )
      c.addIssue({ code: "custom", message: "Select a candidate" });
  });
export const ThinkSchema = z.object({
  observations: z.array(claim),
  inferences: z.array(
    z.object({ claim: text, basis: text, uncertainty: text }),
  ),
  missing_information: strings,
  action_intent: z.object({
    purpose: text,
    candidate_actions: z.array(
      z.enum([
        "SPEAK",
        "CAPTURE_SCREEN",
        "QUERY_WEATHER",
        "SEARCH_STORIES",
        "NOOP",
      ]),
    ),
    talking_points: strings,
    relevant_evidence_ids: strings,
  }),
  memory_candidates: z.array(
    z.object({
      content: text,
      kind: z.enum(["OBSERVATION", "INFERENCE", "INTENTION", "PREFERENCE"]),
      evidence_ids: strings,
      persist: z.boolean().default(false),
      supersedes_id: z.string().nullable().default(null),
    }),
  ),
  drive_proposal: z.object({
    progress: z.string(),
    suggested_status: z.enum(["ENGAGED", "CLOSED", "COOLDOWN", "UNCHANGED"]),
    next_question: z.string(),
    revisit_condition: z.string(),
  }),
  user_control: z.object({
    autonomy: z.enum(["unchanged", "pause", "disable", "resume"]),
    pause_seconds: z.number().min(0).max(86400),
    reject_current_topic: z.boolean(),
  }),
});
export const BehaviorSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SPEAK"),
    arguments: z.object({
      text,
      mode: z.enum(["proactive", "reactive"]),
      topic_id: z.string().nullable(),
    }),
    reason: text,
    revisit_condition: z.string().nullable(),
  }),
  z.object({
    action: z.literal("CAPTURE_SCREEN"),
    arguments: z.object({
      target: z.literal("primary_display"),
      purpose: text,
    }),
    reason: text,
    revisit_condition: z.string().nullable(),
  }),
  z.object({
    action: z.literal("QUERY_WEATHER"),
    arguments: z.object({ location: text, date: text, purpose: text }),
    reason: text,
    revisit_condition: z.string().nullable(),
  }),
  z.object({
    action: z.literal("SEARCH_STORIES"),
    arguments: z.object({ query: text, purpose: text }),
    reason: text,
    revisit_condition: z.string().nullable(),
  }),
  z.object({
    action: z.literal("NOOP"),
    arguments: z.object({}),
    reason: text,
    revisit_condition: text,
  }),
]);
export const ArchiveSchema = z.object({
  decisions: z.array(
    z.object({
      operation: z.enum(["discard", "save", "merge"]),
      detail_level: z.enum(["brief", "summary", "detailed"]).nullable(),
      content: z.string().nullable(),
      kind: z.enum([
        "OBSERVATION",
        "INFERENCE",
        "INTENTION",
        "ACTION_RESULT",
        "PREFERENCE",
      ]),
      essential_fields: strings,
      source_event_ids: strings.min(1),
      merge_target_id: z.string().nullable(),
      retained_artifact_ids: strings,
      tags: strings,
    }),
  ),
  cue_candidates: z.array(
    z.object({
      summary: text,
      suggested_question: text,
      evidence_ids: strings.min(1),
      dedup_key: text,
      ttl_seconds: z.number().min(60).max(604800),
    }),
  ),
});
export interface Trace {
  id: string;
  revision: number;
  background: boolean;
  calls: number;
  thinkRounds: number;
  screenshots: number;
  researchCalls?: number;
  revisions: number;
  deadline: number;
}
export interface Model {
  call<T>(
    role: string,
    input: unknown,
    schema: z.ZodType<T, any, any>,
    trace: Trace,
    images?: string[],
  ): Promise<T>;
}
export interface EventRecord {
  id: string;
  occurred_at: number;
  recorded_at: number;
  source: string;
  kind: Kind;
  content: string;
  evidence_ids: string[];
  topic_id: string | null;
  tier: "HOT" | "PENDING";
  access_seq: number;
  artifact_id?: string;
}
export interface Topic {
  topic_id: string;
  topic_key: string;
  summary: string;
  angle: string;
  basis: string;
  evidence_ids: string[];
  status: string;
  revision: number;
  expires_at: number;
  retry_after: number;
  last_offered_at: number | null;
  last_engaged_at: number | null;
  origin: "user" | "self";
}
export interface DriveState {
  autonomy_enabled: boolean;
  pause_until: number;
  next_review_at: number;
  current_topic_id: string | null;
  last_user_message_at: number;
  last_proactive_commit_at: number;
  unanswered_count: number;
  consecutive_no_progress: number;
  last_no_response_evaluated_message_id: string | null;
  context_revision: number;
  persona_id: string | null;
  persona_version: number;
  screen_enabled: boolean;
  research_enabled?: boolean;
  screen_target: "primary_display";
  last_error: string | null;
  ready_at: number;
  bootstrap_deadline: number;
  bootstrap_failed: boolean;
  pending_user_id: string | null;
}
export const defaults = {
  initialDelay: 10000,
  idle: 300000,
  minGap: 300000,
  backoff: [600000, 1800000, 3600000],
  hourlyMessages: 3,
  maxCalls: 10,
  backgroundCalls: 60,
  hotLimit: 128,
  hotTokens: 16000,
  recallLimit: 20,
  archiveLimit: 8,
};
