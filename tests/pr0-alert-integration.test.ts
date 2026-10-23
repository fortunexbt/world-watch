import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server, { type Env } from "../src/server/index";
import { parseUsgs } from "../src/collector/adapters/usgs";
import { parseGdacs } from "../src/collector/adapters/gdacs";
import { sourceRegistry } from "../src/collector/registry";
import type {
  IncidentView,
  SourceRecord,
  JobInput,
  Lease,
} from "../src/shared/contracts";

function fixtureStore() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  let beforeBatch: (() => void) | null = null;
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
        if (beforeBatch) {
          const action = beforeBatch;
          beforeBatch = null;
          action();
        }
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
    ASSETS: {
      async fetch() {
        return new Response("fixture");
      },
    },
    EUROPE_WATCH_OWNER_TOKEN: "fixture-owner",
    EUROPE_WATCH_COLLECTOR_TOKEN: "fixture-collector",
    EUROPE_WATCH_WORKER_TOKEN: "fixture-worker",
  } as unknown as Env;
  return {
    db,
    env,
    beforeNextBatch(action: () => void) {
      beforeBatch = action;
    },
    async api(path: string, body?: unknown, token = "fixture-owner") {
      const response = await server.fetch(
        new Request("https://fixture.invalid" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
  };
}

function seedNotice(s: ReturnType<typeof fixtureStore>, priorEligible = true) {
  const at = Date.now();
  const view: IncidentView = {
    id: "a".repeat(64),
    version: 1,
    headline: "Synthetic authority restriction",
    summary_en: "Synthetic test notice.",
    summary_it: null,
    activity: "official_advisory",
    impact: "severe",
    evidence_status: "official_advisory",
    location: {
      name: "Paris",
      country: "FR",
      lon: 2.35,
      lat: 48.85,
      accuracy: "point",
      radius_km: 0,
    },
    event_start: new Date(at - 60000).toISOString(),
    event_end: null,
    expires_at: new Date(at + 7200000).toISOString(),
    published_at: null,
    ingested_at: new Date(at - 60000).toISOString(),
    analyzed_at: null,
    updated_at: new Date(at - 60000).toISOString(),
    claims: [],
    reports: [],
    history: [],
    review_needed: false,
    cancelled: false,
  };
  s.db
    .prepare(
      "INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?)",
    )
    .run(view.id, 1, JSON.stringify(view), view.updated_at);
  s.db
    .prepare("INSERT INTO incident_revisions VALUES(?,?,?,?,?)")
    .run(
      view.id,
      1,
      JSON.stringify(view),
      view.updated_at,
      "synthetic initial",
    );
  s.db
    .prepare(
      "INSERT INTO watch_areas VALUES('area','owner',?,'Synthetic area',?)",
    )
    .run(JSON.stringify({ bbox: [2.3, 48.8, 2.4, 48.9] }), view.updated_at);
  s.db
    .prepare("INSERT INTO alert_rules VALUES('rule','owner',1,?)")
    .run(
      JSON.stringify({
        watch_area_id: "area",
        enabled: true,
        cooldown_minutes: 60,
      }),
    );
  if (priorEligible)
    s.db
      .prepare(
        "INSERT INTO alert_deliveries VALUES('first',?,1,'rule',1,'eligible_ui','synthetic eligible notice',?)",
      )
      .run(view.id, new Date(at - 7200000).toISOString());
  return view;
}

async function correct(
  s: ReturnType<typeof fixtureStore>,
  view: IncidentView,
  patch: Record<string, unknown>,
) {
  return s.api("/api/corrections", {
    incident_id: view.id,
    expected_version: view.version,
    patch,
    reason: "Isolated PR0 regression",
  });
}

function receipt(s: ReturnType<typeof fixtureStore>, version: number) {
  return s.db
    .prepare(
      "SELECT state,reason FROM alert_deliveries WHERE incident_version=?",
    )
    .get(version);
}

test("a prior UI recipient receives removed-geography correction even after its rule is disabled", async () => {
  const s = fixtureStore();
  try {
    const view = seedNotice(s);
    s.db
      .prepare("UPDATE alert_rules SET version=2,rule=? WHERE id='rule'")
      .run(JSON.stringify({ watch_area_id: "area", enabled: false }));
    const updated = await correct(s, view, { cancelled: true, location: null });
    assert.equal(updated.status, 200);
    assert.equal(receipt(s, 2)?.state, "eligible_ui");
    assert.match(String(receipt(s, 2)?.reason), /correction/);
  } finally {
    s.db.close();
  }
});

test("same-headline affected area and timing changes create material notices", async () => {
  for (const patch of [
    {
      location: {
        name: "Paris",
        country: "FR",
        lon: 2.35,
        lat: 48.85,
        accuracy: "area",
        radius_km: 20,
      },
    },
    { event_end: new Date(Date.now() + 3600000).toISOString() },
  ]) {
    const s = fixtureStore();
    try {
      const view = seedNotice(s);
      const updated = await correct(s, view, {
        ...patch,
        evidence_status: "official_advisory",
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.headline, view.headline);
      assert.equal(receipt(s, 2)?.state, "eligible_ui");
    } finally {
      s.db.close();
    }
  }
});

test("never-notified recipients stay silent, and repeated unchanged cancellation does not notify again", async () => {
  const never = fixtureStore();
  try {
    const view = seedNotice(never, false);
    assert.equal(
      (await correct(never, view, { cancelled: true, location: null })).status,
      200,
    );
    assert.equal(receipt(never, 2)?.state, "suppressed");
    assert.equal(receipt(never, 2)?.reason, "correction_no_prior_delivery");
  } finally {
    never.db.close();
  }
  const s = fixtureStore();
  try {
    const view = seedNotice(s);
    const first = await correct(s, view, { cancelled: true, location: null });
    assert.equal(first.status, 200);
    assert.equal(receipt(s, 2)?.state, "eligible_ui");
    const repeated = await correct(s, first.body as unknown as IncidentView, {
      summary_en: "A cosmetic follow-up.",
    });
    assert.equal(repeated.status, 200);
    assert.equal(receipt(s, 3)?.state, "suppressed");
    assert.equal(receipt(s, 3)?.reason, "no_material_change");
  } finally {
    s.db.close();
  }
});

test("material comparison uses the last eligible revision across an intervening suppressed update", async () => {
  const s = fixtureStore();
  try {
    const first = seedNotice(s);
    const second = {
      ...first,
      version: 2,
      event_end: new Date(Date.now() + 3600000).toISOString(),
    };
    s.db
      .prepare("UPDATE incidents SET version=2,view=? WHERE id=?")
      .run(JSON.stringify(second), first.id);
    s.db
      .prepare("INSERT INTO incident_revisions VALUES(?,?,?,?,?)")
      .run(
        first.id,
        2,
        JSON.stringify(second),
        second.updated_at,
        "synthetic intervening update",
      );
    s.db
      .prepare(
        "INSERT INTO alert_deliveries VALUES('suppressed',?,2,'rule',1,'suppressed','cooldown',?)",
      )
      .run(first.id, second.updated_at);
    const updated = await correct(s, second, {
      summary_en: "Clarified copy only.",
      evidence_status: "official_advisory",
    });
    assert.equal(updated.status, 200);
    assert.equal(receipt(s, 3)?.state, "eligible_ui");
  } finally {
    s.db.close();
  }
});

const source: SourceRecord = {
  id: "fixture",
  name: "Fixture source",
  owner: "Fixture",
  url: "https://source.example",
  docs: "https://source.example/terms",
  countries: ["FR"],
  languages: ["en"],
  categories: ["reported_violence"],
  family: "rss",
  status: "enabled",
  poll_seconds: 600,
  verified_at: null,
  config: {},
  rights: {
    access: true,
    storage: true,
    display: true,
    ai: true,
    redistribute: false,
    basis: "Synthetic fixture only",
    attribution: "Synthetic fixture",
    retention_days: 30,
  },
};
const run = {
  requested_model: "gpt-6-luna",
  requested_tier: "fast",
  actual_model: null,
  actual_tier: null,
  client_version: "fixture",
  prompt_version: "fixture",
  schema_version: "ew-1",
  duration_ms: 1,
  usage: null,
  tool_attempts: 0,
};
function analysis(lease: Lease, relevant = true) {
  const input = lease.input;
  return {
    report_id: input.report_id,
    content_revision: input.content_revision,
    input_coverage: input.input_coverage,
    original_language: "en",
    relevant,
    relevance_reason: "Synthetic fixture",
    summary_en: "Synthetic report only.",
    summary_it: null,
    published_at: input.published_at,
    source_updated_at: input.source_updated_at,
    claims: relevant
      ? [
          {
            id: "c1",
            activity: "reported_violence",
            summary: "Attributed serious violence in Paris.",
            evidence_ids: ["e1"],
            places: [
              {
                name: "Paris",
                country: "FR",
                admin: null,
                evidence_ids: ["e1"],
                uncertainty: null,
              },
            ],
            event_start: input.published_at,
            event_end: null,
            timezone: "UTC",
            temporal_status: "current",
            time_uncertainty: null,
            impacts: ["Clashes killed five people"],
            violence_mentioned: "yes",
            impact: "severe",
            impact_uncertainty: null,
            official_instruction: null,
            relationships: [],
          },
        ]
      : [],
    candidate_incident_ids: [],
    uncertainty_flags: [],
    targeted_review: false,
  };
}

test("revoked worker completion cannot publish a correction receipt without its accepted incident revision", async () => {
  const s = fixtureStore();
  try {
    const at = new Date(Date.now() - 60000).toISOString();
    const observation = {
      source_id: "fixture",
      native_id: "one",
      canonical_url: "https://source.example/one",
      title: "Synthetic public report",
      original_language: "en",
      published_at: at,
      source_updated_at: null,
      input_coverage: "permitted_excerpt",
      excerpts: [{ id: "e1", text: "Clashes killed five people in Paris." }],
      source_geo: {
        name: "Paris",
        lon: 2.35,
        lat: 48.85,
        accuracy: "point",
        radius_km: 0,
      },
    };
    assert.equal(
      (await s.api("/api/sources", { sources: [source] }, "fixture-collector"))
        .status,
      200,
    );
    assert.equal(
      (
        await s.api(
          "/api/ingest",
          { observations: [observation] },
          "fixture-collector",
        )
      ).status,
      200,
    );
    await s.api("/api/watch-areas", {
      id: "area",
      name: "Synthetic",
      geometry: { bbox: [2.3, 48.8, 2.4, 48.9] },
    });
    await s.api("/api/alert-rules", {
      id: "rule",
      rule: { watch_area_id: "area", enabled: true, allow_unverified: true },
    });
    const claimed = await s.api(
      "/api/worker/claim",
      { worker_id: "fixture", limit: 1 },
      "fixture-worker",
    );
    const first = (claimed.body.leases as Lease[])[0];
    const accepted = await s.api(
      "/api/worker/complete",
      { lease: first, result: analysis(first), run },
      "fixture-worker",
    );
    assert.equal(accepted.body.accepted, true);
    const before = s.db
      .prepare(
        "SELECT incident_version,state,reason FROM alert_deliveries ORDER BY incident_version",
      )
      .all();
    assert.equal(before[0]?.state, "eligible_ui");
    const correction = {
      ...observation,
      title: "Correction: report withdrawn",
      excerpts: [{ id: "e1", text: "The previous report is withdrawn." }],
    };
    await s.api(
      "/api/ingest",
      { observations: [correction] },
      "fixture-collector",
    );
    const next = await s.api(
      "/api/worker/claim",
      { worker_id: "fixture", limit: 1 },
      "fixture-worker",
    );
    const second = (next.body.leases as Lease[])[0];
    s.beforeNextBatch(() =>
      s.db
        .prepare(
          "UPDATE analysis_jobs SET state='pending',lease_until=NULL WHERE id=?",
        )
        .run(second.job_id),
    );
    const rejected = await s.api(
      "/api/worker/complete",
      { lease: second, result: analysis(second, false), run },
      "fixture-worker",
    );
    assert.equal(rejected.body.accepted, false);
    assert.deepEqual(
      s.db
        .prepare(
          "SELECT incident_version,state,reason FROM alert_deliveries ORDER BY incident_version",
        )
        .all(),
      before,
    );
    assert.equal(
      s.db.prepare("SELECT version FROM incidents").get()?.version,
      1,
    );
    assert.equal(
      s.db.prepare("SELECT count(*) AS n FROM analysis_results").get()?.n,
      1,
    );
    // An actual accepted retry must still create exactly one corrective notice.
    const retry = await s.api(
      "/api/worker/claim",
      { worker_id: "fixture", limit: 1 },
      "fixture-worker",
    );
    const final = (retry.body.leases as Lease[])[0];
    assert.equal(
      (
        await s.api(
          "/api/worker/complete",
          { lease: final, result: analysis(final, false), run },
          "fixture-worker",
        )
      ).body.accepted,
      true,
    );
    assert.equal(receipt(s, 2)?.state, "eligible_ui");
    assert.equal(
      s.db
        .prepare(
          "SELECT count(*) AS n FROM alert_deliveries WHERE incident_version=2",
        )
        .get()?.n,
      1,
    );
  } finally {
    s.db.close();
  }
});

const usgsSource = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
const gdacsSource = sourceRegistry.find((s) => s.id === "global-gdacs-alerts")!;
const usgsFeed = JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8"));
const gdacsFeed = JSON.parse(readFileSync("tests/fixtures/gdacs-events.json", "utf8"));
/** A recent PAGER-orange USGS quake and the GDACS Red alert republishing its NEIC solution. */
function nagqu(origin: number, lon = 93.73) {
  const quake = structuredClone(usgsFeed.features[0]);
  Object.assign(quake, { id: "us7000r1qz" });
  Object.assign(quake.properties, {
    mag: 7,
    alert: "orange",
    time: origin,
    updated: origin + 60000,
    place: "191 km ENE of Nagqu, China",
    title: "M 7.0 - 191 km ENE of Nagqu, China",
    ids: ",us7000r1qz,",
  });
  quake.geometry.coordinates = [lon, 32.18, 10];
  return parseUsgs(usgsSource, { ...usgsFeed, metadata: { ...usgsFeed.metadata, count: 1 }, features: [quake] })[0];
}
function china(origin: number, { lon = 93.73, modified = origin } = {}) {
  const alert = structuredClone(gdacsFeed.features.find((f: any) => f.properties.eventtype === "EQ"));
  const utc = (t: number) => new Date(t).toISOString().slice(0, 19);
  Object.assign(alert.properties, {
    eventid: 1573141,
    name: "Earthquake in China",
    alertlevel: "Red",
    fromdate: utc(origin),
    todate: utc(origin),
    datemodified: utc(modified),
    affectedcountries: [{ iso2: "CN", iso3: "CHN", countryname: "China" }],
    severitydata: { severity: 7, severitytext: "Magnitude 7M, Depth:18km", severityunit: "M" },
  });
  alert.geometry.coordinates = [lon, 32.18];
  return parseGdacs(gdacsSource, { ...gdacsFeed, features: [alert] })[0];
}

test("one occurrence notifies a rule once, while material changes and corrections still reach its recipient", async () => {
  const s = fixtureStore();
  try {
    assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
    await s.api("/api/alert-rules", { id: "severe", rule: { impacts: ["severe"], cooldown_minutes: 0 } });
    const ingest = async (row: ReturnType<typeof nagqu>) =>
      assert.equal((await s.api("/api/ingest", { observations: [row] }, "fixture-collector")).status, 200);
    const deliveries = () =>
      s.db
        .prepare(
          "SELECT i.view,d.incident_version AS version,d.state,d.reason FROM alert_deliveries d JOIN incidents i ON i.id=d.incident_id WHERE d.rule_id='severe' ORDER BY d.rowid",
        )
        .all()
        .map((d: any) => ({
          record: JSON.parse(d.view).reports[0].source_id,
          version: d.version,
          state: d.state,
          reason: d.reason,
        }));
    const origin = Date.now() - 600000;
    await ingest(nagqu(origin));
    await ingest(china(origin));
    const quake = (s.db.prepare("SELECT id FROM incidents WHERE json_extract(view,'$.reports[0].source_id')=?").get(usgsSource.id) as { id: string }).id;
    assert.deepEqual(deliveries(), [
      { record: usgsSource.id, version: 1, state: "eligible_ui", reason: "currently_actionable_supported_claim" },
      {
        record: gdacsSource.id,
        version: 1,
        state: "suppressed",
        reason: `same_situation_notified: linked incident ${quake} already notified this rule`,
      },
    ]);
    // A new GDACS revision with nothing material changed stays covered.
    await ingest(china(origin, { modified: origin + 300000 }));
    assert.equal(deliveries().at(-1)?.reason.startsWith("same_situation_notified"), true);
    assert.equal(deliveries().at(-1)?.version, 2);
    // A material change in the covered record notifies, and from then on it has its own notices.
    await ingest(china(origin, { lon: 93.8, modified: origin + 400000 }));
    assert.deepEqual(deliveries().at(-1), {
      record: gdacsSource.id,
      version: 3,
      state: "eligible_ui",
      reason: `material change since covered by linked incident ${quake}; broad_area_notice; location uncertainty overlaps watch area`,
    });
    // A material change in the record that notified first still notifies. Its version also
    // counts the link revisions the GDACS updates wrote.
    await ingest(nagqu(origin, 93.75));
    const version = () =>
      (s.db.prepare("SELECT version FROM incidents WHERE id=?").get(quake) as { version: number }).version;
    assert.deepEqual(deliveries().at(-1), {
      record: usgsSource.id,
      version: version(),
      state: "eligible_ui",
      reason: "currently_actionable_supported_claim",
    });
    // Its retraction reaches the prior recipient through PR 0's correction routing.
    const view = JSON.parse((s.db.prepare("SELECT view FROM incidents WHERE id=?").get(quake) as { view: string }).view) as IncidentView;
    assert.equal(
      (await s.api("/api/corrections", { incident_id: quake, expected_version: view.version, patch: { cancelled: true }, reason: "Issuer deleted the event" })).status,
      200,
    );
    assert.deepEqual(deliveries().at(-1), {
      record: usgsSource.id,
      version: view.version + 1,
      state: "eligible_ui",
      reason: "correction_or_retraction; notify prior eligible recipient (withdrawn or retracted)",
    });
    assert.equal(deliveries().filter((d) => d.state === "eligible_ui").length, 4);
  } finally {
    s.db.close();
  }
});
