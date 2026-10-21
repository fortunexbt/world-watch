import test from "node:test";
import assert from "node:assert/strict";
import server, { type Env } from "../src/server/index";

test("initial SSE bounds quota emits storage pause, ends cleanly and circuits subsequent reads", async () => {
  let calls = 0;
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            calls++;
            throw Error("D1_ERROR: daily read limit exceeded");
          },
          async all() {
            calls++;
            throw Error("D1_ERROR: daily read limit exceeded");
          },
          async run() {
            calls++;
            throw Error("D1_ERROR: daily read limit exceeded");
          },
        };
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
    EUROPE_WATCH_OWNER_TOKEN: "owner",
    EUROPE_WATCH_WORKER_TOKEN: "worker",
    EUROPE_WATCH_COLLECTOR_TOKEN: "collector",
  } as unknown as Env;
  const request = () =>
    new Request("https://isolated.invalid/api/events", {
      headers: { authorization: "Bearer owner" },
    });
  const first = await server.fetch(request(), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const stream = await first.text();
  assert.match(
    stream,
    /event: storage\.paused\ndata: \{"error":"database_quota"\}/,
  );
  assert.equal(calls, 1);
  const second = await server.fetch(request(), env);
  assert.equal(second.status, 503);
  assert.equal(((await second.json()) as any).error, "storage_quota_paused");
  assert.equal(calls, 1);
});
