import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repository.js";
import { Engine } from "../src/runtime/engine.js";
import { FixtureModel, persona, until } from "./helpers.js";
for (const action of ["QUERY_WEATHER", "SEARCH_STORIES"] as const)
  test(`${action}: executes once and routes sourced observation through perception`, async () => {
    const r = new Repository(":memory:");
    r.savePersona(persona);
    const m = new FixtureModel();
    let requests = 0;
    let turns = 0;
    const e = new Engine(r, m, undefined, () => Date.now(), {
      query: async (kind, query, requestId) => {
        requests++;
        return {
          event_id: "web-evidence",
          source: kind === "weather" ? "weather_web" : "story_web",
          task_id: requestId,
          occurred_at: Date.now(),
          content: JSON.stringify({
            summary: "真实查询结果 fixture",
            sources: [{ url: "https://example.com/source", title: "来源" }],
          }),
          evidence_ids: ["web-evidence"],
        };
      },
    });
    m.override.behavior = (input) =>
      ++turns === 1
        ? {
            action,
            arguments:
              action === "QUERY_WEATHER"
                ? { location: "上海", date: "今天", purpose: "核实天气" }
                : { query: "龙的民间故事", purpose: "搜集故事" },
            reason: "需要联网",
            revisit_condition: null,
          }
        : {
            action: "SPEAK",
            arguments: {
              text: "据查询结果给出摘要及来源 https://example.com/source",
              mode: "reactive",
              topic_id: null,
            },
            reason: "已经拿到查询结果",
            revisit_condition: null,
          };
    await e.user("联网查询", "c");
    await until(() => r.messages().length === 2);
    assert.equal(requests, 1);
    assert.equal(r.events().filter((v) => v.source.endsWith("_web")).length, 1);
    assert.equal(m.calls.filter((v) => v === "perception").length, 1);
    r.close();
  });
test("Research disabled rejects generated tool action without executing it", async () => {
  const r = new Repository(":memory:");
  r.savePersona(persona);
  const m = new FixtureModel();
  let calls = 0;
  const e = new Engine(r, m, undefined, () => Date.now(), {
    query: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  e.control({ research_enabled: false });
  m.override.behavior = () => ({
    action: "QUERY_WEATHER",
    arguments: { location: "上海", date: "今天", purpose: "天气" },
    reason: "查询",
    revisit_condition: null,
  });
  await e.user("天气", "c");
  await until(() => Boolean(r.state().last_error));
  assert.equal(calls, 0);
  assert.equal(r.messages().length, 1);
  assert.equal(r.state().last_error, "RESEARCH_NOT_ALLOWED");
  r.close();
});
