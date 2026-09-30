import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../src/storage/repository.js";
import { Engine } from "../src/runtime/engine.js";
import { FixtureModel, persona, until } from "./helpers.js";
test("T06: three hour silence respects backoff and no-response idempotency", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", true);
  now += 10000;
  await e.tick();
  const times = [now];
  for (let minute = 1; minute <= 180; minute++) {
    now += 60000;
    await e.tick();
    const rows = r.messages();
    if (rows.length > times.length) times.push(now);
    e.drive.noResponse(now);
    e.drive.noResponse(now);
  }
  assert.deepEqual(
    times.slice(0, 4).map((t, i) => (i ? t - times[i - 1] : 0)),
    [0, 600000, 1800000, 3600000],
  );
  assert.equal(times.length, 5);
  assert.equal(r.state().unanswered_count, 4);
  r.close();
});
test("T07/T08: pause blocks proactive but allows reply, NOOP has no chat", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", true);
  e.control({ autonomy_enabled: false });
  now += 20000;
  await e.tick();
  assert.equal(r.messages().length, 0);
  await e.user("你好", "a");
  await until(() => r.messages().length === 2);
  e.control({ autonomy_enabled: true });
  now += 400000;
  m.override.behavior = () => ({
    action: "NOOP",
    arguments: {},
    reason: "重复候选",
    revisit_condition: "换方向",
  });
  await e.tick();
  assert.equal(r.messages().length, 2);
  assert.ok(r.state().next_review_at > now);
  r.close();
});
test("T13: actual access LRU, scan does not touch, recoverable PENDING", () => {
  const r = new Repository(":memory:");
  for (const n of ["a", "b", "c"])
    r.record(
      { id: n, content: n, kind: "OBSERVATION", source: "user_chat" },
      3,
    );
  r.candidates("b");
  assert.deepEqual(
    r.events("HOT").map((e) => e.id),
    ["a", "b", "c"],
  );
  r.touch(["a"]);
  r.record(
    { id: "d", content: "d", kind: "OBSERVATION", source: "user_chat" },
    3,
  );
  assert.deepEqual(
    r.events("PENDING").map((e) => e.id),
    ["b"],
  );
  r.close();
});
test("T13: archive save merge discard preserves sources and rejects kind laundering", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  const e = new Engine(r, m);
  r.record(
    {
      id: "a",
      kind: "INFERENCE",
      source: "thinking",
      content: "可能在2026年喜欢雨声",
    },
    0,
  );
  m.override.memory_archive = () => ({
    decisions: [
      {
        operation: "save",
        detail_level: "summary",
        content: "可能在2026年喜欢雨声",
        kind: "OBSERVATION",
        essential_fields: ["2026"],
        source_event_ids: ["a"],
        merge_target_id: null,
        retained_artifact_ids: [],
        tags: [],
      },
    ],
    cue_candidates: [],
  });
  await assert.rejects(e.memory.consolidate(e.trace(true)), /KIND_CHANGED/);
  assert.equal(r.events("PENDING").length, 1);
  m.override.memory_archive = () => ({
    decisions: [
      {
        operation: "save",
        detail_level: "summary",
        content: "可能在2026年喜欢雨声",
        kind: "INFERENCE",
        essential_fields: ["2026"],
        source_event_ids: ["a"],
        merge_target_id: null,
        retained_artifact_ids: [],
        tags: [],
      },
    ],
    cue_candidates: [],
  });
  await e.memory.consolidate(e.trace(true));
  const saved = r.long().find((m) => m.kind === "INFERENCE");
  assert.ok(saved);
  r.record(
    {
      id: "b",
      kind: "INFERENCE",
      source: "thinking",
      content: "也可能喜欢云影",
    },
    0,
  );
  m.override.memory_archive = () => ({
    decisions: [
      {
        operation: "merge",
        detail_level: "summary",
        content: "2026年可能喜欢雨声，也可能喜欢云影",
        kind: "INFERENCE",
        essential_fields: [],
        source_event_ids: ["b"],
        merge_target_id: saved.id,
        retained_artifact_ids: [],
        tags: [],
      },
    ],
    cue_candidates: [],
  });
  await e.memory.consolidate(e.trace(true));
  assert.deepEqual(r.long(saved.id)[0].source_event_ids, ["a", "b"]);
  r.record(
    { id: "c", kind: "INFERENCE", source: "thinking", content: "重复想法" },
    0,
  );
  m.override.memory_archive = () => ({
    decisions: [
      {
        operation: "discard",
        detail_level: null,
        content: null,
        kind: "INFERENCE",
        essential_fields: [],
        source_event_ids: ["c"],
        merge_target_id: null,
        retained_artifact_ids: [],
        tags: [],
      },
    ],
    cue_candidates: [],
  });
  await e.memory.consolidate(e.trace(true));
  assert.equal(r.events("PENDING").length, 0);
  r.close();
});
test("T14/T16/T20: restart, commit idempotency, persona version isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-"));
  const path = join(dir, "db");
  let r = new Repository(path);
  r.savePersona(persona);
  r.record(
    { id: "p", kind: "OBSERVATION", source: "user_chat", content: "明天再聊" },
    0,
  );
  const revision = r.state().context_revision;
  const result = r.commit("act", "具体话题", "proactive", null, revision);
  r.patch({ unanswered_count: 2 });
  r.close();
  r = new Repository(path);
  assert.equal(r.events("PENDING")[0].id, "p");
  assert.equal(r.state().unanswered_count, 2);
  assert.deepEqual(
    r.commit("act", "不应重复", "proactive", null, revision),
    result,
  );
  r.savePersona({ ...persona, interests: ["音乐"] });
  assert.equal(
    r.seeds().every((m) => m.persona_version === 2),
    true,
  );
  assert.equal(r.messages().length, 1);
  assert.throws(
    () => r.commit("stale", "旧人格表达", "proactive", null, revision),
    /STALE/,
  );
  r.close();
  rmSync(dir, { recursive: true });
});
test("Chinese recall uses fragments and preserves explicit preferences", () => {
  const r = new Repository(":memory:");
  r.record({
    id: "x",
    kind: "OBSERVATION",
    source: "user_chat",
    content: "今天想讨论人物塑造和故事动机",
  });
  r.record({
    id: "y",
    kind: "OBSERVATION",
    source: "user_chat",
    content: "别的事情",
  });
  assert.equal(r.candidates("人物塑造", 1)[0].id, "x");
  r.close();
});
test("T15: explicit user preference persists; silence does not change it", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  const e = new Engine(r, m);
  m.override.thinking = (input) => ({
    observations: [],
    inferences: [],
    missing_information: [],
    action_intent: {
      purpose: "确认偏好",
      candidate_actions: ["SPEAK"],
      talking_points: ["已记录"],
      relevant_evidence_ids: [],
    },
    memory_candidates: [
      {
        content: "用户明确喜欢写故事",
        kind: "PREFERENCE",
        evidence_ids: [input.perception.raw_inputs[0].event_id],
        persist: true,
        supersedes_id: null,
      },
    ],
    drive_proposal: {
      progress: "偏好明确",
      suggested_status: "UNCHANGED",
      next_question: "",
      revisit_condition: "",
    },
    user_control: {
      autonomy: "unchanged",
      pause_seconds: 0,
      reject_current_topic: false,
    },
  });
  await e.user("请记住，我喜欢写故事", "pref");
  await until(() => r.messages().length === 2);
  assert.equal(r.preferences().length, 1);
  assert.ok(r.preferences()[0].source_event_ids.includes(r.messages()[0].id));
  const before = r.preferences().length;
  e.drive.noResponse(Date.now() + 7200000);
  assert.equal(r.preferences().length, before);
  r.close();
});
test("Memory cues deduplicate and preserve originating evidence", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  const e = new Engine(r, m);
  const consolidate = async (eid: string) => {
    r.record(
      {
        id: eid,
        kind: "OBSERVATION",
        source: "user_chat",
        content: "想写龙的故事",
      },
      0,
    );
    m.override.memory_archive = () => ({
      decisions: [
        {
          operation: "save",
          detail_level: "summary",
          content: "想写龙的故事",
          kind: "OBSERVATION",
          essential_fields: [],
          source_event_ids: [eid],
          merge_target_id: null,
          retained_artifact_ids: [],
          tags: ["故事"],
        },
      ],
      cue_candidates: [
        {
          summary: "延续龙的故事",
          suggested_question: "龙的动机是什么",
          evidence_ids: [eid],
          dedup_key: "dragon-story:v1",
          ttl_seconds: 3600,
        },
      ],
    });
    await e.memory.consolidate(e.trace(true));
  };
  await consolidate("one");
  await consolidate("two");
  assert.equal(e.memory.cues().length, 1);
  assert.deepEqual(e.memory.cues()[0].evidence_ids, ["one"]);
  r.close();
});
test("T15: explicit correction removes superseded preference from both recall tiers", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  r.record({
    id: "old-pref",
    kind: "PREFERENCE",
    source: "user_explicit",
    content: "用户喜欢雨天",
  });
  r.putLong({
    id: "long-old",
    kind: "PREFERENCE",
    content: "用户喜欢雨天",
    source_event_ids: ["old-pref"],
  });
  const m = new FixtureModel();
  const e = new Engine(r, m);
  m.override.thinking = (input) => ({
    observations: [],
    inferences: [],
    missing_information: [],
    action_intent: {
      purpose: "更正偏好",
      candidate_actions: ["SPEAK"],
      talking_points: [],
      relevant_evidence_ids: [],
    },
    memory_candidates: [
      {
        content: "用户纠正为喜欢晴天",
        kind: "PREFERENCE",
        evidence_ids: [input.perception.raw_inputs[0].event_id],
        persist: true,
        supersedes_id: "long-old",
      },
    ],
    drive_proposal: {
      progress: "",
      suggested_status: "UNCHANGED",
      next_question: "",
      revisit_condition: "",
    },
    user_control: {
      autonomy: "unchanged",
      pause_seconds: 0,
      reject_current_topic: false,
    },
  });
  await e.user("纠正，我现在喜欢晴天", "correction");
  await until(() => r.messages().length === 2);
  assert.equal(
    r.preferences().some((p) => p.id === "long-old"),
    false,
  );
  assert.equal(
    r.candidates("雨天").some((p) => p.id === "old-pref"),
    false,
  );
  r.close();
});
