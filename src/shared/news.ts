/**
 * News coverage signals: machine-geocoded mentions in news coverage, counted by
 * place and time. They are a discovery layer, not verified events, incidents or
 * claims, and they never enter the analysis queue.
 */
export const NEWS_CATEGORIES = [
  "protest",
  "strike",
  "armed_conflict",
  "attack",
  "coup",
  "displacement",
  "evacuation",
  "emergency_measures",
  "disaster",
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];
export const isNewsCategory = (value: unknown): value is NewsCategory =>
  (NEWS_CATEGORIES as readonly unknown[]).includes(value);

/** One article as GDELT describes it. Only the link, headline and GDELT-derived metadata; never article text. */
export type NewsArticle = {
  url: string;
  title: string | null;
  domain: string;
  /** ISO 639-3 code GDELT reports for the original text, "eng" for its English stream. */
  language: string;
  /** GDELT V1.5 document tone, negative to positive. */
  tone: number | null;
  seen_at: string;
  categories: NewsCategory[];
  /** The GDELT GKG themes that placed the article in its categories. */
  themes: string[];
};
export type NewsPlace = {
  /** GDELT GeoNames-derived feature ID. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string | null;
};
/** One collector upload: the matched articles of one GDELT 15-minute file, grouped by place. */
export type NewsBatch = {
  source_id: string;
  file_at: string;
  places: (NewsPlace & { articles: NewsArticle[] })[];
};
export type NewsSignal = {
  id: string;
  place: NewsPlace;
  category: NewsCategory;
  categories: Partial<Record<NewsCategory, number>>;
  window_start: string;
  window_end: string;
  /** Retained articles in the window and their distinct domains. */
  articles_count: number;
  sources_count: number;
  /** Distinct headlines in the window, every stream counted; the measure that ranks. */
  stories_count: number;
  /** The place hit the retained-article cap, so article and source counts are lower bounds. */
  truncated: boolean;
  /**
   * Headlines the window would hold at the place's usual rate, from each stream's
   * headlines per GDELT file over the earlier files; null until every stream in the window
   * has 12 hours of earlier files.
   */
  baseline: { expected: number; files: number } | null;
  /** Window headlines against the baseline expectation, add-one smoothed; null without a baseline. */
  ratio: number | null;
  rising: boolean;
  score: number;
  tone: number | null;
  top_sources: { domain: string; articles: number }[];
  articles: NewsArticle[];
};
export type NewsSignalCatalog = {
  signals: NewsSignal[];
  coverage: {
    window_hours: number;
    window_files: number;
    baseline_files: number;
    first_file_at: string | null;
    last_file_at: string | null;
  };
  attribution: string;
  license_url: string;
};
