// Static server for the presentation page (web/) PLUS a transparent reverse proxy to the
// A / B / C party servers, so the whole demo lives behind ONE origin and port. The browser
// only ever talks to this server: static files, plus /svc/a|b|c/... forwarded to the right
// party. In Docker only this port is published; A/B/C stay internal (127.0.0.1:3001-3003)
// and are reached through the proxy.
//   npm run present     -> http://localhost:8080  (PRESENT_PORT to override)
import express from "express";
import type { Request, Response } from "express";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PRESENT_PORT ?? 8080);
const webDir = fileURLToPath(new URL("../web", import.meta.url));

// Party servers proxied behind this single origin (overridable for non-default setups).
const SERVICES: Record<string, string> = {
  "/svc/a": process.env.AGG_URL ?? "http://127.0.0.1:3001",
  "/svc/b": process.env.TRAINER_B_URL ?? "http://127.0.0.1:3002",
  "/svc/c": process.env.TRAINER_C_URL ?? "http://127.0.0.1:3003",
};

// hop-by-hop / length headers we must not blindly forward (fetch decodes the body for us)
const SKIP_HEADERS = new Set(["host", "connection", "content-length", "content-encoding", "transfer-encoding"]);

function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const app = express();

// Transparent reverse proxy: /svc/a/api/... -> A /api/... (same for b, c). Mounted BEFORE any
// body parser so the raw request body is forwarded untouched.
for (const [prefix, target] of Object.entries(SERVICES)) {
  app.use(prefix, async (req: Request, res: Response) => {
    const upstreamUrl = target + req.url; // express strips the mount prefix; req.url keeps path + query
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!SKIP_HEADERS.has(k) && typeof v === "string") headers[k] = v;
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const init: { method: string; headers: Record<string, string>; body?: Buffer } = { method: req.method, headers };
      if (hasBody) init.body = await readBody(req);
      const upstream = await fetch(upstreamUrl, init);
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: `proxy to ${target} failed: ${(e as Error).message}` });
    }
  });
}

app.use(express.static(webDir));

app.listen(PORT, () => {
  console.log(`presentation on http://localhost:${PORT}  (serving ${webDir})`);
  console.log(`  proxying ${Object.keys(SERVICES).join(" ")} -> A B C`);
});
