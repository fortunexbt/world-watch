import MediaPanel from "./MediaPanel";
import RollingBrief from "./RollingBrief";
import GeospatialPanel from "./GeospatialPanel";
import PublicBanner from "./PublicBanner";
import { CountryCoverage, CoverageChip, CoverageView, freshness, sourceStatus } from "./Coverage";
import PublicFeeds from "./PublicFeeds";
import Notifications from "./Notifications";
import { publicRequest } from "./public-data";
import type {GeospatialCatalog} from "../shared/geospatial";
import type {NewsSignalCatalog} from "../shared/news";
import { NEWS_COLOR, NewsCoverageNote, NewsGlyph, NewsSignalPanel, NewsSignalRow } from "./NewsSignals";
import type {PublicCameraCatalog} from "../shared/media";
import { incidentInWindow, temporalStatus } from "../shared/temporal";
import { independence, memberLinks, situations, type Situation } from "../shared/fusion";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  VolumeX,
  Volume2,
  ArrowLeft,
  ArrowUpRight,
  SlidersHorizontal,
  Activity,
  Radio,
  Clock3,
  Layers,
  Bookmark,
  MapPin,
  Download,
  History,
  ChevronDown,
  Command,
  Check,
  X,
  Globe2,
} from "lucide-react";
import { cueDecision } from "./alerts";
import { translate, type Language } from "./locale";
import {
  formatWhen,
  formatAge,
  eventTime,
  quietHour,
  readLocal,
  readSavedViews,
} from "./time";
import { validBounds } from "./bounds";
import WorldMap, { colors } from "./Map";
import {
  glyphs,
  GLYPH_ACTIVITIES,
  hasGlyph,
  isHazard,
  type GlyphActivity,
} from "./hazards";
import countryRegistry from "../shared/countries.json";
import type { IncidentView, JobInput } from "../shared/contracts";
type Snapshot = {
  incidents: IncidentView[];
  incoming: JobInput[];
  status: any;
  cursor: string;
  sources: any[];
  limited?: boolean;
};
type Surface = "geospatial" | "media" | "news" | "feed" | "health" | "search" | "watches" | "replay" | "country";
const txt = {
  en: {
    feed: "Observed activity",
    reports: "Incoming reports",
    search: "Search places, events, sources…",
    back: "Back to activity",
    empty: "No analyzed events in this view",
    emptySub: "Incoming reports remain available while analysis is pending.",
    pending: "AI pending",
    live: "Connected",
    away: "updates while away",
    new: "new updates",
    health: "Collection & analysis",
    mute: "Enable sound",
    sound: "Mute sound",
  },
  it: {
    feed: "Attività osservate",
    reports: "Segnalazioni in arrivo",
    search: "Cerca luoghi, eventi, fonti…",
    back: "Torna alle attività",
    empty: "Nessun evento analizzato in questa vista",
    emptySub: "Le segnalazioni restano disponibili durante l’analisi.",
    pending: "Analisi in attesa",
    live: "Connesso",
    away: "aggiornamenti durante l’assenza",
    new: "nuovi aggiornamenti",
    health: "Raccolta e analisi",
    mute: "Attiva suono",
    sound: "Disattiva suono",
  },
};
const symbols: Record<string, string> = {
  informational: "●",
  minor: "▰",
  significant: "▲",
  severe: "◆",
  critical: "✚",
  unknown: "◌",
};
const QUOTA_MESSAGE =
  "Daily database read quota reached. Automatic updates are paused. Retry after the quota resets.";
let apiQuotaBlocked = false;
try {
  apiQuotaBlocked = sessionStorage.getItem("ew-database-quota") === "paused";
} catch {}
/** Records from sources that never go to a model are complete without analysis. */
const structuredOnly = (i: IncidentView) =>
  i.reports.length > 0 && i.reports.every((r: any) => r.rights?.ai === false);
function quotaResponse(body: string) {
  if (
    !/storage_quota_paused|database_quota|D1[^\n]*(?:read[^\n]*limit|daily|quota)|daily[^\n]*(?:read|row)[^\n]*limit/i.test(
      body,
    )
  )
    return false;
  apiQuotaBlocked = true;
  try {
    sessionStorage.setItem("ew-database-quota", "paused");
  } catch {}
  window.dispatchEvent(new Event("ew-database-quota"));
  return true;
}
async function api(path: string, options: RequestInit = {}) {
  if (__PUBLIC_DEMO__) return publicRequest(path);
  if (apiQuotaBlocked) throw Error(QUOTA_MESSAGE);
  const r = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!r.ok) {
    const body = await r.text();
    if (quotaResponse(body)) throw Error(QUOTA_MESSAGE);
    throw Error(r.status === 401 ? "Sign in required" : `${r.status}: ${body}`);
  }
  return r.json();
}
export default function App() {
  const [showCameras,setShowCameras]=useState(!__PUBLIC_DEMO__ && (new URLSearchParams(location.search).get("layer")==="cameras" || new URLSearchParams(location.search).has("camera"))),[density,setDensity]=useState(false),[cameraCatalog,setCameraCatalog]=useState<PublicCameraCatalog|null>(null),[selectedCamera,setSelectedCamera]=useState<string|null>(new URLSearchParams(location.search).get("camera")),[mediaError,setMediaError]=useState(""),[mediaLoading,setMediaLoading]=useState(false);
  const [news,setNews]=useState<NewsSignalCatalog|null>(null),[newsError,setNewsError]=useState(""),[selectedSignal,setSelectedSignal]=useState<string|null>(null);
  const [geoLayers,setGeoLayers]=useState<string[]>([]),[geoCatalog,setGeoCatalog]=useState<GeospatialCatalog|null>(null),[selectedGeo,setSelectedGeo]=useState<string|null>(null),[geoError,setGeoError]=useState(""),[geoLoading,setGeoLoading]=useState(false);
  const [clock, setClock] = useState(Date.now);
  const [legendOpen, setLegendOpen] = useState(false);
  const [language, setLanguage] = useState<Language>(() =>
      readLocal<Language>("ew-language", "en") === "it" ? "it" : "en",
    ),
    [snapshot, setSnapshot] = useState<Snapshot>({
      incidents: [],
      incoming: [],
      status: {},
      cursor: "0",
      sources: [],
    }),
    [surface, setSurface] = useState<Surface>(!__PUBLIC_DEMO__ && new URLSearchParams(location.search).has("camera") ? "media" : "feed"),
    [selected, setSelected] = useState<string | null>(
      new URLSearchParams(location.search).get("incident"),
    ),
    [incoming, setIncoming] = useState(false),
    [query, setQuery] = useState(
      new URLSearchParams(location.search).get("q") || "",
    ),
    [filter, setFilter] = useState(
      (__PUBLIC_DEMO__ && new URLSearchParams(location.search).get("filter") === "news" ? "" : new URLSearchParams(location.search).get("filter")) || "all",
    ),
    [sourceFilter, setSourceFilter] = useState(
      new URLSearchParams(location.search).get("source") || "",
    ),
    [languageFilter, setLanguageFilter] = useState(
      new URLSearchParams(location.search).get("language") || "",
    ),
    [evidenceFilter, setEvidenceFilter] = useState(
      new URLSearchParams(location.search).get("evidence") || "",
    ),
    [windowHours, setWindowHours] = useState(
      new URLSearchParams(location.search).get("hours") || "168",
    ),
    [scope, setScope] = useState("World"),
    [bbox, setBbox] = useState(""),
    [ready, setReady] = useState(false),
    [visible, setVisible] = useState(!document.hidden),
    [connection, setConnection] = useState("Connecting"),
    [error, setError] = useState(apiQuotaBlocked ? QUOTA_MESSAGE : ""),
    [quotaPaused, setQuotaPaused] = useState(apiQuotaBlocked),
    [auth, setAuth] = useState(false),
    [sound, setSound] = useState(false),
    [volume, setVolume] = useState(0.12),
    [follow, setFollow] = useState(false),
    [updates, setUpdates] = useState(0),
    [pulse, setPulse] = useState<string[]>([]),
    [sheet, setSheet] = useState(()=>window.matchMedia("(max-width: 760px)").matches ? "compact" : "half"),
    [at, setAt] = useState(""),
    [country, setCountry] = useState(""),
    [watches, setWatches] = useState<any[]>(() =>
      __PUBLIC_DEMO__ ? [] : readLocal<any[]>("ew-watches", []),
    ),
    [savedViews, setSavedViews] = useState<any[]>(readSavedViews),
    [note, setNote] = useState(""),
    [lastSeen] = useState(() => localStorage.getItem("ew-last-seen"));
  const tr = (value: string) => translate(language, value);
  const when = (value: string | null | undefined) =>
    formatWhen(value, language);
  const age = (value: string | null | undefined) => formatAge(value, language);
  const t = txt[language],
    cursor = useRef("0"),
    hydrated = useRef(false),
    away = useRef(false),
    lastCue = useRef(0),
    announced = useRef(new Set<string>()),
    cuedVersions = useRef(new Set<string>()),
    knownVersions = useRef(new Map<string, number>()),
    returnFocus = useRef<string | null>(null),
    audio = useRef<AudioContext | null>(null),
    syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pending = useRef<Snapshot | null>(null),
    reading = useRef(false),
    current = useRef(snapshot),
    snapshotReads = useRef(new Map<string, Promise<Snapshot>>()),
    detailed = useRef<IncidentView | null>(null),
    soundRef = useRef(sound);
  current.current = snapshot;
  soundRef.current = sound;
  const load = useCallback(
    async (force = false) => {
      if (apiQuotaBlocked || document.hidden) return;
      try {
        const params = new URLSearchParams({
          include_incoming: incoming ? "1" : "0",
          q: query,
          hours: windowHours,
          view: "list",
        });
        if (scope === "Map area" && bbox) params.set("bbox", bbox);
        if (scope.startsWith("watch:")) {
          const area = watches.find((w) => w.id === scope.slice(6));
          if (area) params.set("bbox", area.bbox);
        }
        if (sourceFilter) params.set("source", sourceFilter);
        if (languageFilter) params.set("language", languageFilter);
        if (evidenceFilter) params.set("evidence", evidenceFilter);
        if (at) params.set("at", new Date(at).toISOString());
        const snapshotUrl = `/api/snapshot?${params}`;
        let request = snapshotReads.current.get(snapshotUrl);
        if (!request) {
          request = api(snapshotUrl) as Promise<Snapshot>;
          snapshotReads.current.set(snapshotUrl, request);
          void request
            .finally(() => snapshotReads.current.delete(snapshotUrl))
            .catch(() => {});
        }
        // List views omit summaries and evidence text; keep the detail read for the open incident.
        const listed = await request,
          full = detailed.current;
        const s = full
          ? {
              ...listed,
              incidents: listed.incidents.map((i: IncidentView) =>
                i.id === full.id && i.version === full.version ? full : i,
              ),
            }
          : listed;
        setAuth(false);
        setError("");
        for (const i of s.incidents as IncidentView[])
          knownVersions.current.set(
            i.id,
            Math.max(knownVersions.current.get(i.id) ?? 0, i.version),
          );
        away.current = false;
        if (!hydrated.current || force || !reading.current) {
          setSnapshot(s);
          cursor.current = String(
            Math.max(Number(cursor.current) || 0, Number(s.cursor) || 0),
          );
          hydrated.current = true;
          setReady(true);
        } else {
          pending.current = s;
          setUpdates((n) =>
            Math.max(
              n,
              s.incidents.filter(
                (i: IncidentView) =>
                  !current.current.incidents.some(
                    (x) => x.id === i.id && x.version === i.version,
                  ),
              ).length,
            ),
          );
        }
      } catch (e) {
        setError(String(e));
        if (String(e).includes("Sign in")) setAuth(true);
      }
    },
    [
      query,
      incoming,
      windowHours,
      scope,
      scope === "Map area" ? bbox : "",
      at,
      watches,
      sourceFilter,
      languageFilter,
      evidenceFilter,
    ],
  );
  useEffect(() => {
    const pause = () => {
      setQuotaPaused(true);
      setConnection("Updates paused");
      setError(QUOTA_MESSAGE);
    };
    window.addEventListener("ew-database-quota", pause);
    return () => window.removeEventListener("ew-database-quota", pause);
  }, []);
  useEffect(() => {
    load(true);
  }, [load]);
  useEffect(()=>{if(surface!=="feed"&&window.matchMedia("(max-width: 760px)").matches)setSheet("half");},[surface]);
  useEffect(()=>{if(__PUBLIC_DEMO__||!ready||!showCameras)return;const controller=new AbortController();const timer=window.setInterval(()=>{if(document.hidden)return;fetch("/api/cameras",{credentials:"same-origin",signal:controller.signal}).then(async r=>{if(!r.ok)throw Error("Context source unavailable ("+r.status+")");return r.json();}).then(v=>{setCameraCatalog(v);setMediaError("");}).catch(e=>{if(!controller.signal.aborted)setMediaError(String(e));});},600000);return()=>{controller.abort();window.clearInterval(timer);};},[ready,showCameras]);
  // GDELT news signals are not in the public snapshot (docs/DEPLOY-DEMO.md).
  const newsActive=!__PUBLIC_DEMO__&&filter==="news";
  // News signals are read only while their filter is on; the server answers from a one-minute memo.
  useEffect(()=>{if(__PUBLIC_DEMO__||!newsActive||!ready)return;let active=true;const load=()=>{if(document.hidden)return;api("/api/news-signals"+(scope==="Map area"&&bbox?"?"+new URLSearchParams({bbox}):"")).then(value=>{if(active){setNews(value);setNewsError("");}}).catch(e=>{if(active)setNewsError(String(e));});};load();const timer=window.setInterval(load,300000);return()=>{active=false;window.clearInterval(timer);};},[newsActive,ready,scope,scope==="Map area"?bbox:""]);
  const geoActive=geoLayers.length>0;
  // One request per settled viewport: rapid successive moves cancel the pending and in-flight read, and the server answers every bbox from its ten-minute upstream cache.
  useEffect(()=>{if(!geoActive||!ready)return;const controller=new AbortController();const load=()=>{if(document.hidden)return;setGeoLoading(true);(__PUBLIC_DEMO__?publicRequest("/api/geospatial"):fetch("/api/geospatial"+(bbox?"?"+new URLSearchParams({bbox}):""),{credentials:"same-origin",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])}).then(async r=>{if(!r.ok)throw Error("Geospatial context unavailable ("+r.status+")");return r.json();})).then(value=>{setGeoCatalog(value);setGeoError("");setGeoLoading(false);}).catch(e=>{if(controller.signal.aborted)return;setGeoError(String(e));setGeoLoading(false);});};const settle=window.setTimeout(load,400),timer=window.setInterval(load,600000);return()=>{controller.abort();window.clearTimeout(settle);window.clearInterval(timer);};},[geoActive,ready,bbox]);
  useEffect(()=>{if(__PUBLIC_DEMO__||!showCameras||!ready||cameraCatalog)return;let active=true;setMediaLoading(true);setMediaError("");fetch("/api/cameras",{credentials:"same-origin",signal:AbortSignal.timeout(30000)}).then(async r=>{if(!r.ok)throw Error("Public camera catalog unavailable ("+r.status+")");return r.json();}).then(value=>{if(active){setCameraCatalog(value);setMediaLoading(false);}}).catch(e=>{if(active){setMediaError(String(e));setMediaLoading(false);}});return()=>{active=false;};},[showCameras,ready,cameraCatalog]);
  useEffect(() => {
    const u = new URL(location.href);
    query ? u.searchParams.set("q", query) : u.searchParams.delete("q");
    u.searchParams.set("hours", windowHours);
    for (const [key, value] of Object.entries({
      filter,
      source: sourceFilter,
      language: languageFilter,
      evidence: evidenceFilter,
      incident: selected ?? "",
      layer: showCameras ? "cameras" : "",
      camera: surface === "media" ? selectedCamera ?? "" : "",
    })) {
      if (value) u.searchParams.set(key, value);
      else u.searchParams.delete(key);
    }
    history.replaceState(null, "", u);
  }, [
    query,
    windowHours,
    filter,
    sourceFilter,
    languageFilter,
    evidenceFilter,
    selected,
    showCameras,
    selectedCamera,
    surface,
  ]);
  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem("ew-language", JSON.stringify(language));
  }, [language]);
  const cue = useCallback(
    (impact: string, test = false) => {
      if (
        !test &&
        (!soundRef.current ||
          Date.now() - lastCue.current < 15000 ||
          document.hidden ||
          at)
      )
        return;
      if (!test && quietHour()) return;
      const ctx = (audio.current ??= new AudioContext());
      void ctx.resume();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(
        Math.min(volume, 0.2),
        ctx.currentTime + 0.03,
      );
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      gain.connect(ctx.destination);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = impact === "critical" ? 520 : 440;
      o.connect(gain);
      o.start();
      o.stop(ctx.currentTime + 0.45);
      lastCue.current = Date.now();
    },
    [volume, at],
  );
  useEffect(() => {
    // The public snapshot has no live stream; the minute poll below re-reads its manifest.
    if (
      __PUBLIC_DEMO__ ||
      auth ||
      !ready ||
      quotaPaused ||
      apiQuotaBlocked ||
      !visible ||
      document.hidden
    )
      return;
    const stream = new EventSource(`/api/events?cursor=${cursor.current}`);
    stream.onopen = () => {
      setConnection("Connected");
      if (away.current) void load(false);
    };
    stream.onerror = () => {
      setConnection("Reconnecting");
      away.current = true;
    };
    let active = true;
    const simpleView =
      !query &&
      !sourceFilter &&
      !languageFilter &&
      !evidenceFilter &&
      scope === "World" &&
      !incoming &&
      !at;
    const scheduleSnapshot = () => {
      if (!syncTimer.current)
        syncTimer.current = setTimeout(() => {
          syncTimer.current = null;
          void load(false);
        }, 350);
    };
    const bufferedChanges = (next: Snapshot) => {
      const before = new Map(
        current.current.incidents.map((i) => [i.id, i.version]),
      );
      const after = new Map(next.incidents.map((i) => [i.id, i.version]));
      return [...new Set([...before.keys(), ...after.keys()])].filter(
        (id) => before.get(id) !== after.get(id),
      ).length;
    };
    const updateIncident = (
      incident: IncidentView | null,
      id: string,
      eventCursor: number,
    ) => {
      const patch = (base: Snapshot): Snapshot => {
        const hours = Number(windowHours);
        const inWindow = !incident || incidentInWindow(incident,hours);
        const incidents = base.incidents.filter((old) => old.id !== id);
        if (incident && inWindow) incidents.push(incident);
        incidents.sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
        );
        return {
          ...base,
          incidents: incidents.slice(0, 1000),
          cursor: String(Math.max(Number(base.cursor) || 0, eventCursor)),
        };
      };
      if (incident && reading.current) {
        pending.current = patch(pending.current ?? current.current);
        setUpdates(bufferedChanges(pending.current));
      } else {
        // Deletion is immediate even while reading, including already-buffered updates.
        if (!incident && pending.current) {
          pending.current = patch(pending.current);
        }
        const next = patch(current.current);
        current.current = next;
        setSnapshot(next);
        if (!incident && pending.current)
          setUpdates(bufferedChanges(pending.current));
      }
    };
    const changed = (e: MessageEvent) => {
      let d: any;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      const nextCursor = Number(e.lastEventId || d.cursor || 0);
      if (nextCursor && nextCursor <= Number(cursor.current)) return;
      if (nextCursor) cursor.current = String(nextCursor);
      if (at || document.hidden) return;
      const catchup =
        away.current ||
        document.hidden ||
        !hydrated.current ||
        d.replay === true ||
        d.catchup === true;
      if (["incoming", "analysis.completed"].includes(e.type) && !incoming)
        return;
      const id = d.incident_id || d.incident?.id;
      const eventType = e.type;
      if (id && eventType === "incident.deleted") {
        window.dispatchEvent(new Event("ew-brief-invalidated"));
        knownVersions.current.set(id, Number.MAX_SAFE_INTEGER);
        updateIncident(null, id, nextCursor);
        return;
      }
      const incremental =
        simpleView &&
        id &&
        ["incident.created", "incident.updated", "incident.escalated"].includes(
          eventType,
        );
      if (!incremental) scheduleSnapshot();
      const material =
        eventType === "incident.created" || eventType === "incident.escalated";
      if (!id || (!incremental && (!material || catchup))) return;
      if (
        Number(d.version) > 0 &&
        (knownVersions.current.get(id) ?? 0) >= Number(d.version)
      )
        return;
      const notificationKey = `${id}:${d.version ?? "new"}`;
      const announce =
        material && !catchup && !announced.current.has(notificationKey);
      if (announce) announced.current.add(notificationKey);
      // Live changes carry their rights-checked view; others are read back.
      void (
        d.incident
          ? Promise.resolve(d.incident)
          : api("/api/incidents/" + encodeURIComponent(id) + "?compact=1")
      )
        .then((i: IncidentView) => {
          if (
            !active ||
            apiQuotaBlocked ||
            (knownVersions.current.get(id) ?? 0) > i.version
          )
            return;
          if (incremental) {
            knownVersions.current.set(
              id,
              Math.max(knownVersions.current.get(id) ?? 0, i.version),
            );
            updateIncident(i, id, nextCursor);
          }
          if (!announce || document.hidden || at || away.current) return;
          const returnedKey = `${i.id}:${i.version}`;
          if (cuedVersions.current.has(returnedKey)) return;
          cuedVersions.current.add(returnedKey);
          setTimeout(() => {
            if (active && !document.hidden && !at) setPulse([id]);
          }, 350);
          if (
            cueDecision(i, watches, {
              now: Date.now(),
              catchup,
              historical: !!at,
              hidden: document.hidden,
              muted: !soundRef.current,
              lastCue: lastCue.current,
              quiet: quietHour(),
            }).eligible
          )
            cue(i.impact);
        })
        .catch((error) => {
          if (!active || apiQuotaBlocked) return;
          if (/^Error: 404:/.test(String(error))) {
            knownVersions.current.set(id, Number.MAX_SAFE_INTEGER);
            updateIncident(null, id, nextCursor);
          } else setError(String(error));
        });
    };
    for (const type of [
      "incident.created",
      "incident.updated",
      "incident.escalated",
      "incident.deleted",
      "incoming",
      "analysis.completed",
    ])
      stream.addEventListener(type, changed as EventListener);
    stream.addEventListener("update", changed as EventListener);
    stream.addEventListener("incident", changed as EventListener);
    stream.addEventListener("resync", () => {
      window.dispatchEvent(new Event("ew-brief-invalidated"));
      away.current = true;
      void load(true);
    });
    stream.addEventListener("storage.paused", () => {
      quotaResponse("database_quota");
      stream.close();
    });
    stream.onmessage = changed;
    return () => {
      active = false;
      stream.close();
      if (syncTimer.current) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
      }
    };
  }, [
    auth,
    ready,
    load,
    at,
    cue,
    watches,
    quotaPaused,
    incoming,
    query,
    sourceFilter,
    languageFilter,
    evidenceFilter,
    scope,
    windowHours,
    visible,
  ]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) {
        setClock(Date.now());
        void load(false);
      }
    }, 60000);
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) {
        away.current = true;
        setPulse([]);
      } else {
        away.current = true;
        void load(false);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    const manual = () => setFollow(false);
    window.addEventListener("map-manual", manual);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("map-manual", manual);
    };
  }, [load]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setSurface("feed");
        reading.current = false;
        requestAnimationFrame(() => {
          const row =
            returnFocus.current &&
            document.querySelector<HTMLButtonElement>(
              `[data-incident-id="${CSS.escape(returnFocus.current)}"]`,
            );
          (row || document.getElementById("activity"))?.focus();
        });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSurface("search");
        setTimeout(() => document.getElementById("query")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    localStorage.setItem("ew-last-seen", new Date().toISOString());
  }, []);
  useEffect(() => {
    if (!selected || at || document.hidden) return;
    let active = true;
    api("/api/incidents/" + selected)
      .then((detail) => {
        if (!active) return;
        detailed.current = detail;
        setSnapshot((s) => ({
          ...s,
          incidents: s.incidents.some((i) => i.id === selected)
            ? s.incidents.map((i) => (i.id === selected ? detail : i))
            : [detail, ...s.incidents],
        }));
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, [selected, at, visible]);
  // Stable between unrelated renders, so the map re-sends a source only when its own data changes.
  const fused = useMemo(() => situations(snapshot.incidents), [snapshot.incidents]);
  const incidents = useMemo(
    () =>
      fused.filter((i) =>
        filter === "news" ? false : filter === "all" || filter === "demonstrations"
          ? filter === "all" ||
            i.activity.includes("demonstration") ||
            i.activity === "gathering"
          : filter === "disruptions"
            ? ["disruption", "strike", "connectivity_disruption"].includes(
                i.activity,
              )
            : filter === "hazards"
              ? isHazard(i.activity)
              : ["severe", "critical"].includes(i.impact),
      ),
    [fused, filter],
  );
  const geoFeatures = useMemo(
    () => (geoCatalog?.features ?? []).filter((f) => geoLayers.includes(f.layer)),
    [geoCatalog, geoLayers],
  );
  const cameras = useMemo(
    () => (showCameras ? (cameraCatalog?.cameras ?? []) : []),
    [showCameras, cameraCatalog],
  );
  const newsSignals = useMemo(
    () => (newsActive ? (news?.signals ?? []) : []),
    [newsActive, news],
  );
  const incident = fused.find(
    (i) => i.id === selected || i.members?.some((m) => m.id === selected),
  );
  const countryCode =
    countryRegistry.find(
      (c) =>
        c.name === country ||
        c.country === country ||
        c.aliases.includes(country),
    )?.country ?? country;
  const sourceFreshness = useMemo(
    () => freshness(snapshot.sources, clock),
    [snapshot.sources, clock],
  );
  const changedSince = lastSeen
    ? snapshot.incidents.filter(
        (i) => Date.parse(i.updated_at) > Date.parse(lastSeen),
      )
    : [];
  // Stable, so memoised feed rows skip renders that leave their incident unchanged.
  const select = useCallback((id: string) => {
    returnFocus.current = id;
    setFollow(false);
    setSelected(id);
    setSurface("feed");
    reading.current = true;
    setSheet("half");
    setNote(localStorage.getItem(`ew-note-${id}`) || "");
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".detail h1")?.focus(),
    );
  }, []);
  const selectSignal = (id: string) => {
    setFilter("news");
    setSelected(null);
    setSelectedSignal(id);
    setSurface("news");
  };
  const back = () => {
    setSelectedSignal(null);
    if(surface==="geospatial"&&selectedGeo){setSelectedGeo(null);return;}
    setSelectedGeo(null);
    if(surface==="media"&&selectedCamera){setSelectedCamera(null);return;}
    setSelectedCamera(null);
    setSelected(null);
    setSurface("feed");
    if(window.matchMedia("(max-width: 760px)").matches)setSheet("compact");
    reading.current = false;
    requestAnimationFrame(() => {
      const row =
        returnFocus.current &&
        document.querySelector<HTMLButtonElement>(
          `[data-incident-id="${CSS.escape(returnFocus.current)}"]`,
        );
      (row || document.getElementById("activity"))?.focus();
    });
  };
  const accept = () => {
    if (pending.current) {
      setSnapshot(pending.current);
      cursor.current = String(
        Math.max(
          Number(cursor.current) || 0,
          Number(pending.current.cursor) || 0,
        ),
      );
      pending.current = null;
    } else void load(true);
    setUpdates(0);
  };
  const saveView = () => {
    const name = prompt(tr("Name this view"));
    if (!name) return;
    const next = [
      ...savedViews,
      {
        name,
        query,
        filter,
        windowHours,
        sourceFilter,
        languageFilter,
        evidenceFilter,
        scope: scope.startsWith("watch:") ? scope : "World",
      },
    ];
    setSavedViews(next);
    localStorage.setItem("ew-views", JSON.stringify(next));
  };
  const exportData = async (format: string) => {
    try {
      if (apiQuotaBlocked) throw Error(QUOTA_MESSAGE);
      const params = new URLSearchParams({
        format,
        q: query,
        hours: windowHours,
      });
      if (sourceFilter) params.set("source", sourceFilter);
      if (languageFilter) params.set("language", languageFilter);
      if (evidenceFilter) params.set("evidence", evidenceFilter);
      if (at) params.set("at", new Date(at).toISOString());
      if (scope === "Map area" && bbox) params.set("bbox", bbox);
      if (scope.startsWith("watch:")) {
        const area = watches.find((w) => w.id === scope.slice(6));
        if (area) params.set("bbox", area.bbox);
      }
      const r = await fetch(`/api/export?${params}`, {
        credentials: "same-origin",
      });
      if (!r.ok) {
        const body = await r.text();
        if (quotaResponse(body)) throw Error(QUOTA_MESSAGE);
        throw Error(body);
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = `world-watch.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <main className={`app sheet-${sheet}${selected||surface!=="feed" ? " panel-open" : ""}${__PUBLIC_DEMO__ ? " public-demo" : ""}`}>
      <a className="skip-link" href="#activity">
        {tr("Skip to activity")}
      </a>
      {__PUBLIC_DEMO__ && (
        <PublicBanner
          language={language}
          onSources={() => {
            setSurface("health");
            setSelected(null);
          }}
        />
      )}
      <WorldMap
        incidents={incidents}
        selected={incident?.id ?? selected}
        onSelect={select}
        onBounds={setBbox}
        onCountry={(n) => {
          setCountry(n);
          setSelected(null);
          setSurface("country");
        }}
        follow={follow}
        pulse={pulse}
        geoFeatures={geoFeatures}
        onGeo={id=>{setSelected(null);setSelectedCamera(null);setSelectedGeo(id);setSurface("geospatial");}}
        cameras={cameras}
        density={density}
        selectedCamera={selectedCamera}
        onCamera={id=>{setSelected(null);setSelectedCamera(id);setSurface("media");}}
        newsSignals={newsSignals}
        selectedSignal={selectedSignal}
        onSignal={selectSignal}
      />
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label={tr("World Watch home")}>
          <span className="brand-symbol">
            <Globe2 size={21} />
          </span>
          <span>
            World<span className="brand-light"> Watch</span>
          </span>
        </a>
        <div className="search-wrap">
          <Search size={17} />
          <input
            aria-label={tr("Search events, places and sources")}
            placeholder={t.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </div>
        <div className="quick-filters">
          <button
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {tr("All activity")}
          </button>
          <button
            aria-pressed={filter === "demonstrations"}
            onClick={() => setFilter("demonstrations")}
          >
            {tr("Gatherings")}
          </button>
          <button
            aria-pressed={filter === "disruptions"}
            onClick={() => setFilter("disruptions")}
          >
            {tr("Disruption")}
          </button>
          <button
            aria-pressed={filter === "hazards"}
            onClick={() => setFilter("hazards")}
          >
            {tr("Hazards")}
          </button>
          {!__PUBLIC_DEMO__ && <button
            aria-pressed={filter === "news"}
            onClick={() => setFilter("news")}
          >
            {tr("News signals")}
          </button>}
        </div>
        <label className="time-control">
          <Clock3 size={15} />
          <select
            aria-label={tr("Time window")}
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
          >
            <option value="24">{tr("24 hours")}</option>
            <option value="168">{tr("7 days")}</option>
            <option value="720">{tr("30 days")}</option>
            <option value="0">{tr("All observed")}</option>
          </select>
        </label>
        {!__PUBLIC_DEMO__ && <button
          className="icon-button"
          aria-label={sound ? t.sound : t.mute}
          aria-pressed={sound}
          onClick={() => {
            setSound(!sound);
            if (!sound) {
              soundRef.current = true;
              cue("informational", true);
            }
          }}
        >
          {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>}
        <button
          className="icon-button"
          aria-label={tr("Contextual controls")}
          onClick={() => {
            setSurface("search");
            setSelected(null);
          }}
        >
          <SlidersHorizontal size={18} />
        </button>
      </header>
      <RollingBrief ready={ready&&!auth&&!at} analysis={!!snapshot.status.worker_last_seen} hours={windowHours} language={language} request={api} onSelect={select} onSignal={selectSignal}/>
      <aside
        id="activity"
        tabIndex={-1}
        className={`panel sheet-${sheet}`}
        aria-label={tr("Activity feed and detail panel")}
      >
        <div className="sheet-handle">
          <button
            aria-label={tr("Change panel height")}
            onClick={() =>
              setSheet(
                sheet === "compact"
                  ? "half"
                  : sheet === "half"
                    ? "full"
                    : "compact",
              )
            }
          >
            <span />
          </button>
        </div>
        {selected || surface !== "feed" ? (
          <button className="back" onClick={back}>
            <ArrowLeft size={16} />
            {t.back}
          </button>
        ) : null}
        {error && !auth && (
          <div className="error" role="status">
            {quotaPaused
              ? language === "it"
                ? "Quota giornaliera di lettura del database esaurita. Gli aggiornamenti automatici sono sospesi. Riprova dopo il ripristino della quota."
                : QUOTA_MESSAGE
              : tr(error.replace(/^Error: /, ""))}
            <button
              onClick={() => {
                if (quotaPaused) {
                  apiQuotaBlocked = false;
                  try {
                    sessionStorage.removeItem("ew-database-quota");
                  } catch {}
                  setQuotaPaused(false);
                  setConnection("Connecting");
                }
                setError("");
                void load(true);
              }}
            >
              {tr("Retry")}
            </button>
          </div>
        )}
        {!__PUBLIC_DEMO__ && auth ? (
          <section className="panel-content">
            <div className="eyebrow">{tr("Private owner access")}</div>
            <h1>World Watch</h1>
            <p>
              {tr(
                "Enter your owner access token to open the live map. It stays out of shareable URLs.",
              )}
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api("/api/session", {
                    method: "POST",
                    body: JSON.stringify({
                      token: new FormData(e.currentTarget).get("token"),
                    }),
                  });
                  setAuth(false);
                  load(true);
                } catch {
                  setError("Access token was not accepted.");
                }
              }}
            >
              <label htmlFor="token">{tr("Owner token")}</label>
              <input
                id="token"
                name="token"
                type="password"
                autoComplete="current-password"
                required
              />
              <button className="primary" type="submit">
                {tr("Open private map")}
              </button>
            </form>
          </section>
        ) : incident ? (
          <section className="panel-content detail">
            <div className="detail-meta">
              <span style={{ color: colors[incident.impact] }}>
                {symbols[incident.impact]} {tr(incident.impact)}
              </span>
              <span>{tr(incident.evidence_status)}</span>
              {incident.members && <span>{sourceCount(incident, tr)}</span>}
            </div>
            <h1 tabIndex={-1}>{incident.headline}</h1>
            {incident.analyzed_at === null && (
              <p className="notice">
                {structuredOnly(incident) ? (
                  tr(
                    "Structured source record, published without model analysis.",
                  )
                ) : (
                  <>
                    {tr("AI pending")}.{" "}
                    {tr(
                      "Issuer fields are shown unchanged; analysis is still pending.",
                    )}
                  </>
                )}
              </p>
            )}
            <p className="location">
              <MapPin size={15} />
              {incident.location?.name || tr("Location unresolved")}
              {incident.location && incident.location.accuracy !== "point"
                ? " · " + tr("approximate")
                : ""}
            </p>
            <div className="lead">
              <EvidenceText
                text={
                  language === "it" && incident.summary_it
                    ? incident.summary_it
                    : incident.summary_en
                }
                label={tr}
                format={when}
              />
            </div>
            {incident.cancelled && (
              <p className="notice">
                {tr("Cancelled or retracted. See the source update.")}
              </p>
            )}
            <dl className="times">
              <dt>{tr("Event time")}</dt>
              <dd>{when(incident.event_start)}</dd>
              <dt>{tr("Published")}</dt>
              <dd>{when(incident.published_at)}</dd>
              <dt>{tr("Analyzed")}</dt>
              <dd>{when(incident.analyzed_at)}</dd>
              <dt>{tr("Valid until")}</dt>
              <dd>{when(incident.expires_at)}</dd>
            </dl>
            <p className="caution">
              {tr(
                "Severity describes reported conditions. Informational does not mean safe; unknown does not mean low impact.",
              )}
            </p>
            <div className="impact-assessment">
              <h2>{tr("Reported impact")}</h2>
              <strong style={{ color: colors[incident.impact] }}>
                {symbols[incident.impact]}{" "}
                {tr(
                  incident.impact === "unknown"
                    ? "Impact not established"
                    : incident.impact,
                )}
              </strong>
              <p>
                {tr(
                  incident.analysis_status === "source_only" ? "Official record retained; AI extraction needs review" : incident.analyzed_at === null
                    ? structuredOnly(incident) ? "Official source fields; AI processing not enabled" : "AI pending"
                    : "Analyzed from source evidence",
                )}
              </p>
              {[...new Set(incident.claims.flatMap((c) => c.impacts || []))]
                .length > 0 && (
                <p>
                  {[...new Set(incident.claims.flatMap((c) => c.impacts || []))]
                    .map(tr)
                    .join(" · ")}
                </p>
              )}
              {[
                ...new Set(
                  incident.claims
                    .map((c) => c.impact_uncertainty)
                    .filter(Boolean),
                ),
              ].map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
            <LinkedRecords
              situation={incident}
              situations={fused}
              language={language}
              readOnly={!!at}
              onSelect={select}
              onSaved={() => load(true)}
            />
            <h2>{tr("Claims & evidence")}</h2>
            {incident.claims.map((c) => (
              <article className="claim" key={c.id}>
                <p>{c.summary}</p>
                <ClaimCitations
                  claim={c}
                  reports={incident.reports}
                  language={language}
                />
                {c.official_instruction && (
                  <blockquote>
                    <strong>{c.official_instruction.issuer}</strong>
                    <p>{c.official_instruction.instruction}</p>
                  </blockquote>
                )}
                <small>
                  {tr(temporalStatus(c, at ? Date.parse(at) : clock))} ·{" "}
                  {c.violence_mentioned === "no"
                    ? tr("Violence not mentioned")
                    : `${tr("Violence")}: ${tr(c.violence_mentioned)}`}
                </small>
                {c.time_uncertainty && (
                  <p className="uncertainty">{c.time_uncertainty}</p>
                )}
              </article>
            ))}
            <details className="context-section">
              <summary>{tr("Source-linked brief")}</summary>
              <p>
                {language === "it" && incident.summary_it
                  ? incident.summary_it
                  : incident.summary_en}
              </p>
              <p>
                <strong>{tr("Reported conditions")}: </strong>
                {tr(incident.impact)} · {tr(incident.evidence_status)}
              </p>
              <p>
                {when(incident.event_start)} ·{" "}
                {incident.location?.name ?? tr("Unlocated")}
              </p>
              <h2>{tr("Evidence links")}</h2>
              {incident.reports.map((r: any, n: number) => (
                <a
                  className="brief-link"
                  key={r.report_id ?? n}
                  href={r.canonical_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.title ?? r.source_name ?? r.source_id}
                  <ArrowUpRight size={14} />
                </a>
              ))}
              {!__PUBLIC_DEMO__ && <>
              <p className="caution">
                {tr("Export current view")}.{" "}
                {tr(
                  "Exports include only redistributable evidence and exclude private areas and notes.",
                )}
              </p>
              <div className="control-grid">
                {["json", "csv", "geojson"].map((format) => (
                  <button key={format} onClick={() => exportData(format)}>
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
              </>}
            </details>
            <h2>{tr("Source records")}</h2>
            {incident.reports.map((r: any, n: number) => (
              <article className="evidence" key={r.report_id || r.id || n}>
                <a
                  href={r.canonical_url || r.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.title || r.source_id || tr("Original report")}
                  <ArrowUpRight size={15} />
                </a>
                <small>
                  {r.source_id} · {tr(r.input_coverage ?? "unknown")} ·{" "}
                  {when(r.published_at)}
                </small>
                {r.source_metadata?.publisher_generated && <small className="caution">{tr("Publisher-generated dispatch interpretation; incident not independently confirmed")}</small>}
                {r.analysis_reused && <small>{tr("Shared analysis of identical source evidence")}</small>}
                {r.source_reports?.length > 1 && <details><summary>{r.source_reports.length} {tr("publisher updates bundled")}</summary>{r.source_reports.map((v: any) => <a className="brief-link" key={v.native_id} href={v.canonical_url} target="_blank" rel="noreferrer">{when(v.published_at)} <ArrowUpRight size={14} /></a>)}</details>}
                {r.rights?.attribution && (
                  <small className="rights">{r.rights.attribution}</small>
                )}
                {r.rights?.basis && (
                  <details>
                    <summary>{tr("Licence and permitted use")}</summary>
                    <p className="caution">{r.rights.basis}</p>
                  </details>
                )}
                {r.excerpts?.map((e: any) => (
                  <blockquote
                    key={e.id}
                    id={evidenceAnchor(r, e.id)}
                    tabIndex={-1}
                    lang={r.original_language}
                  >
                    <EvidenceText text={e.text} label={tr} format={when} />
                  </blockquote>
                ))}
              </article>
            ))}
            <details>
              <summary>
                {tr("Change history")} ({incident.history.length})
              </summary>
              {incident.history.map((r: any, n: number) => (
                <div className="history" key={n}>
                  <strong>
                    {tr("Revision")} {r.version || n + 1}
                  </strong>
                  <p>{tr(r.reason || r.kind || "Source analysis updated")}</p>
                  <small>{when(r.created_at || r.updated_at)}</small>
                </div>
              ))}
            </details>
            {!__PUBLIC_DEMO__ && <>
            <details>
              <summary>{tr("Private notes & corrections")}</summary>
              <label htmlFor="note">
                {tr("Local note (only this browser)")}
              </label>
              <textarea
                id="note"
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  localStorage.setItem(
                    `ew-note-${incident.id}`,
                    e.target.value,
                  );
                }}
              />
              {at ? (
                <p className="caution">
                  {tr(
                    "Historical replay is read-only. Return to live to make audited changes.",
                  )}
                </p>
              ) : (
                <CorrectionEditor
                  key={incident.id}
                  incident={incident}
                  incidents={snapshot.incidents}
                  language={language}
                  onSaved={() => load(true)}
                />
              )}
            </details>
            <details className="context-section">
              <summary>{tr("Incident reconstruction")}</summary>
              {at ? (
                <p className="caution">
                  {tr(
                    "Historical replay is read-only. Return to live to make audited changes.",
                  )}
                </p>
              ) : (
                <ReconstructionEditor
                  key={incident.id}
                  incident={incident}
                  incidents={snapshot.incidents}
                  language={language}
                  onSaved={() => load(true)}
                />
              )}
            </details>
            </>}
          </section>
        ) : surface === "geospatial" ? (
          <GeospatialPanel language={language} catalog={geoCatalog} selected={selectedGeo} onSelect={setSelectedGeo} error={geoError} loading={geoLoading}/>
        ) : !__PUBLIC_DEMO__ && surface === "news" ? (
          <NewsSignalPanel catalog={news} selected={selectedSignal} language={language}/>
        ) : !__PUBLIC_DEMO__ && surface === "media" ? (
          <MediaPanel catalog={cameraCatalog} selected={selectedCamera} onSelect={setSelectedCamera} language={language} error={mediaError} loading={mediaLoading}/>
        ) : surface === "health" ? (
          <section className="panel-content">
            <h1>{t.health}</h1>
            <p>
              {tr(
                __PUBLIC_DEMO__
                  ? "This public snapshot is rebuilt from the sources below about every ten minutes. No model analysis runs in it."
                  : "Connection status and source freshness are separate. A connected map can still have delayed analysis.",
              )}
            </p>
            <dl className="times">
              {__PUBLIC_DEMO__ ? (
                <ReactFragment
                  label={tr("Snapshot generated")}
                  value={when(snapshot.status.generated_at)}
                />
              ) : (
                Object.entries(snapshot.status)
                  .filter(([, v]) => typeof v !== "object")
                  .map(([k, v]) => (
                    <ReactFragment
                      key={k}
                      label={tr(k)}
                      value={tr(String(v ?? "unknown"))}
                    />
                  ))
              )}
            </dl>
            {!__PUBLIC_DEMO__ && <>
            <h2>{tr("Processing queue")}</h2>
            <QueueReports
              reports={snapshot.incoming.filter((r: any) =>
                [
                  "blocked",
                  "retrying",
                  "permanently_failed",
                  "dead_letter",
                  "failed",
                ].includes(r.state),
              )}
              language={language}
              historical={!!at}
              onRetried={() => load(true)}
            />
            </>}
            <h2>{tr("Monitored sources")}</h2>
            {snapshot.sources.map((s: any) => (
              <article className="source" key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.name || s.id}
                  <ArrowUpRight size={14} />
                </a>
                <small>
                  <CoverageChip status={sourceStatus(s, clock)} language={language} /> ·{" "}
                  {s.countries?.includes("*")
                    ? tr("worldwide")
                    : s.countries?.join(", ")}
                </small>
                <small>
                  {tr("Last success")}:{" "}
                  {when(s.last_success_at || s.health?.last_success_at)}
                </small>
                {(s.error || s.health?.error) && (
                  <p>{tr(s.error || s.health?.error)}</p>
                )}
                {s.health?.checkpoint?.admission && <small>{s.health.checkpoint.admission.admitted} {tr("eligible")} · {s.health.checkpoint.admission.excluded} {tr("routine or archived items filtered before queue")}</small>}
                <small>{s.rights?.attribution}</small>
              </article>
            ))}
            <p className="caution">
              {tr(
                "These are observed reports from monitored sources. Coverage is incomplete and varies by country.",
              )}
            </p>
            {__PUBLIC_DEMO__ && <PublicFeeds language={language} />}
          </section>
        ) : surface === "search" ? (
          <section className="panel-content">
            <h1>{tr("Explore & focus")}</h1>
            <div className="context-section"><h2>{tr("Map layers")}</h2>{[["thermal","Satellite thermal detections"],["emergency_mapping","Copernicus mapping areas"]].map(([id,label])=><label className="check-row" key={id}><input type="checkbox" checked={geoLayers.includes(id)} onChange={e=>setGeoLayers(old=>e.target.checked?[...old,id]:old.filter(v=>v!==id))}/>{tr(label)}</label>)}{geoLayers.length>0&&<button onClick={()=>{setSelected(null);setSelectedGeo(null);setSurface("geospatial");}}>{tr("Explore geospatial context")}</button>}{!__PUBLIC_DEMO__&&<><label className="check-row"><input type="checkbox" checked={showCameras} onChange={e=>setShowCameras(e.target.checked)}/>{tr("Public cameras")}</label><button onClick={()=>{setShowCameras(true);setSurface("media");setSelectedCamera(null);}}>{tr("Browse public cameras")}</button></>}<label className="check-row"><input type="checkbox" checked={density} onChange={e=>setDensity(e.target.checked)}/>{tr("Observed incident density")}</label>{density&&<p className="caution">{tr("Density represents geolocated incidents, not measured crowd size or population movement.")}</p>}</div>
            <CoverageView sources={snapshot.sources} incidents={snapshot.incidents} catalog={geoCatalog} now={clock} language={language} />

            <label htmlFor="query">{tr("Search reports and incidents")}</label>
            <input
              id="query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("Place, phrase or source")}
            />
            <label htmlFor="source-filter">{tr("Source")}</label>
            <select
              id="source-filter"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            >
              <option value="">{tr("All monitored sources")}</option>
              {snapshot.sources
                .filter((s) => ["enabled","disabled"].includes(s.status) && s.rights?.display)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <label htmlFor="language-filter">{tr("Original language")}</label>
            <select
              id="language-filter"
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
            >
              <option value="">{tr("All languages")}</option>
              {[
                ...new Set(
                  snapshot.sources.flatMap((s: any) => s.languages ?? []),
                ),
              ].map((l) => (
                <option key={l} value={l}>
                  {new Intl.DisplayNames([language], { type: "language" }).of(
                    l,
                  ) ?? l}
                </option>
              ))}
            </select>
            <label htmlFor="evidence-filter">{tr("Evidence status")}</label>
            <select
              id="evidence-filter"
              value={evidenceFilter}
              onChange={(e) => setEvidenceFilter(e.target.value)}
            >
              <option value="">{tr("All evidence states")}</option>
              {[
                "unverified",
                "corroborated",
                "official_advisory",
                "disputed",
                "corrected",
                "retracted",
              ].map((e) => (
                <option key={e} value={e}>
                  {tr(e)}
                </option>
              ))}
            </select>
            <div className="control-grid">
              <button onClick={() => setSurface("feed")}>
                <Search size={16} />
                {tr("Show results")}
              </button>
              <button onClick={saveView}>
                <Bookmark size={16} />
                {tr("Save this view")}
              </button>
              {!__PUBLIC_DEMO__ && <>
              <button onClick={() => setSurface("watches")}>
                <MapPin size={16} />
                {tr("Private areas")}
              </button>
              <button onClick={() => setSurface("replay")}>
                <History size={16} />
                {tr("Replay")}
              </button>
              </>}
              <button onClick={() => setSurface("health")}>
                <Activity size={16} />
                {tr("Source health")}
              </button>
              {!__PUBLIC_DEMO__ && <>
              <button onClick={() => exportData("geojson")}>
                <Download size={16} />
                GeoJSON
              </button>
              <button onClick={() => exportData("csv")}>
                <Download size={16} />
                CSV
              </button>
              <button onClick={() => exportData("json")}>
                <Download size={16} />
                JSON
              </button>
              </>}
            </div>
            <h2>{tr("Changes since your last visit")}</h2>
            <p>
              {lastSeen
                ? `${changedSince.length} ${tr("observed incidents changed since")} ${when(lastSeen)}.`
                : tr("This is your first visit in this browser.")}
            </p>
            {lastSeen && changedSince.length === 0 && (
              <p>{tr("No changes in this view since your last visit.")}</p>
            )}
            {changedSince.slice(0, 5).map((i) => (
              <button
                className="saved-view"
                key={i.id}
                onClick={() => select(i.id)}
              >
                {i.headline}
              </button>
            ))}
            <h2>{tr("Saved views")}</h2>
            {savedViews.map((v, n) => (
              <button
                className="saved-view"
                key={n}
                onClick={() => {
                  setQuery(v.query);
                  setFilter(v.filter);
                  setWindowHours(v.windowHours);
                  setSourceFilter(v.sourceFilter ?? "");
                  setLanguageFilter(v.languageFilter ?? "");
                  setEvidenceFilter(v.evidenceFilter ?? "");
                  setScope(v.scope ?? "World");
                  setSurface("feed");
                }}
              >
                {v.name}
                <ArrowUpRight size={15} />
              </button>
            ))}
            <h2>{tr("Preferences")}</h2>
            <label htmlFor="language">{tr("Interface language")}</label>
            <select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value as any)}
            >
              <option value="en">{tr("English")}</option>
              <option value="it">Italiano</option>
            </select>
            {!__PUBLIC_DEMO__ && <>
            <label htmlFor="volume">{tr("Sound volume (ceiling 20%)")}</label>
            <input
              id="volume"
              type="range"
              min="0"
              max=".2"
              step=".01"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
            <p className="sound-status">
              {tr(sound ? "Sound is on" : "Sound is muted")}
            </p>
            <button onClick={() => cue("significant", true)}>
              {tr("Test gentle sound")}
            </button>
            <p className="caution">
              {tr(
                "Sounds are muted initially. Quiet hours: 22:00–08:00 {zone}. Reconnects, replay and backlog reconciliation stay silent.",
              ).replace(
                "{zone}",
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              )}
            </p>
            </>}
            <button aria-pressed={follow} onClick={() => setFollow(!follow)}>
              {tr("Follow live")}: {tr(follow ? "on" : "off")}
            </button>
          </section>
        ) : !__PUBLIC_DEMO__ && surface === "watches" ? (
          <section className="panel-content">
            <h1>{tr("Private watch areas")}</h1>
            <p>
              {tr(
                "Saved in this browser. Map movement never changes these subscriptions.",
              )}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                if (!validBounds(String(d.get("bbox") ?? ""))) {
                  setError(
                    tr(
                      "Enter valid bounds within world coordinates, with south below north. A west value above east crosses the 180° meridian.",
                    ),
                  );
                  return;
                }
                const next = [
                  ...watches,
                  {
                    id: crypto.randomUUID(),
                    name: d.get("name"),
                    bbox: d.get("bbox"),
                    minimum: d.get("minimum"),
                  },
                ];
                setWatches(next);
                localStorage.setItem("ew-watches", JSON.stringify(next));
                e.currentTarget.reset();
              }}
            >
              <label htmlFor="area-name">{tr("Area name")}</label>
              <input id="area-name" name="name" required />
              <label htmlFor="area-bbox">
                {tr("Area bounds (west, south, east, north)")}
              </label>
              <input
                id="area-bbox"
                name="bbox"
                required
                defaultValue={bbox}
                pattern="-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+"
              />
              <label htmlFor="minimum">{tr("Alert interest")}</label>
              <select id="minimum" name="minimum">
                <option value="all">{tr("All reported activity")}</option>
                <option value="disruption">{tr("Disruptions")}</option>
                <option value="danger">
                  {tr("Supported reported danger")}
                </option>
              </select>
              <button className="primary">{tr("Save private area")}</button>
            </form>
            {watches.map((w) => (
              <article className="source" key={w.id}>
                <strong>{w.name}</strong>
                <p>{tr(w.minimum)}</p>
                <button
                  onClick={() => {
                    setScope("watch:" + w.id);
                    setSurface("feed");
                    setSelected(null);
                  }}
                >
                  {tr("Use this area in the feed")}
                </button>
                <button
                  onClick={() => {
                    const next = watches.filter((x) => x.id !== w.id);
                    setWatches(next);
                    localStorage.setItem("ew-watches", JSON.stringify(next));
                    if (scope === "watch:" + w.id) setScope("World");
                  }}
                >
                  {tr("Remove area")}
                </button>
              </article>
            ))}
            <p className="caution">
              {tr(
                "Areas saved in this browser only cue this page. Delivery outside the app follows the server's watch rules below.",
              )}
            </p>
            <Notifications language={language} />
          </section>
        ) : !__PUBLIC_DEMO__ && surface === "replay" ? (
          <section className="panel-content">
            <h1>{tr("Replay observed history")}</h1>
            <p>
              {tr(
                "View what the system knew at a chosen time. Later revisions are excluded. Replay never emits live alerts.",
              )}
            </p>
            <label htmlFor="replay-at">
              {tr("Historical time (local browser time)")}
            </label>
            <input
              id="replay-at"
              type="datetime-local"
              value={at}
              onChange={(e) => {
                setAt(e.target.value);
                setPulse([]);
              }}
            />
            <button
              className="primary"
              onClick={() => {
                setAt("");
                setPulse([]);
                setSurface("feed");
                void load(true);
              }}
            >
              {tr("Return to live")}
            </button>
            {at && (
              <div className="historical">
                {tr("Historical view")} · {when(at)}
              </div>
            )}
            <div className="results">
              {incidents.map((i) => (
                <button
                  className="saved-view"
                  key={i.id}
                  onClick={() => select(i.id)}
                >
                  {i.headline}
                </button>
              ))}
            </div>
          </section>
        ) : surface === "country" ? (
          <section className="panel-content">
            <h1>
              {/^[A-Z]{2}$/.test(countryCode)
                ? (new Intl.DisplayNames([language], { type: "region" }).of(
                    countryCode,
                  ) ?? country)
                : country}
            </h1>
            <p>{tr("Observed activity and source coverage")}</p>
            {fused
              .filter(
                (i) =>
                  i.location?.country === countryCode ||
                  i.location?.name.includes(country),
              )
              .map((i) => (
                <button
                  className="saved-view"
                  key={i.id}
                  onClick={() => select(i.id)}
                >
                  {i.headline}
                </button>
              ))}
            <h2>{tr("Coverage")}</h2>
            <CountryCoverage sources={snapshot.sources} country={countryCode} now={clock} language={language} />
            <p>
              {tr(
                "Source scope does not establish complete local coverage. Open the coverage view for every source's status and what silence means.",
              )}
            </p>
            <button onClick={() => setSurface("search")}>
              {tr("Inspect coverage")}
            </button>
          </section>
        ) : (
          <>
            <div className="feed-heading">
              <div>
                <h1>{incoming ? t.reports : newsActive ? tr("News signals") : tr("Live reports")}<small className="feed-peek-count">{incoming ? snapshot.incoming.length : newsActive ? news?.signals.length ?? 0 : incidents.length}</small></h1>
              </div>
              {!__PUBLIC_DEMO__ && <button
                className="icon-button"
                aria-label={tr("Switch incoming reports and incidents")}
                aria-pressed={incoming}
                onClick={() => setIncoming(!incoming)}
              >
                <Layers size={18} />
              </button>}
            </div>
            <div className="feed-context">
              <label>
                <Globe2 size={13} />
                <select
                  aria-label={tr("Feed scope")}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="World">{tr("World")}</option>
                  <option value="Map area">{tr("Map area")}</option>
                  {watches.map((w) => (
                    <option key={w.id} value={"watch:" + w.id}>
                      {w.name} ({tr("private")})
                    </option>
                  ))}
                </select>
              </label>
              <span>
                {ready ? (
                  <>
                    {incoming ? snapshot.incoming.length : newsActive ? news?.signals.length ?? 0 : incidents.length}{" "}
                    {newsActive && !incoming ? tr("news signals") : <>{tr("observed")} {tr(incoming ? "reports" : "incidents")}</>}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </div>
            {ready && !incoming && newsActive && news && (
              <NewsCoverageNote catalog={news} language={language} />
            )}
            {newsError && newsActive && !incoming && (
              <p className="error" role="status">{newsError}</p>
            )}
            {ready && !incoming && !newsActive && (
              <p className="map-coverage-note">
                <MapPin size={12} />
                {incidents.filter((i) => i.location).length} {tr("on map")}
                <span>·</span>
                {incidents.filter((i) => !i.location).length}{" "}
                {tr("location unresolved")}
              </p>
            )}
            {at && (
              <div className="historical">
                {tr("Historical")} · {when(at)}
                <button onClick={() => setAt("")}>{tr("Live")}</button>
              </div>
            )}
            {updates > 0 && (
              <button className="new-updates" onClick={accept}>
                {updates} {away.current ? t.away : t.new}
                <ChevronDown size={14} />
              </button>
            )}
            {snapshot.limited && (
              <p className="scope-notice">
                {tr(
                  "This view is limited to 1,000 incidents. Narrow the area, time or search.",
                )}
              </p>
            )}
            {incoming && snapshot.incoming.length >= 200 && (
              <p className="scope-notice">
                {tr(
                  "Showing up to 200 matching reports. Narrow the filters for more specific results.",
                )}
              </p>
            )}
            <div
              className="feed-list"
              onKeyDown={(e) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
                  return;
                const rows = Array.from(
                  e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    ".feed-item",
                  ),
                );
                const index = rows.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? rows.length - 1
                      : e.key === "ArrowDown"
                        ? Math.min(rows.length - 1, index + 1)
                        : Math.max(0, index - 1);
                if (rows[next]) {
                  e.preventDefault();
                  rows[next].focus();
                }
              }}
              onScroll={(e) => {
                reading.current = e.currentTarget.scrollTop > 10;
              }}
              onPointerEnter={() => (reading.current = true)}
              onPointerLeave={() => {
                if (!selected) reading.current = false;
              }}
            >
              {!ready && !error && (
                <div className="feed-loading" role="status">
                  <Radio size={18} />
                  <p>{tr("Loading observed activity…")}</p>
                </div>
              )}
              <ol>
                {incoming
                  ? snapshot.incoming.map((r: any) => (
                      <li key={r.report_id}>
                        <a
                          className="report"
                          href={r.canonical_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className="report-meta">
                            {r.source_id}
                            <span>{age(r.ingested_at)}</span>
                          </span>
                          <h2>{r.title}</h2>
                          <p>
                            {r.source_geo?.name || tr("Location unresolved")}
                          </p>
                          <span className="badge">
                            {tr(r.processing_status || r.state || "AI pending")}
                          </span>
                        </a>
                      </li>
                    ))
                  : newsActive
                    ? (news?.signals ?? []).map((signal) => (
                        <li key={signal.id}>
                          <NewsSignalRow signal={signal} language={language} onSelect={selectSignal} />
                        </li>
                      ))
                  : incidents.map((i) => (
                      <FeedItem
                        key={i.id}
                        incident={i}
                        language={language}
                        clock={clock}
                        onSelect={select}
                      />
                    ))}
              </ol>
              {ready && newsActive && !incoming && news?.signals.length === 0 && (
                <div className="empty">
                  <Radio size={24} />
                  <h2>{tr("No news signals in the last six hours")}</h2>
                  <p>{tr("GDELT coverage is counted as the collector reads each 15-minute file.")}</p>
                </div>
              )}
              {ready && !newsActive &&
                (incoming ? snapshot.incoming.length : incidents.length) ===
                  0 && (
                  <div className="empty">
                    <Radio size={24} />
                    <h2>{incoming ? tr("No incoming reports") : t.empty}</h2>
                    {!__PUBLIC_DEMO__ && <>
                    <p>{t.emptySub}</p>
                    <button onClick={() => setIncoming(!incoming)}>
                      {incoming
                        ? tr("Show analyzed incidents")
                        : tr("View incoming reports")}
                    </button>
                    </>}
                  </div>
                )}
            </div>
            <footer className="feed-footer">
              <span>{tr("Source-backed. Uncertainty preserved.")}</span>
              <button
                aria-label={tr("Open contextual search")}
                onClick={() => setSurface("search")}
              >
                <Command size={14} />
              </button>
            </footer>
          </>
        )}
      </aside>
      <div className="mobile-attribution">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>{" "}
        ·{" "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>{" "}
        ·{" "}
        <a
          href="https://www.naturalearthdata.com"
          target="_blank"
          rel="noreferrer"
        >
          Natural Earth
        </a>
      </div>
      <div
        className={`legend${legendOpen ? " open" : ""}`}
        role="group"
        aria-label={tr("Map legend")}
      >
        <button
          className="legend-toggle"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen(!legendOpen)}
        >
          {tr("Legend")}
          <ChevronDown size={12} />
        </button>
        <div className="legend-row">
          {Object.entries(colors).map(([k, v]) => (
            <span key={k} title={`${tr(k)} ${tr("reported impact")}`}>
              <i style={{ color: v }}>{symbols[k]}</i>
              {tr(k)}
            </span>
          ))}
        </div>
        <div className="legend-row">
          {GLYPH_ACTIVITIES.map((a) => (
            <span key={a}>
              <ActivityGlyph activity={a} />
              {tr(a)}
            </span>
          ))}
          <span>
            <i className="area-swatch" />
            {tr("approximate area")}
          </span>
          {newsActive && (
            <span>
              <span style={{ color: NEWS_COLOR, display: "inline-flex" }}>
                <NewsGlyph size={13} />
              </span>
              {tr("news coverage, not an event")}
            </span>
          )}
        </div>
      </div>
      <button
        className="health-pill"
        onClick={() => {
          setSurface("health");
          setSelected(null);
        }}
      >
        {__PUBLIC_DEMO__ ? (
          <>
            <span
              className={`connection-dot ${clock - Date.parse(snapshot.status.generated_at) < 1800000 ? "" : "offline"}`}
            />
            <span>{tr("Public snapshot")}</span>
            <span className="health-divider" />
            <span title={when(snapshot.status.generated_at)}>
              {tr("Updated")} {age(snapshot.status.generated_at)}
            </span>
          </>
        ) : (
          <>
            <span
              className={`connection-dot ${connection === "Connected" ? "" : "offline"}`}
            />
            <span>
              {quotaPaused
                ? language === "it"
                  ? "Aggiornamenti sospesi"
                  : "Updates paused"
                : tr(connection)}
            </span>
            <span className="health-divider" />
            <span title={when(snapshot.status.worker_last_seen)}>
              {tr("AI")}: {tr(snapshot.status.worker_state ?? "Awaiting status")}
            </span>
            <span className="health-divider" />
            <Activity size={13} />
            <span>
              {snapshot.status.pending_count ?? snapshot.status.pending ?? "—"}{" "}
              {tr("pending")}
            </span>
          </>
        )}
        {sourceFreshness.read > 0 && (
          <>
            <span className="health-divider" />
            <span className={`coverage-dot ${sourceFreshness.worst}`} />
            <span title={tr("Sources read successfully on schedule")}>
              {sourceFreshness.fresh}/{sourceFreshness.read} {tr("sources fresh")}
            </span>
          </>
        )}
        <ArrowUpRight size={13} />
      </button>
      <div className="sr-only" role="status" aria-live="polite">
        {updates
          ? `${updates} ${tr("updates available. Activate new updates to refresh the feed.")}`
          : ""}
      </div>
    </main>
  );
}
function ReactFragment({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

type EditorProps = {
  incident: IncidentView;
  incidents: IncidentView[];
  language: Language;
  onSaved: () => Promise<unknown>;
};
function CorrectionEditor({
  incident,
  incidents,
  language,
  onSaved,
}: EditorProps) {
  const tr = (v: string) => translate(language, v);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const expectedVersion = useRef(incident.version);
  const places = [
    ...new Map(
      incidents
        .filter((i) => i.location)
        .map((i) => [JSON.stringify(i.location), i]),
    ).values(),
  ];
  return (
    <form
      className="context-form"
      action="/api/corrections"
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        const start = String(values.get("event_start") ?? "").trim(),
          end = String(values.get("event_end") ?? "").trim();
        if ([start, end].some((v) => v && !eventTime(v))) {
          setMessage(
            tr("Use a valid date or ISO timestamp with an explicit timezone."),
          );
          return;
        }
        if (start && end && Date.parse(end) < Date.parse(start)) {
          setMessage(tr("The end must not precede the start."));
          return;
        }
        const patch: Record<string, unknown> = {};
        const headline = String(values.get("headline") ?? "").trim();
        if (headline !== incident.headline) patch.headline = headline;
        if ((start || null) !== incident.event_start)
          patch.event_start = start || null;
        if ((end || null) !== incident.event_end) patch.event_end = end || null;
        const location = String(values.get("location") ?? "keep");
        if (location === "unresolved") patch.location = null;
        else if (location !== "keep") {
          const supported = places.find((i) => i.id === location)?.location;
          if (!supported) {
            setMessage(tr("Request failed. Please retry."));
            return;
          }
          patch.location = supported;
        }
        setBusy(true);
        setMessage("");
        try {
          const saved = await api("/api/corrections", {
            method: "POST",
            body: JSON.stringify({
              incident_id: incident.id,
              expected_version: expectedVersion.current,
              reason: String(values.get("reason") ?? "").trim(),
              patch,
            }),
          });
          if (saved.version) expectedVersion.current = saved.version;
          setMessage(tr("Correction saved."));
          await onSaved();
        } catch (error) {
          setMessage(
            tr(
              String(error).includes("409:")
                ? "This event changed. Reopen the correction form before submitting again."
                : "Request failed. Please retry.",
            ),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{tr("Audited correction")}</h2>
      <label htmlFor="correction-headline">{tr("Headline")}</label>
      <input
        id="correction-headline"
        name="headline"
        defaultValue={incident.headline}
        required
        maxLength={240}
      />
      <label htmlFor="correction-start">{tr("Event start")}</label>
      <input
        id="correction-start"
        name="event_start"
        defaultValue={incident.event_start ?? ""}
        aria-describedby="correction-time-help"
        autoComplete="off"
      />
      <label htmlFor="correction-end">{tr("Event end")}</label>
      <input
        id="correction-end"
        name="event_end"
        defaultValue={incident.event_end ?? ""}
        aria-describedby="correction-time-help"
        autoComplete="off"
      />
      <small id="correction-time-help">
        {tr("Date or ISO time with offset; blank means unknown.")}
      </small>
      <label htmlFor="correction-location">{tr("Supported location")}</label>
      <select id="correction-location" name="location" defaultValue="keep">
        <option value="keep">{tr("Keep current location")}</option>
        <option value="unresolved">{tr("Set unresolved")}</option>
        {places.map((i) => (
          <option key={i.id} value={i.id}>
            {tr("Existing source-backed place")}: {i.location!.name} ·{" "}
            {tr(i.location!.accuracy)}
          </option>
        ))}
      </select>
      <label htmlFor="correction-reason">
        {tr("Audit reason and source URL")}
      </label>
      <textarea
        id="correction-reason"
        name="reason"
        required
        minLength={5}
        maxLength={1000}
      />
      <button type="submit" disabled={busy}>
        {tr(busy ? "Saving…" : "Save correction")}
      </button>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
function ReconstructionEditor({
  incident,
  incidents,
  language,
  onSaved,
}: EditorProps) {
  const tr = (v: string) => translate(language, v);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const others = incidents.filter((i) => i.id !== incident.id && !i.cancelled);
  const submit = async (route: string, payload: unknown) => {
    setBusy(true);
    setMessage("");
    try {
      await api(route, { method: "POST", body: JSON.stringify(payload) });
      await onSaved();
    } catch {
      setMessage(tr("Request failed. Please retry."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <details>
        <summary>{tr("Merge incidents")}</summary>
        {others.length ? (
          <form
            action="/api/incidents/merge"
            method="post"
            className="context-form"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void submit("/api/incidents/merge", {
                ids: [incident.id, String(d.get("other"))],
                reason: String(d.get("reason") ?? "").trim(),
              });
            }}
          >
            <label htmlFor="merge-other">{tr("Merge with")}</label>
            <select id="merge-other" name="other" required defaultValue="">
              <option value="" disabled>
                {tr("Choose another observed incident")}
              </option>
              {others.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.headline}
                </option>
              ))}
            </select>
            <label htmlFor="merge-reason">
              {tr("Audit reason and source URL")}
            </label>
            <textarea
              id="merge-reason"
              name="reason"
              required
              minLength={5}
              maxLength={1000}
            />
            <button type="submit" disabled={busy}>
              {tr(busy ? "Saving…" : "Merge with audit reason")}
            </button>
          </form>
        ) : (
          <p>{tr("No other incident is available in this view.")}</p>
        )}
      </details>
      <details>
        <summary>{tr("Split claims")}</summary>
        {incident.claims.length < 2 ? (
          <p>
            {tr(
              "This incident needs at least two claims before it can be split.",
            )}
          </p>
        ) : (
          <form
            action="/api/incidents/split"
            method="post"
            className="context-form"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget),
                ids = d.getAll("claim_ids").map(String);
              if (!ids.length || ids.length === incident.claims.length) {
                setMessage(
                  tr(
                    "Select at least one claim and leave at least one in this incident.",
                  ),
                );
                return;
              }
              void submit("/api/incidents/split", {
                id: incident.id,
                claim_ids: ids,
                reason: String(d.get("reason") ?? "").trim(),
              });
            }}
          >
            <fieldset>
              <legend>
                {tr(
                  "Choose claims to move into a separate incident. Both groups must keep at least one claim.",
                )}
              </legend>
              {incident.claims.map((c, index) => (
                <label
                  className="claim-check"
                  key={c.id}
                  htmlFor={"split-claim-" + index}
                >
                  <input
                    type="checkbox"
                    id={"split-claim-" + index}
                    name="claim_ids"
                    value={c.id}
                  />
                  <span>{c.summary}</span>
                </label>
              ))}
            </fieldset>
            <label htmlFor="split-reason">
              {tr("Audit reason and source URL")}
            </label>
            <textarea
              id="split-reason"
              name="reason"
              required
              minLength={5}
              maxLength={1000}
            />
            <button type="submit" disabled={busy}>
              {tr(busy ? "Saving…" : "Split selected claims")}
            </button>
          </form>
        )}
      </details>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </>
  );
}
/** How many records a situation fuses, and whether they corroborate each other or share one origin. */
function sourceCount(situation: Situation, tr: (v: string) => string) {
  const members = situation.members ?? [situation],
    sources = new Set(members.map((m) => m.reports[0]?.source_id)).size,
    origin = independence(situation);
  return `${members.length} ${tr(sources === members.length ? "sources" : "records")} · ${tr(
    origin === "same_origin"
      ? "one origin"
      : origin === "independent"
        ? "independent origins"
        : "origin unknown",
  )}`;
}
function LinkedRecords({
  situation,
  situations,
  language,
  readOnly,
  onSelect,
  onSaved,
}: {
  situation: Situation;
  situations: Situation[];
  language: Language;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onSaved: () => Promise<unknown>;
}) {
  const tr = (v: string) => translate(language, v);
  const members = situation.members ?? [situation],
    ids = new Set(members.map((m) => m.id));
  const source = (v: IncidentView) =>
    v.reports[0]?.source_name ?? v.reports[0]?.source_id ?? v.headline;
  const outside = [
    ...new Map(
      members.flatMap((m) =>
        (m.links ?? [])
          .filter((l) => l.type !== "same_event" && !ids.has(l.incident_id))
          .map((l) => [l.type + l.incident_id, { from: m, link: l }] as const),
      ),
    ).values(),
  ];
  if (members.length < 2 && !outside.length) return null;
  const origin = independence(situation);
  return (
    <div className="linked-records">
      {members.length > 1 && (
        <>
          <h2>{tr("One event from linked records")}</h2>
          <p>
            {tr(
              origin === "same_origin"
                ? "These records republish one upstream measurement. They are one origin, not independent corroboration."
                : origin === "independent"
                  ? "These records come from independent origins and corroborate each other."
                  : "A record states no upstream origin, so independence is unknown.",
            )}
          </p>
          {memberLinks(situation).map(({ from, link }) => {
            const to = members.find((m) => m.id === link.incident_id)!;
            return (
              <div key={from.id + to.id}>
                <p>
                  <strong>
                    {source(from)} · {source(to)}
                  </strong>{" "}
                  {link.reason}
                </p>
                {!__PUBLIC_DEMO__ && !readOnly && (
                  <LinkForm ids={[from.id, to.id]} linked={false} language={language} onSaved={onSaved} />
                )}
              </div>
            );
          })}
        </>
      )}
      {outside.map(({ from, link }) => {
        const other = situations.find(
          (s) => s.id === link.incident_id || s.members?.some((m) => m.id === link.incident_id),
        );
        return (
          <div key={link.type + link.incident_id}>
            <p>
              {tr(
                link.type === "split_from"
                  ? "Separated by an operator from"
                  : "Possibly the same event as",
              )}{" "}
              {other ? (
                <button className="saved-view" onClick={() => onSelect(link.incident_id)}>
                  {other.headline}
                </button>
              ) : (
                tr("a record outside this view")
              )}
              : {link.reason}
            </p>
            {link.type === "split_from" && !__PUBLIC_DEMO__ && !readOnly && (
              <LinkForm ids={[from.id, link.incident_id]} linked language={language} onSaved={onSaved} />
            )}
          </div>
        );
      })}
    </div>
  );
}
/** Separates two linked records, or hands a separated pair back to the same-event rule. */
function LinkForm({
  ids,
  linked,
  language,
  onSaved,
}: {
  ids: string[];
  linked: boolean;
  language: Language;
  onSaved: () => Promise<unknown>;
}) {
  const tr = (v: string) => translate(language, v);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const field = "link-reason-" + ids.join("-");
  return (
    <details>
      <summary>{tr(linked ? "Let the rule decide again" : "Separate these records")}</summary>
      <form
        className="context-form"
        action="/api/incidents/link"
        method="post"
        onSubmit={async (e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
          setBusy(true);
          setMessage("");
          try {
            await api("/api/incidents/link", {
              method: "POST",
              body: JSON.stringify({ ids, linked, reason }),
            });
            await onSaved();
          } catch {
            setMessage(tr("Request failed. Please retry."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor={field}>{tr("Audit reason and source URL")}</label>
        <textarea id={field} name="reason" required minLength={5} maxLength={1000} />
        <button type="submit" disabled={busy}>
          {tr(busy ? "Saving…" : linked ? "Restore the rule decision" : "Separate with audit reason")}
        </button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </form>
    </details>
  );
}
function RetryReport({
  report,
  language,
  historical,
  onRetried,
}: {
  report: any;
  language: Language;
  historical: boolean;
  onRetried: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const tr = (v: string) => translate(language, v);
  if (!["blocked", "retrying", "permanently_failed"].includes(report.state))
    return null;
  return (
    <div className="queue-action">
      {report.error_kind && (
        <small>
          {tr("Processing blocker")}: {tr(report.error_kind)}
        </small>
      )}
      {!historical && report.job_id && report.error_kind !== "rights" && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(
                "/api/jobs/" + encodeURIComponent(report.job_id) + "/retry",
                { method: "POST", body: "{}" },
              );
              setMessage(tr("Retry requested."));
              await onRetried();
            } catch {
              setMessage(tr("Request failed. Please retry."));
            } finally {
              setBusy(false);
            }
          }}
        >
          {tr("Retry analysis")}
        </button>
      )}
      <small role="status">{message}</small>
    </div>
  );
}
function QueueReports({
  reports,
  language,
  historical,
  onRetried,
}: {
  reports: any[];
  language: Language;
  historical: boolean;
  onRetried: () => Promise<unknown>;
}) {
  const tr = (v: string) => translate(language, v);
  return (
    <div>
      {!reports.length && <p>{tr("No incoming reports")}</p>}
      {reports.map((r) => (
        <article className="source" key={r.job_id ?? r.report_id}>
          <a href={r.canonical_url} target="_blank" rel="noreferrer">
            {r.title}
          </a>
          <small>{tr(r.state ?? "pending")}</small>
          <RetryReport
            report={r}
            language={language}
            historical={historical}
            onRetried={onRetried}
          />
        </article>
      ))}
    </div>
  );
}

function ActivityGlyph({
  activity,
  size = 13,
}: {
  activity: GlyphActivity;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={glyphs[activity]} />
    </svg>
  );
}
/**
 * One feed row. Memoised on its incident object, so an SSE patch or an unrelated render re-renders
 * only the rows whose incident changed instead of every row in the list. `clock` refreshes the age.
 */
const FeedItem = memo(function FeedItem({
  incident: i,
  language,
  clock,
  onSelect,
}: {
  incident: Situation;
  language: Language;
  clock: number;
  onSelect: (id: string) => void;
}) {
  const tr = (value: string) => translate(language, value);
  return (
    <li>
      <button
        className="feed-item"
        data-incident-id={i.id}
        onClick={() => onSelect(i.id)}
        aria-label={`${i.headline}, ${hasGlyph(i.activity) ? tr(i.activity) + ", " : ""}${tr(i.impact)}, ${tr(i.evidence_status)}${i.members ? ", " + sourceCount(i, tr) : ""}`}
      >
        <div className="incident-symbol" style={{ color: colors[i.impact] }}>
          {hasGlyph(i.activity) ? (
            <ActivityGlyph activity={i.activity} size={16} />
          ) : (
            symbols[i.impact]
          )}
        </div>
        <div className="feed-item-body">
          <span className="report-meta">
            {i.location?.name || tr("Location unresolved")}
            <time>{formatAge(i.updated_at, language, clock)}</time>
          </span>
          <h2>{i.reports.length===1&&i.reports[0].source_id==="de-demos-assemblies" ? i.reports[0].title : i.headline}</h2>
          <p>
            {formatWhen(i.event_start || i.published_at, language)}
            {!i.event_start ? " · " + tr("publication") : ""}
          </p>
          <span className="item-label">
            <span className="impact-label" style={{ color: colors[i.impact] }}>
              {tr(i.impact === "unknown" ? "Impact unknown" : i.impact)}
            </span>
            <span className="evidence-state">
              {tr(i.evidence_status)}
              {i.analyzed_at === null
                ? " · " +
                  tr(structuredOnly(i) ? "structured source" : "AI pending")
                : ""}
            </span>
            {i.members && (
              <span className="evidence-state">{sourceCount(i, tr)}</span>
            )}
          </span>
        </div>
      </button>
    </li>
  );
});
/** Structured adapters store their record as JSON; show its fields instead of raw text. */
function EvidenceText({
  text,
  label,
  format,
}: {
  text: string;
  label: (key: string) => string;
  format: (time: string) => string;
}) {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return <>{text}</>;
  }
  if (!record || typeof record !== "object" || Array.isArray(record))
    return <>{text}</>;
  const { notice, ...fields } = record as Record<string, unknown>;
  const value = (v: unknown) =>
    Array.isArray(v)
      ? v.join(", ")
      : typeof v === "boolean"
        ? label(v ? "yes" : "no")
        : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
          ? format(v)
          : String(v);
  return (
    <>
      <dl className="evidence-fields">
        {Object.entries(fields)
          .filter(
            ([, v]) =>
              v !== null && v !== "" && !(Array.isArray(v) && !v.length),
          )
          .map(([k, v]) => (
            <Fragment key={k}>
              <dt>{label(k)}</dt>
              <dd>{value(v)}</dd>
            </Fragment>
          ))}
      </dl>
      {typeof notice === "string" && <p className="caution">{notice}</p>}
    </>
  );
}
function evidenceAnchor(report: any, evidenceId: string) {
  return (
    "evidence-" +
    [
      report.report_id ?? report.id ?? "single",
      report.content_revision ?? report.revision ?? "",
      evidenceId,
    ]
      .map((v) => encodeURIComponent(String(v)))
      .join("-")
  );
}
function ClaimCitations({
  claim,
  reports,
  language,
}: {
  claim: IncidentView["claims"][number];
  reports: any[];
  language: Language;
}) {
  const scoped = claim as typeof claim & {
    report_id?: string;
    content_revision?: string;
  };
  const report = scoped.report_id
    ? reports.find(
        (r) =>
          r.report_id === scoped.report_id &&
          (!scoped.content_revision ||
            r.content_revision === scoped.content_revision),
      )
    : reports.length === 1
      ? reports[0]
      : null;
  if (!report) return null;
  const ids = [
    ...new Set([
      ...claim.evidence_ids,
      ...claim.places.flatMap((p) => p.evidence_ids),
      ...(claim.official_instruction?.evidence_ids ?? []),
    ]),
  ].filter((id) => report.excerpts?.some((e: any) => e.id === id));
  if (!ids.length) return null;
  return (
    <div aria-label={translate(language, "Evidence links")}>
      {ids.map((id) => (
        <a
          key={id}
          href={"#" + evidenceAnchor(report, id)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            marginRight: 12,
            fontSize: 12,
          }}
        >
          {translate(language, "Evidence links")} · {id}
        </a>
      ))}
    </div>
  );
}
