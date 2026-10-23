import type { EventClaim, IncidentView } from "../shared/contracts";
import { lonOverlaps } from "../shared/view";

export type AlertRule = {
  name?: string;
  watch_area_id?: string;
  impacts?: string[];
  activities?: string[];
  allow_unverified?: boolean;
  cooldown_minutes?: number;
  quiet_hours?: { start: number; end: number; timezone: string };
  enabled?: boolean;
};

/**
 * A prior notice visible to this rule's recipient. `eligible_ui` is an
 * application delivery state; it does not mean an external channel sent it.
 * Callers may attach the material version from the last such notice.
 */
export type AlertDeliverySnapshot = {
  created_at?: string;
  state?: string;
  material_version?: string | null;
  material_projection?: AlertMaterialityProjection | null;
};

export type AlertMaterialityProjection = {
  version: 1;
  rule: {
    watch_area_id: string | null;
    impacts: string[];
    activities: string[];
  };
  location: null | {
    role: "legacy_incident_location";
    name: string;
    country: string | null;
    lon: number;
    lat: number;
    accuracy: string;
    radius_km: number;
  };
  timing: {
    event_start: string | null;
    event_end: string | null;
    expires_at: string | null;
  };
  severity: {
    activity: string;
    impact: string;
  };
  evidence_status: string;
  assertions: Array<{
    activity: string;
    impact: string;
    impacts: string[];
    violence_mentioned: string;
    places: Array<{
      name: string;
      country: string | null;
      admin: string | null;
      uncertainty: string | null;
    }>;
    timing: {
      event_start: string | null;
      event_end: string | null;
      timezone: string | null;
      temporal_status: string;
      time_uncertainty: string | null;
    };
    instruction: null | {
      issuer: string;
      instruction: string;
      effective_at: string | null;
      expires_at: string | null;
    };
    relationships: Array<{ type: string; target: string }>;
  }>;
  cancelled: boolean;
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizedNullableText(value: unknown): string | null {
  const result = normalizedText(value);
  return result || null;
}

function canonicalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizedText(value);
  // Keep date-only precision distinct from midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return normalized;
  const iso = new Date(parsed).toISOString();
  // Normalize only valid canonical UTC timestamps; preserve alternate
  // offsets and malformed-but-retained source strings as supplied.
  if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(normalized)) {
    const withoutMillis = iso.replace(".000Z", "Z");
    if (normalized === iso || normalized === withoutMillis) return iso;
  }
  return normalized;
}

function sortedUnique(values: readonly unknown[] | null | undefined): string[] {
  return [
    ...new Set((values ?? []).map(normalizedText).filter(Boolean)),
  ].sort();
}

function normalizeClaim(claim: EventClaim) {
  const instruction = claim.official_instruction;
  return {
    activity: normalizedText(claim.activity),
    impact: normalizedText(claim.impact),
    impacts: sortedUnique(claim.impacts),
    violence_mentioned: normalizedText(claim.violence_mentioned),
    places: (claim.places ?? [])
      .map((place) => ({
        name: normalizedText(place.name),
        country: normalizedNullableText(place.country),
        admin: normalizedNullableText(place.admin),
        uncertainty: normalizedNullableText(place.uncertainty),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    timing: {
      event_start: canonicalTime(claim.event_start),
      event_end: canonicalTime(claim.event_end),
      timezone: normalizedNullableText(claim.timezone),
      temporal_status: normalizedText(claim.temporal_status),
      time_uncertainty: normalizedNullableText(claim.time_uncertainty),
    },
    instruction: instruction
      ? {
          issuer: normalizedText(instruction.issuer),
          instruction: normalizedText(instruction.instruction),
          effective_at: canonicalTime(instruction.effective_at),
          expires_at: canonicalTime(instruction.expires_at),
        }
      : null,
    relationships: (claim.relationships ?? [])
      .map((relationship) => ({
        type: normalizedText(relationship.type),
        target: normalizedText(relationship.target),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

/**
 * Build the rule-scoped values whose changes can justify another alert.
 * Headline and summary copy, claim/evidence IDs, report counts, and incident
 * version numbers are deliberately omitted because they can churn without a
 * material change to the situation.
 */
export function alertMaterialityProjection(
  incident: IncidentView,
  rule: AlertRule,
): AlertMaterialityProjection {
  const location = incident.location;
  return {
    version: 1,
    rule: {
      watch_area_id: normalizedNullableText(rule.watch_area_id),
      impacts: sortedUnique(rule.impacts),
      activities: sortedUnique(rule.activities),
    },
    // This preserves the existing location's declared meaning. It does not
    // reinterpret a city centroid or radius as calibrated uncertainty.
    location: location
      ? {
          role: "legacy_incident_location",
          name: normalizedText(location.name),
          country: normalizedNullableText(location.country),
          lon: location.lon,
          lat: location.lat,
          accuracy: normalizedText(location.accuracy),
          radius_km: location.radius_km,
        }
      : null,
    timing: {
      event_start: canonicalTime(incident.event_start),
      event_end: canonicalTime(incident.event_end),
      expires_at: canonicalTime(incident.expires_at),
    },
    severity: {
      activity: normalizedText(incident.activity),
      impact: normalizedText(incident.impact),
    },
    evidence_status: normalizedText(incident.evidence_status),
    assertions: (incident.claims ?? [])
      .map(normalizeClaim)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cancelled: incident.cancelled,
  };
}

/** Stable exact serialization avoids hash-collision based alert suppression. */
export function alertMaterialityVersion(
  incident: IncidentView,
  rule: AlertRule,
): string {
  return `alert-material-v1:${JSON.stringify(alertMaterialityProjection(incident, rule))}`;
}

/** Watch bboxes with west > east, or polygon rings with an edge jumping over 180 degrees of longitude, cross the antimeridian. */
export function intersects(location: IncidentView["location"], geometry: any) {
  if (!location) return false;
  const radius = location.radius_km / 111;
  const ring: number[][] | null =
    geometry?.type === "Polygon" ? geometry.coordinates[0] : null;
  const lons = ring?.map((p) => p[0]) ?? [],
    lats = ring?.map((p) => p[1]) ?? [];
  const crossing = lons.some(
    (lon, i) => i > 0 && Math.abs(lon - lons[i - 1]) > 180,
  );
  const bbox = Array.isArray(geometry?.bbox)
    ? geometry.bbox
    : ring
      ? [
          crossing
            ? Math.min(...lons.filter((lon) => lon >= 0))
            : Math.min(...lons),
          Math.min(...lats),
          crossing
            ? Math.max(...lons.filter((lon) => lon < 0))
            : Math.max(...lons),
          Math.max(...lats),
        ]
      : null;
  if (!bbox || bbox.length !== 4) return false;
  const lonRadius =
    radius / Math.max(0.15, Math.cos((location.lat * Math.PI) / 180));
  return (
    lonOverlaps(location.lon, lonRadius, bbox[0], bbox[2]) &&
    location.lat + radius >= bbox[1] &&
    location.lat - radius <= bbox[3]
  );
}

/** Reason prefix of a notice that corrects an earlier one; the cause follows in parentheses. */
export const CORRECTION = "correction_or_retraction";

const impactRank: Record<string, number> = {
  informational: 0,
  minor: 1,
  significant: 2,
  severe: 3,
  critical: 4,
};

export function alertDecision(
  i: IncidentView,
  rule: AlertRule,
  geometry: unknown,
  last: AlertDeliverySnapshot | null,
  at = new Date(),
) {
  const suppress = (reason: string) => ({ state: "suppressed", reason });
  const isCorrection = i.cancelled || i.evidence_status === "retracted";
  const hasPriorEligibleDelivery = Boolean(
    last && (last.state === undefined || last.state === "eligible_ui"),
  );
  const materialVersion = alertMaterialityVersion(i, rule);
  const changedSinceDelivery = Boolean(
    hasPriorEligibleDelivery &&
    last?.material_version &&
    last.material_version !== materialVersion,
  );
  const correction = (reason: string) => ({
    state: "eligible_ui",
    reason: `${CORRECTION}; notify prior eligible recipient (${reason})`,
    material_version: materialVersion,
  });

  // A correction belongs to recipients who saw an earlier eligible notice.
  // It must survive current-area, current-filter, quiet-hours and cooldown
  // changes. `last` is per rule/incident and represents an eligible UI notice;
  // this function does not imply any external channel was used.
  if (isCorrection) {
    if (!hasPriorEligibleDelivery)
      return suppress("correction_no_prior_delivery");
    if (last?.material_version === materialVersion)
      return suppress("no_material_change");
    return correction("withdrawn or retracted");
  }

  // A previously eligible recipient must hear that the material update has
  // moved or removed the incident from their area, even though the new
  // location no longer matches. A prior version alone is not enough: require
  // the caller's last-delivered material version to establish a real change.
  if (
    hasPriorEligibleDelivery &&
    changedSinceDelivery &&
    rule.watch_area_id &&
    (!i.location || !intersects(i.location, geometry))
  )
    return correction("location no longer intersects watch area");

  const suppressOrCorrect = (reason: string) =>
    hasPriorEligibleDelivery && changedSinceDelivery
      ? correction(`current eligibility changed: ${reason}`)
      : suppress(reason);

  if (rule.enabled === false) return suppress("rule_disabled");
  if (rule.watch_area_id && !intersects(i.location, geometry))
    return suppressOrCorrect("outside_watch_area_or_unresolved");
  if (i.event_start && /^\d{4}-\d{2}-\d{2}$/.test(i.event_start))
    return suppressOrCorrect("actionability_time_unknown");
  if (i.event_end && Date.parse(i.event_end) <= +at)
    return suppressOrCorrect("event_ended");
  if (i.event_start && Date.parse(i.event_start) > +at)
    return suppressOrCorrect("future_event");
  if (i.expires_at && Date.parse(i.expires_at) <= +at)
    return suppressOrCorrect("expired");
  if (
    i.event_start &&
    Date.parse(i.event_start) < +at - 24 * 3600000 &&
    !i.event_end
  )
    return suppressOrCorrect("historical_or_stale");
  if (rule.impacts?.length && !rule.impacts.includes(i.impact))
    return suppressOrCorrect("impact_filter");
  if (rule.activities?.length && !rule.activities.includes(i.activity))
    return suppressOrCorrect("activity_filter");
  if (!i.location) return suppressOrCorrect("geography_unresolved");
  if (i.evidence_status !== "official_advisory" && !rule.allow_unverified)
    return suppressOrCorrect("insufficient_supported_evidence");
  if (!i.event_start && !i.expires_at)
    return suppressOrCorrect("actionability_time_unknown");
  if (
    !["severe", "critical"].includes(i.impact) &&
    !i.claims.some((c) => c.official_instruction)
  )
    return suppressOrCorrect("no_current_urgent_claim");

  if (rule.quiet_hours) {
    const h = Number(
      new Intl.DateTimeFormat("en", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: rule.quiet_hours.timezone,
      }).format(at),
    );
    const { start, end } = rule.quiet_hours;
    if (start < end ? h >= start && h < end : h >= start || h < end)
      return suppress("quiet_hours");
  }

  if (last?.material_version === materialVersion)
    return suppress("no_material_change");

  const escalation = Boolean(
    last &&
    impactRank[i.impact] !== undefined &&
    impactRank[last.material_projection?.severity.impact ?? ""] !== undefined &&
    impactRank[i.impact] >
      impactRank[last.material_projection?.severity.impact ?? ""],
  );
  if (
    !escalation &&
    last?.created_at &&
    +at - Date.parse(last.created_at) < (rule.cooldown_minutes ?? 15) * 60000
  )
    return suppress("cooldown");

  return {
    state: "eligible_ui",
    reason: escalation
      ? "severity_escalation; currently_actionable_supported_claim"
      : i.location.accuracy === "point"
        ? "currently_actionable_supported_claim"
        : "broad_area_notice; location uncertainty overlaps watch area",
    material_version: materialVersion,
  };
}

/** Reason prefix of a notice withheld because a same-event partner already gave it. */
export const SAME_SITUATION = "same_situation_notified";

/**
 * One occurrence notifies a rule once. A record that has never notified this rule itself, whose
 * same-event partner has, is covered by the partner's notice. It still notifies when it escalates
 * past the severity the partner notified, or when its own material version has changed since it
 * was last covered. Corrections are untouched: they follow each record's own prior notices.
 */
export function situationDecision<D extends { state: string; reason: string; material_version?: string }>(
  decision: D,
  incident: IncidentView,
  last: AlertDeliverySnapshot | null,
  partner: (AlertDeliverySnapshot & { incident_id: string }) | null,
  covered: AlertDeliverySnapshot | null,
): D | { state: string; reason: string } {
  if (
    decision.state !== "eligible_ui" ||
    !partner ||
    (last && (last.state === undefined || last.state === "eligible_ui"))
  )
    return decision;
  if (covered?.material_version && covered.material_version !== decision.material_version)
    return {
      ...decision,
      reason: `material change since covered by linked incident ${partner.incident_id}; ${decision.reason}`,
    };
  if (
    !covered &&
    (impactRank[incident.impact] ?? -1) >
      (impactRank[partner.material_projection?.severity.impact ?? ""] ?? -1)
  )
    return {
      ...decision,
      reason: `severity_escalation over linked incident ${partner.incident_id}; ${decision.reason}`,
    };
  return {
    state: "suppressed",
    reason: `${SAME_SITUATION}: linked incident ${partner.incident_id} already notified this rule`,
  };
}
