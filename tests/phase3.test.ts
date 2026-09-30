import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repository.js";
import { Engine } from "../src/runtime/engine.js";
import { DeepSeek } from "../src/runtime/model.js";
import { RecallSchema } from "../src/runtime/contracts.js";
import { FixtureModel, persona, until } from "./helpers.js";
test("T10/T11/T12: capture loop preserves raw image, related sources, no self-reply", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  let count = 0;
  const e = new Engine(r, m, {
    capture: async () => {
      count++;
      return {
        observation: {
          event_id: "screen",
          source: "desktop_screen",
          occurred_at: Date.now(),
          task_id: "assigned",
          content: "Weave assistant output in screen",
          artifact_id: "image",
          evidence_ids: ["image"],
        },
        image: "data:image/png;base64,fixture",
      };
    },
  });
  let decisions = 0;
  m.override.behavior = (input) =>
    ++decisions === 1
      ? {
          action: "CAPTURE_SCREEN",
          arguments: { target: "primary_display", purpose: "查看真实界面" },
          reason: "需要图像",
          revisit_condition: null,
        }
      : {
          action: "SPEAK",
          arguments: {
            text: "画面包含本应用自己的输出，不能当成你的新要求。",
            mode: "reactive",
            topic_id: null,
          },
          reason: "观察结果",
          revisit_condition: null,
        };
  await e.user("看看现在是什么界面", "request");
  await until(() => r.messages().length === 2);
  assert.equal(count, 1);
  assert.equal(m.calls.filter((x) => x === "perception").length, 1);
  assert.equal(r.messages().filter((x) => x.role === "user").length, 1);
  assert.equal(
    r.events().filter((e) => e.source === "desktop_screen").length,
    1,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(decisions, 2);
  r.close();
});
test("T19: hidden client cannot receive proactive commit; reconnect does not duplicate", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", false);
  now += 20000;
  await e.tick();
  assert.equal(m.calls.length, 0);
  e.client("a", true);
  now += 10000;
  await e.tick();
  const mid = r.messages()[0].id;
  e.client("a", null);
  e.client("b", true);
  assert.equal(r.messages().length, 1);
  assert.equal(r.messages()[0].displayed_at, null);
  r.displayed(mid, "b", now);
  r.displayed(mid, "b", now + 1);
  assert.equal(r.messages()[0].displayed_at, now);
  r.close();
});
test("T17: malformed JSON repairs once, no chat and all attempts budgeted", async () => {
  const r = new Repository(":memory:");
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response(
      JSON.stringify({
        model: "test",
        choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
        usage: { total_tokens: 2 },
      }),
    );
  };
  try {
    const model = new DeepSeek(r, {
      apiKey: "test",
      baseUrl: "http://fixture",
      model: "fixture",
      timeout: 100,
    });
    const e = new Engine(r, model);
    const trace = e.trace(true);
    await assert.rejects(
      model.call("memory_recall", {}, RecallSchema, trace),
      /MODEL_FORMAT_INVALID/,
    );
    assert.equal(count, 2);
    assert.equal(trace.calls, 2);
    assert.equal(r.modelCount(0), 2);
    trace.calls = 10;
    await assert.rejects(
      model.call("memory_recall", {}, RecallSchema, trace),
      /BUDGET/,
    );
    assert.equal(count, 2);
    assert.equal(r.messages().length, 0);
  } finally {
    globalThis.fetch = original;
    r.close();
  }
});
test("T17: timeout and empty model response produce recoverable failure", async () => {
  const original = globalThis.fetch;
  const r = new Repository(":memory:");
  const model = new DeepSeek(r, {
    apiKey: "test",
    baseUrl: "http://fixture",
    model: "fixture",
    timeout: 5,
  });
  const e = new Engine(r, model);
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    await assert.rejects(
      model.call("memory_recall", {}, RecallSchema, e.trace(true)),
      /FORMAT/,
    );
    globalThis.fetch = async (_url, opts) =>
      new Promise((_resolve, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(Error("timeout"))),
      );
    const keepAlive = setTimeout(() => {}, 50);
    await assert.rejects(
      model.call("memory_recall", {}, RecallSchema, e.trace(true)),
      /timeout/,
    );
    clearTimeout(keepAlive);
  } finally {
    globalThis.fetch = original;
    r.close();
  }
});
test("T18: repeated exhausted candidates defer instead of endless recursion", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", true);
  now += 10000;
  await e.tick();
  m.topic = 0;
  now += 600000;
  await e.tick();
  assert.ok(m.calls.length <= 15);
  assert.ok(r.state().next_review_at > now);
  r.close();
});
test("T15: screen inference cannot become explicit user preference", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  const e = new Engine(r, m, {
    capture: async () => ({
      observation: {
        event_id: "screen-pref",
        source: "desktop_screen",
        task_id: "x",
        occurred_at: Date.now(),
        content: "屏幕有编辑器",
        artifact_id: "screen-img",
        evidence_ids: ["screen-img"],
      },
      image: "data:image/png;base64,fixture",
    }),
  });
  let turns = 0;
  m.override.behavior = (input) =>
    ++turns === 1
      ? {
          action: "CAPTURE_SCREEN",
          arguments: { target: "primary_display", purpose: "观察" },
          reason: "用户要求",
          revisit_condition: null,
        }
      : {
          action: "SPEAK",
          arguments: {
            text: "屏幕有编辑器，但兴趣未知。",
            mode: "reactive",
            topic_id: null,
          },
          reason: "观察",
          revisit_condition: null,
        };
  m.override.thinking = (input) => ({
    observations: [],
    inferences: [],
    missing_information: [],
    action_intent: {
      purpose: "观察",
      candidate_actions: ["CAPTURE_SCREEN"],
      talking_points: [],
      relevant_evidence_ids: [],
    },
    memory_candidates: input.perception.raw_inputs.some(
      (o: any) => o.source === "desktop_screen",
    )
      ? [
          {
            content: "用户喜欢编程",
            kind: "PREFERENCE",
            evidence_ids: ["screen-img"],
          },
        ]
      : [],
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
  await e.user("看看屏幕", "screen-user");
  await until(() => r.messages().length === 2);
  assert.equal(r.preferences().length, 0);
  r.close();
});
