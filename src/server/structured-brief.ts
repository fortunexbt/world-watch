import type { IncidentView } from "../shared/contracts";
import { situations, type Situation } from "../shared/fusion";

/** The headline budget of the model brief contract. */
const WORDS = 30;
const RANK: Record<string, number> = {
  informational: 1,
  minor: 2,
  significant: 3,
  severe: 4,
  critical: 5,
};
const regions = new Intl.DisplayNames("en", { type: "region" });
const ARTICLE =
  /^(Philippines|Netherlands|Bahamas|Gambia|Maldives|Seychelles|Comoros)$|(Islands|Republic|States|Kingdom|Emirates)$/;
const iso = (n: number) => new Date(n).toISOString();
const time = (v: IncidentView) => Date.parse(v.event_start ?? v.updated_at) || 0;
/** Impact first, then the issuer's most recent event time; the id settles exact ties. */
const order = (a: IncidentView, b: IncidentView) =>
  (RANK[b.impact] ?? 0) - (RANK[a.impact] ?? 0) ||
  time(b) - time(a) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const words = (s: string) => s.split(/\s+/u).length;
const list = (items: string[]) =>
  items.length > 1
    ? items.slice(0, -1).join(", ") + " and " + items.at(-1)
    : (items[0] ?? "");

/** Structured adapters store the issuer's record as a JSON excerpt. */
function issuer(view: IncidentView): Record<string, any> {
  try {
    const record = JSON.parse(view.reports[0]?.excerpts?.[0]?.text);
    return record && typeof record === "object" && !Array.isArray(record)
      ? record
      : {};
  } catch {
    return {};
  }
}
/** NWS and ECCC warning records, recognised by their own fields, are counted per issuer, hazard and country. */
function warningIssuer(record: Record<string, any>) {
  if (typeof record.vtec === "string") return "NWS";
  if (typeof record.alert === "string" && "risk_colour" in record)
    return "ECCC";
  return null;
}
function countries(codes: unknown) {
  const names = [
    ...new Set(
      (Array.isArray(codes) ? codes : []).filter((c) =>
        /^[A-Z]{2}$/.test(c),
      ),
    ),
  ].map((code) => {
    const name = regions.of(code) ?? code;
    return ARTICLE.test(name) ? "the " + name : name;
  });
  return list(
    names.length > 4
      ? [...names.slice(0, 3), `${names.length - 3} other countries`]
      : names,
  );
}

/**
 * A model-free headline from issuer fields alone: one statement per issuer alert, one per
 * activity for the rest, each citing the incidents it counts. A fused situation counts once and
 * cites every record in it. Statements follow their most important incident and stop at the
 * first that would exceed the word budget.
 */
export function structuredBrief(
  views: IncidentView[],
  hours: number,
  clock = Date.now(),
) {
  const live = situations(
    views.filter(
      (v) =>
        !v.analyzed_at &&
        v.evidence_status === "official_advisory" &&
        !v.cancelled &&
        !v.superseded_by &&
        !(v.expires_at && Date.parse(v.expires_at) <= clock),
    ),
  ).sort(order);
  if (!live.length) return null;
  const statements: { text: string; incidents: Situation[] }[] = [],
    groups = new Map<string, Situation[]>();
  for (const v of live) {
    const records = (v.members ?? [v]).map(issuer),
      record =
        records.find((r) => typeof r.alert_level === "string") ?? records[0],
      hazard = v.activity.replaceAll("_", " ");
    if (typeof record.alert_level === "string") {
      // A fused earthquake alert names the magnitude its measuring record states.
      const magnitude = records
          .map((r) => r.magnitude)
          .find((m) => Number.isFinite(m)),
        name =
          typeof record.event_name === "string" && record.event_name
            ? record.event_name
            : v.activity === "earthquake" && magnitude !== undefined
              ? `M${magnitude.toFixed(1)}`
              : "",
        affected = countries(record.affected_countries),
        area = typeof record.countries === "string" ? record.countries : "";
      statements.push({
        text: `${record.alert_level} ${hazard} alert${name ? " for " + name : ""}${affected ? " affecting " + affected : area ? " in " + area : ""}.`,
        incidents: [v],
      });
    } else {
      const warning = warningIssuer(record);
      const key = warning
        ? `warning|${warning}|${v.activity}|${v.location?.country ?? ""}`
        : v.activity === "earthquake" && Number.isFinite(record.magnitude)
          ? "magnitude"
          : v.activity;
      groups.set(key, [...(groups.get(key) ?? []), v]);
    }
  }
  for (const [key, incidents] of groups) {
    if (key.startsWith("warning|")) {
      const [, by, activity, country] = key.split("|"),
        n = incidents.length,
        where = countries([country]);
      statements.push({
        text: `${n} ${by} ${activity.replaceAll("_", " ")} ${n === 1 ? "warning" : "warnings"}${where ? " in " + where : ""}.`,
        incidents,
      });
      continue;
    }
    if (key !== "magnitude") {
      const n = incidents.length;
      statements.push({
        text: `${n} ${key.replaceAll("_", " ")} ${n === 1 ? "record" : "records"}.`,
        incidents,
      });
      continue;
    }
    const magnitudes = incidents.map((v) => issuer(v).magnitude as number),
      top = Math.max(...magnitudes),
      largest = incidents[magnitudes.indexOf(top)],
      place = issuer(largest).place,
      where = typeof place === "string" && place ? ` (${place})` : "";
    statements.push({
      text:
        incidents.length === 1
          ? `1 earthquake, M${top.toFixed(1)}${where}.`
          : `${incidents.length} earthquakes M${(Math.floor(Math.min(...magnitudes) * 10) / 10).toFixed(1)}+, largest M${top.toFixed(1)}${where}.`,
      incidents,
    });
  }
  statements.sort((a, b) => order(a.incidents[0], b.incidents[0]));
  const cited = statements.slice(0, 1);
  for (const s of statements.slice(1)) {
    if (words([...cited, s].map((c) => c.text).join(" ")) > WORDS) break;
    cited.push(s);
  }
  const incidents = cited.flatMap((s) => s.incidents),
    records = (list: Situation[]) => list.flatMap((v) => v.members ?? [v]);
  return {
    kind: "structured" as const,
    id: "structured:" + iso(clock),
    headline: cited.map((s) => s.text).join(" "),
    statements: cited.map((s) => ({
      text: s.text,
      incident_ids: records(s.incidents).map((v) => v.id),
    })),
    references: records(incidents).map((v) => ({
      incident_id: v.id,
      headline: v.headline,
      version: v.version,
    })),
    pins: incidents
      .filter((v) => (RANK[v.impact] ?? 0) >= RANK.significant)
      .sort(order)
      .slice(0, 3)
      .map((v) => ({
        incident_id: v.id,
        headline: v.headline,
        impact: v.impact,
        evidence_status: v.evidence_status,
        version: v.version,
      })),
    counts: {
      reports: new Set(live.flatMap((v) => v.reports.map((r) => r.report_id)))
        .size,
      incidents: live.length,
      pending: 0,
      omitted: live.length - incidents.length,
    },
    window_start: hours > 0 ? iso(clock - hours * 3600000) : null,
    window_end: iso(clock),
    generated_at: iso(clock),
  };
}
