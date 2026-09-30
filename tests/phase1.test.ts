import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repository.js";
import { Engine } from "../src/runtime/engine.js";
import { FixtureModel, persona, until } from "./helpers.js";
test("T00/T01: setup gate, transaction, no synthetic user message", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  e.client("a", true);
  await e.tick();
  assert.equal(m.calls.length, 0);
  assert.throws(() => r.savePersona({ ...persona, likes: [] }));
  assert.equal(r.persona(), null);
  r.savePersona(persona, now);
  assert.equal(r.messages().length, 0);
  assert.equal(r.long().length, 3);
  now += 10000;
  await e.tick();
  assert.equal(r.messages().length, 1);
  assert.equal(r.messages()[0].role, "assistant");
  assert.deepEqual(m.calls, [
    "memory_recall",
    "drive",
    "memory_recall",
    "thinking",
    "behavior",
  ]);
  r.close();
});
test("T02/T03/T05: cold startup topic and user reply in same context", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", true);
  now += 10000;
  await e.tick();
  assert.match(r.messages()[0].text, /雨滴/);
  assert.equal(r.messages()[0].displayed_at, null);
  r.displayed(r.messages()[0].id, "a", now);
  assert.equal(r.messages()[0].displayed_at, now);
  now += 1000;
  await e.user("树叶上的雨声", "client1");
  await until(() => r.messages().length === 3);
  assert.equal(r.state().unanswered_count, 0);
  assert.equal(r.messages()[2].mode, "reactive");
  await e.user("树叶上的雨声", "client1");
  assert.equal(r.messages().length, 3);
  r.close();
});
test("T16: new input invalidates a suspended autonomous expression", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  let now = 100000;
  const e = new Engine(r, m, undefined, () => now);
  r.savePersona(persona, now);
  e.client("a", true);
  let release!: () => void;
  let entered = false;
  m.override.behavior = async (input) => {
    if (input.mode === "proactive") {
      entered = true;
      await new Promise<void>((resolve) => (release = resolve));
    }
    return {
      action: "SPEAK",
      arguments: {
        text: input.mode === "proactive" ? "旧话题" : "新话题回答",
        mode: input.mode,
        topic_id: null,
      },
      reason: "测试",
      revisit_condition: null,
    };
  };
  now += 10000;
  const wake = e.tick();
  await until(() => entered);
  await e.user("换话题", "new");
  release();
  await wake;
  await until(() => r.messages().length === 2);
  assert.equal(
    r.messages().some((m) => m.text === "旧话题"),
    false,
  );
  r.close();
});
test("T09: single channel preserves raw inputs and bypasses model", async () => {
  const r = new Repository(":memory:");
  const m = new FixtureModel();
  const e = new Engine(r, m);
  const observations = [
    {
      event_id: "e",
      source: "user_chat" as const,
      occurred_at: 10,
      task_id: "t",
      content: " 原样\n内容 ",
      evidence_ids: ["e"],
    },
  ];
  const result = await e.perception.perceive(observations, e.trace(false));
  assert.strictEqual(result.raw_inputs, observations);
  assert.equal(result.passthrough, true);
  assert.equal(m.calls.length, 0);
  r.close();
});
