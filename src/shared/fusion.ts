import type { IncidentLink, IncidentView } from "./contracts";

/** A fused situation leads with one record and lists every record in `members`, the lead first. */
export type Situation = IncidentView & { members?: IncidentView[] };
const ACCURACY = ["point", "city", "area", "country"];
const RANK: Record<string, number> = {
  informational: 1,
  minor: 2,
  significant: 3,
  severe: 4,
  critical: 5,
};
const precision = (v: IncidentView) =>
  v.location ? ACCURACY.indexOf(v.location.accuracy) + 1 || ACCURACY.length + 1 : 9;
const lead = (a: IncidentView, b: IncidentView) =>
  precision(a) - precision(b) ||
  (RANK[b.impact] ?? 0) - (RANK[a.impact] ?? 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Joins incidents connected by same_event links into one situation each, keeping input order.
 * The member with the most precise location leads, the highest issuer impact stands for the
 * whole, and the reports of every member are listed. An operator split on either side wins.
 */
export function situations(views: IncidentView[]): Situation[] {
  const byId = new Map(views.map((v) => [v.id, v])),
    root = new Map(views.map((v) => [v.id, v.id]));
  const find = (id: string): string =>
    root.get(id) === id ? id : find(root.get(id)!);
  const splits = (a: IncidentView, b: IncidentView) =>
    !!a.links?.some((l) => l.type === "split_from" && l.incident_id === b.id);
  const split = (a: IncidentView, b: IncidentView) => splits(a, b) || splits(b, a);
  for (const v of views)
    for (const l of v.links ?? []) {
      const other = byId.get(l.incident_id);
      if (l.type === "same_event" && other && !split(v, other))
        root.set(find(v.id), find(other.id));
    }
  const groups = new Map<string, IncidentView[]>();
  for (const v of views) groups.set(find(v.id), [...(groups.get(find(v.id)) ?? []), v]);
  const seen = new Set<string>();
  return views.flatMap((v) => {
    const key = find(v.id);
    if (seen.has(key)) return [];
    seen.add(key);
    const members = groups.get(key)!;
    if (members.length === 1) return [v];
    members.sort(lead);
    const impact = members.reduce(
      (top, m) => ((RANK[m.impact] ?? 0) > (RANK[top] ?? 0) ? m.impact : top),
      members[0].impact,
    );
    return [
      {
        ...members[0],
        impact,
        reports: members.flatMap((m) => m.reports),
        members,
      },
    ];
  });
}

/** The same_event links between members of one situation, each pair once. */
export function memberLinks(situation: Situation) {
  const ids = new Set((situation.members ?? []).map((m) => m.id));
  return (situation.members ?? []).flatMap((m) =>
    (m.links ?? [])
      .filter(
        (l) => l.type === "same_event" && ids.has(l.incident_id) && m.id < l.incident_id,
      )
      .map((l) => ({ from: m, link: l })),
  );
}

/** Independent when any pair has independent origins, one origin when every pair shares it. */
export function independence(situation: Situation): IncidentLink["independence"] {
  const kinds = memberLinks(situation).map((p) => p.link.independence ?? "unknown");
  return kinds.includes("independent")
    ? "independent"
    : kinds.length && kinds.every((k) => k === "same_origin")
      ? "same_origin"
      : "unknown";
}
