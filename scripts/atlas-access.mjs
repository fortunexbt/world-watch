/** Bounded, credential-free HEAD checks for explicitly curated research candidates.
 * This does not read articles, inspect model results, or enable collection.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import assert from "node:assert/strict";

const deny = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  deny.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 23],
  ["2002::", 16],
])
  deny.addSubnet(network, prefix, "ipv6");
const publicAddress = (address) => {
  const family = isIP(address);
  if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  if (address.toLowerCase().includes("::ffff:")) return false;
  return (
    Boolean(family) && !deny.check(address, family === 4 ? "ipv4" : "ipv6")
  );
};
function targetUrl(raw) {
  const u = new URL(raw);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.includes(".") ||
    /[\\\u0000-\u0020\u007f]/u.test(raw)
  )
    throw Error("invalid_public_url");
  return u;
}
async function head(
  raw,
  resolveAddresses = (host) => lookup(host, { all: true }),
) {
  const url = targetUrl(raw);
  const addresses = await resolveAddresses(url.hostname);
  if (!addresses.length || addresses.some((r) => !publicAddress(r.address)))
    throw Error("private_or_reserved_dns");
  const address = addresses.find((a) => a.family === 4) || addresses[0];
  return new Promise((done, fail) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "HEAD",
        agent: false,
        timeout: 6500,
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          "user-agent":
            "WorldWatchSourceResearch/1.0 (+https://github.com/fortunexbt/world-watch)",
          accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.1",
        },
      },
      (response) => {
        const result = {
          status: response.statusCode,
          content_type: response.headers["content-type"] || null,
          location: response.headers.location || null,
        };
        response.destroy();
        done(result);
      },
    );
    request.on("timeout", () => request.destroy(Error("timeout")));
    request.on("error", fail);
    request.end();
  });
}
async function check(raw) {
  const checked_at = new Date().toISOString();
  let url = raw;
  const chain = [];
  try {
    for (let n = 0; n < 4; n++) {
      const result = await head(url);
      chain.push({ url, status: result.status });
      if (result.status >= 300 && result.status < 400 && result.location) {
        url = new URL(result.location, url).href;
        targetUrl(url);
        continue;
      }
      return {
        url: raw,
        checked_at,
        method: "HEAD",
        final_url: url,
        http_status: result.status,
        content_type: result.content_type,
        redirect_chain: chain,
        access_scope: "homepage_or_declared_link_only",
        content_rights: "unreviewed",
        integration: "none",
      };
    }
    throw Error("redirect_limit");
  } catch (error) {
    return {
      url: raw,
      checked_at,
      method: "HEAD",
      final_url: url,
      http_status: null,
      error: error.code || error.message,
      redirect_chain: chain,
      access_scope: "homepage_or_declared_link_only",
      content_rights: "unreviewed",
      integration: "none",
    };
  }
}
if (process.argv.includes("--self-test")) {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "100.64.0.1",
    "::127.0.0.1",
    "fec0::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001::1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress("1.1.1.1"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  for (const u of [
    "file:///tmp/test",
    "https://user:secret@example.org/",
    "http://127.0.0.1:8787/",
    "https://example.org/\\escape",
  ])
    assert.throws(() => targetUrl(u));
  await assert.rejects(
    () =>
      head("https://publisher.test", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    /private_or_reserved_dns/,
  );
  await assert.rejects(
    () =>
      head("https://publisher.test", async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    /private_or_reserved_dns/,
  );
  console.log(
    "Access-check guard passed (no network): URL, private/reserved ranges, DNS rejection and pinned lookup.",
  );
} else if (process.argv.includes("--run")) {
  const folder = fileURLToPath(
    new URL("../research/world-atlas/", import.meta.url),
  );
  const candidates = ["asia-oceania.jsonl", "americas-africa.jsonl"].flatMap(
    (name) =>
      readFileSync(resolve(folder, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
  );
  const unique = [...new Set(candidates.map((r) => r.url))].sort();
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < unique.length) {
        const url = unique[next++];
        results.push(await check(url));
        if (results.length % 50 === 0)
          console.log(
            `${results.length}/${unique.length} credential-free HEAD checks`,
          );
      }
    }),
  );
  results.sort((a, b) => a.url.localeCompare(b.url));
  writeFileSync(
    resolve(folder, "access-checks.jsonl"),
    results.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const summary = {
    checked: results.length,
    method: "HEAD",
    http_2xx: results.filter((r) => r.http_status >= 200 && r.http_status < 300)
      .length,
    blocked_or_limited: results.filter((r) =>
      [401, 403, 429].includes(r.http_status),
    ).length,
    other_http: results.filter(
      (r) =>
        r.http_status !== null &&
        !(r.http_status >= 200 && r.http_status < 300) &&
        ![401, 403, 429].includes(r.http_status),
    ).length,
    transport_or_guard_errors: results.filter((r) => r.http_status === null)
      .length,
    working_feed_integrations: 0,
  };
  writeFileSync(
    resolve(folder, "access-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} else
  console.log(
    "node scripts/atlas-access.mjs --self-test | --run (bounded HEAD checks of curated public research URLs, no credentials or application jobs)",
  );
