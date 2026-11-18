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
import { viewportBounds } from "./bounds";
import { glyphs, HAZARDS, magnitude, markerIcon, markerScale } from "./hazards";
/** Issuer-style hazard inks, chosen to read on the pale chart and on paper. */
export const colors: Record<string, string> = {
  informational: "#2E72B3",
  minor: "#D9A514",
  significant: "#E06A16",
  severe: "#C7312A",
  critical: "#6E0F2E",
  unknown: "#76848D",
};
const INK = "#13202A",
  PAPER = "#FFFFFF",
  OCEAN = "#C7D6DE",
  LAND = "#F4F5F1";
/** Glyphs sit in white on the darker inks and in ink on the light yellow. */
const glyphInk = (impact: string) => (impact === "minor" ? INK : PAPER);
/** Ascending severity; a cluster takes the colour of its most severe member. */
const severity = [
  "unknown",
  "informational",
  "minor",
  "significant",
  "severe",
  "critical",
];
/** Severe records stand out by size as well as colour, so hierarchy survives colour-blindness and print. */
const severityScale: Record<string, number> = {
  unknown: 0.82,
  informational: 0.86,
  minor: 0.9,
  significant: 1.04,
  severe: 1.22,
  critical: 1.34,
};
/** A 30° graticule, as on a printed chart, so position reads without labels. */
const graticule = {
  type: "FeatureCollection" as const,
  features: [
    ...Array.from({ length: 13 }, (_, n) => -180 + n * 30).map((lon) => ({
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates: Array.from({ length: 35 }, (_, k) => [lon, -85 + k * 5]),
      },
    })),
    ...[-60, -30, 0, 30, 60].map((lat) => ({
      type: "Feature" as const,
      properties: { equator: lat === 0 },
      geometry: {
        type: "LineString" as const,
        coordinates: Array.from({ length: 73 }, (_, k) => [-180 + k * 5, lat]),
      },
    })),
  ],
};
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
      paint: { "background-color": OCEAN },
    },
    {
      id: "land",
      type: "fill",
      source: "countries",
      paint: { "fill-color": LAND },
    },
    {
      id: "borders",
      type: "line",
      source: "countries",
      paint: { "line-color": "#A9B6BD", "line-width": 0.6 },
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
  data.current = incidents;
  select.current = onSelect;
  bounds.current = onBounds;
  country.current = onCountry;
  cameraData.current = cameras;
  cameraSelect.current = onCamera;
  densityEnabled.current = density;
  const update = () => {
    const m = map.current;
    if (!m?.getSource("events")) return;
    const features = data.current
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
          scale: markerScale(magnitude(i)) * (severityScale[i.impact] ?? 1),
          selected: i.id === selected ? 1 : 0,
          approx: i.location!.accuracy !== "point",
        },
      }));
    (m.getSource("events") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });
    (m.getSource("selected-event") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: features.filter((f) => f.properties.selected),
    });
    (m.getSource("report-density") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features,
    });
    (m.getSource("public-cameras") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: cameraData.current.map((c) => ({
        type: "Feature",
        id: c.id,
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: {
          id: c.id,
          name: c.name,
          video: !!c.video_url,
          selected: c.id === selectedCamera,
        },
      })),
    });
    if (m.getLayer("report-heatmap"))
      m.setLayoutProperty(
        "report-heatmap",
        "visibility",
        densityEnabled.current ? "visible" : "none",
      );
    (m.getSource("geospatial-context") as GeoJSONSource | undefined)?.setData({
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
          left: 24,
          right: 24,
          top: innerWidth > 760 ? 24 : 80,
          bottom: innerWidth > 760 ? 24 : innerHeight * 0.45,
        },
        duration: 0,
      });
    const layers = () => {
      if (m.getSource("events")) return;
      m.addSource("graticule", { type: "geojson", data: graticule });
      m.addLayer(
        {
          id: "graticule",
          type: "line",
          source: "graticule",
          paint: {
            "line-color": "#6F8D9C",
            "line-opacity": ["case", ["boolean", ["get", "equator"], false], 0.5, 0.28],
            "line-width": 0.7,
          },
        },
        m.getStyle().layers.find((l) => l.type === "symbol")?.id,
      );
      m.addSource("events", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 10,
        clusterRadius: 40,
        clusterProperties: { rank: ["max", ["get", "rank"]] },
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
            14,
            10,
            17,
            40,
            21,
          ],
          "circle-color": PAPER,
          "circle-stroke-color": [
            "to-color",
            [
              "at",
              ["get", "rank"],
              ["literal", severity.map((impact) => colors[impact])],
            ],
          ],
          "circle-stroke-width": 3.5,
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
          "text-font": ["Noto Sans Bold"],
        },
        paint: { "text-color": INK },
      });
      // GDACS and other area records are centroids, so a soft ring stands in for an unknown footprint.
      m.addLayer({
        id: "area-cue",
        type: "circle",
        source: "events",
        filter: ["all", ["!", ["has", "point_count"]], ["get", "approx"]],
        paint: {
          "circle-radius": ["*", ["get", "scale"], 30],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.13,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": 0.55,
          "circle-stroke-width": 1,
        },
      });
      for (const [impact, color] of Object.entries(colors)) {
        if (!m.hasImage("impact-" + impact))
          m.addImage(
            "impact-" + impact,
            canvasImage(48, (ctx) => {
              traceImpact(ctx, impact);
              ctx.fillStyle = impact === "unknown" ? PAPER : color;
              ctx.strokeStyle = impact === "unknown" ? color : PAPER;
              ctx.lineWidth = 4;
              ctx.fill();
              ctx.stroke();
            }),
            { pixelRatio: 2 },
          );
        // Hazard glyph on an impact-coloured disc, with the impact shape as a
        // corner badge so impact never rests on colour alone. Unknown stays hollow.
        for (const hazard of HAZARDS)
          if (!m.hasImage(`hazard-${hazard}-${impact}`))
            m.addImage(
              `hazard-${hazard}-${impact}`,
              canvasImage(72, (ctx) => {
                const hollow = impact === "unknown";
                // A faint ink edge keeps white-rimmed discs crisp on pale land.
                ctx.beginPath();
                ctx.arc(0, 0, 25.5, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(19,32,42,0.28)";
                ctx.fill();
                ctx.beginPath();
                ctx.arc(0, 0, 22, 0, Math.PI * 2);
                ctx.fillStyle = hollow ? PAPER : color;
                ctx.strokeStyle = hollow ? color : PAPER;
                ctx.lineWidth = hollow ? 4.5 : 4;
                ctx.fill();
                ctx.stroke();
                ctx.save();
                ctx.scale(1.3, 1.3);
                ctx.translate(-12, -12);
                ctx.lineWidth = 2.4;
                ctx.lineCap = ctx.lineJoin = "round";
                ctx.strokeStyle = hollow ? color : glyphInk(impact);
                ctx.stroke(new Path2D(glyphs[hazard]));
                ctx.restore();
                if (hollow) return;
                ctx.translate(21, -21);
                ctx.scale(0.42, 0.42);
                traceImpact(ctx, impact);
                ctx.fillStyle = color;
                ctx.strokeStyle = PAPER;
                ctx.lineWidth = 7;
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
          "circle-stroke-color": INK,
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
          paint: { "fill-color": "#1F5A8C", "fill-opacity": 0.08 },
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
            "line-color": "#1F5A8C",
            "line-width": 1.4,
            "line-opacity": 0.85,
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
            // Magenta keeps heat measurements apart from the severity inks.
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.2, 10, 5],
            "circle-color": "#A12C7B",
            "circle-opacity": 0.55,
            "circle-stroke-color": "#FFFFFF",
            "circle-stroke-width": 0.6,
            "circle-stroke-opacity": 0.7,
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
              "rgba(31,90,140,0)",
              0.3,
              "rgba(31,90,140,0.25)",
              0.7,
              "rgba(31,90,140,0.5)",
              1,
              "rgba(19,32,42,0.7)",
            ],
          },
        },
        "clusters",
      );
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
          "circle-radius": 18,
          "circle-color": PAPER,
          "circle-stroke-color": "#1F5A8C",
          "circle-stroke-width": 2,
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
        paint: { "text-color": "#1F5A8C" },
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
          "text-color": ["case", ["get", "selected"], INK, "#1F5A8C"],
          "text-halo-color": PAPER,
          "text-halo-width": 2,
        },
      });
      // The open record is drawn again above clusters with an ink registration
      // ring, so it stays visible even when its neighbours are grouped.
      m.addSource("selected-event", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "selected-ring",
        type: "circle",
        source: "selected-event",
        paint: {
          "circle-radius": ["*", ["get", "scale"], 20],
          "circle-color": PAPER,
          "circle-opacity": 0.85,
          "circle-stroke-color": INK,
          "circle-stroke-width": 2.5,
        },
      });
      m.addLayer({
        id: "selected-symbol",
        type: "symbol",
        source: "selected-event",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["get", "scale"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      update();
    };
    m.on("style.load", layers);
    m.on("load", () => {
      if (host.current) host.current.dataset.mapReady = "true";
      initialFrame();
      layers();
      fetch("/countries.geojson", {
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
        "https://tiles.openfreemap.org/styles/positron";
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
              layer.paint = { ...layer.paint, "fill-color": OCEAN };
            if (layer.id === "park")
              layer.paint = { ...layer.paint, "fill-color": LAND };
            if (layer.id === "boundary_3")
              layer.minzoom = Math.max(5, layer.minzoom ?? 0);
            if (layer.id === "boundary_2")
              layer.paint = { ...layer.paint, "line-color": "#9AA8B0" };
            if (layer.id.startsWith("label_country"))
              layer.paint = {
                ...layer.paint,
                "text-color": "#4B5A63",
                "text-halo-color": LAND,
                "text-halo-width": 1.4,
                "text-halo-blur": 0,
              };
            if (/^water_name/.test(layer.id))
              layer.paint = { ...layer.paint, "text-color": "#5B7A8B" };
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
            fetch("/countries.geojson", {
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
      ctx.fillStyle = "#8597A1";
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
          ["points", "clusters", "camera-points", "camera-clusters"].includes(
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
    m.on("click", (e) => {
      const fs = m.queryRenderedFeatures(e.point);
      if (
        fs.some((f) =>
          [
            "points",
            "clusters",
            "camera-points",
            "camera-clusters",
            "thermal-hit",
            "thermal-detections",
            "mapping-areas",
            "mapping-outlines",
          ].includes(f.layer.id),
        )
      )
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
  useEffect(update, [
    incidents,
    selected,
    cameras,
    density,
    selectedCamera,
    geoFeatures,
  ]);
  // Opening a record off-screen brings it into view without changing the zoom.
  useEffect(() => {
    const m = map.current,
      i = incidents.find((x) => x.id === selected);
    if (!m || !i?.location) return;
    const point = m.project([i.location.lon, i.location.lat]),
      canvas = m.getCanvas(),
      inset = 60;
    if (
      point.x > inset &&
      point.y > inset &&
      point.x < canvas.clientWidth - inset &&
      point.y < canvas.clientHeight - inset
    )
      return;
    m.easeTo({
      center: [i.location.lon, i.location.lat],
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900,
    });
  }, [selected]);
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
          Map detail unavailable. Bundled country boundaries are still shown.
        </div>
      )}
    </>
  );
}
