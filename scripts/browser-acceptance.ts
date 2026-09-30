import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Repository } from "../src/storage/repository.js";
const exec = promisify(execFile);
const root = process.cwd();
const batch =
  process.env.BATCH ?? new Date().toISOString().replace(/[:.]/g, "-");
const output = resolve("artifacts/browser", batch);
mkdirSync(output, { recursive: true });
const persona = JSON.parse(readFileSync("config/persona.dragon.json", "utf8"));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
});
const samples = Number(process.env.SAMPLES ?? 10);
const records: any[] = [];
try {
  for (const kind of (process.env.KINDS ?? "cold,history").split(","))
    for (let n = 0; n < samples; n++) {
      const sample = `${kind}-${n}`;
      const dir = resolve(output, sample);
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, "weave.db");
      if (kind === "history") {
        const r = new Repository(path);
        r.savePersona(persona, Date.now() - 3600000);
        r.userMessage(
          "我喜欢写奇幻故事，尤其想聊人物的动机。请记住这个偏好。",
          "fixture-history",
          Date.now() - 3600000,
        );
        const event = r.record({
          id: "historical-preference",
          kind: "PREFERENCE",
          source: "user_chat",
          content: "用户明确喜欢写奇幻故事，尤其人物动机",
          evidence_ids: ["fixture-history"],
          occurred_at: Date.now() - 3600000,
        });
        r.putLong({
          id: "preference-stories",
          kind: "PREFERENCE",
          content: event.content,
          source_event_ids: [event.id],
          occurred_at: event.occurred_at,
          detail_level: "detailed",
          tags: ["故事", "人物动机"],
        });
        r.patch({ pending_user_id: null, next_review_at: Date.now() });
        r.close();
      }
      const name = `weave-accept-${process.pid}`;
      let record: any = {
        sample,
        kind,
        status: "NOT_RUN",
        persona_id: persona.persona_id,
      };
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let start = Date.now();
      try {
        await exec("docker", [
          "run",
          "-d",
          "--rm",
          "--name",
          name,
          "--platform",
          "linux/amd64",
          "-u",
          `${process.getuid!()}:${process.getgid!()}`,
          "-p",
          "127.0.0.1:4320:4318",
          "-v",
          `${root}:/app`,
          "-w",
          "/app",
          "--env-file",
          resolve(".env"),
          "-e",
          "HOST=0.0.0.0",
          "-e",
          `DATA_DIR=/app/${dir.slice(root.length + 1)}`,
          "node:22.16.0-bookworm-slim",
          "node",
          "dist/src/server.js",
        ]);
        for (let retry = 0; retry < 50; retry++) {
          try {
            await page.goto("http://127.0.0.1:4320");
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (kind === "cold") {
          await page.locator("#persona").fill(JSON.stringify(persona));
          start = Date.now();
          await page.locator("#save-persona").click();
          await page.locator("#conversation").waitFor({ state: "visible" });
        } else start = Date.now();
        await page
          .locator(".assistant")
          .first()
          .waitFor({ state: "visible", timeout: 125000 });
        const text = await page.locator(".assistant").first().innerText();
        const elapsed = Date.now() - start;
        await page.screenshot({
          path: resolve(dir, "conversation.png"),
          fullPage: true,
        });
        await page.waitForFunction(async () => {
          const rows = await (await fetch("/api/messages")).json();
          return rows.some(
            (m: any) => m.role === "assistant" && m.displayed_at,
          );
        });
        record = {
          ...record,
          status: elapsed <= 120000 ? "PASS" : "FAIL",
          elapsed_ms: elapsed,
          text,
          errors,
        };
        if (kind === "cold" && n === 0) {
          await page
            .locator("#input")
            .fill("我想让屋檐下住着一只想当鼓手的小龙，继续说说它的故事吧。");
          await page.locator("#chat button").click();
          await page
            .locator(".assistant")
            .nth(1)
            .waitFor({ state: "visible", timeout: 120000 });
          record.reactive_text = await page
            .locator(".assistant")
            .nth(1)
            .innerText();
          await page.reload();
          await page.locator(".assistant").nth(1).waitFor();
          record.reload_count = await page.locator(".assistant").count();
        }
      } catch (e) {
        record = {
          ...record,
          status: "FAIL",
          elapsed_ms: Date.now() - start,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        await context.close();
        await exec("docker", ["stop", "-t", "2", name]).catch(() => {});
        const r = new Repository(path);
        record.messages = r.messages();
        record.state = r.state();
        record.calls = r.db
          .prepare("SELECT data FROM model_calls")
          .all()
          .map((row) => JSON.parse(row.data as string));
        if (
          record.state.last_error?.includes("HTTP_401") ||
          (record.state.last_error?.includes("fetch failed") &&
            !record.calls.some((c: any) => c.status === "RECEIVED"))
        )
          record.status = "INVALID";
        r.close();
        writeFileSync(
          resolve(dir, "result.json"),
          JSON.stringify(record, null, 2),
        );
        records.push(record);
        writeFileSync(
          resolve(output, "summary.json"),
          JSON.stringify(
            records.map(({ calls, messages, ...rest }) => rest),
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            sample,
            status: record.status,
            elapsed_ms: record.elapsed_ms,
            error: record.state.last_error,
            text: record.text,
          }),
        );
      }
    }
} finally {
  await browser.close();
}
if (records.some((r) => r.status !== "PASS")) process.exitCode = 1;
