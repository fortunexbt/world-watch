import type { IncidentView } from "../shared/contracts";
export type PrivateArea = {
  id: string;
  name: string;
  bbox: string;
  minimum: string;
};
export type CueDecision = { eligible: boolean; reason: string };
export function intersectsArea(i: IncidentView, a: PrivateArea) {
  if (!i.location) return false;
  const b = a.bbox.split(",").map(Number);
  if (b.length !== 4 || b.some((x) => !Number.isFinite(x))) return false;
  const g = i.location,
    dy = g.radius_km / 111.32,
    dx = dy / Math.max(0.05, Math.cos((g.lat * Math.PI) / 180));
  return (
    g.lon + dx >= b[0] &&
    g.lon - dx <= b[2] &&
    g.lat + dy >= b[1] &&
    g.lat - dy <= b[3]
  );
}
export function cueDecision(
  i: IncidentView,
  areas: PrivateArea[],
  context: {
    now: number;
    catchup: boolean;
    historical: boolean;
    hidden: boolean;
    muted: boolean;
    lastCue: number;
    quiet: boolean;
  },
): CueDecision {
  const no = (reason: string) => ({ eligible: false, reason });
  if (context.muted) return no("muted");
  if (context.catchup) return no("catchup_silent");
  if (context.historical) return no("historical_read_only");
  if (context.hidden) return no("hidden");
  if (context.quiet) return no("quiet_hours");
  if (context.now - context.lastCue < 15000) return no("cooldown");
  if (i.cancelled || ["retracted", "disputed"].includes(i.evidence_status))
    return no("not_current_supported");
  if (!["severe", "critical"].includes(i.impact)) return no("not_urgent");
  if (
    !["corroborated", "official_advisory", "corrected"].includes(
      i.evidence_status,
    )
  )
    return no("insufficient_support");
  if (i.event_start && /^\d{4}-\d{2}-\d{2}$/.test(i.event_start))
    return no("current_validity_unknown");
  if (i.event_end && Date.parse(i.event_end) <= context.now)
    return no("event_ended");
  if (i.expires_at && Date.parse(i.expires_at) <= context.now)
    return no("expired");
  if (i.event_start && Date.parse(i.event_start) > context.now)
    return no("future");
  if (
    !i.expires_at &&
    (!i.event_start || context.now - Date.parse(i.event_start) > 6 * 3600000)
  )
    return no("current_validity_unknown");
  if (!areas.length) return no("no_subscribed_area");
  if (!areas.some((a) => intersectsArea(i, a)))
    return no("outside_subscribed_areas");
  return {
    eligible: true,
    reason:
      i.location?.accuracy === "point"
        ? "supported_current_claim"
        : "broad_area_notice",
  };
}
