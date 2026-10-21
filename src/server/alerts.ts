import type { IncidentView } from "../shared/contracts";
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
export function intersects(location: IncidentView["location"], geometry: any) {
  if (!location) return false;
  const radius = location.radius_km / 111;
  const bbox = Array.isArray(geometry?.bbox)
    ? geometry.bbox
    : geometry?.type === "Polygon"
      ? [
          Math.min(...geometry.coordinates[0].map((p: any) => p[0])),
          Math.min(...geometry.coordinates[0].map((p: any) => p[1])),
          Math.max(...geometry.coordinates[0].map((p: any) => p[0])),
          Math.max(...geometry.coordinates[0].map((p: any) => p[1])),
        ]
      : null;
  if (!bbox || bbox.length !== 4) return false;
  const lonRadius =
    radius / Math.max(0.15, Math.cos((location.lat * Math.PI) / 180));
  return (
    location.lon + lonRadius >= bbox[0] &&
    location.lon - lonRadius <= bbox[2] &&
    location.lat + radius >= bbox[1] &&
    location.lat - radius <= bbox[3]
  );
}
export function alertDecision(
  i: IncidentView,
  rule: AlertRule,
  geometry: unknown,
  last: any,
  previous: IncidentView | null,
  at = new Date(),
) {
  const suppress = (reason: string) => ({ state: "suppressed", reason });
  if (rule.enabled === false) return suppress("rule_disabled");
  if (rule.watch_area_id && !intersects(i.location, geometry))
    return suppress("outside_watch_area_or_unresolved");
  if (i.cancelled || i.evidence_status === "retracted") {
    if (!last) return suppress("correction_no_prior_delivery");
    return {
      state: "eligible_ui",
      reason: "correction_or_retraction; review previously affected area",
    };
  }
  if (i.event_start && /^\d{4}-\d{2}-\d{2}$/.test(i.event_start))
    return suppress("actionability_time_unknown");
  if (i.event_end && Date.parse(i.event_end) <= +at)
    return suppress("event_ended");
  if (i.event_start && Date.parse(i.event_start) > +at)
    return suppress("future_event");
  if (i.expires_at && Date.parse(i.expires_at) <= +at)
    return suppress("expired");
  if (
    i.event_start &&
    Date.parse(i.event_start) < +at - 24 * 3600000 &&
    !i.event_end
  )
    return suppress("historical_or_stale");
  if (rule.impacts?.length && !rule.impacts.includes(i.impact))
    return suppress("impact_filter");
  if (rule.activities?.length && !rule.activities.includes(i.activity))
    return suppress("activity_filter");
  if (!i.location) return suppress("geography_unresolved");
  if (i.evidence_status !== "official_advisory" && !rule.allow_unverified)
    return suppress("insufficient_supported_evidence");
  if (!i.event_start && !i.expires_at)
    return suppress("actionability_time_unknown");
  if (
    !["severe", "critical"].includes(i.impact) &&
    !i.claims.some((c) => c.official_instruction)
  )
    return suppress("no_current_urgent_claim");
  if (rule.quiet_hours) {
    const h = Number(
        new Intl.DateTimeFormat("en", {
          hour: "numeric",
          hourCycle: "h23",
          timeZone: rule.quiet_hours.timezone,
        }).format(at),
      ),
      { start, end } = rule.quiet_hours;
    if (start < end ? h >= start && h < end : h >= start || h < end)
      return suppress("quiet_hours");
  }
  if (
    previous &&
    previous.impact === i.impact &&
    previous.headline === i.headline &&
    previous.cancelled === i.cancelled
  )
    return suppress("no_material_change");
  if (
    last &&
    +at - Date.parse(last.created_at) < (rule.cooldown_minutes ?? 15) * 60000
  )
    return suppress("cooldown");
  return {
    state: "eligible_ui",
    reason:
      i.location.accuracy === "point"
        ? "currently_actionable_supported_claim"
        : "broad_area_notice; location uncertainty overlaps watch area",
  };
}
