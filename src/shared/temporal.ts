import type { EventClaim } from "./contracts";
/** Derive only what explicit bounds establish, relative to live time or the selected replay time. */
export function temporalStatus(
  claim: EventClaim,
  at: number = Date.now(),
): EventClaim["temporal_status"] {
  const start = claim.event_start,
    end = claim.event_end;
  const today = new Date(at).toISOString().slice(0, 10);
  const dateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (end && (dateOnly(end) ? end < today : Date.parse(end) < at))
    return "historical";
  if (start && (dateOnly(start) ? start > today : Date.parse(start) > at))
    return "planned";
  if (
    start &&
    end &&
    (dateOnly(start) ? start <= today : Date.parse(start) <= at) &&
    (dateOnly(end) ? end >= today : Date.parse(end) >= at)
  )
    return "current";
  if (
    start &&
    !end &&
    claim.temporal_status === "planned" &&
    (dateOnly(start) ? start < today : Date.parse(start) < at)
  )
    return "unknown";
  return claim.temporal_status;
}

/** A live window includes recent events and planned events no farther ahead than the selected span. */
export function incidentInWindow(incident: {event_start:string|null;published_at:string|null;expires_at:string|null},hours:number,at=Date.now()):boolean {
  if(!(hours>0))return true;
  if(!incident.event_start&&!incident.published_at)return true;
  const time=Date.parse(incident.event_start??incident.published_at??"");
  const span=hours*3600000;
  if(Number.isFinite(time)&&time>=at-span&&time<=at+span)return true;
  return Number.isFinite(time)&&time<=at&&!!incident.expires_at&&Date.parse(incident.expires_at)>at;
}
