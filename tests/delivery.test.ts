import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import server, { type Env } from "../src/server/index";
import { parseUsgs } from "../src/collector/adapters/usgs";
import { sourceRegistry } from "../src/collector/registry";
import {
  atomFeed,
  entryId,
  geojsonFeed,
  incidentCorrection,
  noticeCorrection,
} from "../src/server/feeds";
import {
  base64url,
  encryptPush,
  fromBase64url,
  p256Jwk,
  pushKeys,
  pushMessage,
  vapidAuthorization,
} from "../src/server/push";
import type { IncidentView } from "../src/shared/contracts";

const usgsSource = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
const usgsFeed = JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8"));
/** A recent PAGER-orange quake; `title` and `lon` vary one cosmetic and one material field. */
function quake(origin: number, { lon = 93.73, title = "M 7.0 - 191 km ENE of Nagqu, China" } = {}) {
  const feature = structuredClone(usgsFeed.features[0]);
  Object.assign(feature, { id: "us7000r1qz" });
  Object.assign(feature.properties, {
    mag: 7,
    alert: "orange",
    time: origin,
    updated: origin + 60000,
    place: "191 km ENE of Nagqu, China",
    title,
    ids: ",us7000r1qz,",
  });
  feature.geometry.coordinates = [lon, 32.18, 10];
  return parseUsgs(usgsSource, {
    ...usgsFeed,
    metadata: { ...usgsFeed.metadata, count: 1 },
    features: [feature],
  })[0];
}

function store(vars: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...next: SQLInputValue[]) {
        values = next;
        return this;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async first() {
        return db.prepare(sql).get(...values) ?? null;
      },
      async run() {
        return db.prepare(sql).run(...values);
      },
    };
  };
  const env = {
    DB: {
      prepare,
      async batch(statements: { run(): Promise<unknown> }[]) {
        db.exec("BEGIN");
        try {
          const out = [];
          for (const statement of statements) out.push(await statement.run());
          db.exec("COMMIT");
          return out;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ASSETS: { fetch: async () => new Response("fixture") },
    EUROPE_WATCH_OWNER_TOKEN: "fixture-owner",
    EUROPE_WATCH_COLLECTOR_TOKEN: "fixture-collector",
    EUROPE_WATCH_WORKER_TOKEN: "fixture-worker",
    ...vars,
  } as unknown as Env;
  const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    server.fetch(
      new Request("https://fixture.invalid" + path, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          ...(init.token === "" ? {} : { authorization: "Bearer " + (init.token ?? "fixture-owner") }),
          "content-type": "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      env,
    );
  const api = async (path: string, body?: unknown, token?: string) => {
    const r = await call(path, { body, token });
    return { status: r.status, body: (await r.json()) as any };
  };
  const ingest = async (row: ReturnType<typeof quake>) =>
    assert.equal((await api("/api/ingest", { observations: [row] }, "fixture-collector")).status, 200);
  const incident = () =>
    JSON.parse((db.prepare("SELECT view FROM incidents").get() as { view: string }).view) as IncidentView;
  return { db, env, call, api, ingest, incident };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => ["entry", "category", "link"].includes(name) });

test("a rule's Atom and GeoJSON feeds keep one entry per incident that moves only on material change and marks corrections", async () => {
  const s = store();
  try {
    await s.api("/api/sources", { sources: [usgsSource] }, "fixture-collector");
    await s.api("/api/alert-rules", { id: "severe", rule: { name: "Severe quakes", impacts: ["severe"], cooldown_minutes: 0 } });
    const origin = Date.now() - 600000;
    await s.ingest(quake(origin));
    const { feeds } = (await s.api("/api/alert-rules")).body.rules[0];
    const path = (url: string) => new URL(url).pathname + new URL(url).search;
    // The key in the URL stands in for a sign-in; without it, or with another rule's, the feed is closed.
    const read = async () => {
      const r = await s.call(path(feeds.atom), { token: "" });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type")!, /^application\/atom\+xml/);
      const text = await r.text();
      assert.equal(XMLValidator.validate(text), true);
      return parser.parse(text).feed;
    };
    assert.equal((await s.call(path(feeds.atom).replace(/key=.*/, "key=wrong"), { token: "" })).status, 401);
    assert.equal((await s.call(new URL(feeds.atom).pathname, { token: "" })).status, 401);
    assert.equal((await s.call(path(feeds.atom).replace("/severe/", "/other/"), { token: "" })).status, 401);
    const first = await read();
    const id = s.incident().id;
    assert.equal(first.title["#text"], "World Watch: Severe quakes");
    assert.equal(first.entry.length, 1);
    assert.equal(first.entry[0].id, entryId(id));
    assert.match(first.rights["#text"], /U\.S\. Geological Survey|USGS/);
    assert.equal(first.entry[0]["georss:point"], "32.18 93.73");
    assert(!first.entry[0].category.some((c: any) => c["@_term"] === "correction"));

    // A reworded title is not material, so no notice and no feed update.
    await sleep(5);
    await s.ingest(quake(origin, { title: "M 7.0 - Eastern Xizang" }));
    assert.equal((await read()).entry[0].updated, first.entry[0].updated);
    // A moved epicentre is, so the same entry updates.
    await s.ingest(quake(origin, { lon: 93.9 }));
    const moved = await read();
    assert.equal(moved.entry.length, 1);
    assert.equal(moved.entry[0].id, entryId(id));
    assert(moved.entry[0].updated > first.entry[0].updated);

    // A withdrawal updates the entry again, marked as a correction.
    await sleep(5);
    assert.equal(
      (await s.api("/api/corrections", { incident_id: id, patch: { cancelled: true }, reason: "Issuer deleted the event" })).status,
      200,
    );
    const corrected = await read();
    assert.equal(corrected.entry.length, 1);
    assert.match(corrected.entry[0].title["#text"], /^Correction: /);
    assert(corrected.entry[0].category.some((c: any) => c["@_term"] === "correction"));
    assert.match(corrected.entry[0].summary["#text"], /Correction to an earlier notice: withdrawn or retracted\./);
    assert(corrected.entry[0].updated > moved.entry[0].updated);

    const geo = await s.call(path(feeds.geojson), { token: "" });
    assert.equal(geo.headers.get("content-type"), "application/geo+json");
    const collection = (await geo.json()) as any;
    assert.equal(collection.type, "FeatureCollection");
    assert.equal(collection.features.length, 1);
    assert.equal(collection.features[0].id, id);
    assert.deepEqual(collection.features[0].geometry, { type: "Point", coordinates: [93.9, 32.18] });
    assert.equal(collection.features[0].properties.correction, "withdrawn or retracted");
    assert(collection.features[0].properties.attribution[0].attribution.length > 0);

    // Feeds follow the source's current redistribution right, as exports do.
    await s.api("/api/sources", { sources: [{ ...usgsSource, rights: { ...usgsSource.rights, redistribute: false } }] }, "fixture-collector");
    const withheld = await read();
    assert.equal(withheld.entry, undefined);
    assert.match(withheld.subtitle["#text"], /1 left out because a source doesn't permit redistribution/);
  } finally {
    s.db.close();
  }
});

test("feed text is escaped, unsafe characters dropped and correction states named", () => {
  const view = {
    id: "x1",
    headline: "Flood <warning> & \u0007alert \"now\"",
    summary_en: "",
    impact: "severe",
    activity: "flood",
    evidence_status: "retracted",
    location: { name: "Town", country: null, lon: 1, lat: 2, accuracy: "area", radius_km: 12 },
    event_start: null,
    event_end: null,
    expires_at: null,
    cancelled: false,
    reports: [{ source_id: "s", canonical_url: "https://example.org/a?b=1&c=2", rights: { attribution: "Issuer & co" } }],
  } as unknown as IncidentView;
  const meta = { id: "urn:world-watch:feed:test", title: "T", subtitle: "S", self: "t.atom", alternate: "t.geojson", attribution: ["Issuer & co"], updated: "2026-10-23T00:00:00.000Z" };
  const entry = { id: view.id, incident: view, updated: "2026-10-23T01:00:00.000Z", correction: incidentCorrection(view) };
  const text = atomFeed(meta, [entry]);
  assert.equal(XMLValidator.validate(text), true);
  assert(!text.includes("\u0007"));
  const feed = parser.parse(text).feed;
  assert.equal(feed.updated, entry.updated);
  assert.equal(feed.entry[0].title["#text"], 'Correction: Flood <warning> & alert "now"');
  assert.equal(feed.entry[0].link[0]["@_href"], "https://example.org/a?b=1&c=2");
  assert(text.includes('href="https://example.org/a?b=1&amp;c=2"'));
  assert.equal(geojsonFeed(meta, [entry]).features[0].properties.correction, "retracted by its source");
  assert.equal(atomFeed(meta, []).includes("<updated>2026-10-23T00:00:00.000Z</updated>"), true);
  assert.equal(incidentCorrection({ ...view, evidence_status: "official_advisory" }), null);
  assert.equal(
    noticeCorrection("correction_or_retraction; notify prior eligible recipient (current eligibility changed: event_ended)", view),
    "no longer meets this rule, event ended",
  );
});

// RFC 8291 section 5, the specification's own worked example.
test("message encryption reproduces the RFC 8291 example byte for byte", async () => {
  const asPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const sender = {
    publicKey: await crypto.subtle.importKey("jwk", p256Jwk(asPublic), { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      p256Jwk(asPublic, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
  } as CryptoKeyPair;
  const body = await encryptPush(
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    fromBase64url("DGv6ra1nlYgDCS1FRnbzlw"),
    sender,
  );
  assert.equal(
    base64url(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

/** A fresh P-256 pair as the base64url point and scalar that VAPID keys and subscriptions use. */
async function p256(usage: "ECDSA" | "ECDH") {
  const pair = (await crypto.subtle.generateKey(
    { name: usage, namedCurve: "P-256" },
    true,
    usage === "ECDSA" ? ["sign", "verify"] : ["deriveBits"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    pair,
    point: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    scalar: jwk.d!,
  };
}
async function testKeys() {
  const key = await p256("ECDSA");
  return { VAPID_PUBLIC_KEY: key.point, VAPID_PRIVATE_KEY: key.scalar, VAPID_SUBJECT: "https://operator.example/contact" };
}

test("the VAPID header is an ES256 JWT for the push service's origin, verifiable with the public key", async () => {
  const vars = await testKeys();
  const keys = pushKeys(vars)!;
  const now = Date.UTC(2026, 9, 23, 12);
  const value = await vapidAuthorization("https://push.example:8443/send/abc?x=1", keys, now);
  const [, token, k] = value.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, vars.VAPID_PUBLIC_KEY);
  const [header, claims, signature] = token.split(".");
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  assert.deepEqual(decode(header), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(decode(claims), { aud: "https://push.example:8443", exp: now / 1000 + 12 * 3600, sub: vars.VAPID_SUBJECT });
  const verifier = await crypto.subtle.importKey("jwk", p256Jwk(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${header}.${claims}`);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromBase64url(signature), signed), true);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromBase64url(signature), signed.slice(1)), false);
  assert.equal(pushKeys({ ...vars, VAPID_SUBJECT: undefined }), null);
  assert.equal(pushKeys({}), null);
});

/** A browser's side of a subscription, able to open what the server encrypts for it. */
async function device(name: string) {
  const key = await p256("ECDH");
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint: `https://push.example/${name}`, keys: { p256dh: key.point, auth: base64url(auth) } },
    async open(body: Uint8Array<ArrayBuffer>) {
      const salt = body.slice(0, 16), sender = body.slice(21, 86);
      const hkdf = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
        new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
      const text = new TextEncoder();
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "ECDH", public: await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, []) },
          key.pair.privateKey,
          256,
        ),
      );
      const ikm = await hkdf(auth, shared, new Uint8Array([...text.encode("WebPush: info\0"), ...fromBase64url(key.point), ...sender]), 32);
      const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), body.slice(86)),
      );
      assert.equal(plain.at(-1), 2);
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

test("without VAPID keys Web Push is off: nothing is queued, nothing is sent and subscribing is refused", async () => {
  const s = store();
  const sent = mock.method(globalThis, "fetch", async () => {
    throw Error("no request expected");
  });
  try {
    assert.deepEqual((await s.api("/api/push")).body, { configured: false, public_key: null, subscriptions: 0 });
    const phone = await device("phone");
    assert.equal((await s.api("/api/push", phone.subscription)).status, 409);
    await s.api("/api/sources", { sources: [usgsSource] }, "fixture-collector");
    await s.api("/api/alert-rules", { id: "severe", rule: { impacts: ["severe"] } });
    await s.ingest(quake(Date.now() - 600000));
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM alert_deliveries WHERE state='eligible_ui'").get()!.n, 1);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM push_outbox").get()!.n, 0);
    assert.equal((await s.api("/api/alert-rules")).body.channels.web_push, "not configured");
    assert.equal(sent.mock.callCount(), 0);
  } finally {
    sent.mock.restore();
    s.db.close();
  }
});

test("one push per notice reaches subscribed devices, carries no notes, and a correction goes only to prior recipients", async () => {
  const vars = await testKeys();
  const s = store(vars);
  const requests: { url: string; headers: Headers; body: Uint8Array<ArrayBuffer> }[] = [];
  let status = 201;
  const sent = mock.method(globalThis, "fetch", async (input: any, init: any) => {
    requests.push({ url: String(input), headers: new Headers(init.headers), body: new Uint8Array(init.body) });
    return new Response(null, { status });
  });
  try {
    const phone = await device("phone"), laptop = await device("laptop");
    assert.equal((await s.api("/api/push", { ...phone.subscription, endpoint: "http://push.example/plain" })).status, 400);
    assert.equal((await s.api("/api/push", phone.subscription)).status, 200);
    assert.deepEqual((await s.api("/api/push")).body, { configured: true, public_key: vars.VAPID_PUBLIC_KEY, subscriptions: 1 });
    await s.api("/api/sources", { sources: [usgsSource] }, "fixture-collector");
    await s.api("/api/alert-rules", { id: "severe", rule: { name: "Private rule name", impacts: ["severe"], cooldown_minutes: 0 } });
    const origin = Date.now() - 600000;
    await s.ingest(quake(origin));
    const id = s.incident().id;
    await s.api("/api/notes", { incident_id: id, body: "Private note: call the desk" });
    assert.equal(requests.length, 1);
    const [first] = requests;
    assert.equal(first.url, phone.subscription.endpoint);
    assert.equal(first.headers.get("content-encoding"), "aes128gcm");
    assert.equal(first.headers.get("urgency"), "high");
    assert.equal(first.headers.get("ttl"), "21600");
    assert.match(first.headers.get("authorization")!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert(first.body.length < 1024);
    const message = await phone.open(first.body);
    assert.deepEqual(message, pushMessage(s.incident(), null));
    assert.equal(message.url, "/?incident=" + id);
    assert.match(message.body, /^Impact severe · /);
    assert(!JSON.stringify(message).includes("Private"));
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM push_outbox").get()!.n, 0);

    // A reworded title notifies nobody.
    await s.ingest(quake(origin, { title: "M 7.0 - Eastern Xizang" }));
    assert.equal(requests.length, 1);

    // The laptop subscribes after the notice, so it never saw it and gets no correction of it.
    await sleep(5);
    assert.equal((await s.api("/api/push", laptop.subscription)).status, 200);
    await s.api("/api/corrections", { incident_id: id, patch: { cancelled: true }, reason: "Issuer deleted the event" });
    assert.deepEqual(requests.slice(1).map((r) => r.url), [phone.subscription.endpoint]);
    const correction = await phone.open(requests[1].body);
    assert.equal(correction.correction, true);
    assert.match(correction.title, /^Correction: /);
    assert.match(correction.body, /^withdrawn or retracted · Impact severe/);
    // Both notices of one incident share a topic, so the push service replaces one still waiting.
    assert.equal(requests[1].headers.get("topic"), first.headers.get("topic"));
    assert.equal(first.headers.get("topic")!.length, 32);

    // A rejected send stays queued for a retry; a push service that says the subscription is gone removes it.
    status = 500;
    await s.api("/api/alert-rules", { id: "any", rule: { allow_unverified: true, impacts: ["severe"], cooldown_minutes: 0 } });
    await s.ingest(quake(origin, { lon: 94.2 }));
    assert(requests.length > 2);
    assert(Number(s.db.prepare("SELECT count(*) AS n FROM push_outbox").get()!.n) > 0);
    status = 410;
    await s.ingest(quake(origin, { lon: 94.4 }));
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM push_subscriptions").get()!.n, 0);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM push_outbox").get()!.n, 0);

    // Unsubscribing removes the device and anything queued for it.
    assert.equal((await s.api("/api/push", phone.subscription)).status, 200);
    const r = await s.call("/api/push", { method: "DELETE", body: { endpoint: phone.subscription.endpoint } });
    assert.equal(r.status, 200);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM push_subscriptions").get()!.n, 0);
  } finally {
    sent.mock.restore();
    s.db.close();
  }
});

test("push routes and rule feeds belong to the owner", async () => {
  const s = store(await testKeys());
  try {
    await s.api("/api/alert-rules", { id: "r", rule: {} });
    for (const token of ["", "fixture-worker", "fixture-collector"]) {
      assert.notEqual((await s.api("/api/push", undefined, token)).status, 200);
      assert.notEqual((await s.call("/api/alert-rules/r/feed.atom", { token })).status, 200);
    }
    assert.equal((await s.call("/api/alert-rules/r/feed.atom")).status, 200);
    assert.equal((await s.call("/api/alert-rules/missing/feed.geojson")).status, 404);
  } finally {
    s.db.close();
  }
});
