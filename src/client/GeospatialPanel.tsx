import { useEffect, useRef, useState } from "react";
import type { GeospatialCatalog } from "../shared/geospatial";
import { translate, type Language } from "./locale";

export default function GeospatialPanel({
  catalog,
  selected,
  onSelect,
  error,
  loading,
  language = "en",
}: {
  catalog: GeospatialCatalog | null;
  selected: string | null;
  onSelect: (id: string) => void;
  error: string;
  loading: boolean;
  language?: Language;
}) {
  const [query, setQuery] = useState("");
  const tr = (text: string) => translate(language, text);
  const number = (value: number) =>
    value.toLocaleString(language === "it" ? "it-IT" : "en-GB");
  const fill = (text: string, values: Record<string, number>) =>
    Object.entries(values).reduce(
      (out, [key, value]) => out.replace(`{${key}}`, number(value)),
      tr(text),
    );
  const heading = useRef<HTMLHeadingElement>(null);
  const feature = catalog?.features.find((f) => f.id === selected);
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected, feature?.id]);
  const matches = (catalog?.features ?? []).filter((f) =>
    `${f.layer === "thermal" ? tr(f.name) : f.name} ${f.properties.sensor ?? ""} ${f.properties.activation_code ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const timestamp = (value: string | null) =>
    value ? (
      <time dateTime={value}>
        {new Date(value).toLocaleString(language === "it" ? "it-IT" : "en-GB", {
          timeZone: "UTC",
        })}{" "}
        UTC
      </time>
    ) : (
      tr("Not supplied by publisher")
    );
  if (feature)
    return (
      <section className="panel-content geospatial-panel">
        <p className="eyebrow">
          {feature.layer === "thermal"
            ? tr("Satellite thermal detection")
            : tr("Emergency mapping coverage")}
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {feature.layer === "thermal" ? tr(feature.name) : feature.name}
        </h1>
        <p className="caution">
          {feature.properties.uncertainty && tr(feature.properties.uncertainty)}
        </p>
        <dl className="times">
          <dt>
            {feature.layer === "thermal"
              ? tr("Instrument acquisition")
              : tr("Reported event start")}
          </dt>
          <dd>{timestamp(feature.observed_at)}</dd>
          {feature.properties.sensor && (
            <>
              <dt>{tr("Sensor")}</dt>
              <dd>{feature.properties.sensor}</dd>
            </>
          )}
          {feature.properties.confidence && (
            <>
              <dt>{tr("Detection confidence")}</dt>
              <dd>
                {tr(feature.properties.confidence)} —{" "}
                {tr("Instrument classification, not incident severity")}
              </dd>
            </>
          )}
          {feature.properties.activation_code && (
            <>
              <dt>{tr("Mapping activation")}</dt>
              <dd>{feature.properties.activation_code}</dd>
            </>
          )}
          {feature.properties.hazard && (
            <>
              <dt>{tr("Source hazard category")}</dt>
              <dd>{feature.properties.hazard}</dd>
            </>
          )}
          <dt>{tr("Geometry")}</dt>
          <dd>
            {feature.geometry.type === "Point"
              ? tr(
                  "Source detection pixel location; 375 m nominal sensor resolution",
                )
              : tr("Source-published mapping area boundary")}
          </dd>
        </dl>
        <p>
          {tr(
            "Contextual geospatial data are separate from analyzed incident reports. They do not establish cause, crowd presence, casualties or displacement.",
          )}
        </p>
        <a
          className="brief-link"
          href={feature.source_url}
          target="_blank"
          rel="noreferrer"
        >
          {tr("Open publisher source")} ↗
        </a>
        <p className="rights">
          {feature.attribution} ·{" "}
          <a href={feature.license_url} target="_blank" rel="noreferrer">
            {tr("Data reuse terms")}
          </a>
        </p>
      </section>
    );
  return (
    <section className="panel-content geospatial-panel">
      <h1 ref={heading} tabIndex={-1}>
        {tr("Satellite & emergency mapping")}
      </h1>
      <p>
        {tr(
          "Thermal detections and mapping areas add sourced context to the same world map.",
        )}
      </p>
      <p className="caution">
        {tr(
          "Thermal dots are satellite measurements, not confirmed fires or crowd heat. Dashed polygons show mapping coverage, not flood extent or evacuation zones.",
        )}
      </p>
      {loading && (
        <p role="status">{tr("Loading public geospatial sources…")}</p>
      )}
      {error && (
        <p className="error" role="status">
          {tr(error)}
        </p>
      )}
      {selected && !feature && !loading && (
        <p role="status">
          {tr(
            "This feature is outside the current source window or unavailable.",
          )}
        </p>
      )}
      {catalog && (
        <>
          <p>
            {number(
              catalog.features.filter((f) => f.layer === "thermal").length,
            )}{" "}
            {tr("thermal detections")} ·{" "}
            {number(
              catalog.features.filter((f) => f.layer === "emergency_mapping")
                .length,
            )}{" "}
            {tr("mapping areas")}
          </p>
          <label htmlFor="geospatial-search">
            {tr("Find mapping area or sensor")}
          </label>
          <input
            id="geospatial-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("Place, activation code or sensor")}
          />
          <div className="camera-list">
            {matches.slice(0, 30).map((f) => (
              <button
                className="camera-row"
                key={f.id}
                onClick={() => onSelect(f.id)}
              >
                <span>{f.layer === "thermal" ? tr(f.name) : f.name}</span>
                <small>
                  {f.layer === "thermal"
                    ? tr("Thermal detection")
                    : tr("Mapping area")}{" "}
                  · {timestamp(f.observed_at)}
                </small>
              </button>
            ))}
          </div>
          {matches.length > 30 && (
            <p>
              {tr(
                "Showing the first 30 results. Select a map marker or narrow the search.",
              )}
            </p>
          )}
          <h2>{tr("Source availability")}</h2>
          {catalog.sources.map((s) => (
            <article className="source" key={s.id}>
              <strong>
                {s.id === "firms"
                  ? "NASA FIRMS"
                  : "Copernicus Emergency Management Service"}
              </strong>
              <small>
                {s.status === "ok"
                  ? `${number(s.features_count)} ${tr("contextual features")}`
                  : tr("Source unavailable")}
              </small>
              {s.truncated && (
                <p className="caution">
                  {s.id === "firms"
                    ? fill(
                        __PUBLIC_DEMO__
                          ? "Showing {shown} of {total} worldwide, spread across the map. The public demo doesn't add detections when you zoom in."
                          : "Showing {shown} of {total} in this view. Zoom in for complete coverage.",
                        { shown: s.features_count, total: s.total_available },
                      )
                    : fill(
                        "Showing {shown} of at least {total} in this view. Some publisher records were not acquired in this refresh.",
                        { shown: s.features_count, total: s.total_available },
                      )}
                </p>
              )}
              {s.sensors?.map((sensor) => (
                <small key={sensor.id}>
                  {sensor.label} ·{" "}
                  {sensor.status === "ok"
                    ? fill(__PUBLIC_DEMO__ ? "{shown} of {total} detections worldwide" : "{shown} of {total} detections in this view", {
                        shown: sensor.features_count,
                        total: sensor.total_available,
                      })
                    : tr("Sensor unavailable")}
                  {sensor.error && ` · ${tr(sensor.error)}`}
                </small>
              ))}
              {s.error && (
                <p role="status" className="error">
                  {tr(s.error)}
                </p>
              )}
              <small>
                {tr("Checked")} {timestamp(s.checked_at)} ·{" "}
                {tr("Catalog cached for")} {number(s.cadence_seconds / 60)}{" "}
                {tr("minutes")}
              </small>
              <p className="rights">
                {s.attribution} ·{" "}
                <a href={s.license_url} target="_blank" rel="noreferrer">
                  {tr("Data reuse terms")}
                </a>
              </p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
