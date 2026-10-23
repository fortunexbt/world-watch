/**
 * GNSS interference grid derived from ADSB.lol globe_history traces (ODbL 1.0).
 * Each cell counts the aircraft whose ADS-B reports there were classified, and
 * how many of them reported degraded navigation accuracy and integrity.
 */
export const GNSS_CELL_DEGREES = 0.5;
const COLUMNS = 360 / GNSS_CELL_DEGREES,
  ROWS = 180 / GNSS_CELL_DEGREES;
export const GNSS_CELLS = COLUMNS * ROWS;
export const GNSS_METHOD = {
  cell_degrees: GNSS_CELL_DEGREES,
  /** Positions the aircraft's own avionics broadcast, not multilateration or TIS-B. */
  position_source: "adsb_icao",
  /** Airborne and faster than readsb's own no-GPS check requires. */
  min_ground_speed_kt: 50,
  /** 14 CFR 91.227(c)(1): NACp under 0.05 NM, NIC under 0.2 NM, SIL 1e-7. */
  healthy: { nac_p_min: 8, nic_min: 7, sil: 3 },
  /** Estimated position uncertainty of 4 NM or more, or unknown, with integrity below the rule. */
  degraded: { nac_p_max: 1, nic_max: 6 },
  min_aircraft: 10,
  /** GPSJam's bands, on its share (degraded - 1) / aircraft. */
  medium_share: 0.02,
  high_share: 0.1,
} as const;
export const GNSS_LICENSE = "ODbL-1.0";
export const GNSS_LICENSE_URL =
  "https://opendatacommons.org/licenses/odbl/1-0/";
export const GNSS_SOURCE_URL = "https://github.com/adsblol/globe_history_2026";
export const GNSS_ATTRIBUTION =
  "Contains information from ADSB.lol globe_history, which is made available here under the Open Database License (ODbL).";

export type GnssLevel = "low" | "medium" | "high";
/** [south, west, aircraft, degraded]; a cell spans cell_degrees north and east of its corner. */
export type GnssCell = [number, number, number, number];
export type GnssGrid = {
  date: string;
  cell_degrees: number;
  columns: ["south", "west", "aircraft", "degraded"];
  cells: GnssCell[];
};
export type GnssCounts = {
  traces: number;
  traces_other_day: number;
  /** Trace points carrying a details object, of any position source. */
  reports: number;
  /** Airborne ADS-B reports with NACp, NIC and SIL classified. */
  classified_reports: number;
  healthy_reports: number;
  degraded_reports: number;
  reference_aircraft: number;
  /** Aircraft with classified reports that never met the healthy minimum that day. */
  unreferenced_aircraft: number;
  cells_observed: number;
  cells_published: number;
  cells_with_degraded: number;
};
export type GnssManifest = {
  format: "world-watch-gnss-grid";
  version: 1;
  date: string;
  generated_at: string;
  grid: { file: string; bytes: number; sha256: string };
  method: typeof GNSS_METHOD;
  counts: GnssCounts;
  source: { name: string; release: string; url: string; license: string };
  license: typeof GNSS_LICENSE;
  license_url: typeof GNSS_LICENSE_URL;
  attribution: typeof GNSS_ATTRIBUTION;
};

/** Row-major cell index from the south-west corner, or -1 off the globe. 180°E wraps to 180°W. */
export function gnssCell(lat: number, lon: number) {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return -1;
  const row = Math.min(ROWS - 1, Math.floor((lat + 90) / GNSS_CELL_DEGREES)),
    column = Math.floor((lon + 180) / GNSS_CELL_DEGREES) % COLUMNS;
  return row * COLUMNS + column;
}
/** South-west corner of a cell index. */
export function gnssCorner(cell: number): [south: number, west: number] {
  return [
    Math.floor(cell / COLUMNS) * GNSS_CELL_DEGREES - 90,
    (cell % COLUMNS) * GNSS_CELL_DEGREES - 180,
  ];
}
/** GPSJam subtracts one degraded aircraft so a single faulty receiver cannot colour a cell. */
export function gnssShare(aircraft: number, degraded: number) {
  return aircraft > 0 ? Math.max(0, degraded - 1) / aircraft : 0;
}
export function gnssLevel(aircraft: number, degraded: number): GnssLevel {
  const share = gnssShare(aircraft, degraded);
  return share > GNSS_METHOD.high_share
    ? "high"
    : share >= GNSS_METHOD.medium_share
      ? "medium"
      : "low";
}

const NONE = 0,
  OTHER = 1,
  HEALTHY = 2,
  DEGRADED = 3;
/** A missing field is -1. Reports between the two bands still place the aircraft in the cell. */
export function classifyReport(nacP: number, nic: number, sil: number) {
  if (nacP < 0 || nic < 0 || sil < 0) return NONE;
  const { healthy, degraded } = GNSS_METHOD;
  if (
    nacP >= healthy.nac_p_min &&
    nic >= healthy.nic_min &&
    sil === healthy.sil
  )
    return HEALTHY;
  if (nacP <= degraded.nac_p_max && nic <= degraded.nic_max) return DEGRADED;
  return OTHER;
}

const PRESENT_MARK = 1,
  DEGRADED_MARK = 2;
/**
 * Fixed-size counters for one worker. An aircraft (one trace) counts once per
 * cell, and only if it met the healthy minimum somewhere that day, so avionics
 * that never report good accuracy are left out rather than read as jamming.
 * Unlike GPSJam the healthy report may come after the degraded one, so a
 * flight that departs inside interference is still counted.
 */
export class GnssAccumulator {
  aircraft = new Uint32Array(GNSS_CELLS);
  degraded = new Uint32Array(GNSS_CELLS);
  counts = {
    traces: 0,
    traces_other_day: 0,
    reports: 0,
    classified_reports: 0,
    healthy_reports: 0,
    degraded_reports: 0,
    reference_aircraft: 0,
    unreferenced_aircraft: 0,
  };
  private marks = new Uint8Array(GNSS_CELLS);
  private touched = new Int32Array(GNSS_CELLS);
  private touchedCount = 0;
  private referenced = false;
  report(lat: number, lon: number, kind: number) {
    if (kind === NONE) return;
    const cell = gnssCell(lat, lon);
    if (cell < 0) return;
    this.counts.classified_reports++;
    if (!this.marks[cell]) this.touched[this.touchedCount++] = cell;
    this.marks[cell] |= kind === DEGRADED ? DEGRADED_MARK : PRESENT_MARK;
    if (kind === HEALTHY) {
      this.counts.healthy_reports++;
      this.referenced = true;
    } else if (kind === DEGRADED) this.counts.degraded_reports++;
  }
  endAircraft() {
    if (this.touchedCount)
      this.counts[
        this.referenced ? "reference_aircraft" : "unreferenced_aircraft"
      ]++;
    for (let i = 0; i < this.touchedCount; i++) {
      const cell = this.touched[i];
      if (this.referenced) {
        this.aircraft[cell]++;
        if (this.marks[cell] & DEGRADED_MARK) this.degraded[cell]++;
      }
      this.marks[cell] = 0;
    }
    this.touchedCount = 0;
    this.referenced = false;
  }
  merge(other: Pick<GnssAccumulator, "aircraft" | "degraded" | "counts">) {
    for (let i = 0; i < GNSS_CELLS; i++) {
      this.aircraft[i] += other.aircraft[i];
      this.degraded[i] += other.degraded[i];
    }
    for (const key of Object.keys(this.counts) as (keyof typeof this.counts)[])
      this.counts[key] += other.counts[key];
  }
}

/** Cells under the aircraft minimum are left out, so a blank cell means no data rather than no interference. */
export function gnssGrid(
  acc: Pick<GnssAccumulator, "aircraft" | "degraded" | "counts">,
  date: string,
): { grid: GnssGrid; counts: GnssCounts } {
  const cells: GnssCell[] = [];
  let observed = 0,
    withDegraded = 0;
  for (let i = 0; i < GNSS_CELLS; i++) {
    const aircraft = acc.aircraft[i];
    if (!aircraft) continue;
    observed++;
    if (aircraft < GNSS_METHOD.min_aircraft) continue;
    const degraded = acc.degraded[i];
    if (degraded) withDegraded++;
    cells.push([...gnssCorner(i), aircraft, degraded]);
  }
  return {
    grid: {
      date,
      cell_degrees: GNSS_CELL_DEGREES,
      columns: ["south", "west", "aircraft", "degraded"],
      cells,
    },
    counts: {
      ...acc.counts,
      cells_observed: observed,
      cells_published: cells.length,
      cells_with_degraded: withDegraded,
    },
  };
}

/** The release tag from the archive's own README, which must cover date and grant the ODbL this grid inherits. */
export function archiveRelease(readme: string, date: string) {
  const release = /GitHub Release: (\S+)/.exec(readme)?.[1];
  if (
    !release ||
    !readme.includes(`database for the day of ${date}`) ||
    !readme.includes("Open Database License")
  )
    throw Error("archive_readme_without_odbl_grant");
  return release;
}
export function gnssManifest(
  date: string,
  release: string,
  counts: GnssCounts,
  grid: GnssManifest["grid"],
  generatedAt: string,
): GnssManifest {
  return {
    format: "world-watch-gnss-grid",
    version: 1,
    date,
    generated_at: generatedAt,
    grid,
    method: GNSS_METHOD,
    counts,
    source: {
      name: "ADSB.lol globe_history",
      release,
      url: `${GNSS_SOURCE_URL}/releases/tag/${release}`,
      license: GNSS_LICENSE,
    },
    license: GNSS_LICENSE,
    license_url: GNSS_LICENSE_URL,
    attribution: GNSS_ATTRIBUTION,
  };
}
const finiteCell = (c: unknown, cellDegrees: number) =>
  Array.isArray(c) &&
  c.length === 4 &&
  c[0] >= -90 &&
  c[0] + cellDegrees <= 90 &&
  c[1] >= -180 &&
  c[1] + cellDegrees <= 180 &&
  Number.isInteger(c[2]) &&
  c[2] >= GNSS_METHOD.min_aircraft &&
  Number.isInteger(c[3]) &&
  c[3] >= 0 &&
  c[3] <= c[2];
/** A served manifest and its grid, accepted only under the ODbL and for the manifest's own day. */
export function validGnss(manifest: any, grid: any): manifest is GnssManifest {
  return (
    manifest?.format === "world-watch-gnss-grid" &&
    manifest.version === 1 &&
    manifest.license === GNSS_LICENSE &&
    typeof manifest.attribution === "string" &&
    grid?.date === manifest.date &&
    grid.cell_degrees === GNSS_CELL_DEGREES &&
    Array.isArray(grid.cells) &&
    grid.cells.every((c: unknown) => finiteCell(c, grid.cell_degrees))
  );
}

// readsb trace_full JSON: {"icao":..,"timestamp":..,"trace":[[t,lat,lon,alt,gs,track,flags,rate,details|null,type,..],..]}
// Only about one point in four carries a details object with the accuracy
// fields, so the scanner jumps between "{" bytes with native indexOf and
// parses only those points. Helpers take and return byte positions, and the
// last number read is left in `value`, so no objects are built.
const QUOTE = 0x22,
  COMMA = 0x2c,
  COLON = 0x3a,
  OPEN_ARRAY = 0x5b,
  CLOSE_ARRAY = 0x5d,
  OPEN_OBJECT = 0x7b,
  CLOSE_OBJECT = 0x7d,
  BACKSLASH = 0x5c;
const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const TIMESTAMP = bytesOf('"timestamp"'),
  TRACE = bytesOf('"trace"'),
  TYPE = bytesOf('"type"'),
  NAC_P = bytesOf('"nac_p"'),
  NIC = bytesOf('"nic"'),
  SIL = bytesOf('"sil"'),
  ADSB_ICAO = bytesOf('"adsb_icao"'),
  GROUND = bytesOf('"ground"');
let value = 0;
const invalid = () => Error("invalid_trace");
function space(b: Uint8Array, i: number) {
  let c = b[i];
  while (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) c = b[++i];
  return i;
}
function expect(b: Uint8Array, i: number, byte: number) {
  i = space(b, i);
  if (b[i] !== byte) throw invalid();
  return i + 1;
}
/** Just past the string whose opening quote is at i. */
function stringEnd(b: Uint8Array, i: number) {
  for (let c = b[++i]; c !== QUOTE; c = b[++i]) {
    if (c === BACKSLASH) i++;
    else if (c === undefined) throw invalid();
  }
  return i + 1;
}
/** Whether the bytes from i to end are exactly word, quotes included. */
function equals(b: Uint8Array, i: number, end: number, word: Uint8Array) {
  if (end - i !== word.length) return false;
  for (let k = 0; k < word.length; k++) if (b[i + k] !== word[k]) return false;
  return true;
}
/** Sets value to a JSON number, or NaN for null, a string or anything else, which is skipped. */
function number(b: Uint8Array, i: number) {
  i = space(b, i);
  let c = b[i];
  if (c !== 0x2d && (c < 0x30 || c > 0x39)) {
    value = NaN;
    return skip(b, i);
  }
  const negative = c === 0x2d;
  if (negative) c = b[++i];
  let digits = 0,
    scale = 0;
  for (; c >= 0x30 && c <= 0x39; c = b[++i]) digits = digits * 10 + c - 0x30;
  if (c === 0x2e)
    for (c = b[++i]; c >= 0x30 && c <= 0x39; c = b[++i]) {
      digits = digits * 10 + c - 0x30;
      scale++;
    }
  if (c === 0x65 || c === 0x45) {
    c = b[++i];
    const minus = c === 0x2d;
    if (minus || c === 0x2b) c = b[++i];
    let exponent = 0;
    for (; c >= 0x30 && c <= 0x39; c = b[++i])
      exponent = exponent * 10 + c - 0x30;
    scale += minus ? exponent : -exponent;
  }
  // Dividing by an exact power of ten keeps decimal corners such as 47.5 exact.
  digits = scale > 0 ? digits / 10 ** scale : digits * 10 ** -scale;
  value = negative ? -digits : digits;
  return i;
}
/** Just past the value at i. */
function skip(b: Uint8Array, i: number) {
  i = space(b, i);
  let c = b[i];
  if (c === QUOTE) return stringEnd(b, i);
  if (c !== OPEN_ARRAY && c !== OPEN_OBJECT) {
    // Number or literal: runs to the next delimiter.
    while (c !== COMMA && c !== CLOSE_ARRAY && c !== CLOSE_OBJECT) {
      if (c === undefined) throw invalid();
      c = b[++i];
    }
    return i;
  }
  let depth = 0;
  do {
    c = b[i];
    if (c === QUOTE) {
      i = stringEnd(b, i);
      continue;
    }
    if (c === undefined) throw invalid();
    if (c === OPEN_ARRAY || c === OPEN_OBJECT) depth++;
    else if (c === CLOSE_ARRAY || c === CLOSE_OBJECT) depth--;
    i++;
  } while (depth);
  return i;
}
/** A non-negative integer category from the number just read, or -1. */
const category = () => (Number.isInteger(value) && value >= 0 ? value : -1);

/**
 * Feeds one aircraft's trace to the accumulator. dayStart is the UTC midnight
 * (seconds) the archive covers; a trace starting on another day is counted and
 * skipped. Throws invalid_trace on anything that is not readsb's layout.
 */
export function scanTrace(
  b: Uint8Array,
  acc: GnssAccumulator,
  dayStart: number,
) {
  let timestamp = NaN,
    trace = -1,
    traceEnd = -1,
    i = expect(b, 0, OPEN_OBJECT);
  for (;;) {
    const key = space(b, i);
    if (b[key] !== QUOTE) throw invalid();
    const keyEnd = stringEnd(b, key);
    i = expect(b, keyEnd, COLON);
    if (equals(b, key, keyEnd, TIMESTAMP)) {
      i = number(b, i);
      timestamp = value;
    } else if (equals(b, key, keyEnd, TRACE)) {
      trace = space(b, i);
      i = traceEnd = skip(b, trace);
    } else i = skip(b, i);
    i = space(b, i);
    if (b[i] === CLOSE_OBJECT) break;
    i = expect(b, i, COMMA);
  }
  if (trace < 0 || b[trace] !== OPEN_ARRAY || !Number.isFinite(timestamp))
    throw invalid();
  acc.counts.traces++;
  if (timestamp < dayStart || timestamp >= dayStart + 86400) {
    acc.counts.traces_other_day++;
    return;
  }
  for (
    let brace = b.indexOf(OPEN_OBJECT, trace);
    brace >= 0 && brace < traceEnd;
    brace = b.indexOf(OPEN_OBJECT, i)
  ) {
    // Elements before the details object are scalars, so the nearest "[" opens this point.
    i = brace;
    while (b[--i] !== OPEN_ARRAY) if (i <= trace) throw invalid();
    i++;
    i = number(b, i);
    const offset = value;
    i = number(b, expect(b, i, COMMA));
    const lat = value;
    i = number(b, expect(b, i, COMMA));
    const lon = value;
    i = space(b, expect(b, i, COMMA));
    const altitude = i;
    i = skip(b, i);
    const ground = equals(b, altitude, i, GROUND);
    i = number(b, expect(b, i, COMMA));
    const speed = value;
    for (let k = 0; k < 3; k++) i = skip(b, expect(b, i, COMMA));
    if (space(b, expect(b, i, COMMA)) !== brace) throw invalid();
    let adsb = false,
      nacP = -1,
      nic = -1,
      sil = -1;
    i = space(b, brace + 1);
    if (b[i] === CLOSE_OBJECT) i++;
    else
      for (;;) {
        const key = space(b, i);
        if (b[key] !== QUOTE) throw invalid();
        const keyEnd = stringEnd(b, key);
        i = expect(b, keyEnd, COLON);
        if (equals(b, key, keyEnd, TYPE)) {
          const type = space(b, i);
          i = skip(b, type);
          adsb = equals(b, type, i, ADSB_ICAO);
        } else if (equals(b, key, keyEnd, NAC_P)) {
          i = number(b, i);
          nacP = category();
        } else if (equals(b, key, keyEnd, NIC)) {
          i = number(b, i);
          nic = category();
        } else if (equals(b, key, keyEnd, SIL)) {
          i = number(b, i);
          sil = category();
        } else i = skip(b, i);
        i = space(b, i);
        if (b[i] === CLOSE_OBJECT) {
          i++;
          break;
        }
        i = expect(b, i, COMMA);
      }
    acc.counts.reports++;
    if (
      adsb &&
      !ground &&
      speed > 50 &&
      offset >= 0 &&
      timestamp + offset < dayStart + 86400
    )
      acc.report(lat, lon, classifyReport(nacP, nic, sil));
  }
  acc.endAircraft();
}
