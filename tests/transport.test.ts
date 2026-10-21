import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredSiteOrigin,
  siteServiceHeaders,
} from "../src/shared/transport.js";
const origin = "https://example.chatgpt.site";
test("Site service credentials need an explicit independent exact HTTPS origin pin", () => {
  assert.equal(configuredSiteOrigin(), null);
  assert.throws(() => siteServiceHeaders(origin, "fixture"), /ORIGIN_required/);
  assert.deepEqual(siteServiceHeaders(origin, "fixture", origin), {
    "OAI-Sites-Authorization": "Bearer fixture",
  });
  for (const destination of [
    origin + ".evil.invalid",
    origin + "/path",
    "http://example.chatgpt.site",
    "https://elsewhere.invalid",
  ])
    assert.deepEqual(siteServiceHeaders(destination, "fixture", origin), {});
  for (const pin of [
    origin + "/",
    origin + "/path",
    origin + "?x=1",
    origin + "#fragment",
    "http://example.chatgpt.site",
    "https://user:pass@example.chatgpt.site",
    "https://example.chatgpt.site:444",
  ])
    assert.throws(() => configuredSiteOrigin(pin), /exact_https_origin/);
});
