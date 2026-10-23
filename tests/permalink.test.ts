import test from "node:test";
import assert from "node:assert/strict";
import { readView, writeView, type LinkedView } from "../src/client/permalink";

const full: LinkedView = {
  q: "Zürich flood",
  hours: "24",
  filter: "hazards",
  source: "global-usgs-earthquakes",
  language: "de",
  evidence: "corrected",
  incident: "inc/1 & 2",
  camera: null,
  at: "2026-10-22T06:00:00.000Z",
  scope: "Map area",
  map: { zoom: 4.25, lat: -17.7134, lon: 178.065 },
  layers: ["thermal", "emergency_mapping", "cameras", "density", "gnss"],
  imagery: { layer: "modis-true-colour", day: "2026-10-21" },
};
const link = (view: LinkedView, base = "https://watch.invalid/app/?keep=1") => writeView(new URL(base), view);

test("every part of a view survives a link and is read back the same", () => {
  assert.deepEqual(readView(link(full).search), full);
  const variants: Partial<LinkedView>[] = [
    { at: null, scope: "World", map: null, layers: [], imagery: null },
    { scope: "watch:3f2a", camera: "cam-7", layers: ["cameras"] },
    { filter: "all", q: "", hours: "0", imagery: { layer: "night-lights", day: null } },
    { map: { zoom: 0, lat: 0, lon: -180 } },
  ];
  for (const change of variants) {
    const view = { ...full, ...change };
    assert.deepEqual(readView(link(view).search), view, JSON.stringify(change));
  }
  // Parameters the app does not own stay in the link.
  assert.equal(link(full).searchParams.get("keep"), "1");
});

test("links made before the time control still open their view", () => {
  const old = readView("?hours=168&filter=news&incident=abc&layer=cameras&q=strike&evidence=disputed");
  assert.deepEqual(
    { hours: old.hours, filter: old.filter, incident: old.incident, layers: old.layers, q: old.q, evidence: old.evidence, at: old.at, scope: old.scope, map: old.map },
    { hours: "168", filter: "news", incident: "abc", layers: ["cameras"], q: "strike", evidence: "disputed", at: null, scope: "World", map: null },
  );
  assert.deepEqual(readView(""), {
    q: "",
    hours: "168",
    filter: "all",
    source: "",
    language: "",
    evidence: "",
    incident: null,
    camera: null,
    at: null,
    scope: "World",
    map: null,
    layers: [],
    imagery: null,
  });
});

test("malformed or foreign values fall back instead of reaching the view", () => {
  const view = readView("?at=yesterday&map=3/120/10&layer=thermal,ships,,density&imagery=landsat&scope=elsewhere");
  assert.equal(view.at, null);
  assert.equal(view.map, null);
  assert.deepEqual(view.layers, ["thermal", "density"]);
  assert.equal(view.imagery, null);
  assert.equal(view.scope, "World");
  // An offset time is normalised to the instant the server compares known_at with.
  assert.equal(readView("?at=2026-10-22T08:00:00%2B02:00").at, "2026-10-22T06:00:00.000Z");
  assert.equal(readView("?imagery=viirs-true-colour&imagery_day=22-10-2026").imagery?.day, null);
});
