import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Repository } from "./storage/repository.js";
import { DeepSeek } from "./runtime/model.js";
import { Engine } from "./runtime/engine.js";
import { id } from "./runtime/contracts.js";
import { DshResearch } from "./adapters/research.js";
import { HostCapture } from "./adapters/screen.js";
export function serve(
  repo: Repository,
  engine: Engine,
  port = 4318,
  host = "127.0.0.1",
) {
  const server = createServer(async (req, res) => {
    try {
      const expected = req.headers.host;
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== expected) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      let body: any = {};
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          res.writeHead(415).end();
          return;
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 65536) {
            res.writeHead(413).end();
            return;
          }
        }
        body = JSON.parse(raw);
      }
      let result: any;
      if (req.method === "GET" && url.pathname === "/api/persona")
        result = {
          phase: repo.persona() ? "READY" : "PERSONA_SETUP",
          persona: repo.persona(),
        };
      else if (req.method === "POST" && url.pathname === "/api/persona") {
        result = repo.savePersona(body);
        if (engine.visible())
          repo.patch({ bootstrap_deadline: Date.now() + 120000 });
      } else if (req.method === "GET" && url.pathname === "/api/messages")
        result = repo.messages(
          Math.max(0, Number(url.searchParams.get("after")) || 0),
        );
      else if (req.method === "POST" && url.pathname === "/api/messages") {
        const v = z
          .object({
            text: z.string().trim().min(1).max(12000),
            client_message_id: z.string().min(1),
          })
          .parse(body);
        result = await engine.user(v.text, v.client_message_id);
      } else if (req.method === "POST" && url.pathname === "/api/autonomy") {
        const v = z
          .object({
            enabled: z.boolean(),
            pause_seconds: z.number().min(0).max(86400).default(0),
          })
          .parse(body);
        engine.control({
          autonomy_enabled: v.enabled,
          pause_until: v.pause_seconds
            ? Date.now() + v.pause_seconds * 1000
            : 0,
        });
        result = engine.status();
      } else if (
        req.method === "POST" &&
        url.pathname === "/api/screen-settings"
      ) {
        const v = z
          .object({
            enabled: z.boolean(),
            target: z.literal("primary_display"),
          })
          .parse(body);
        engine.control({ screen_enabled: v.enabled });
        result = engine.status();
      } else if (
        req.method === "POST" &&
        url.pathname === "/api/research-settings"
      ) {
        const v = z.object({ enabled: z.boolean() }).parse(body);
        engine.control({ research_enabled: v.enabled });
        result = engine.status();
      } else if (req.method === "GET" && url.pathname === "/api/status")
        result = engine.status();
      else if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(url.pathname)
      ) {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith("html")
            ? "text/html; charset=utf-8"
            : file.endsWith("css")
              ? "text/css"
              : "text/javascript",
        );
        res.end(await readFile(resolve("web", file)));
        return;
      } else {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: e instanceof Error ? e.message : "REQUEST_FAILED",
        }),
      );
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/api/events" ||
      (req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const clientId = id("client");
    engine.client(clientId, false);
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 45000) ws.terminate();
      else ws.ping();
    }, 15000);
    ws.on("pong", () => (lastPong = Date.now()));
    ws.send(JSON.stringify({ type: "connected", client_id: clientId }));
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "visibility" && typeof msg.visible === "boolean")
          engine.client(clientId, msg.visible);
        if (
          msg.type === "displayed" &&
          typeof msg.message_id === "string" &&
          engine.clients.get(clientId)
        )
          repo.displayed(msg.message_id, clientId);
      } catch {
        ws.close(1007, "Invalid event");
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      engine.client(clientId, null);
    });
  });
  const broadcast = (type: string, payload?: unknown) => {
    for (const ws of wss.clients)
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type, payload }));
  };
  engine.on("messages", () => broadcast("messages"));
  engine.on("status", (s) => broadcast("status", s));
  server.listen(port, host);
  engine.start();
  return { server, wss };
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const repo = new Repository(
    resolve(process.env.DATA_DIR ?? "data", "weave.db"),
  );
  const capture = new HostCapture(
    repo,
    resolve(process.env.DATA_DIR ?? "data"),
  );
  const engine = new Engine(
    repo,
    new DeepSeek(repo),
    capture,
    undefined,
    new DshResearch(),
  );
  setInterval(
    () => void capture.cleanup().catch(console.error),
    3600000,
  ).unref();
  const { server, wss } = serve(
    repo,
    engine,
    Number(process.env.PORT ?? 4318),
    process.env.HOST ?? "127.0.0.1",
  );
  console.log("Weave listening on", process.env.PORT ?? 4318);
  process.on("SIGTERM", () => {
    engine.stop();
    wss.close();
    server.close(() => {
      repo.close();
      process.exit(0);
    });
  });
}
