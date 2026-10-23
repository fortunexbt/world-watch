import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveRelease,
  classifyReport,
  GNSS_CELLS,
  GnssAccumulator,
  gnssCell,
  gnssCorner,
  gnssGrid,
  gnssLevel,
  gnssManifest,
  scanTrace,
  validGnss,
} from "../src/shared/gnss.js";

const DAY = Date.parse("2026-10-22T00:00:00Z") / 1000;
const encode = (text: string) => new TextEncoder().encode(text);
type Point = {
  t?: number;
  lat: number;
  lon: number;
  alt?: number | "ground" | null;
  gs?: number | null;
  type?: string;
  nac_p?: number;
  nic?: number;
  sil?: number;
  extra?: Record<string, unknown>;
};
/** A readsb trace_full file: only points with accuracy fields get a details object. */
function trace(points: Point[], timestamp = DAY, space = "") {
  const rows = points.map((p, k) => {
    const type = p.type ?? "adsb_icao";
    const fields = [p.nac_p, p.nic, p.sil].some((v) => v !== undefined)
      ? JSON.stringify(
          {
            type,
            flight: 'TEST"1\\',
            ...p.extra,
            ...(p.nic === undefined ? {} : { nic: p.nic, rc: 186 }),
            ...(p.nac_p === undefined ? {} : { nac_p: p.nac_p }),
            ...(p.sil === undefined ? {} : { sil: p.sil, sil_type: "perhour" }),
          },
          null,
          space ? 1 : undefined,
        )
      : "null";
    const alt = p.alt === undefined ? 35000 : p.alt;
    return `[${p.t ?? k * 10},${p.lat},${p.lon},${JSON.stringify(alt)},${p.gs === undefined ? 450.5 : p.gs},90.0,0,null,${fields},"${type}",null,null,null,null]`;
  });
  return encode(
    `{"icao":"4ca7b1",${space}"r":"EI-ABC","t":"B738","dbFlags":0,"desc":"BOEING 737-800 {x}",\n"timestamp": ${timestamp.toFixed(3)},\n"trace":[${space}\n${rows.join(`,${space}\n`)}\n]}`,
  );
}
const healthy = { nac_p: 9, nic: 8, sil: 3 },
  degraded = { nac_p: 0, nic: 0, sil: 3 };
function scan(...traces: Uint8Array[]) {
  const acc = new GnssAccumulator();
  for (const t of traces) scanTrace(t, acc, DAY);
  return acc;
}

test("cells are half-degree squares from the south-west, and 180°E wraps onto 180°W", () => {
  assert.equal(gnssCell(-90, -180), 0);
  assert.deepEqual(gnssCorner(gnssCell(52.49, 13.4)), [52, 13]);
  assert.deepEqual(gnssCorner(gnssCell(52.5, 13.5)), [52.5, 13.5]);
  assert.deepEqual(gnssCorner(gnssCell(-33.9, -70.6)), [-34, -71]);
  assert.deepEqual(gnssCorner(gnssCell(90, 0)), [89.5, 0]);
  // Dateline: 179.9°E and 179.9°W are neighbours in different cells; 180° is the 180°W cell.
  assert.deepEqual(gnssCorner(gnssCell(-17, 179.9)), [-17, 179.5]);
  assert.deepEqual(gnssCorner(gnssCell(-17, -179.9)), [-17, -180]);
  assert.equal(gnssCell(-17, 180), gnssCell(-17, -180));
  for (const [lat, lon] of [
    [91, 0],
    [0, 180.1],
    [NaN, 0],
    [0, -Infinity],
  ])
    assert.equal(gnssCell(lat, lon), -1);
  for (let cell = 0; cell < GNSS_CELLS; cell += 7919) {
    const [south, west] = gnssCorner(cell);
    assert.equal(gnssCell(south + 0.25, west + 0.25), cell);
  }
});

test("reports are healthy at the FAA ADS-B Out minimum and degraded only with both accuracy and integrity lost", () => {
  const [NONE, OTHER, HEALTHY, DEGRADED] = [0, 1, 2, 3];
  assert.equal(classifyReport(8, 7, 3), HEALTHY);
  assert.equal(classifyReport(11, 11, 3), HEALTHY);
  assert.equal(classifyReport(7, 8, 3), OTHER);
  assert.equal(classifyReport(9, 6, 3), OTHER);
  assert.equal(classifyReport(9, 8, 2), OTHER);
  assert.equal(classifyReport(1, 6, 3), DEGRADED);
  assert.equal(classifyReport(0, 0, 0), DEGRADED);
  // NACp 2 is under 4 NM, and NACp 0 with a containment radius under 0.2 NM is contradictory.
  assert.equal(classifyReport(2, 0, 3), OTHER);
  assert.equal(classifyReport(0, 7, 3), OTHER);
  assert.equal(classifyReport(-1, 8, 3), NONE);
  assert.equal(classifyReport(9, -1, 3), NONE);
  assert.equal(classifyReport(9, 8, -1), NONE);
});

test("an aircraft counts once per cell, only if it was healthy at some point that day", () => {
  const acc = scan(
    // Reference aircraft: departs inside interference, then recovers in the next cell.
    trace([
      { lat: 34.9, lon: 33.6, ...degraded },
      { lat: 34.95, lon: 33.7, ...degraded },
      { lat: 35.6, lon: 33.6, ...healthy },
      { lat: 35.7, lon: 33.7, ...healthy },
    ]),
    // Chronic equipment: never healthy, so neither cell counts it.
    trace([
      { lat: 34.9, lon: 33.6, ...degraded },
      { lat: 35.6, lon: 33.6, nac_p: 6, nic: 6, sil: 1 },
    ]),
    // Healthy throughout.
    trace([
      { lat: 34.8, lon: 33.8, ...healthy },
      { lat: 35.6, lon: 33.9, nac_p: 7, nic: 8, sil: 3 },
    ]),
  );
  const jammed = gnssCell(34.9, 33.6),
    clear = gnssCell(35.6, 33.6);
  assert.deepEqual(
    [acc.aircraft[jammed], acc.degraded[jammed]],
    [2, 1],
    "the recovering flight and the healthy one; the chronic one is left out",
  );
  assert.deepEqual([acc.aircraft[clear], acc.degraded[clear]], [2, 0]);
  assert.equal(acc.counts.traces, 3);
  assert.equal(acc.counts.reference_aircraft, 2);
  assert.equal(acc.counts.unreferenced_aircraft, 1);
  assert.equal(acc.counts.degraded_reports, 3);
  assert.equal(acc.counts.healthy_reports, 3);
});

test("ground, slow, non-ADS-B, unclassified and out-of-day reports are not counted", () => {
  const acc = scan(
    trace([
      { lat: 10.1, lon: 10.1, ...healthy },
      { lat: 11.1, lon: 11.1, alt: "ground", gs: 140, ...degraded },
      { lat: 12.1, lon: 12.1, gs: 40, ...degraded },
      { lat: 13.1, lon: 13.1, gs: null, ...degraded },
      { lat: 14.1, lon: 14.1, type: "mlat", ...degraded },
      { lat: 15.1, lon: 15.1, type: "adsr_icao", ...degraded },
      { lat: 16.1, lon: 16.1, nic: 0 },
      { lat: 17.1, lon: 17.1, t: 86400, ...degraded },
      { lat: 18.1, lon: 18.1, alt: null, ...degraded },
    ]),
    trace([{ lat: 10.1, lon: 10.1, ...healthy }], DAY - 86400),
  );
  assert.equal(acc.counts.traces, 2);
  assert.equal(acc.counts.traces_other_day, 1);
  assert.equal(acc.counts.reports, 9);
  assert.equal(acc.counts.classified_reports, 2);
  const counted = [...acc.aircraft.keys()].filter((i) => acc.aircraft[i]);
  assert.deepEqual(counted, [gnssCell(10.1, 10.1), gnssCell(18.1, 18.1)]);
});

test("a flight across the dateline lands in cells on both sides", () => {
  const acc = scan(
    trace([
      { lat: 52.1, lon: 179.8, ...healthy },
      { lat: 52.1, lon: 180, ...degraded },
      { lat: 52.1, lon: -179.8, ...degraded },
    ]),
  );
  const east = gnssCell(52.1, 179.8),
    west = gnssCell(52.1, -179.8);
  assert.notEqual(east, west);
  assert.deepEqual([acc.aircraft[east], acc.degraded[east]], [1, 0]);
  assert.deepEqual([acc.aircraft[west], acc.degraded[west]], [1, 1]);
  assert.deepEqual(gnssCorner(west), [52, -180]);
  assert.deepEqual(gnssCorner(east), [52, 179.5]);
});

test("the scanner reads exactly what JSON.parse reads, whatever the spacing and extra fields", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
  const traces = Array.from({ length: 60 }, (_, n) =>
    trace(
      Array.from({ length: 40 }, () => ({
        lat: +(random() * 180 - 90).toFixed(6),
        lon: +(random() * 360 - 180).toFixed(6),
        alt: pick([35000, "ground", null, -50]),
        gs: pick([450.5, 30, null, 51, 1e2]),
        type: pick([
          "adsb_icao",
          "adsb_icao",
          "mlat",
          "tisb_icao",
          "adsb_icao_nt",
        ]),
        nac_p: pick([undefined, 0, 1, 2, 8, 9, 10]),
        nic: pick([undefined, 0, 6, 7, 8]),
        sil: pick([undefined, 0, 2, 3]),
        extra: pick([
          {},
          { nav_modes: ["autopilot", "lnav"], roll: -1.5e-1 },
          { acas_ra: { advisory: "{]}" }, emergency: "none" },
        ]),
      })),
      DAY + pick([0, 0, 0, -86400]),
      n % 3 ? "" : " ",
    ),
  );
  const fast = scan(...traces),
    reference = new GnssAccumulator();
  for (const bytes of traces) {
    const d = JSON.parse(new TextDecoder().decode(bytes));
    reference.counts.traces++;
    if (d.timestamp < DAY || d.timestamp >= DAY + 86400) {
      reference.counts.traces_other_day++;
      continue;
    }
    for (const p of d.trace) {
      const x = p[8];
      if (!x) continue;
      reference.counts.reports++;
      if (
        x.type === "adsb_icao" &&
        p[3] !== "ground" &&
        p[4] > 50 &&
        p[0] < 86400
      )
        reference.report(
          p[1],
          p[2],
          classifyReport(x.nac_p ?? -1, x.nic ?? -1, x.sil ?? -1),
        );
    }
    reference.endAircraft();
  }
  assert.deepEqual(fast.counts, reference.counts);
  assert.deepEqual(fast.aircraft, reference.aircraft);
  assert.deepEqual(fast.degraded, reference.degraded);
  assert.ok(fast.counts.classified_reports > 100);
});

test("anything other than readsb's trace layout fails visibly", () => {
  for (const text of [
    "",
    "[]",
    '{"icao":"abc","timestamp":1}',
    `{"timestamp":${DAY},"trace":{}}`,
    `{"timestamp":${DAY},"trace":[[1,2,{"nac_p":1}]]}`,
    `{"timestamp":${DAY},"trace":[[1,2,3,4,5,6,7,8,{"nac_p":1`,
    `{"timestamp":${DAY},"trace":[{"nac_p":1}]}`,
  ])
    assert.throws(() => scanTrace(encode(text), new GnssAccumulator(), DAY), {
      message: "invalid_trace",
    });
});

test("cells under the aircraft minimum stay blank, and levels follow GPSJam's bands after its one-aircraft discount", () => {
  const acc = new GnssAccumulator();
  const fly = (lat: number, lon: number, bad: boolean) => {
    acc.report(lat, lon, classifyReport(9, 8, 3));
    acc.report(
      lat,
      lon,
      bad ? classifyReport(0, 0, 3) : classifyReport(9, 8, 3),
    );
    acc.endAircraft();
  };
  for (let k = 0; k < 9; k++) fly(1.1, 1.1, k < 5);
  for (let k = 0; k < 10; k++) fly(2.1, 2.1, k < 3);
  const { grid, counts } = gnssGrid(acc, "2026-10-22");
  assert.deepEqual(grid.cells, [[2, 2, 10, 3]]);
  assert.equal(counts.cells_observed, 2);
  assert.equal(counts.cells_published, 1);
  assert.equal(counts.cells_with_degraded, 1);
  assert.equal(gnssLevel(10, 1), "low");
  assert.equal(gnssLevel(10, 2), "medium");
  assert.equal(gnssLevel(10, 3), "high");
  assert.equal(gnssLevel(100, 2), "low");
  assert.equal(gnssLevel(100, 3), "medium");
  assert.equal(gnssLevel(100, 11), "medium");
  assert.equal(gnssLevel(100, 12), "high");
});

test("workers' counters merge into the same grid as one accumulator", () => {
  const traces = [
    trace([
      { lat: 56.1, lon: 21.1, ...healthy },
      { lat: 56.2, lon: 21.2, ...degraded },
    ]),
    trace([{ lat: 56.1, lon: 21.1, ...healthy }]),
    trace([{ lat: 40.1, lon: -3.1, ...healthy }]),
  ];
  const one = scan(...traces),
    left = scan(traces[0]),
    right = scan(traces[1], traces[2]);
  left.merge(right);
  assert.deepEqual(left.aircraft, one.aircraft);
  assert.deepEqual(left.degraded, one.degraded);
  assert.deepEqual(left.counts, one.counts);
});

const README = `This is a database for the day of 2026-10-22 of all aircraft known to adsb.lol.
GitHub Release: v2026.10.22-planes-readsb-prod-0
This database is made available under the Open Database License:
    http://opendatacommons.org/licenses/odbl/1.0/.`;

test("the manifest names the ODbL, its notice, the source release, the method and the counts", () => {
  const release = archiveRelease(README, "2026-10-22");
  assert.equal(release, "v2026.10.22-planes-readsb-prod-0");
  assert.throws(() => archiveRelease(README, "2026-10-23"));
  assert.throws(() =>
    archiveRelease(
      README.replace("Open Database License", "licence"),
      "2026-10-22",
    ),
  );
  assert.throws(() => archiveRelease("", "2026-10-22"));
  const { grid, counts } = gnssGrid(new GnssAccumulator(), "2026-10-22");
  const manifest = gnssManifest(
    "2026-10-22",
    release,
    counts,
    { file: "gnss-2026-10-22.json", bytes: 10, sha256: "0".repeat(64) },
    "2026-10-23T06:00:00.000Z",
  );
  assert.equal(manifest.license, "ODbL-1.0");
  assert.equal(
    manifest.license_url,
    "https://opendatacommons.org/licenses/odbl/1-0/",
  );
  assert.match(
    manifest.attribution,
    /^Contains information from ADSB\.lol globe_history, .*Open Database License \(ODbL\)\.$/,
  );
  assert.deepEqual(manifest.source, {
    name: "ADSB.lol globe_history",
    release,
    url: "https://github.com/adsblol/globe_history_2026/releases/tag/v2026.10.22-planes-readsb-prod-0",
    license: "ODbL-1.0",
  });
  assert.equal(manifest.method.cell_degrees, 0.5);
  assert.equal(manifest.method.min_aircraft, 10);
  assert.deepEqual(manifest.method.healthy, {
    nac_p_min: 8,
    nic_min: 7,
    sil: 3,
  });
  assert.deepEqual(manifest.method.degraded, { nac_p_max: 1, nic_max: 6 });
  assert.equal(manifest.counts.cells_published, 0);
  assert.ok(validGnss(manifest, grid));
  const served = JSON.parse(JSON.stringify(manifest));
  assert.ok(!validGnss({ ...served, license: "CC-BY-4.0" }, grid));
  assert.ok(!validGnss(served, { ...grid, date: "2026-10-21" }));
  assert.ok(!validGnss(served, { ...grid, cells: [[52, 13, 9, 0]] }));
  assert.ok(!validGnss(served, { ...grid, cells: [[52, 13, 10, 11]] }));
  assert.ok(!validGnss(served, { ...grid, cells: [[90, 13, 10, 0]] }));
  assert.ok(validGnss(served, { ...grid, cells: [[52, 179.5, 10, 1]] }));
});
