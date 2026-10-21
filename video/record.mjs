import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { hashes } from "./prepare.mjs";
const { values: v } = parseArgs({
  options: {
    site: { type: "string", default: "replay" },
    out: { type: "string", default: "swarm.mp4" },
    fps: { type: "string", default: "30" },
    preview: { type: "boolean", default: false },
  },
});
const site = path.resolve(v.site),
  out = path.resolve(v.out),
  fps = Number(v.fps),
  seconds = 36,
  frames = seconds * fps,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
if (!Number.isInteger(fps) || fps < 24 || fps > 60)
  throw Error("fps must be 24..60");
const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const server = http.createServer((req, res) => {
  try {
    let p = path.resolve(
      site,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (!p.startsWith(site + path.sep)) throw Error("path");
    if (fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    // Opaque-origin sandboxed modules need CORS, but never get parent DOM access.
    if (p.startsWith(path.join(site, "game") + path.sep))
      res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Content-Type",
      mime[path.extname(p)] || "application/octet-stream",
    );
    fs.createReadStream(p)
      .on("error", () => res.end())
      .pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
let browser,
  encoder,
  encoderError = "";
const errors = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1080 },
    deviceScaleFactor: 1,
  });
  await page.route("**/*", (r) =>
    r
      .request()
      .url()
      .startsWith(origin + "/") || /^(data:|blob:)/.test(r.request().url())
      ? r.continue()
      : r.abort(),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.addInitScript(() => {
    let queue = [],
      clock = 0,
      id = 0;
    const epoch = Date.now(),
      timers = new Map();
    Date.now = () => epoch + clock;
    Object.defineProperty(performance, "now", { value: () => clock });
    window.requestAnimationFrame = (cb) => (queue.push({ id: ++id, cb }), id);
    window.cancelAnimationFrame = (n) => {
      queue = queue.filter((x) => x.id !== n);
    };
    const timer = (cb, delay, repeat, args) => {
      const key = ++id;
      timers.set(key, {
        cb,
        at: clock + Math.max(1, Number(delay) || 0),
        repeat,
        args,
      });
      return key;
    };
    window.setTimeout = (cb, delay, ...args) => timer(cb, delay, 0, args);
    window.setInterval = (cb, delay, ...args) =>
      timer(cb, delay, Math.max(1, Number(delay) || 1), args);
    window.clearTimeout = window.clearInterval = (n) => timers.delete(n);
    window.__step = (ms) => {
      clock = ms;
      for (let n = 0; n < 10000; n++) {
        const due = [...timers]
          .filter(([, x]) => x.at <= clock)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [key, t] = due;
        if (t.repeat) t.at += t.repeat;
        else timers.delete(key);
        if (typeof t.cb === "function") t.cb(...t.args);
        else
          throw Error(
            "String timers are unsupported during deterministic capture",
          );
      }
      const batch = queue;
      queue = [];
      for (const x of batch) x.cb(ms);
    };
  });
  await page.goto(origin + "/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(
    () => window.swarmFilm?.ready,
    {},
    { polling: 100, timeout: 90000 },
  );
  const game = await (
    await page.locator("#game").elementHandle()
  ).contentFrame();
  await game.waitForLoadState("load");
  const session = await page.context().newCDPSession(page),
    step = async (t) => {
      const state = await page.evaluate((t) => {
        const s = swarmFilm.seek(t);
        window.__step?.(t * 1000);
        return s;
      }, t);
      await game.evaluate((t) => window.__step?.(t * 1000), t);
      return state;
    };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const shots = new Set(
    [0, 4, 12, 20, 26, 32, 36].map((t) => Math.min(frames - 1, t * fps)),
  );
  if (v.preview) {
    for (let end = 0; end < frames; end += fps) {
      await page.evaluate(
        ({ start, end, fps }) => {
          for (let i = start; i <= end; i++) {
            const t = i / fps;
            swarmFilm.seek(t);
            window.__step?.(t * 1000);
          }
        },
        { start: end === 0 ? 0 : end - fps + 1, end, fps },
      );
      await game.evaluate(
        ({ start, end, fps }) => {
          for (let i = start; i <= end; i++) window.__step?.((i / fps) * 1000);
        },
        { start: end === 0 ? 0 : end - fps + 1, end, fps },
      );
      if (shots.has(end))
        await page.screenshot({ path: out + "." + end + ".png" });
    }
  } else {
    encoder = spawn(
      ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-vf",
        "scale=in_range=full:out_range=tv,format=yuv420p",
        "-color_range",
        "tv",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const encoderDone = new Promise((resolve, reject) => {
      encoder.once("error", reject);
      encoder.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(encoderError || "Encoder failed")),
      );
    });
    encoderDone.catch(() => {});
    encoder.stdin.on("error", () => {});
    encoder.stderr.on("data", (d) => (encoderError += d));
    for (let i = 0; i < frames; i++) {
      await step(i / fps);
      const shot = await session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 94,
        fromSurface: true,
      });
      if (!encoder.stdin.write(Buffer.from(shot.data, "base64")))
        await Promise.race([once(encoder.stdin, "drain"), encoderDone]);
      if (shots.has(i)) await page.screenshot({ path: out + "." + i + ".png" });
      if (i % (fps * 6) === 0)
        console.log(JSON.stringify({ frame: i, total: frames }));
    }
    encoder.stdin.end();
    await encoderDone;
  }
  const expected = JSON.parse(
      fs.readFileSync(path.join(site, "source-hashes.json")),
    ),
    actual = hashes(path.join(site, "game"));
  if (
    JSON.stringify(Object.entries(expected).sort()) !==
    JSON.stringify(Object.entries(actual).sort())
  )
    throw Error("Application source changed during capture");
  if (errors.length) throw Error("Playback errors: " + errors.join("; "));
  const report = {
    preview: v.preview,
    file: out,
    fps,
    frames: v.preview ? undefined : frames,
    durationSeconds: seconds,
    width: 1080,
    height: 1080,
    gameFilesUnmodified: true,
    errors,
    scope:
      "Accelerated recorded trace plus exact exported final artifact. Browser timers and animation frames are advanced per frame. Model inference, media playback and browser acceptance are not simulated.",
  };
  if (!v.preview) {
    const check = spawn(ffmpeg, [
      "-hide_banner",
      "-i",
      out,
      "-map",
      "0:v:0",
      "-an",
      "-f",
      "null",
      "-",
      "-progress",
      "pipe:1",
      "-nostats",
    ]);
    let progress = "",
      diagnostic = "";
    check.stdout.on("data", (d) => (progress += d));
    check.stderr.on("data", (d) => (diagnostic += d));
    const code = await new Promise((resolve, reject) => {
      check.on("error", reject);
      check.on("exit", resolve);
    });
    if (
      code !== 0 ||
      Number([...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]) !==
        frames ||
      !diagnostic.includes("1080x1080") ||
      !diagnostic.includes("h264") ||
      !diagnostic.includes("yuv420p") ||
      !diagnostic.includes(fps + " fps") ||
      Math.abs(
        Number([...progress.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) /
          1e6 -
          seconds,
      ) > 0.05
    )
      throw Error("Encoded MP4 validation failed");
    report.fullDecodePassed = true;
  }
  fs.writeFileSync(out + ".verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  encoder?.kill();
  await browser?.close();
  if (server.listening) await new Promise((r) => server.close(r));
}
