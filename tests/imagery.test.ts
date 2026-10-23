import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COPERNICUS_BROWSER,
  GIBS,
  GIBS_LAYERS,
  STAC,
  browserUrl,
  defaultDay,
  gibsDomainUrl,
  gibsTiles,
  hasDay,
  parseDomain,
  parseScenes,
  sceneSearchUrl,
  sceneWindow,
  type GibsLayerId,
} from "../src/client/imagery.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");
const sentinel2 = JSON.parse(fixture("cdse-stac-sentinel-2.json")),
  sentinel1 = JSON.parse(fixture("cdse-stac-sentinel-1.json"));
const manila = { lon: 120.99, lat: 14.59 };

test("GIBS tile URLs carry each layer's identifier, day, tile matrix set and format, and stop at its deepest level", () => {
  assert.equal(
    gibsTiles("viirs-true-colour", "2026-10-22"),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-22/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
  );
  assert.equal(
    gibsTiles("modis-true-colour", "2001-01-01"),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2001-01-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
  );
  assert.equal(
    gibsTiles("night-lights", "2026-10-22"),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance/default/2026-10-22/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
  );
  // GIBS answers 400 past a matrix set's last level, so the source's maxzoom must match it and MapLibre overzooms beyond.
  for (const [id, layer] of Object.entries(GIBS_LAYERS))
    assert.equal(layer.matrix, `GoogleMapsCompatible_Level${layer.maxzoom}`, id);
  assert.deepEqual(
    Object.values(GIBS_LAYERS).map((l) => l.maxzoom),
    [9, 9, 8],
  );
  const tile = gibsTiles("viirs-true-colour", "2026-10-22")
    .replace("{z}", "9")
    .replace("{y}", "225")
    .replace("{x}", "428");
  assert.match(tile, /\/GoogleMapsCompatible_Level9\/9\/225\/428\.jpg$/);
});

test("the day list comes from a real DescribeDomains reply and the default is the newest finished day", () => {
  assert.equal(
    gibsDomainUrl("viirs-true-colour", "2026-09-23"),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/all/2026-09-23.xml",
  );
  // Fetched 23 October 2026, when the newest day was still filling in.
  const days = parseDomain(fixture("gibs-domain.xml"));
  assert.deepEqual(days, [["2026-09-23", "2026-10-23"]]);
  assert.equal(defaultDay(days, "2026-10-23"), "2026-10-22");
  assert.equal(defaultDay(days, "2026-10-25"), "2026-10-23");
  assert.equal(defaultDay([["2026-10-23", "2026-10-23"]], "2026-10-23"), "2026-10-23");
  assert.equal(defaultDay([], "2026-10-23"), null);
  // The same layer's real reply across its 2018 gaps, and a day it never had.
  const gaps = parseDomain(
    "<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2018-02-10/2018-02-21/P1D,2018-02-24/2018-03-12/P1D,2018-03-14/2018-03-20/P1D</Domain><Size>3</Size></DimensionDomain></Domains>",
  );
  assert.equal(gaps.length, 3);
  assert.equal(hasDay(gaps, "2018-02-21"), true);
  assert.equal(hasDay(gaps, "2018-02-22"), false);
  assert.equal(hasDay(gaps, "2018-03-13"), false);
  assert.deepEqual(
    parseDomain("<Domains><DimensionDomain><Domain></Domain><Size>0</Size></DimensionDomain></Domains>"),
    [],
  );
  assert.throws(() => parseDomain("<html>error</html>"), /invalid_gibs_domain/);
  assert.throws(() => parseDomain("<Domain>2018-02-10/2018-02-21/PT1H</Domain>"), /invalid_gibs_domain/);
});

test("scene searches ask the STAC catalogue for a kilometre around the point, ten days either side, slim fields only", () => {
  const event = Date.parse("2026-10-18T00:00:00Z"),
    now = Date.parse("2026-10-23T15:00:00Z");
  const span = sceneWindow(event, now);
  assert.deepEqual(span, ["2026-10-08T00:00:00.000Z", "2026-10-23T15:00:00.000Z"]);
  assert.deepEqual(sceneWindow(event, Date.parse("2026-12-01T00:00:00Z")), [
    "2026-10-08T00:00:00.000Z",
    "2026-10-28T00:00:00.000Z",
  ]);
  const url = new URL(sceneSearchUrl("sentinel-2-l2a", manila, span));
  assert.equal(url.origin + url.pathname, STAC + "/search");
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.collections, "sentinel-2-l2a");
  assert.equal(q.bbox, "120.985,14.585,120.995,14.595");
  assert.equal(q.datetime, "2026-10-08T00:00:00.000Z/2026-10-23T15:00:00.000Z");
  assert.equal(q.limit, "10");
  assert.equal(q.sortby, "-datetime");
  assert.ok(q.fields.split(",").includes("properties.eo:cloud_cover"));
  assert.ok(["-geometry", "-assets", "-links"].every((f) => q.fields.split(",").includes(f)));
  // The box is clamped at the antimeridian and the poles rather than wrapping.
  assert.equal(
    new URL(sceneSearchUrl("sentinel-1-grd", { lon: 179.998, lat: -89.999 }, span)).searchParams.get("bbox"),
    "179.993,-90,180,-89.994",
  );
});

test("scenes parse from real Copernicus Data Space replies, keeping catalogue fields and dropping malformed items", () => {
  // Captured 23 October 2026 from the two search URLs built for Manila on 18 October.
  const optical = parseScenes(sentinel2, "sentinel-2-l2a"),
    radar = parseScenes(sentinel1, "sentinel-1-grd");
  assert.equal(optical.length, 5);
  assert.deepEqual(optical[0], {
    id: "S2C_MSIL2A_20261023T021731_N0513_R003_T51PTS_20261023T054303",
    collection: "sentinel-2-l2a",
    platform: "sentinel-2c",
    acquired: "2026-10-23T02:17:31.025000Z",
    published: "2026-10-23T06:41:33.692771Z",
    cloud_cover: 100,
    orbit: "descending",
    mode: null,
    polarisations: [],
  });
  assert.deepEqual(
    optical.map((s) => s.cloud_cover),
    [100, 54.18, 7.69, 57.62, 99.62],
  );
  assert.equal(radar.length, 2);
  assert.deepEqual(
    radar.map((s) => [s.platform, s.mode, s.polarisations.join("+"), s.orbit]),
    [
      ["sentinel-1c", "IW", "VV+VH", "ascending"],
      ["sentinel-1d", "IW", "VV+VH", "descending"],
    ],
  );
  // An item from the wrong collection, an unparseable time, an impossible cloud figure or a radar scene without its mode.
  const [good] = sentinel1.features;
  const mixed = {
    ...sentinel2,
    features: [
      sentinel2.features[0],
      { ...sentinel2.features[1], properties: { ...sentinel2.features[1].properties, datetime: "yesterday" } },
      { ...sentinel2.features[2], properties: { ...sentinel2.features[2].properties, "eo:cloud_cover": 140 } },
      good,
    ],
  };
  const parsed = parseScenes(mixed, "sentinel-2-l2a");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].cloud_cover, null);
  const { "sar:instrument_mode": _, ...modeless } = good.properties;
  assert.equal(parseScenes({ ...sentinel1, features: [{ ...good, properties: modeless }] }, "sentinel-1-grd").length, 0);
  assert.throws(() => parseScenes({ code: "Timeout" }, "sentinel-1-grd"), /invalid_stac_response/);
});

test("each scene opens the Copernicus Browser on its UTC day at the incident", () => {
  const [optical] = parseScenes(sentinel2, "sentinel-2-l2a"),
    [radar] = parseScenes(sentinel1, "sentinel-1-grd");
  const s2 = new URL(browserUrl(optical, manila)),
    s1 = new URL(browserUrl(radar, manila));
  assert.equal(s2.origin + "/", COPERNICUS_BROWSER);
  assert.deepEqual(Object.fromEntries(s2.searchParams), {
    zoom: "12",
    lat: "14.5900",
    lng: "120.9900",
    themeId: "DEFAULT-THEME",
    datasetId: "S2_L2A_CDAS",
    layerId: "1_TRUE_COLOR",
    fromTime: "2026-10-23T00:00:00.000Z",
    toTime: "2026-10-23T23:59:59.999Z",
  });
  assert.equal(s1.searchParams.get("datasetId"), "S1_CDAS_IW_VVVH");
  assert.equal(s1.searchParams.get("layerId"), null);
  assert.equal(s1.searchParams.get("fromTime"), "2026-10-13T00:00:00.000Z");
});

test("every request and link the imagery context builds stays on the three hosts a content security policy would need to allow", () => {
  const allowed = new Set([new URL(GIBS).origin, new URL(STAC).origin, new URL(COPERNICUS_BROWSER).origin]);
  assert.deepEqual([...allowed], [
    "https://gibs.earthdata.nasa.gov",
    "https://stac.dataspace.copernicus.eu",
    "https://browser.dataspace.copernicus.eu",
  ]);
  const [optical] = parseScenes(sentinel2, "sentinel-2-l2a");
  const span = sceneWindow(Date.parse("2026-10-18T00:00:00Z"), Date.parse("2026-10-23T00:00:00Z"));
  const urls = [
    ...(Object.keys(GIBS_LAYERS) as GibsLayerId[]).flatMap((id) => [
      gibsTiles(id, "2026-10-22").replace(/[{}]/g, ""),
      gibsDomainUrl(id, "2026-09-23"),
    ]),
    sceneSearchUrl("sentinel-2-l2a", manila, span),
    sceneSearchUrl("sentinel-1-grd", manila, span),
    browserUrl(optical, manila),
  ];
  for (const url of urls) assert.ok(allowed.has(new URL(url).origin), url);
  // Catalogue thumbnails live on a CREODIAS host and are deliberately never requested.
  assert.ok(!fixture("cdse-stac-sentinel-2.json").includes("creodias"));
});
