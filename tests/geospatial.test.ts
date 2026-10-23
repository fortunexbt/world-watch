import test from "node:test";
import assert from "node:assert/strict";
import {
  csvParser,
  firmsParser,
  parseBbox,
  parseCemsDetail,
  parseWktGeometry,
  validGeometry,
  getGeospatialCatalog,
  getThermalIndex,
  getThermalTile,
  FIRMS_SENSORS,
  CEMS_URL,
} from "../src/server/geospatial.js";
import { decodeTile, tileOf } from "./vector-tiles.js";
const now = Date.parse("2026-10-21T12:00:00Z");
const [n20, n21, snpp] = FIRMS_SENSORS;
const header =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";
const row = (
  lat: number,
  lon: number,
  date: string,
  time: string,
  satellite: string,
  confidence = "nominal",
) =>
  `${lat},${lon},320.1,0.4,0.4,${date},${time},${satellite},${confidence},2.0NRT,290.2,1.5,N`;
/** A catalogue clock while all three sensors still deliver; the catalogue filters on it. */
const live = Date.parse("2026-10-30T12:00:00Z");
/** acq_date and acq_time minutesAgo before the catalogue clock. */
const ago = (minutesAgo: number) => {
  const iso = new Date(live - minutesAgo * 60000).toISOString();
  return [iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16)] as const;
};
const extent = "POLYGON ((0 38,1 38,1 39,0 38))";
const fijiExtent = "POLYGON ((179 -18,179.9 -18,179.9 -17,179 -17,179 -18))";
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
const parse = (text: string, chunk = text.length || 1) => {
  const rows: string[][] = [];
  const csv = csvParser((cells) => rows.push(cells));
  for (let i = 0; i < text.length; i += chunk)
    csv.push(text.slice(i, i + chunk));
  csv.end();
  return rows;
};
const firms = (sensor: (typeof FIRMS_SENSORS)[number], text: string) => {
  const parser = firmsParser(sensor, now);
  parser.push(text);
  return parser.end();
};
test("RFC4180 parser supports quoted comma, newline and escaped quote across any chunk split; malformed records fail", () => {
  const text = 'a,b\r\n"one,two","a""b\nline"\r\n"x"\r';
  for (const chunk of [1, 2, 3, 7, text.length])
    assert.deepEqual(parse(text, chunk), [
      ["a", "b"],
      ["one,two", 'a"b\nline'],
      ["x"],
    ]);
  for (const bad of ['a,"unclosed', '"closed"garbage,b', 'bad"quote,b'])
    assert.throws(() => parse(bad));
  assert.throws(
    () => parse("x".repeat(1024 * 1024 + 1), 4096),
    /csv_record_limit/,
  );
});
test("FIRMS keeps each sensor's own UTC acquisitions within 24h, newest first, deduplicated", () => {
  const rows = firms(
    n20,
    [
      header,
      row(41.2, 12.5, "2026-10-21", "1100", "N20"),
      row(41.2, 12.5, "2026-10-21", "1100", "N20"),
      row(-33.8, 18.5, "2026-10-21", "1130", "N20", "low"),
      row(41.2, 12.5, "2026-10-20", "0001", "N20", "high"),
      row(41.2, 12.5, "2026-10-21", "1300", "N20", "high"),
      row(91, 12.5, "2026-10-21", "1100", "N20", "high"),
      row(10, 10, "2026-10-21", "1100", "N21", "high"),
    ].join("\n"),
  );
  assert.deepEqual([...rows.lat], [-33.8, 41.2]);
  assert.deepEqual([...rows.lon], [18.5, 12.5]);
  assert.deepEqual(
    [...rows.at],
    [Date.parse("2026-10-21T11:30:00Z"), Date.parse("2026-10-21T11:00:00Z")],
  );
  assert.deepEqual([...rows.confidence], [0, 1]);
  for (const [sensor, code] of [
    [n21, "N21"],
    [snpp, "N"],
  ] as const) {
    assert.equal(
      firms(
        sensor,
        `${header}\n${row(-17.8, 179.5, "2026-10-21", "0905", code)}`,
      ).at.length,
      1,
    );
    assert.throws(
      () =>
        firms(sensor, `${header}\n${row(1, 1, "2026-10-21", "0905", "N20")}`),
      /values/,
    );
  }
  for (const bad of [
    row(41, 12, "2026-02-30", "1100", "N20"),
    row(41, 12, "2026-10-21", "2460", "N20"),
    row(41, 12, "2026-10-21", "1100", "N20") + ",extra",
  ])
    assert.equal(
      firms(n20, `${header}\n${row(1, 1, "2026-10-21", "1100", "N20")}\n${bad}`)
        .at.length,
      1,
    );
  assert.throws(() => firms(n20, "bad,columns\n1,2"), /columns/);
  assert.throws(() => firms(n20, ""), /columns/);
  assert.throws(
    () =>
      firms(n20, `${header}\n${row(41, 12, "2026-10-21", "1100", "N20", "n")}`),
    /values/,
  );
});
test("bbox parsing is west,south,east,north with west > east crossing the antimeridian", () => {
  assert.deepEqual(parseBbox("-10,35,30,60"), [-10, 35, 30, 60]);
  assert.deepEqual(parseBbox("170,-50,-170,0"), [170, -50, -170, 0]);
  assert.deepEqual(parseBbox("-180,-90,180,90"), [-180, -90, 180, 90]);
  for (const bad of [
    "",
    "1,2,3",
    "1,2,3,4,5",
    "1,,3,4",
    "a,1,2,3",
    "181,0,10,10",
    "0,10,10,5",
    "0,-91,10,10",
    "5,0,5,10",
    "Infinity,0,1,1",
  ])
    assert.equal(parseBbox(bad), null, bad);
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
/**
 * FIRMS bodies keyed by satellite code; 30 recent CEMS activations, EMSR950 mapped near Fiji.
 * The list reports n_aois as a string: EMSR950 lists 102 AOIs, EMSR926 an unreadable count.
 */
const upstream = (firmsRows: Record<string, string[]>, calls: string[] = []) =>
  (async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.redirect, "manual");
    assert(init.signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.has("Authorization"), false);
    assert.match(
      headers.get("User-Agent") ?? "",
      /^WorldWatch\/1\.0 \(\+https:\/\/github\.com\/fortunexbt\/world-watch; /,
    );
    const sensor = FIRMS_SENSORS.find((s) => s.url === String(url));
    if (sensor) {
      assert.equal(headers.get("Accept"), "text/csv");
      return new Response(
        [header, ...(firmsRows[sensor.satellite] ?? [])].join("\n"),
      );
    }
    assert.equal(headers.get("Accept"), "application/json");
    const eventTime = new Date(live - 3600000).toISOString();
    if (String(url) === CEMS_URL)
      return Response.json({
        count: 300,
        results: Array.from({ length: 30 }, (_, n) => ({
          code: "EMSR" + (950 - n),
          eventTime,
          n_aois: n === 0 ? "102" : n === 24 ? "unknown" : "1",
        })),
      });
    const code = new URL(String(url)).searchParams.get("code");
    return Response.json({
      results: [
        {
          ...detail.results[0],
          eventTime,
          code,
          aois: [
            {
              ...detail.results[0].aois[0],
              extent: code === "EMSR950" ? fijiExtent : extent,
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
test("catalog acquires every sensor's global file and a bounded CEMS budget, coalesces cache and keeps sensor provenance in the tiles", async () => {
  const calls: string[] = [];
  const [d, t] = ago(60);
  const fetcher = upstream(
    {
      N20: [row(41, 12, d, t, "N20", "high")],
      N21: [row(-17.8, 179.5, d, t, "N21", "low")],
      N: [row(64.1, -21.9, d, t, "N", "nominal")],
    },
    calls,
  );
  const [a, b] = await Promise.all([
    getGeospatialCatalog(undefined, fetcher, live),
    getGeospatialCatalog(undefined, fetcher, live),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.bbox, [-180, -90, 180, 90]);
  assert.equal(calls.length, 3 + 1 + 10);
  assert.deepEqual(
    calls.filter((c) => c.includes("?code=")).map((c) => c.split("=").pop()),
    Array.from({ length: 10 }, (_, n) => "EMSR" + (950 - n)),
  );
  // Thermal detections reach the map only as tiles, each carrying sensor, time and confidence.
  assert(a.features.every((f) => f.layer === "emergency_mapping"));
  assert.equal(a.features.length, 10);
  assert.match(a.thermal_version!, /^[0-9a-z]+$/);
  const { version, tile } = await getThermalTile(9, 0, 0, fetcher, live);
  assert.equal(version, a.thermal_version);
  assert.equal(tile, null, "an empty tile has no bytes");
  const world = await getThermalTile(6, 0, 0, fetcher, live);
  assert.equal(world.tile, null);
  const detections: ReturnType<typeof decodeTile>["detections"] = [];
  for (const [lon, lat] of [
    [12, 41],
    [179.5, -17.8],
    [-21.9, 64.1],
  ]) {
    const [x, y] = tileOf(lon, lat, 6),
      found = decodeTile((await getThermalTile(6, x, y, fetcher, live)).tile!, 6, x, y);
    assert.equal(found.detections.length, 1);
    assert(Math.abs(found.detections[0].lon - lon) < 0.01);
    assert(Math.abs(found.detections[0].lat - lat) < 0.01);
    detections.push(...found.detections);
  }
  assert.deepEqual(
    detections.map((d) => [d.sensor, d.confidence, d.at]).sort(),
    [
      ["noaa-20-viirs", "high", Date.parse(`${d}T${t.slice(0, 2)}:${t.slice(2)}:00Z`) / 1000],
      ["noaa-21-viirs", "low", Date.parse(`${d}T${t.slice(0, 2)}:${t.slice(2)}:00Z`) / 1000],
      ["snpp-viirs", "nominal", Date.parse(`${d}T${t.slice(0, 2)}:${t.slice(2)}:00Z`) / 1000],
    ],
  );
  const [cems, firmsSource] = a.sources;
  assert.equal(cems.id, "copernicus");
  assert.equal(cems.truncated, true);
  assert.equal(cems.features_count, 10);
  // 2 AOIs past EMSR950's cap and one each for 14 of the 15 unfetched listed activations.
  assert.equal(cems.total_available, 26);
  assert.doesNotMatch(cems.attribution, /—/);
  assert.equal(firmsSource.id, "firms");
  assert.equal(firmsSource.status, "ok");
  assert.equal(firmsSource.truncated, false);
  assert.equal(firmsSource.features_count, 3);
  assert.equal(firmsSource.total_available, 3);
  assert.match(firmsSource.attribution, /NOAA-20, NOAA-21 and Suomi NPP VIIRS/);
  assert.deepEqual(
    firmsSource.sensors!.map((s) => [
      s.id,
      s.status,
      s.features_count,
      s.source_url,
    ]),
    FIRMS_SENSORS.map((s) => [s.id, "ok", 1, s.url]),
  );
});
test("bbox counts detections across the antimeridian and in the southern hemisphere", async () => {
  const [d, t] = ago(30);
  const fetcher = upstream({
    N20: [
      row(-17.8, 179.5, d, t, "N20"),
      row(-18.1, -179.6, d, t, "N20"),
      row(-17.8, 0, d, t, "N20"),
      row(10, 179.5, d, t, "N20"),
    ],
    N21: [row(-45, -175, d, t, "N21")],
    N: [row(-60, 175, d, t, "N")],
  });
  const pacific = await getGeospatialCatalog([170, -50, -170, 0], fetcher, live);
  assert.deepEqual(pacific.bbox, [170, -50, -170, 0]);
  assert.deepEqual(
    pacific.features
      .filter((f) => f.layer === "emergency_mapping")
      .map((f) => f.properties.activation_code),
    ["EMSR950"],
  );
  const firmsSource = pacific.sources.find((s) => s.id === "firms")!;
  assert.equal(firmsSource.total_available, 3);
  assert.equal(firmsSource.features_count, 3);
  const pacificCems = pacific.sources.find((s) => s.id === "copernicus")!;
  assert.equal(pacificCems.truncated, true);
  assert.equal(
    pacificCems.total_available,
    1,
    "skipped AOIs have no geometry to place inside a smaller view",
  );
  assert.deepEqual(
    firmsSource.sensors!.map((s) => s.total_available),
    [2, 1, 0],
  );
  const europe = await getGeospatialCatalog([-10, 35, 30, 60], fetcher, live);
  assert.equal(
    europe.sources.find((s) => s.id === "firms")!.features_count,
    0,
  );
  assert.equal(
    europe.features.filter((f) => f.layer === "emergency_mapping").length,
    9,
  );
});
test("every detection is counted and tiled, however many share a region", async () => {
  const rows = (code: string, offset: number) =>
    Array.from({ length: 900 }, (_, n) => {
      const [d, t] = ago(10 + offset + 3 * (n % 300));
      return row(-30 + n / 100, 150 + n / 100, d, t, code);
    });
  const [qd, qt] = ago(1200);
  const fetcher = upstream({
    N20: [...rows("N20", 0), row(-10, -60, qd, qt, "N20")],
    N21: rows("N21", 1),
    N: rows("N", 2),
  });
  const catalog = await getGeospatialCatalog(undefined, fetcher, live);
  const source = catalog.sources.find((s) => s.id === "firms")!;
  assert.equal(source.features_count, 2701);
  assert.equal(source.total_available, 2701);
  assert.equal(source.truncated, false);
  assert.deepEqual(
    source.sensors!.map((s) => [s.features_count, s.total_available]),
    [
      [901, 901],
      [900, 900],
      [900, 900],
    ],
  );
  const { tile } = await getThermalTile(0, 0, 0, fetcher, live);
  assert.equal(
    decodeTile(tile!, 0, 0, 0).cells.reduce((n, c) => n + c.n, 0),
    2701,
  );
});
test("each sensor fails independently and failures are reported, not silently dropped", async () => {
  const [d, t] = ago(60);
  const healthy = upstream({ N20: [row(41, 12, d, t, "N20")] });
  const partial = await getGeospatialCatalog(undefined, (async (
    url: any,
    init: any,
  ) =>
    String(url) === n21.url
      ? new Response("", { status: 503 })
      : healthy(url, init)) as typeof fetch, live);
  const source = partial.sources.find((s) => s.id === "firms")!;
  assert.equal(source.status, "ok");
  assert.equal(source.error, "source_http_503");
  assert.deepEqual(
    source.sensors!.map((s) => [s.id, s.status, s.error]),
    [
      ["noaa-20-viirs", "ok", undefined],
      ["noaa-21-viirs", "error", "source_http_503"],
      ["snpp-viirs", "ok", undefined],
    ],
  );
  const failed = await getGeospatialCatalog(
    undefined,
    (async () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://private.invalid/" },
      })) as any,
    live,
  );
  assert.equal(failed.features.length, 0);
  assert.equal(failed.thermal_version, null);
  assert(
    failed.sources.every(
      (s) => s.status === "error" && s.error === "source_http_302",
    ),
  );
  assert(
    failed.sources[1].sensors!.every((s) => s.error === "source_http_302"),
  );
});
test("stream byte caps reject oversized sources before parsing: 24 MB per FIRMS file, 2 MB per JSON document", async () => {
  const streamed = await getGeospatialCatalog(
    undefined,
    (async (url: any) =>
      new Response(
        new Uint8Array(
          FIRMS_SENSORS.some((s) => s.url === String(url))
            ? 24 * 1024 * 1024 + 1
            : 2 * 1024 * 1024 + 1,
        ),
      )) as any,
    live,
  );
  assert(
    streamed.sources.every(
      (s) => s.status === "error" && s.error === "source_byte_limit",
    ),
  );
  const declared = await getGeospatialCatalog(
    undefined,
    (async () =>
      new Response("latitude", {
        headers: { "content-length": String(24 * 1024 * 1024 + 1) },
      })) as any,
    live,
  );
  assert(declared.sources.every((s) => s.error === "source_byte_limit"));
});
test("Suomi NPP is marked ended from NASA's cessation date and no longer read, while NOAA-20 and NOAA-21 carry the thermal layer", async () => {
  const ended = Date.parse(snpp.ended!.at);
  const iso = new Date(ended + 3600000).toISOString();
  const [d, t] = [iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16)];
  const calls: string[] = [];
  const fetcher = upstream(
    {
      N20: [row(41, 12, d, t, "N20")],
      N21: [row(-17.8, 179.5, d, t, "N21")],
      N: [row(64.1, -21.9, d, t, "N")],
    },
    calls,
  );
  const catalog = await getGeospatialCatalog(undefined, fetcher, ended + 2 * 3600000);
  assert(!calls.includes(snpp.url), "an ended sensor's file is not downloaded");
  const firmsSource = catalog.sources.find((s) => s.id === "firms")!;
  assert.equal(firmsSource.status, "ok");
  assert.deepEqual(
    firmsSource.sensors!.map((s) => [s.id, s.status, s.total_available]),
    [
      ["noaa-20-viirs", "ok", 1],
      ["noaa-21-viirs", "ok", 1],
      ["snpp-viirs", "ended", 0],
    ],
  );
  const suomi = firmsSource.sensors!.find((s) => s.id === "snpp-viirs")!;
  assert.equal(suomi.ended_at, "2026-11-02T13:00:00Z");
  assert.match(suomi.notice_url!, /^https:\/\/www\.earthdata\.nasa\.gov\//);
  assert.equal(suomi.error, undefined);
  assert.equal(firmsSource.error, undefined);
  assert.match(firmsSource.attribution, /NOAA-20 and NOAA-21 VIIRS 375 m/);
  assert.doesNotMatch(firmsSource.attribution, /Suomi/);
  // Tiles hold only the sensors still delivering.
  const index = await getThermalIndex(fetcher, ended + 2 * 3600000);
  assert.deepEqual(index.sensors, ["noaa-20-viirs", "noaa-21-viirs"]);
  assert.equal(index.key.length, 2);
  const before = await getGeospatialCatalog(undefined, upstream({}), ended - 1);
  assert.equal(
    before.sources[1].sensors!.find((s) => s.id === "snpp-viirs")!.status,
    "ok",
  );
});
