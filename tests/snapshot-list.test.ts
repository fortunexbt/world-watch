import test from "node:test";
import assert from "node:assert/strict";
import { listView } from "../src/shared/view";
import { magnitude, markerIcon } from "../src/client/hazards";
import { views } from "../scripts/synthetic";

test("list views keep what the feed, map and filters read and drop summaries and other evidence text", async () => {
  const all = await views(200, 11, 200);
  const full = JSON.stringify(all).length,
    listed = all.map(listView);
  assert.ok(JSON.stringify(listed).length < full / 2, "a list view is under half a full view");
  for (const [n, v] of all.entries()) {
    const l = listed[n] as any;
    assert.equal(l.summary_en, undefined);
    for (const key of ["id", "version", "headline", "activity", "impact", "evidence_status", "location", "event_start", "published_at", "expires_at", "updated_at", "analyzed_at", "claims", "history", "cancelled"] as const)
      assert.deepEqual(l[key], v[key], key);
    assert.equal(magnitude(l), magnitude(v));
    assert.equal(markerIcon(l), markerIcon(v));
    // App marks structured-only incidents by every report's rights.ai being false.
    assert.deepEqual(l.reports.map((r: any) => r.rights.ai), v.reports.map((r: any) => r.rights.ai));
    assert.deepEqual(l.reports.map((r: any) => [r.source_id, r.title, r.original_language, r.canonical_url]), v.reports.map((r: any) => [r.source_id, r.title, r.original_language, r.canonical_url]));
    assert.ok(l.reports.every((r: any) => r.rights.basis === undefined && r.rights.attribution === undefined));
  }
  assert.ok(all.some((v) => magnitude(v) !== null), "the fixture includes quakes");
});
