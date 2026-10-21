import test from "node:test";
import assert from "node:assert/strict";
import remote, { runCollectionCycle } from "../src/collector/remote";
const SITE_ORIGIN = "https://example.chatgpt.site";
const env = {
  EW_API_URL: SITE_ORIGIN,
  EW_SITES_ORIGIN: SITE_ORIGIN,
  EW_COLLECTOR_TOKEN: "role-fixture",
  EW_SITES_SERVICE_TOKEN: "site-fixture",
};
test("tiny cron performs one authenticated Site run request, never parses or fetches sources", async () => {
  let calls = 0;
  const result = await runCollectionCycle(env, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), SITE_ORIGIN + "/api/collector/run");
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.method, "POST");
      const h = new Headers(init?.headers);
      assert.equal(h.get("Authorization"), "Bearer role-fixture");
      assert.equal(h.get("OAI-Sites-Authorization"), "Bearer site-fixture");
      return Response.json({ ok: true, acquired: true });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
});
test("tiny cron rejects redirects without forwarding either secret and fails closed on origin/access errors", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response("", {
      status: 302,
      headers: { location: "https://untrusted.invalid/" },
    });
  };
  await assert.rejects(
    () =>
      runCollectionCycle(
        { ...env, EW_API_URL: "https://untrusted.invalid" },
        { fetch: fetcher },
      ),
    /origin_mismatch/,
  );
  await assert.rejects(
    () =>
      runCollectionCycle(
        { ...env, EW_SITES_SERVICE_TOKEN: "" },
        { fetch: fetcher },
      ),
    /access_missing/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => runCollectionCycle(env, { fetch: fetcher }),
    /redirect_rejected/,
  );
  assert.equal(calls, 1);
});
test("old host redirects pages but never proxies API credentials", async () => {
  const page = await remote.fetch(
    new Request("https://old.invalid/?incident=real-id&hours=24"),
    env,
  );
  assert.equal(
    page.headers.get("location"),
    SITE_ORIGIN + "/?incident=real-id&hours=24",
  );
  assert.equal(page.status, 302);
  const api = await remote.fetch(
    new Request("https://old.invalid/api/snapshot"),
    env,
  );
  assert.equal(api.status, 503);
  assert.match(await api.text(), /api_moved/);
});

test("paused collector skips credentials and every network call, including already-scheduled invocations", async () => {
  let calls = 0;
  const result = await runCollectionCycle(
    { EW_COLLECTION_PAUSED: "1", EW_SITES_SERVICE_TOKEN: "" },
    {
      fetch: async () => {
        calls++;
        throw Error("must not fetch");
      },
    },
  );
  assert.deepEqual(result, { skipped: "paused" });
  assert.equal(calls, 0);
});
