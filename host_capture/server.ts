import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
const exec = promisify(execFile);
const token = process.env.CAPTURE_TOKEN;
if (!token) throw Error("CAPTURE_TOKEN is required");
let busy = false;
const server = createServer(async (req, res) => {
  let dir: string | undefined;
  let acquired = false;
  try {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/capture") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) {
        res.writeHead(413).end();
        return;
      }
    }
    const body = JSON.parse(raw);
    if (
      body.target !== "primary_display" ||
      typeof body.request_id !== "string"
    ) {
      res.writeHead(400).end();
      return;
    }
    if (busy) {
      res.writeHead(429).end();
      return;
    }
    busy = true;
    acquired = true;
    if (!process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "wayland")
      throw Error("X11_DISPLAY_REQUIRED");
    const { stdout } = await exec("xrandr", ["--query"], { timeout: 5000 });
    const match = stdout.match(
      /^(\S+) connected primary (\d+)x(\d+)\+(\d+)\+(\d+)/m,
    );
    if (!match) throw Error("PRIMARY_DISPLAY_NOT_FOUND");
    const [, display, width, height, x, y] = match;
    dir = await mkdtemp(join(tmpdir(), "weave-screen-"));
    const path = join(dir, "screen.png");
    await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        `${width}x${height}`,
        "-i",
        `${process.env.DISPLAY}+${x},${y}`,
        "-frames:v",
        "1",
        "-y",
        path,
      ],
      { timeout: 15000 },
    );
    const image = await readFile(path);
    const captured_at = Date.now();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: "CAPTURED",
        request_id: body.request_id,
        target: "primary_display",
        display,
        dimensions: { width: Number(width), height: Number(height) },
        captured_at,
        content_hash: createHash("sha256").update(image).digest("hex"),
        mime_type: "image/png",
        image_base64: image.toString("base64"),
      }),
    );
  } catch (e) {
    res
      .writeHead(503, { "Content-Type": "application/json" })
      .end(
        JSON.stringify({
          status: "FAILED",
          error: e instanceof Error ? e.message : "CAPTURE_FAILED",
        }),
      );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (acquired) busy = false;
  }
});
server.listen(
  Number(process.env.CAPTURE_PORT ?? 4319),
  process.env.CAPTURE_HOST ?? "127.0.0.1",
  () => console.log("X11 primary display capture adapter ready"),
);
