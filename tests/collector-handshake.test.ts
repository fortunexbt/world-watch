import test from "node:test";
import assert from "node:assert/strict";
import { collectSources } from "../src/collector/index";
import { sourceRegistry } from "../src/collector/registry";
const base = "https://example.chatgpt.site";
const disabled = sourceRegistry.map((s) => ({
  ...s,
  status: "disabled" as const,
}));
test("durable registry hash avoids repeated registration, preserves chunks and scopes Site access", async () => {
  let hash: string | null = null;
  const batches: number[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/collector/config")) {
      if (init?.method === "POST")
        hash = JSON.parse(String(init.body)).registry_hash;
      return Response.json({ registry_hash: hash });
    }
    if (String(url).endsWith("/api/sources") && init?.method === "POST")
      batches.push(JSON.parse(String(init.body)).sources.length);
    return Response.json({ sources: [] });
  };
  const env = {
    EW_API_URL: base,
    EW_COLLECTOR_TOKEN: "scoped-fixture",
    EW_SITES_SERVICE_TOKEN: "site-fixture",
    EW_SITES_ORIGIN: base,
  };
  await collectSources(env, { sources: disabled, fetch: fake });
  assert.equal(
    batches.reduce((a, b) => a + b, 0),
    disabled.length,
  );
  assert(batches.every((n) => n <= 40));
  assert.match(hash!, /^[a-f0-9]{64}$/);
  const initial = batches.length;
  await collectSources(env, { sources: [...disabled].reverse(), fetch: fake });
  assert.equal(batches.length, initial);
  for (const call of calls) {
    const h = new Headers(call.init?.headers);
    assert.equal(h.get("OAI-Sites-Authorization"), "Bearer site-fixture");
    assert.equal(h.get("Authorization"), "Bearer scoped-fixture");
    assert.equal(call.init?.redirect, "manual");
  }
  calls.length = 0;
  await collectSources(
    { ...env, EW_API_URL: "https://api.example.org" },
    { sources: disabled, fetch: fake },
  );
  assert(
    calls.every(
      (c) => !new Headers(c.init?.headers).has("OAI-Sites-Authorization"),
    ),
  );
});
test("failed registration never publishes registry marker and failed checkpoint prevents upstream work", async () => {
  let writes = 0,
    marker = false;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/api/collector/config")) {
      if (init?.method === "POST") marker = true;
      return Response.json({ registry_hash: null });
    }
    if (init?.method === "POST") {
      writes++;
      return Response.json({}, { status: writes === 2 ? 503 : 200 });
    }
    throw Error("unexpected_upstream");
  };
  await assert.rejects(
    () =>
      collectSources(
        { EW_API_URL: base, EW_COLLECTOR_TOKEN: "fixture" },
        { sources: disabled, fetch: fake },
      ),
    /collector_api_503/,
  );
  assert.equal(marker, false);
  let upstream = 0;
  await assert.rejects(
    () =>
      collectSources(
        { EW_API_URL: base, EW_COLLECTOR_TOKEN: "fixture" },
        {
          sources: disabled,
          register: async () => {},
          fetch: async (url) => {
            if (String(url).endsWith("/api/sources"))
              return new Response("", { status: 503 });
            upstream++;
            throw Error("unexpected_upstream");
          },
        },
      ),
    /collector_checkpoint_unavailable/,
  );
  assert.equal(upstream, 0);
});
test("Site service credentials never reach public upstream publisher", async () => {
  const source = {
    ...sourceRegistry.find((s) => s.id === "it-dpc-notizia")!,
    id: "fixture-feed",
    status: "enabled" as const,
  };
  let publisher = false;
  await collectSources(
    {
      EW_API_URL: base,
      EW_COLLECTOR_TOKEN: "fixture",
      EW_SITES_SERVICE_TOKEN: "site-fixture",
      EW_SITES_ORIGIN: base,
    },
    {
      sources: [source],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      fetch: async (url, init) => {
        publisher = true;
        assert(!new Headers(init?.headers).has("OAI-Sites-Authorization"));
        assert(!new Headers(init?.headers).has("Authorization"));
        return new Response("<rss><channel/></rss>", {
          headers: { "content-type": "application/rss+xml" },
        });
      },
    },
  );
  assert.equal(publisher, true);
});
