import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Repository } from "../src/storage/repository.js";
import { DeepSeek } from "../src/runtime/model.js";
import { Engine } from "../src/runtime/engine.js";
import { DshResearch } from "../src/adapters/research.js";
for (const [kind, text] of [
  [
    "weather",
    "请通过联网查询上海今天的天气，告诉我能核实的气温、降水信息，并给出来源和日期。",
  ],
  [
    "story",
    "请上网搜集一个和龙有关的传统民间故事，简短讲讲梗概，给出真实网页来源；不要只凭自己的知识编故事。",
  ],
]) {
  const dir = resolve(`artifacts/research/${Date.now()}-${kind}`);
  mkdirSync(dir, { recursive: true });
  const r = new Repository(resolve(dir, "weave.db"));
  r.savePersona(JSON.parse(readFileSync("config/persona.dragon.json", "utf8")));
  const e = new Engine(
    r,
    new DeepSeek(r),
    undefined,
    () => Date.now(),
    new DshResearch(),
  );
  e.control({ autonomy_enabled: false });
  const start = Date.now();
  await e.user(text, kind);
  while (
    Date.now() - start < 150000 &&
    !r.messages().some((m) => m.role === "assistant") &&
    !r.state().last_error
  )
    await new Promise((r) => setTimeout(r, 200));
  const results = r.db
    .prepare("SELECT data FROM action_results")
    .all()
    .map((row) => JSON.parse(row.data as string));
  const record = {
    kind,
    status:
      r.messages().some((m) => m.role === "assistant") &&
      results.some((v) => v.status === "RETRIEVED")
        ? "PASS"
        : "FAIL",
    elapsed_ms: Date.now() - start,
    messages: r.messages(),
    results,
    state: r.state(),
    calls: r.db
      .prepare("SELECT data FROM model_calls")
      .all()
      .map((row) => JSON.parse(row.data as string)),
    observations: r.events().filter((e) => e.source.endsWith("_web")),
  };
  writeFileSync(resolve(dir, "result.json"), JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify({
      kind,
      status: record.status,
      elapsed_ms: record.elapsed_ms,
      error: record.state.last_error,
      reply: record.messages.at(-1)?.text,
    }),
  );
  r.close();
  if (record.status !== "PASS") process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
