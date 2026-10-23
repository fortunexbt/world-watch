import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
maplibregl.setWorkerUrl(mapWorkerUrl);
import type {
  Map as GLMap,
  GeoJSONSource,
  StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PublicCamera } from "../shared/media";
import type { GeoFeature } from "../shared/geospatial";
import type { IncidentView } from "../shared/contracts";
import { footprintShape } from "../shared/footprint";
import type { Situation } from "../shared/fusion";
import type { NewsSignal } from "../shared/news";
import { NEWS_COLOR, NEWS_GLYPH } from "./NewsSignals";
import { viewportBounds } from "./bounds";
import {
  glyphs,
  GLYPH_ACTIVITIES,
  magnitude,
  markerIcon,
  markerScale,
  MMI_COLORS,
} from "./hazards";
export const colors: Record<string, string> = {
  informational: "#73B6E6",
  minor: "#E4D06C",
  significant: "#EDAB61",
  severe: "#ED7575",
  critical: "#C55064",
  unknown: "#9BA9B3",
};
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
/** Ascending severity; a cluster takes the colour of its most severe member. */
const severity = [
  "unknown",
  "informational",
  "minor",
  "significant",
  "severe",
  "critical",
];
/** Traces an impact shape on a 32-unit box centred on the origin. */
function traceImpact(ctx: CanvasRenderingContext2D, impact: string) {
  ctx.beginPath();
  if (impact === "significant") {
    ctx.moveTo(0, -15);
    ctx.lineTo(14, 12);
    ctx.lineTo(-14, 12);
    ctx.closePath();
  } else if (impact === "severe") {
    ctx.moveTo(0, -16);
    ctx.lineTo(14, 0);
    ctx.lineTo(0, 16);
    ctx.lineTo(-14, 0);
    ctx.closePath();
  } else if (impact === "critical") {
    ctx.rect(-5, -16, 10, 32);
    ctx.rect(-16, -5, 32, 10);
  } else if (impact === "minor") {
    ctx.rect(-14, -7, 28, 14);
  } else {
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
  }
}
function canvasImage(
  size: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(size / 2, size / 2);
  draw(ctx);
  return ctx.getImageData(0, 0, size, size);
}
// The whole width of the world, clamped short of the polar latitudes that
// Mercator inflates, so populated land fills the frame on any screen.
const worldFrame: [[number, number], [number, number]] = [
  [-180, -58],
  [180, 78],
];
const fallback: StyleSpecification = {
  version: 8,
  sources: {
    countries: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution: "Made with Natural Earth (public domain)",
    },
  },
  layers: [
    {
      id: "ocean",
      type: "background",
      paint: { "background-color": "#0D151C" },
    },
    {
      id: "land",
      type: "fill",
      source: "countries",
      paint: { "fill-color": "#192730" },
    },
    {
      id: "borders",
      type: "line",
      source: "countries",
      paint: { "line-color": "#354650", "line-width": 0.65 },
    },
  ],
};
export default function WorldMap({
  incidents,
  selected,
  onSelect,
  onBounds,
  onCountry,
  follow,
  pulse,
  cameras = [],
  onCamera = () => {},
  density = false,
  selectedCamera = null,
  geoFeatures = [],
  onGeo = () => {},
  newsSignals = [],
  selectedSignal = null,
  onSignal = () => {},
}: {
  incidents: IncidentView[];
  selected: string | null;
  onSelect: (id: string) => void;
  onBounds: (b: string) => void;
  onCountry: (name: string) => void;
  follow: boolean;
  pulse: string[];
  cameras?: PublicCamera[];
  onCamera?: (id: string) => void;
  density?: boolean;
  selectedCamera?: string | null;
  geoFeatures?: GeoFeature[];
  onGeo?: (id: string) => void;
  newsSignals?: NewsSignal[];
  selectedSignal?: string | null;
  onSignal?: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<GLMap | null>(null),
    data = useRef(incidents),
    select = useRef(onSelect),
    bounds = useRef(onBounds),
    country = useRef(onCountry),
    cameraData = useRef(cameras),
    cameraSelect = useRef(onCamera),
    densityEnabled = useRef(density);
  const [reduced, setReduced] = useState(false);
  const geoData = useRef(geoFeatures),
    geoSelect = useRef(onGeo);
  geoData.current = geoFeatures;
  geoSelect.current = onGeo;
  const newsData = useRef(newsSignals),
    newsSelect = useRef(onSignal);
  newsData.current = newsSignals;
  newsSelect.current = onSignal;
  data.current = incidents;
  select.current = onSelect;
  bounds.current = onBounds;
  country.current = onCountry;
  cameraData.current = cameras;
  cameraSelect.current = onCamera;
  densityEnabled.current = density;
  const selectedId = useRef(selected),
    cameraId = useRef(selectedCamera),
    signalId = useRef(selectedSignal);
  selectedId.current = selected;
  cameraId.current = selectedCamera;
  signalId.current = selectedSignal;
  // Each source goes to the map worker only when its own inputs change. Sending every source on
  // any render re-clustered all incidents and re-tiled the thermal points on each pan and SSE event.
  const updateIncidents = () => {
    const m = map.current;
    if (!m?.getSource("events")) return;
    const collection = {
      type: "FeatureCollection" as const,
      features: data.current
        .filter((i) => i.location)
        .map((i) => ({
          type: "Feature" as const,
          id: i.id,
          geometry: {
            type: "Point" as const,
            coordinates: [i.location!.lon, i.location!.lat],
          },
          properties: {
            id: i.id,
            impact: i.impact,
            color: colors[i.impact],
            rank: severity.indexOf(i.impact),
            icon: markerIcon(i),
            scale: markerScale(magnitude(i)),
            selected: i.id === selectedId.current ? 1 : 0,
            // A drawn issuer footprint replaces the ring that stands in for an unknown one.
            approx: i.location!.accuracy !== "point" && !i.footprint,
          },
        })),
    };
    (m.getSource("events") as GeoJSONSource).setData(collection);
    // A hidden heatmap needs no data; turning density on sends the current set.
    if (densityEnabled.current)
      (m.getSource("report-density") as GeoJSONSource | undefined)?.setData(
        collection,
      );
    if (m.getLayer("report-heatmap"))
      m.setLayoutProperty(
        "report-heatmap",
        "visibility",
        densityEnabled.current ? "visible" : "none",
      );
  };
  // Footprints change far less often than incidents, so their source is re-sent only when a
  // drawn footprint or its detail changes, and selection only restyles it.
  const footprintKey = useRef("");
  const updateFootprints = () => {
    const m = map.current,
      source = m?.getSource("footprints") as GeoJSONSource | undefined;
    if (!m || !source) return;
    const drawn = data.current.flatMap((s) =>
      ((s as Situation).members ?? [s]).flatMap((member) =>
        member.footprint ? [{ lead: s.id, member }] : [],
      ),
    );
    const key = drawn
      .map(({ lead, member }) => `${lead}:${member.id}:${member.version}:${member.footprint!.detail ? 1 : 0}`)
      .join(",");
    if (key !== footprintKey.current) {
      footprintKey.current = key;
      source.setData({
        type: "FeatureCollection",
        features: drawn.flatMap(({ lead, member }) =>
          footprintShape(member.footprint!).parts.map((part) => ({
            type: "Feature" as const,
            geometry: part.geometry,
            properties: {
              id: lead,
              member: member.id,
              role: member.footprint!.role,
              color: colors[member.impact],
              level: part.level ?? 0,
              // Whole MMI values carry a label; half steps are drawn thinner and unlabelled.
              label:
                member.footprint!.role === "shaking_intensity" &&
                Number.isInteger(part.level)
                  ? "MMI " + ROMAN[part.level!]
                  : "",
            },
          })),
        ),
      });
    }
    const chosen = selectedId.current ?? "";
    m.setFilter("footprint-selected", [
      "any",
      ["==", ["get", "id"], chosen],
      ["==", ["get", "member"], chosen],
    ]);
  };
  const updateCameras = () => {
    (
      map.current?.getSource("public-cameras") as GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: cameraData.current.map((c) => ({
        type: "Feature",
        id: c.id,
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: {
          id: c.id,
          name: c.name,
          video: !!c.video_url,
          selected: c.id === cameraId.current,
        },
      })),
    });
  };
  const updateNews = () => {
    (
      map.current?.getSource("news-signals") as GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: newsData.current.map((s) => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.place.lon, s.place.lat] },
        properties: {
          id: s.id,
          icon: s.rising ? "news-signal-rising" : "news-signal",
          // Breadth of coverage, not impact: the mark grows with distinct sources up to 20.
          scale: 0.75 + 0.5 * Math.min(1, s.sources_count / 20),
          rank: s.score,
          selected: s.id === signalId.current ? 1 : 0,
        },
      })),
    });
  };
  const updateContext = () => {
    (
      map.current?.getSource("geospatial-context") as GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: geoData.current.map((f) => ({
        type: "Feature",
        id: f.id,
        geometry: f.geometry,
        properties: { id: f.id, kind: f.properties.kind, name: f.name },
      })),
    });
  };
  useEffect(() => {
    if (!host.current) return;
    const m = new maplibregl.Map({
      container: host.current,
      style: structuredClone(fallback),
      center: [0, 20],
      zoom: 1,
      pitch: 0,
      bearing: 0,
      minZoom: -1,
      maxZoom: 18,
      renderWorldCopies: true,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    m.addControl(
      new maplibregl.ScaleControl({ maxWidth: 100 }),
      "bottom-right",
    );
    const initialFrame = () =>
      m.fitBounds(worldFrame, {
        padding: {
          left: innerWidth > 760 ? 420 : 24,
          right: 40,
          top: 100,
          bottom: innerWidth > 760 ? 70 : innerHeight * 0.45,
        },
        duration: 0,
      });
    const layers = () => {
      if (m.getSource("events")) return;
      m.addSource("events", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 10,
        clusterRadius: 40,
        clusterProperties: { rank: ["max", ["get", "rank"]] },
        // The ODbL asks for this notice wherever its data is shown, not only in the record. The public demo has no ADSB.lol data.
        ...(__PUBLIC_DEMO__
          ? {}
          : {
              attribution:
                'Contains information from <a href="https://adsb.lol">ADSB.lol</a>, made available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL</a>',
            }),
      });
      m.addLayer({
        id: "clusters",
        type: "circle",
        source: "events",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": [
            "step",
            ["get", "point_count"],
            22,
            20,
            25,
            100,
            32,
          ],
          "circle-color": "#304854",
          "circle-stroke-color": [
            "to-color",
            [
              "at",
              ["get", "rank"],
              ["literal", severity.map((impact) => colors[impact])],
            ],
          ],
          "circle-stroke-width": 1.5,
        },
      });
      m.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "events",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#E7EDF1" },
      });
      // Issuer geometry sits under every marker and context layer. Fills stay faint so a warning
      // area reads as context, never as surveyed damage; contour lines are lines, not areas.
      m.addSource("footprints", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      footprintKey.current = "";
      m.addLayer(
        {
          id: "footprint-fill",
          type: "fill",
          source: "footprints",
          filter: ["!=", ["get", "role"], "shaking_intensity"],
          paint: {
            "fill-color": ["get", "color"],
            // Nested GDACS wind buffers add up towards the strongest winds.
            "fill-opacity": [
              "match",
              ["get", "role"],
              "advisory_area",
              0.1,
              0.05,
            ],
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "footprint-outline",
          type: "line",
          source: "footprints",
          filter: ["==", ["get", "role"], "advisory_area"],
          paint: {
            "line-color": ["get", "color"],
            "line-width": 1,
            "line-opacity": 0.6,
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "footprint-modelled",
          type: "line",
          source: "footprints",
          filter: ["==", ["get", "role"], "inferred_affected_area"],
          paint: {
            "line-color": ["get", "color"],
            "line-width": 1,
            "line-opacity": 0.6,
            "line-dasharray": [4, 3],
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "footprint-contours",
          type: "line",
          source: "footprints",
          filter: ["==", ["get", "role"], "shaking_intensity"],
          layout: { "line-join": "round" },
          paint: {
            "line-color": [
              "interpolate",
              ["linear"],
              ["get", "level"],
              ...MMI_COLORS.flat(),
            ],
            "line-width": [
              "case",
              ["==", ["%", ["get", "level"], 1], 0],
              1.4,
              0.7,
            ],
            "line-opacity": 0.75,
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "footprint-labels",
          type: "symbol",
          source: "footprints",
          filter: ["!=", ["get", "label"], ""],
          minzoom: 5,
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "label"],
            "text-size": 10,
            "text-font": ["Noto Sans Regular"],
          },
          paint: {
            "text-color": "#D6E1E7",
            "text-halo-color": "#0D151C",
            "text-halo-width": 1.5,
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "footprint-selected",
          type: "line",
          source: "footprints",
          filter: ["==", ["get", "id"], ""],
          paint: {
            "line-color": "#E7EDF1",
            "line-width": 1.5,
            "line-opacity": 0.8,
          },
        },
        "clusters",
      );
      // Area records without issuer geometry are centroids, so a soft ring stands in for their unknown footprint.
      m.addLayer({
        id: "area-cue",
        type: "circle",
        source: "events",
        filter: ["all", ["!", ["has", "point_count"]], ["get", "approx"]],
        paint: {
          "circle-radius": ["*", ["get", "scale"], 30],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.14,
          "circle-blur": 0.6,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": 0.35,
          "circle-stroke-width": 1,
        },
      });
      m.addLayer({
        id: "points-halo",
        type: "circle",
        source: "events",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": [
            "*",
            ["get", "scale"],
            ["case", ["==", ["get", "selected"], 1], 15, 9],
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.12,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "selected"], 1],
            2,
            0.5,
          ],
        },
      });
      for (const [impact, color] of Object.entries(colors)) {
        if (!m.hasImage("impact-" + impact))
          m.addImage(
            "impact-" + impact,
            canvasImage(48, (ctx) => {
              traceImpact(ctx, impact);
              ctx.fillStyle = color;
              ctx.strokeStyle = impact === "unknown" ? color : "#0D151C";
              ctx.lineWidth = impact === "unknown" ? 4 : 3;
              if (impact !== "unknown") ctx.fill();
              ctx.stroke();
            }),
            { pixelRatio: 2 },
          );
        // Activity glyph on an impact-coloured disc, with the impact shape as a
        // corner badge so impact never rests on colour alone. Unknown stays hollow.
        for (const activity of GLYPH_ACTIVITIES)
          if (!m.hasImage(`hazard-${activity}-${impact}`))
            m.addImage(
              `hazard-${activity}-${impact}`,
              canvasImage(64, (ctx) => {
                const hollow = impact === "unknown";
                ctx.beginPath();
                ctx.arc(0, 0, 22, 0, Math.PI * 2);
                ctx.fillStyle = hollow ? "#0D151C" : color;
                ctx.strokeStyle = hollow ? color : "#0D151C";
                ctx.lineWidth = hollow ? 4 : 3;
                ctx.fill();
                ctx.stroke();
                ctx.save();
                ctx.scale(1.4, 1.4);
                ctx.translate(-12, -12);
                ctx.lineWidth = 2.3;
                ctx.lineCap = ctx.lineJoin = "round";
                ctx.strokeStyle = hollow ? color : "#0D151C";
                ctx.stroke(new Path2D(glyphs[activity]));
                ctx.restore();
                if (hollow) return;
                ctx.translate(20, -20);
                ctx.scale(0.45, 0.45);
                traceImpact(ctx, impact);
                ctx.fillStyle = color;
                ctx.strokeStyle = "#0D151C";
                ctx.lineWidth = 6;
                ctx.stroke();
                ctx.fill();
              }),
              { pixelRatio: 2 },
            );
      }
      m.addLayer({
        id: "points",
        type: "circle",
        source: "events",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": 22,
          "circle-opacity": 0,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 0,
          "circle-stroke-color": "#0D151C",
        },
      });
      m.addLayer({
        id: "impact-symbols",
        type: "symbol",
        source: "events",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["get", "scale"],
          "symbol-sort-key": ["get", "rank"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      m.addSource("report-density", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addSource("geospatial-context", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution:
          "NASA FIRMS / EOSDIS; Copernicus Emergency Management Service / European Union",
      });
      m.addLayer(
        {
          id: "mapping-areas",
          type: "fill",
          source: "geospatial-context",
          filter: ["==", ["get", "kind"], "mapping_aoi"],
          paint: { "fill-color": "#8CAEBE", "fill-opacity": 0.09 },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "mapping-outlines",
          type: "line",
          source: "geospatial-context",
          filter: ["==", ["get", "kind"], "mapping_aoi"],
          paint: {
            "line-color": "#98BAC7",
            "line-width": 1.5,
            "line-opacity": 0.8,
            "line-dasharray": [3, 3],
          },
        },
        "clusters",
      );
      m.addLayer(
        {
          id: "thermal-detections",
          type: "circle",
          source: "geospatial-context",
          filter: ["==", ["get", "kind"], "thermal_detection"],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 10, 6],
            "circle-color": "#D8B28E",
            "circle-opacity": 0.32,
            "circle-stroke-color": "#E2C19C",
            "circle-stroke-width": 1.2,
          },
        },
        "clusters",
      );
      m.addLayer({id:"thermal-hit",type:"circle",source:"geospatial-context",filter:["==",["get","kind"],"thermal_detection"],paint:{"circle-radius":22,"circle-opacity":0}},"clusters");
      m.addLayer(
        {
          id: "report-heatmap",
          type: "heatmap",
          source: "report-density",
          maxzoom: 14,
          layout: { visibility: densityEnabled.current ? "visible" : "none" },
          paint: {
            "heatmap-weight": 1,
            "heatmap-intensity": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0,
              0.5,
              12,
              2,
            ],
            "heatmap-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0,
              12,
              12,
              35,
            ],
            "heatmap-opacity": 0.5,
            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],
              0,
              "rgba(80,160,185,0)",
              0.3,
              "rgba(80,160,185,0.35)",
              0.7,
              "#82C9CB",
              1,
              "#D1E3CB",
            ],
          },
        },
        "clusters",
      );
      // A broadcast mark on a rounded square, never an impact shape or colour: coverage is not an event.
      for (const rising of [false, true])
        if (!m.hasImage(rising ? "news-signal-rising" : "news-signal"))
          m.addImage(
            rising ? "news-signal-rising" : "news-signal",
            canvasImage(64, (ctx) => {
              ctx.beginPath();
              ctx.roundRect(-21, -21, 42, 42, 10);
              ctx.fillStyle = rising ? NEWS_COLOR : "#0D151C";
              ctx.strokeStyle = rising ? "#0D151C" : NEWS_COLOR;
              ctx.lineWidth = 3;
              ctx.fill();
              ctx.stroke();
              ctx.scale(1.35, 1.35);
              ctx.translate(-12, -12);
              ctx.lineWidth = 2.3;
              ctx.lineCap = ctx.lineJoin = "round";
              ctx.strokeStyle = rising ? "#0D151C" : NEWS_COLOR;
              ctx.stroke(new Path2D(NEWS_GLYPH));
            }),
            { pixelRatio: 2 },
          );
      m.addSource("news-signals", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        // The public demo has no GDELT data.
        ...(__PUBLIC_DEMO__ ? {} : { attribution: "GDELT Project" }),
      });
      m.addLayer({
        id: "news-hit",
        type: "circle",
        source: "news-signals",
        paint: {
          "circle-radius": ["*", ["get", "scale"], 22],
          "circle-opacity": 0,
          "circle-stroke-color": NEWS_COLOR,
          "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 2, 0],
        },
      });
      m.addLayer({
        id: "news-symbols",
        type: "symbol",
        source: "news-signals",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["get", "scale"],
          "symbol-sort-key": ["-", ["get", "rank"]],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      m.addSource("public-cameras", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 35,
        clusterMaxZoom: 12,
      });
      m.addLayer({
        id: "camera-clusters",
        type: "circle",
        source: "public-cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": 22,
          "circle-color": "#1C3943",
          "circle-stroke-color": "#78B8C4",
          "circle-stroke-width": 1,
        },
      });
      m.addLayer({
        id: "camera-count",
        type: "symbol",
        source: "public-cameras",
        filter: ["has", "point_count"],
        layout: {
          "text-field": [
            "concat",
            "▣ ",
            ["to-string", ["get", "point_count_abbreviated"]],
          ],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#D6EDF1" },
      });
      m.addLayer({
        id: "camera-points",
        type: "circle",
        source: "public-cameras",
        filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": 22, "circle-opacity": 0 },
      });
      m.addLayer({
        id: "camera-icons",
        type: "symbol",
        source: "public-cameras",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": "▣",
          "text-size": 19,
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": ["case", ["get", "selected"], "#FFFFFF", "#8BC0CB"],
          "text-halo-color": "#0D151C",
          "text-halo-width": 2,
        },
      });
      updateIncidents();
      updateFootprints();
      updateCameras();
      updateNews();
      updateContext();
    };
    m.on("style.load", layers);
    m.on("load", () => {
      if (host.current) host.current.dataset.mapReady = "true";
      initialFrame();
      layers();
      fetch(import.meta.env.BASE_URL + "countries.geojson", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(10000),
      })
        .then((r) => {
          if (!r.ok) throw Error("Boundary fetch " + r.status);
          return r.json();
        })
        .then((geo) => {
          if (!map.current) return;
          (m.getSource("countries") as GeoJSONSource)?.setData(geo);
          if (host.current) host.current.dataset.boundaries = "loaded";
        })
        .catch((e) => {
          if (host.current) host.current.dataset.mapError = String(e);
          setReduced(true);
        });
      const styleUrl =
        (import.meta as any).env.VITE_MAP_STYLE ||
        "https://tiles.openfreemap.org/styles/dark";
      fetch(styleUrl, { signal: AbortSignal.timeout(8000) })
        .then((r) => {
          if (!r.ok) throw Error("tiles");
          return r.json();
        })
        .then((style) => {
          if (!map.current) return;
          // Provider styles must never reset the user's camera or world framing.
          const camera = {
            center: m.getCenter(),
            zoom: m.getZoom(),
            bearing: 0,
            pitch: 0,
          };
          delete style.center;
          delete style.zoom;
          delete style.bearing;
          delete style.pitch;
          const boundaries = m.getStyle().sources.countries;
          style.sources = { ...style.sources, countries: boundaries };
          style.layers = style.layers.map((layer: any) => {
            if (layer.id === "water")
              layer.paint = { ...layer.paint, "fill-color": "#0D151C" };
            if (layer.id === "boundary_state")
              layer.minzoom = Math.max(5, layer.minzoom ?? 0);
            if (layer.id.startsWith("boundary_country"))
              layer.paint = { ...layer.paint, "line-color": "#465C69" };
            if (
              layer.type === "symbol" &&
              /state|province|subplace/.test(layer.id)
            )
              layer.minzoom = Math.max(6, layer.minzoom ?? 0);
            return layer;
          });
          style.layers = [
            ...fallback.layers,
            ...style.layers.filter(
              (l: any) =>
                !["background", "fill-extrusion", "hillshade"].includes(l.type),
            ),
          ];
          m.once("style.load", () => {
            layers();
            m.jumpTo(camera);
            fetch(import.meta.env.BASE_URL + "countries.geojson", {
              credentials: "same-origin",
              signal: AbortSignal.timeout(10000),
            })
              .then((r) => r.json())
              .then((geo) =>
                (m.getSource("countries") as GeoJSONSource)?.setData(geo),
              )
              .catch(() => setReduced(true));
          });
          m.setStyle(style, { diff: false });
          setReduced(false);
        })
        .catch(() => setReduced(true));
    });
    m.on("styleimagemissing", (e) => {
      if (e.id !== "circle-11" || m.hasImage(e.id)) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 12;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#A6B5BE";
      ctx.beginPath();
      ctx.arc(6, 6, 3, 0, 2 * Math.PI);
      ctx.fill();
      m.addImage(e.id, ctx.getImageData(0, 0, 12, 12), { pixelRatio: 2 });
    });
    m.on("error", (e) => {
      if (host.current)
        host.current.dataset.mapError = e.error?.message || "Unknown map error";
      if (/tile|fetch|load|ajax/i.test(e.error?.message || ""))
        setReduced(true);
    });
    m.on("moveend", () => {
      const b = m.getBounds(),
        view = viewportBounds(
          b.getWest(),
          b.getSouth(),
          b.getEast(),
          b.getNorth(),
        );
      if (host.current) {
        host.current.dataset.mapZoom = String(m.getZoom());
        host.current.dataset.mapBounds = view;
      }
      bounds.current(view);
    });
    m.on("click", "points", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) select.current(id);
    });
    m.on("click", "clusters", async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const z = await (
        m.getSource("events") as GeoJSONSource
      ).getClusterExpansionZoom(f.properties.cluster_id);
      m.easeTo({ center: (f.geometry as any).coordinates, zoom: z });
    });
    m.on("click", "news-hit", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) newsSelect.current(id);
    });
    m.on("mouseenter", "news-hit", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "news-hit", () => (m.getCanvas().style.cursor = ""));
    m.on("click", "camera-points", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) cameraSelect.current(id);
    });
    m.on("click", "camera-clusters", async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await (
        m.getSource("public-cameras") as GeoJSONSource
      ).getClusterExpansionZoom(f.properties.cluster_id);
      m.easeTo({ center: (f.geometry as any).coordinates, zoom });
    });
    m.on(
      "mouseenter",
      "camera-points",
      () => (m.getCanvas().style.cursor = "pointer"),
    );
    m.on(
      "mouseleave",
      "camera-points",
      () => (m.getCanvas().style.cursor = ""),
    );
    const contextClick = (event: maplibregl.MapMouseEvent) => {
      const hits = m.queryRenderedFeatures(event.point);
      if (
        hits.some((f) =>
          ["points", "clusters", "camera-points", "camera-clusters", "news-hit"].includes(
            f.layer.id,
          ),
        )
      )
        return;
      const feature = hits.find((f) =>
        ["thermal-hit", "thermal-detections", "mapping-areas", "mapping-outlines"].includes(
          f.layer.id,
        ),
      );
      if (feature?.properties?.id) geoSelect.current(feature.properties.id);
    };
    for (const layer of [
      "thermal-hit",
      "thermal-detections",
      "mapping-areas",
      "mapping-outlines",
    ]) {
      m.on("click", layer, contextClick);
      m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
    }
    const interactive = [
      "points",
      "clusters",
      "camera-points",
      "camera-clusters",
      "news-hit",
      "thermal-hit",
      "thermal-detections",
      "mapping-areas",
      "mapping-outlines",
    ];
    // An issuer area selects its incident only where nothing more specific was hit.
    m.on("click", "footprint-fill", (e) => {
      if (m.queryRenderedFeatures(e.point).some((f) => interactive.includes(f.layer.id)))
        return;
      const id = e.features?.[0]?.properties?.id;
      if (id) select.current(id);
    });
    m.on("click", (e) => {
      const fs = m.queryRenderedFeatures(e.point);
      if (fs.some((f) => [...interactive, "footprint-fill"].includes(f.layer.id)))
        return;
      const f = fs.find(
        (f) => f.properties?.ADMIN || f.properties?.["name:en"],
      );
      const name = f?.properties?.ADMIN || f?.properties?.["name:en"];
      if (name) country.current(name);
    });
    m.on(
      "mouseenter",
      "points",
      () => (m.getCanvas().style.cursor = "pointer"),
    );
    m.on("mouseleave", "points", () => (m.getCanvas().style.cursor = ""));
    return () => {
      map.current = null;
      m.remove();
    };
  }, []);
  useEffect(updateIncidents, [incidents, selected, density]);
  useEffect(updateFootprints, [incidents, selected]);
  useEffect(updateCameras, [cameras, selectedCamera]);
  useEffect(updateNews, [newsSignals, selectedSignal]);
  useEffect(updateContext, [geoFeatures]);
  useEffect(() => {
    if (!follow || !pulse.length || document.hidden) return;
    const i = incidents.find((x) => x.id === pulse[0]);
    if (i?.location)
      map.current?.easeTo({
        center: [i.location.lon, i.location.lat],
        duration: 600,
      });
  }, [pulse, follow]);
  useEffect(() => {
    const m = map.current;
    if (
      !m ||
      !pulse.length ||
      document.hidden ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const markers = pulse.slice(0, 3).map((id) => {
      const i = incidents.find((x) => x.id === id);
      if (!i?.location) return null;
      const e = document.createElement("div");
      e.className = "arrival-ring";
      e.style.borderColor = colors[i.impact];
      return new maplibregl.Marker({ element: e })
        .setLngLat([i.location.lon, i.location.lat])
        .addTo(m);
    });
    const timer = setTimeout(() => markers.forEach((x) => x?.remove()), 1300);
    return () => {
      clearTimeout(timer);
      markers.forEach((x) => x?.remove());
    };
  }, [pulse]);
  return (
    <>
      <div
        className="map"
        ref={host}
        aria-label="World map. All mapped events are also available in the feed."
        onPointerDown={() => window.dispatchEvent(new Event("map-manual"))}
      />
      {reduced && (
        <div className="map-fallback">
          Map detail unavailable · bundled boundaries remain available
        </div>
      )}
    </>
  );
}
