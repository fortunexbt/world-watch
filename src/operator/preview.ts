import { previewDestination } from "./preview-url.js";
import { siteServiceHeaders } from "../shared/transport.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Readable } from "node:stream";
const local = parse(await readFile(".dev.vars", "utf8"));
const sites = await readFile(".runtime/sites-service.env", "utf8")
  .then(parse)
  .catch(() => ({}));
const env = { ...local, ...sites, ...process.env };
const upstream = env.EW_API_URL || "http://127.0.0.1:8787";
const serviceHeaders = siteServiceHeaders(
  upstream,
  env.EW_SITES_SERVICE_TOKEN,
  env.EW_SITES_ORIGIN,
);
const port = Number(env.EW_PREVIEW_PORT || 4318);
if (!env.EUROPE_WATCH_OWNER_TOKEN) throw Error("owner_credential_missing");
const server = createServer(async (req, res) => {
  try {
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      res.writeHead(403);
      res.end("Invalid host");
      return;
    }
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin &&
        !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
          req.headers.origin,
        ))
    ) {
      res.writeHead(403);
      res.end("Cross-site preview request denied");
      return;
    }
    const path = req.url || "/";
    const destination = previewDestination(path, upstream);
    const headers = new Headers();
    headers.set("authorization", "Bearer " + env.EUROPE_WATCH_OWNER_TOKEN);
    for (const [name, value] of Object.entries(serviceHeaders))
      headers.set(name, value);
    if (req.headers["content-type"])
      headers.set("content-type", req.headers["content-type"]);
    if (req.headers["last-event-id"])
      headers.set("last-event-id", String(req.headers["last-event-id"]));
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const method = req.method || "GET";
    const response = await fetch(destination, {
      method,
      headers,
      redirect: "error",
      signal: abort.signal,
      ...(["GET", "HEAD"].includes(method)
        ? {}
        : { body: Readable.toWeb(req) as any, duplex: "half" as any }),
    });
    const h: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      if (
        ![
          "content-encoding",
          "content-length",
          "transfer-encoding",
          "set-cookie",
        ].includes(k)
      )
        h[k] = v;
    });
    h["cache-control"] = "no-store";
    res.writeHead(response.status, h);
    if (response.body) {
      const body = Readable.fromWeb(response.body as any);
      body.on("error", () => {
        if (!res.destroyed) res.end();
      });
      body.pipe(res);
    } else res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Private preview upstream unavailable");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Private owner preview: http://127.0.0.1:${port}`),
);
