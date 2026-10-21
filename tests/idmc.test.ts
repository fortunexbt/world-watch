import test from "node:test";
import assert from "node:assert/strict";
import {
  parseIdmcUkraine,
  IDMC_UKRAINE_URL,
} from "../src/collector/adapters/idmc.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { collectSources } from "../src/collector/index.js";
import { fetchSource } from "../src/collector/fetch.js";
const source = sourceRegistry.find(
  (s) => s.id === "ua-idmc-displacement-flows",
)!;
const header = [
  "id",
  "iso3",
  "figure",
  "qualifier",
  "displacement_type",
  "displacement_date",
  "displacement_start_date",
  "displacement_end_date",
  "locations_name",
  "locations_accuracy",
  "locations_type",
  "created_at",
  "event_id",
  "event_name",
  "type",
  "subtype",
  "sources",
  "source_url",
  "latitude",
  "longitude",
  "description",
];
// Fully synthetic displacement records; city names only exercise multi-location semantics.
const row = {
  id: "900001",
  iso3: "UKR",
  figure: "12",
  qualifier: "total",
  displacement_type: "Conflict",
  displacement_date: "2026-10-18",
  displacement_start_date: "2026-10-18",
  displacement_end_date: "2026-10-18",
  locations_name: "Kyiv; Lviv; Odesa",
  locations_accuracy: "County/City/town/Village/Woreda (ADM3)",
  locations_type: "Origin",
  created_at: "2026-10-19T12:00:00Z",
  event_id: "900003",
  event_name: "Ukraine: synthetic displacement scenario for parser fixture",
  type: "International armed conflict (IAC)",
  subtype: "International armed conflict (IAC)",
  sources: "Fixture public bulletin",
  source_url: "",
  latitude: "48.22222222",
  longitude: "30.11111111",
  description: "Unneeded long source description must not be copied",
};
function csv(rows: Partial<typeof row>[]) {
  return (
    header.join(",") +
    "\r\n" +
    rows
      .map((r) =>
        header
          .map(
            (k) =>
              '"' + String((r as any)[k] ?? "").replaceAll('"', '""') + '"',
          )
          .join(","),
      )
      .join("\r\n")
  );
}
const now = Date.parse("2026-10-21T12:00:00Z");
test("synthetic IDMC record retains daily flow qualifiers and source provenance, no averaged point", () => {
  const [input] = parseIdmcUkraine(source, csv([row]), now),
    meta = JSON.parse(input.excerpts[0].text);
  assert.equal(input.native_id, "900001");
  assert.equal(input.source_event_id, "900001");
  assert.equal(input.published_at, null);
  assert.equal(input.source_updated_at, null);
  assert.equal(meta.figure, 12);
  assert.equal(meta.qualifier, "total");
  assert.equal(meta.displacement_started_on, "2026-10-18");
  assert.equal(meta.source_record_created_at, "2026-10-19T12:00:00.000Z");
  assert.equal(meta.upstream_event_id, "900003");
  assert.equal(input.source_geo, undefined);
  assert.equal(input.official, undefined);
  assert.match(meta.notice, /do not sum/i);
  assert.match(meta.attribution, /CC BY-IGO 3.0/);
  assert.ok(!input.excerpts[0].text.includes("48.222222"));
  assert.ok(!input.excerpts[0].text.includes("Unneeded long"));
});
test("IDMC excludes archive/future/invalid/cross-country rows before queue and limits recent unique rows30", () => {
  const rows = [
    {
      ...row,
      id: "old",
      displacement_date: "2025-01-01",
      displacement_end_date: "2025-01-01",
    },
    {
      ...row,
      id: "2",
      displacement_date: "2026-10-22",
      displacement_end_date: "2026-10-22",
    },
    { ...row, id: "3", iso3: "RUS" },
    { ...row, id: "4", figure: "-1" },
    { ...row, id: "6", figure: "" },
    {
      ...row,
      id: "5",
      displacement_date: "2026-02-30",
      displacement_end_date: "2026-02-30",
    },
    ...Array.from({ length: 35 }, (_, i) => ({ ...row, id: String(1000 + i) })),
  ];
  assert.equal(parseIdmcUkraine(source, csv(rows), now).length, 30);
});
test("IDMC exact duplicate IDs keep newest version, distinct flows in same upstream yearly event stay distinct", () => {
  const data = [
    { ...row, figure: "8", created_at: "2026-10-20T12:00:00Z" },
    row,
    { ...row, id: "900002", figure: "9" },
  ];
  const values = parseIdmcUkraine(source, csv(data), now);
  assert.equal(values.length, 2);
  assert.equal(
    JSON.parse(values.find((v) => v.native_id === row.id)!.excerpts[0].text)
      .figure,
    8,
  );
  assert.notEqual(values[0].source_event_id, values[1].source_event_id);
});
test("CSV reader preserves quoted commas, escaped quotes and newline source fields without evaluation", () => {
  const [value] = parseIdmcUkraine(
    source,
    csv([{ ...row, locations_name: 'City, district "A"\nSecond town' }]),
    now,
  );
  assert.equal(
    JSON.parse(value.excerpts[0].text).locations,
    'City, district "A"\nSecond town',
  );
  assert.throws(
    () => parseIdmcUkraine(source, "id,iso3\n1,UKR", now),
    /headers/,
  );
  assert.throws(() => parseIdmcUkraine(source, csv([row]) + '"', now), /quote/);
});
test("daily collector admits only recent compact context through exact licensed CSV MIME path", async () => {
  const accepted: any[] = [];
  let checkpoint: any;
  const result = await collectSources(
    { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "fixture" },
    {
      sources: [source],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async (_id, p) => {
        checkpoint = p;
      },
      ingest: async (r) => {
        accepted.push(...r);
      },
      fetch: async (input) => {
        assert.equal(String(input), IDMC_UKRAINE_URL);
        return new Response(csv([row]), {
          headers: { "Content-Type": "text/csv" },
        });
      },
      maxRequests: 20,
      now: () => now,
    },
  );
  assert.equal(result[0].status, "ok");
  assert.equal(accepted.length, 1);
  assert.equal(
    accepted[0].eligibility.reason,
    "daily_provisional_displacement_flow_context",
  );
  assert.equal(checkpoint.checkpoint.admission.admitted, 1);
  assert.equal(source.poll_seconds, 86400);
});
test("CSV MIME permission never broadens arbitrary approved endpoints", async () => {
  await assert.rejects(
    fetchSource(
      "https://data.humdata.org/unrelated.csv",
      {},
      {
        fetch: async () =>
          new Response("id,iso3", { headers: { "Content-Type": "text/csv" } }),
      },
    ),
    /unsupported_source_mime/,
  );
});
test("only the publisher-issued redirect to this exact HDX filestore resource is followed without credentials", async () => {
  let calls = 0;
  const target =
    "https://s3.us-east-1.amazonaws.com/hdx-production-filestore/resources/ee65f9fe-f1c7-4466-9f83-620b50eccdc6/ukr_idmc_idu_events.csv?Signature=public-fixture&Expires=1792584542";
  const result = await fetchSource(
    IDMC_UKRAINE_URL,
    {},
    {
      fetch: async (input, init) => {
        calls++;
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        if (calls === 1)
          return new Response(null, {
            status: 302,
            headers: { location: target },
          });
        assert.equal(String(input), target);
        return new Response(csv([row]), {
          headers: { "Content-Type": "text/csv" },
        });
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(parseIdmcUkraine(source, result.text, now).length, 1);
  await assert.rejects(
    fetchSource(
      IDMC_UKRAINE_URL,
      {},
      {
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: target.replace(
                "hdx-production-filestore",
                "unrelated-bucket",
              ),
            },
          }),
      },
    ),
    /unapproved_source_url/,
  );
  await assert.rejects(
    fetchSource(
      "https://warnung.bund.de/",
      {},
      {
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: target } }),
      },
    ),
    /cross_host_source_redirect/,
  );
});
