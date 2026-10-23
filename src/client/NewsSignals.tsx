import { useEffect, useRef } from "react";
import type {
  NewsCategory,
  NewsSignal,
  NewsSignalCatalog,
} from "../shared/news";
import { translate, type Language } from "./locale";

/** A broadcast mark on the 24-unit glyph grid, shared by the map canvas and the feed. */
export const NEWS_GLYPH =
  "M13.2 12a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 1 1 2.4 0M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8";
/** Outside the impact palette, so coverage never reads as an impact level. */
export const NEWS_COLOR = "#B7A4E6";
export const NEWS_LABELS: Record<NewsCategory, string> = {
  protest: "Protests",
  strike: "Strikes",
  armed_conflict: "Armed conflict",
  attack: "Attacks and explosions",
  coup: "Coup plotting",
  displacement: "Displacement",
  evacuation: "Evacuations",
  emergency_measures: "Curfews and emergency measures",
  disaster: "Disasters",
};

export function NewsGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={NEWS_GLYPH} />
    </svg>
  );
}

function wording(language: Language) {
  const tr = (text: string) => translate(language, text);
  const number = (value: number, digits = 0) =>
    value.toLocaleString(language === "it" ? "it-IT" : "en-GB", {
      maximumFractionDigits: digits,
    });
  const fill = (text: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (out, [key, value]) => out.replace(`{${key}}`, value),
      tr(text),
    );
  const change = (s: NewsSignal) =>
    s.ratio === null
      ? tr("No baseline yet")
      : fill("{ratio}× its usual coverage", { ratio: number(s.ratio, 1) });
  const counts = (s: NewsSignal) =>
    fill(
      s.truncated
        ? "{articles} articles from at least {sources} sources"
        : "{articles} articles from {sources} sources",
      { articles: number(s.articles_count), sources: number(s.sources_count) },
    );
  return { tr, number, fill, change, counts };
}

export function NewsSignalRow({
  signal,
  language,
  onSelect,
}: {
  signal: NewsSignal;
  language: Language;
  onSelect: (id: string) => void;
}) {
  const { tr, number, fill, change, counts } = wording(language);
  return (
    <button
      className="feed-item"
      data-signal-id={signal.id}
      onClick={() => onSelect(signal.id)}
      aria-label={`${signal.place.name}, ${tr("News signal")}, ${tr(NEWS_LABELS[signal.category])}, ${change(signal)}`}
    >
      <div className="incident-symbol" style={{ color: NEWS_COLOR }}>
        <NewsGlyph />
      </div>
      <div className="feed-item-body">
        <span className="report-meta">
          {tr(NEWS_LABELS[signal.category])}
          <span>{tr("Last 6 hours")}</span>
        </span>
        <h2>{signal.place.name}</h2>
        <p>
          {fill("{stories} distinct headlines", {
            stories: number(signal.stories_count),
          })}{" "}
          · {counts(signal)}
        </p>
        <span className="item-label">
          <span className="impact-label" style={{ color: NEWS_COLOR }}>
            {tr(signal.rising ? "Rising news signal" : "News signal")}
          </span>
          <span className="evidence-state">{change(signal)}</span>
        </span>
      </div>
    </button>
  );
}

export function NewsCoverageNote({
  catalog,
  language,
}: {
  catalog: NewsSignalCatalog;
  language: Language;
}) {
  const { tr, number, fill } = wording(language);
  return (
    <p className="scope-notice">
      {tr(
        "News signals count GDELT's machine-geocoded news mentions by place. They show where coverage is unusual, not verified events.",
      )}{" "}
      {catalog.signals.some((s) => s.baseline)
        ? fill("Baseline from {files} earlier GDELT files.", {
            files: number(catalog.coverage.baseline_files),
          })
        : tr(
            "Baseline building: changes are stated once each GDELT stream has 12 hours of files.",
          )}
    </p>
  );
}

export function NewsSignalPanel({
  catalog,
  selected,
  language,
}: {
  catalog: NewsSignalCatalog | null;
  selected: string | null;
  language: Language;
}) {
  const { tr, number, fill, change, counts } = wording(language);
  const heading = useRef<HTMLHeadingElement>(null);
  const signal = catalog?.signals.find((s) => s.id === selected);
  useEffect(() => {
    if (signal) heading.current?.focus();
  }, [signal?.id]);
  const time = (value: string) =>
    new Date(value).toLocaleString(language === "it" ? "it-IT" : "en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC";
  if (!signal)
    return (
      <section className="panel-content news-panel">
        <h1 ref={heading} tabIndex={-1}>
          {tr("News signal")}
        </h1>
        <p role="status">
          {tr(
            "This news signal is no longer in the six-hour window or is unavailable.",
          )}
        </p>
      </section>
    );
  return (
    <section className="panel-content news-panel">
      <p className="eyebrow">
        {tr(signal.rising ? "Rising news signal" : "News signal")} ·{" "}
        {tr(NEWS_LABELS[signal.category])}
      </p>
      <h1 ref={heading} tabIndex={-1}>
        {signal.place.name}
      </h1>
      <p className="caution">
        {tr(
          "Machine-geocoded mentions in news coverage from GDELT, not a verified event. GDELT's place, theme and translation tagging is automatic and is often wrong, and syndicated copies of one story count once per outlet.",
        )}
      </p>
      <dl className="times">
        <dt>{tr("Window")}</dt>
        <dd>
          {time(signal.window_start)} – {time(signal.window_end)}
        </dd>
        <dt>{tr("Coverage")}</dt>
        <dd>
          {counts(signal)} ·{" "}
          {fill("{stories} distinct headlines", {
            stories: number(signal.stories_count),
          })}
        </dd>
        <dt>{tr("Change")}</dt>
        <dd>
          {change(signal)}
          {signal.baseline &&
            " · " +
              fill(
                "about {expected} headlines expected from {files} earlier GDELT files",
                {
                  expected: number(signal.baseline.expected, 1),
                  files: number(signal.baseline.files),
                },
              )}
        </dd>
        <dt>{tr("Themes")}</dt>
        <dd>
          {Object.entries(signal.categories)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([c, n]) =>
                `${tr(NEWS_LABELS[c as NewsCategory])} (${number(n)})`,
            )
            .join(", ")}
        </dd>
        {signal.tone !== null && (
          <>
            <dt>{tr("Average tone")}</dt>
            <dd>
              {number(signal.tone, 1)} ·{" "}
              {tr("GDELT document tone, negative to positive")}
            </dd>
          </>
        )}
        <dt>{tr("Place")}</dt>
        <dd>
          {number(signal.place.lat, 2)}, {number(signal.place.lon, 2)} ·{" "}
          {tr(
            "City-level point from GDELT's geocoder, not the location of an event",
          )}
        </dd>
      </dl>
      <h2>{tr("Top sources")}</h2>
      <p>
        {signal.top_sources
          .map((s) => `${s.domain} (${number(s.articles)})`)
          .join(", ")}
      </p>
      <h2>{tr("Articles")}</h2>
      <div className="camera-list">
        {signal.articles.map((a) => (
          <a
            className="camera-row"
            key={a.url}
            href={a.url}
            target="_blank"
            rel="noreferrer"
          >
            <span>{a.title ?? a.domain}</span>
            <small>
              {a.domain} · {a.language} · {time(a.seen_at)}
            </small>
          </a>
        ))}
      </div>
      <p>
        {tr(
          "Not queued for analysis. World Watch keeps only links, headlines and GDELT metadata, and publisher rights for model use of these articles are not established.",
        )}
      </p>
      <p className="rights">
        {catalog!.attribution} ·{" "}
        <a href={catalog!.license_url} target="_blank" rel="noreferrer">
          {tr("Data reuse terms")}
        </a>
      </p>
    </section>
  );
}
