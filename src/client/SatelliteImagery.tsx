import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { IncidentView } from "../shared/contracts";
import {
  GIBS_CREDIT,
  GIBS_LAYERS,
  GIBS_TERMS,
  SCENE_COLLECTIONS,
  SENTINEL_TERMS,
  addDays,
  browserUrl,
  defaultDay,
  gibsDomainUrl,
  hasDay,
  parseDomain,
  parseScenes,
  reducedData,
  sceneSearchUrl,
  sceneWindow,
  utcDay,
  type GibsLayerId,
  type Scene,
} from "./imagery";
import { translate, type Language } from "./locale";

export type ImageryView = { layer: GibsLayerId; day: string | null };
const request = (url: string) =>
  fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15000),
  }).then((r) => {
    if (!r.ok) throw Error(String(r.status));
    return r;
  });
const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, String(value)),
    text,
  );
const utc = (value: string, language: Language) =>
  new Date(value).toLocaleString(language === "it" ? "it-IT" : "en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " UTC";

/** The map's NASA daily imagery: a layer, a day defaulting to the newest finished one, and what the picture is. */
export function ImageryControl({
  value,
  onChange,
  language,
}: {
  value: ImageryView | null;
  onChange: (value: ImageryView | null) => void;
  language: Language;
}) {
  const tr = (text: string) => translate(language, text);
  const [domain, setDomain] = useState<{
    layer: GibsLayerId;
    from: string;
    days: [string, string][];
  } | null>(null);
  const [error, setError] = useState("");
  const layer = value && GIBS_LAYERS[value.layer],
    today = utcDay(Date.now()),
    known = domain && value && domain.layer === value.layer ? domain : null;
  useEffect(() => {
    if (!value || (known && (!value.day || known.from <= value.day))) return;
    // A month of days covers the default; an older choice is checked from that day on.
    const from =
      value.day && value.day < addDays(today, -30)
        ? value.day
        : addDays(today, -30);
    let live = true;
    request(gibsDomainUrl(value.layer, from))
      .then((r) => r.text())
      .then((xml) => {
        if (!live) return;
        const days = parseDomain(xml);
        setDomain({ layer: value.layer, from, days });
        setError("");
        const day = value.day ?? defaultDay(days, today);
        if (day !== value.day) onChange({ layer: value.layer, day });
      })
      .catch(
        () =>
          live &&
          setError(
            "NASA's list of imagery days is unavailable. Pick a day to load it anyway.",
          ),
      );
    return () => {
      live = false;
    };
  }, [value?.layer, value?.day]);
  return (
    <div className="imagery-control">
      <label htmlFor="imagery-layer">{tr("Satellite imagery")}</label>
      <select
        id="imagery-layer"
        value={value?.layer ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? {
                  layer: e.target.value as GibsLayerId,
                  day: value?.day ?? null,
                }
              : null,
          )
        }
      >
        <option value="">{tr("Off")}</option>
        {(Object.keys(GIBS_LAYERS) as GibsLayerId[]).map((id) => (
          <option key={id} value={id}>
            {tr(GIBS_LAYERS[id].label)}
          </option>
        ))}
      </select>
      {value && layer && (
        <>
          <label htmlFor="imagery-day">{tr("Day (UTC)")}</label>
          <input
            id="imagery-day"
            type="date"
            min={layer.first}
            max={known?.days.at(-1)?.[1] ?? today}
            value={value.day ?? ""}
            onChange={(e) =>
              e.target.value &&
              onChange({ layer: value.layer, day: e.target.value })
            }
          />
          {error && (
            <p className="error" role="status">
              {tr(error)}
            </p>
          )}
          {value.day && known && !hasDay(known.days, value.day) && (
            <p className="caution" role="status">
              {tr("NASA lists no imagery for this day.")}
            </p>
          )}
          {value.day && (
            <dl className="times">
              <dt>{tr("Acquired")}</dt>
              <dd>
                {tr("Daily mosaic of passes on")}{" "}
                <time dateTime={value.day}>{value.day}</time>
                {value.day >= today &&
                  ` · ${tr("still filling in pass by pass")}`}
              </dd>
              <dt>{tr("Sensor")}</dt>
              <dd>
                {tr(layer.sensor)} · {tr(layer.pass)}
              </dd>
              <dt>{tr("Resolution")}</dt>
              <dd>{tr(layer.resolution)}</dd>
              <dt>{tr("Cloud cover")}</dt>
              <dd>
                {tr(
                  value.layer === "night-lights"
                    ? "Not measured. Cloud hides lights and moonlight brightens cloud and snow."
                    : "Not measured for a daily mosaic. Clouds appear as imaged.",
                )}
              </dd>
            </dl>
          )}
          {reducedData() && (
            <p className="caution">
              {tr("Data saver is on, so tiles load at half detail.")}
            </p>
          )}
          <p className="rights">
            {GIBS_CREDIT} ·{" "}
            <a href={GIBS_TERMS} target="_blank" rel="noreferrer">
              {tr("Data reuse terms")}
            </a>
          </p>
        </>
      )}
    </div>
  );
}

type Found = { scenes: Scene[]; failed: Scene["collection"][] };
const LABEL: Record<Scene["collection"], string> = {
  "sentinel-2-l2a": "Sentinel-2 L2A optical",
  "sentinel-1-grd": "Sentinel-1 GRD radar",
};
/**
 * Sentinel scenes over an incident from the public Copernicus catalogue, on demand.
 * Only catalogue fields are shown; each scene opens in the Copernicus Browser.
 */
export function RecentImagery({
  incident,
  language,
  onShowDay,
}: {
  incident: IncidentView;
  language: Language;
  onShowDay: (day: string) => void;
}) {
  const tr = (text: string) => translate(language, text);
  const [found, setFound] = useState<Found | null>(null),
    [loading, setLoading] = useState(false);
  const place = incident.location,
    event =
      incident.event_start ?? incident.published_at ?? incident.ingested_at,
    eventMs = Date.parse(event);
  if (!place || !Number.isFinite(eventMs)) return null;
  const span = sceneWindow(eventMs, Date.now());
  const search = () => {
    setLoading(true);
    Promise.allSettled(
      SCENE_COLLECTIONS.map((c) =>
        request(sceneSearchUrl(c, place, span))
          .then((r) => r.json())
          .then((json) => parseScenes(json, c)),
      ),
    ).then((results) => {
      setFound({
        scenes: results
          .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
          .sort((a, b) => b.acquired.localeCompare(a.acquired)),
        failed: SCENE_COLLECTIONS.filter(
          (_, i) => results[i].status === "rejected",
        ),
      });
      setLoading(false);
    });
  };
  const relative = (acquired: string) => {
    const hours = Math.round((Date.parse(acquired) - eventMs) / 3600000),
      near = Math.abs(hours) < 48,
      text = `{n} ${near ? "h" : "days"} ${hours < 0 ? "before" : "after"} the event`;
    return fill(tr(text), {
      n: near ? Math.abs(hours) : Math.round(Math.abs(hours) / 24),
    });
  };
  return (
    <section className="context-section recent-imagery">
      <h2>{tr("Satellite imagery")}</h2>
      <div className="control-grid">
        <button onClick={search} disabled={loading} aria-busy={loading}>
          {tr(
            found
              ? "Search the catalogue again"
              : "Find recent Sentinel scenes",
          )}
        </button>
        <button onClick={() => onShowDay(utcDay(eventMs))}>
          {tr("Show the event day on the map")}
        </button>
      </div>
      <p>
        {fill(
          tr(
            "Sentinel-2 and Sentinel-1 scenes covering the mapped point from {from} to {to}, listed by the Copernicus Data Space Ecosystem catalogue.",
          ),
          { from: utc(span[0], language), to: utc(span[1], language) },
        )}
      </p>
      {place.accuracy !== "point" && (
        <p className="caution">
          {tr(
            "The mapped point is approximate, so a scene may miss part of the affected area.",
          )}
        </p>
      )}
      {loading && (
        <p role="status">{tr("Searching the Copernicus catalogue…")}</p>
      )}
      {found?.failed.map((c) => (
        <p className="error" role="status" key={c}>
          {fill(tr("{collection} search unavailable"), {
            collection: tr(LABEL[c]),
          })}
        </p>
      ))}
      {found && !loading && !found.scenes.length && !found.failed.length && (
        <p role="status">{tr("No scenes in this window.")}</p>
      )}
      {found && found.scenes.length > 0 && (
        <ul className="scene-list">
          {found.scenes.map((s) => (
            <li key={s.id}>
              <strong>
                {s.platform.replace(
                  /^sentinel-(\d)(\w)$/,
                  (_, n, x) => `Sentinel-${n}${x.toUpperCase()}`,
                )}{" "}
                · {tr(LABEL[s.collection])}
              </strong>
              <small>
                {utc(s.acquired, language)} · {relative(s.acquired)}
              </small>
              <small>
                {s.collection === "sentinel-2-l2a"
                  ? s.cloud_cover === null
                    ? tr("Cloud cover not reported")
                    : fill(
                        tr(
                          "Cloud over {n}% of its 110 km tile, not measured at this point",
                        ),
                        {
                          n: Math.round(s.cloud_cover),
                        },
                      )
                  : [
                      `${s.mode} ${s.polarisations.join("+")}`,
                      s.orbit && tr(s.orbit),
                      tr("radar sees through cloud"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </small>
              {s.published && (
                <small>
                  {tr("Catalogued")} {utc(s.published, language)}
                </small>
              )}
              <a
                className="brief-link"
                href={browserUrl(s, place)}
                target="_blank"
                rel="noreferrer"
              >
                {tr("Open this day in the Copernicus Browser")}
                <ArrowUpRight size={14} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {found && found.scenes.length > 0 && (
        <p className="rights">
          {fill(
            tr(
              "Catalogue fields from the Copernicus Data Space Ecosystem, Copernicus Sentinel data {year}. Previews stay in the Copernicus Browser.",
            ),
            {
              year: [
                ...new Set(found.scenes.map((s) => s.acquired.slice(0, 4))),
              ].join(", "),
            },
          )}{" "}
          ·{" "}
          <a href={SENTINEL_TERMS} target="_blank" rel="noreferrer">
            {tr("Data reuse terms")}
          </a>
        </p>
      )}
    </section>
  );
}
