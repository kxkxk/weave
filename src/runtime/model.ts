import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defaults, id, type Model, type Trace } from "./contracts.js";
import type { Repository } from "../storage/repository.js";
export class DeepSeek implements Model {
  private active = 0;
  private waiters: { priority: number; resolve: () => void }[] = [];
  constructor(
    private repo: Repository,
    private options = {
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
      timeout: 30000,
    },
  ) {}
  private async acquire(background: boolean) {
    if (this.active < 2) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ priority: background ? 0 : 1, resolve });
      this.waiters.sort((a, b) => b.priority - a.priority);
    });
  }
  private release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  async call<T>(
    role: string,
    input: unknown,
    schema: z.ZodType<T, any, any>,
    trace: Trace,
    images: string[] = [],
  ): Promise<T> {
    if (!this.options.apiKey) throw Error("API_KEY_MISSING");
    let repair = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.acquire(trace.background);
      const started = Date.now();
      const callId = id("call");
      let attempted = false;
      let responseStats: Record<string, unknown> = {};
      try {
        if (trace.calls >= defaults.maxCalls || Date.now() > trace.deadline)
          throw Error("WAKE_BUDGET_EXHAUSTED");
        if (
          trace.background &&
          this.repo.modelCount(started - 3600000) >= defaults.backgroundCalls
        )
          throw Error("BACKGROUND_BUDGET_EXHAUSTED");
        trace.calls++;
        attempted = true;
        this.repo.logCall({
          id: callId,
          trace_id: trace.id,
          role,
          background: trace.background,
          started_at: started,
          status: "STARTED",
        });
        const contract = JSON.stringify(
          zodToJsonSchema(schema as any, { target: "jsonSchema7" }),
        );
        const prompt = readFileSync(
          new URL(`../../..//prompts/${role}.md`, import.meta.url),
          "utf8",
        );
        const content: any[] = [
          { type: "text", text: JSON.stringify(input) + repair },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ];
        const response = await fetch(
          `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: this.options.model,
              messages: [
                {
                  role: "system",
                  content:
                    prompt + "\n完整输出 JSON Schema（必须遵守）：" + contract,
                },
                { role: "user", content },
              ],
              response_format: { type: "json_object" },
              max_tokens: role === "memory_archive" ? 2400 : 1800,
              thinking: { type: "disabled" },
            }),
            signal: AbortSignal.timeout(
              Math.min(
                this.options.timeout,
                Math.max(1, trace.deadline - Date.now()),
              ),
            ),
          },
        );
        if (!response.ok) throw Error(`MODEL_HTTP_${response.status}`);
        const body: any = await response.json();
        const choice = body.choices?.[0];
        responseStats = {
          model: body.model,
          usage: body.usage,
          prompt_version: 2,
          prompt_hash: createHash("sha256")
            .update(prompt + contract)
            .digest("hex"),
        };
        this.repo.logCall({
          id: callId,
          trace_id: trace.id,
          role,
          background: trace.background,
          started_at: started,
          elapsed_ms: Date.now() - started,
          model: body.model,
          usage: body.usage,
          prompt_version: 2,
          prompt_hash: createHash("sha256")
            .update(prompt + contract)
            .digest("hex"),
          status: "RECEIVED",
        });
        try {
          if (
            choice?.finish_reason === "length" ||
            !choice?.message?.content?.trim()
          )
            throw Error("Empty or truncated model output");
          return schema.parse(JSON.parse(choice.message.content));
        } catch (e) {
          const detail = e instanceof Error ? e.message : "Invalid output";
          if (attempt === 1)
            throw Error("MODEL_FORMAT_INVALID: " + detail.slice(0, 1500));
          repair =
            "\n上次响应结构错误：" +
            detail.slice(0, 1500) +
            "。请严格按系统示例输出完整 json，检查字段及枚举。";
        }
      } catch (e) {
        if (attempted)
          this.repo.logCall({
            ...responseStats,
            id: callId,
            trace_id: trace.id,
            role,
            background: trace.background,
            started_at: started,
            elapsed_ms: Date.now() - started,
            status: "FAILED",
            error: e instanceof Error ? e.message : "MODEL_ERROR",
          });
        throw e;
      } finally {
        this.release();
      }
    }
    throw Error("MODEL_FORMAT_INVALID");
  }
}
