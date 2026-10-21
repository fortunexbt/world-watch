import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  parseFirms,
  parseCemsDetail,
  parseWktGeometry,
  validGeometry,
  getGeospatialCatalog,
  FIRMS_URL,
  CEMS_URL,
} from "../src/server/geospatial.js";
const now = Date.parse("2026-10-21T12:00:00Z");
const header = "latitude,longitude,acq_date,acq_time,satellite,confidence";
const csv =
  header +
  "\n41.2,12.5,2026-10-21,1100,N20,nominal\n41.2,12.5,2026-10-21,1100,N20,nominal\n41.2,12.5,2026-10-20,0001,N20,high\n41.2,12.5,2026-10-21,1300,N20,high\n91,12.5,2026-10-21,1100,N20,high";
const extent = "POLYGON ((0 38,1 38,1 39,0 38))";
const detail = {
  results: [
    {
      code: "EMSR935",
      name: "Flood Spain",
      category: "Flood",
      eventTime: "2026-10-19T03:10:00",
      sensitive: false,
      aois: [
        {
          name: "Moraira",
          number: 1,
          extent,
          products: [{ imagery: "https://thirdparty.invalid/private" }],
        },
      ],
    },
  ],
};
test("RFC4180 parser supports quoted comma, newline and escaped quote; malformed records fail", () => {
  assert.deepEqual(parseCsv('a,b\r\n"one,two","a""b\nline"\r\n'), [
    ["a", "b"],
    ["one,two", 'a"b\nline'],
  ]);
  for (const bad of ['a,"unclosed', '"closed"garbage,b', 'bad"quote,b'])
    assert.throws(() => parseCsv(bad));
});
test("FIRMS uses actual UTC acquisition24h, finite Earth points and stable instrument/time identity", () => {
  const rows = parseFirms(csv, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observed_at, "2026-10-21T11:00:00Z");
  assert.equal(rows[0].properties.kind, "thermal_detection");
  assert.match(rows[0].properties.uncertainty!, /not a confirmed wildfire/);
  assert.equal(
    parseFirms(header + "\n41,12,2026-02-30,1100,N20,high", now).length,
    0,
  );
  assert.equal(
    parseFirms(header + "\n41,12,2026-10-21,2460,N20,high", now).length,
    0,
  );
  assert.throws(() => parseFirms("bad,columns\n1,2", now), /columns/);
  assert.throws(
    () => parseFirms(header + "\n41,12,2026-10-21,1100,N20,n", now),
    /values/,
  );
});
test("exact AOI polygon/multipolygon supports holes; malformed, unclosed, zero-area and oversized rings rejected", () => {
  assert(parseWktGeometry(extent));
  assert(
    parseWktGeometry("MULTIPOLYGON (((0 0,2 0,2 2,0 0)),((3 3,4 3,4 4,3 3)))"),
  );
  for (const bad of [
    "POINT (0 0)",
    "POLYGON ((0 0,2 0,2 2,0 1))",
    "POLYGON ((0 0,1 1,2 2,0 0))",
    "POLYGON ((0 91,2 0,2 2,0 91))",
    "POLYGON ((0 0,2 0,2 2,0 0)) trailing",
  ])
    assert.equal(parseWktGeometry(bad), null);
  assert.equal(
    validGeometry({
      type: "Polygon",
      coordinates: [Array.from({ length: 5001 }, () => [0, 0])],
    }),
    false,
  );
});
test("CEMS displays only public recent source AOI geometry and never thirdparty imagery or guessed hazard extent", () => {
  const rows = parseCemsDetail(detail, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].properties.kind, "mapping_aoi");
  assert.match(
    rows[0].properties.uncertainty!,
    /not the observed hazard extent/,
  );
  assert(!JSON.stringify(rows).includes("thirdparty"));
  for (const patch of [
    { sensitive: true },
    { sensitive: undefined },
    { eventTime: "2025-01-01T00:00:00" },
    { eventTime: "2027-01-01T00:00:00" },
    { eventTime: "2026-02-30T00:00:00" },
  ])
    assert.equal(
      parseCemsDetail({ results: [{ ...detail.results[0], ...patch }] }, now)
        .length,
      0,
    );
});
test("catalog coalesces cache, fetches max2 recent detail records, never auth or redirects, and reports source failure", async () => {
  const calls: string[] = [];
  const date = new Date(Date.now() - 3600000).toISOString();
  const fetcher = async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    if (String(url) === FIRMS_URL) {
      assert.equal(headers.get("Accept"), "text/csv");
      assert.equal(headers.has("User-Agent"), false);
    } else {
      assert.equal(headers.get("Accept"), "application/json");
      assert.match(headers.get("User-Agent") ?? "", /^EuropeWatch\/1\.0 \(/);
      assert.match(
        headers.get("User-Agent") ?? "",
        /public Copernicus contextual data/,
      );
    }
    assert(init.signal);
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    if (String(url) === FIRMS_URL)
      return new Response(
        header +
          `\n41,12,${date.slice(0, 10)},${date.slice(11, 13) + date.slice(14, 16)},N20,nominal`,
      );
    if (String(url) === CEMS_URL)
      return Response.json({
        results: [1, 2, 3, 4, 5].map((n) => ({
          code: "EMSR" + n,
          eventTime: date,
        })),
      });
    return Response.json({
      results: [
        {
          ...detail.results[0],
          eventTime: date,
          code: new URL(String(url)).searchParams.get("code"),
        },
      ],
    });
  };
  const [a, b] = await Promise.all([
    getGeospatialCatalog(fetcher as any),
    getGeospatialCatalog(fetcher as any),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 4);
  assert.equal(a.features.length, 3);
  assert(a.sources.every((s) => s.status === "ok"));
  const failed = await getGeospatialCatalog(
    (async () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://private.invalid/" },
      })) as any,
  );
  assert.equal(failed.features.length, 0);
  assert(
    failed.sources.every(
      (s) => s.status === "error" && s.error === "source_http_302",
    ),
  );
});
test("stream byte cap rejects oversized source before JSON/CSV parsing", async () => {
  const result = await getGeospatialCatalog(
    (async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))) as any,
  );
  assert(
    result.sources.every(
      (s) => s.status === "error" && s.error === "source_byte_limit",
    ),
  );
});
