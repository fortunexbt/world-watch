import {
  IDMC_UKRAINE_URL,
  IDMC_UKRAINE_PAGE,
  IDMC_LICENSE,
} from "./adapters/idmc.js";
import { DEMOS_QUERY_URL, DEMOS_LICENSE_URL } from "./adapters/demos.js";
import type { SourceRecord } from "../shared/contracts.js";
import { CATALUNYA_BOMBERS_QUERY } from "./adapters/catalunya-bombers.js";
import { ZWAAILICHT_URL } from "./adapters/zwaailicht.js";
const VERIFIED = "2026-10-21T09:05:00Z";
const rights = (
  basis: string,
  attribution: string,
  ai = true,
): SourceRecord["rights"] => ({
  access: true,
  storage: true,
  ai,
  display: true,
  redistribute: true,
  basis,
  attribution,
  retention_days: 30,
});
const base = {
  poll_seconds: 300,
  verified_at: VERIFIED,
  status: "enabled" as const,
};
const dpc = [
  "notizia",
  "comunicato_stampa",
  "bollettino_criticita",
  "bollettino_vigilanza",
].map((category): SourceRecord => ({
  ...base,
  id: "it-dpc-" + category,
  status: category.startsWith("bollettino") ? "enabled" : "disabled",
  name: "Protezione Civile — " + category,
  owner: "Dipartimento della Protezione Civile",
  url:
    "https://api.protezionecivile.it/default/dpcPortalGenerateRss?categoria=" +
    category,
  docs: "https://www.protezionecivile.gov.it/it/rss/",
  countries: ["IT"],
  languages: ["it", "en"],
  categories: ["official_advisory", "weather", "civil_protection"],
  family: "rss",
  rights: rights(
    "CC BY 4.0; https://www.protezionecivile.gov.it/it/approfondimento/note-legali-0/ (exclude integral Provvedimenti and separately licensed content)",
    "Fonte: Dipartimento della Protezione Civile-Presidenza del Consiglio dei Ministri",
  ),
  config: {
    format: "rss",
    queue_priority: 0,
    context_only: category.startsWith("bollettino"),
    operational_role: category.startsWith("bollettino")
      ? "official_alert_context"
      : "disabled_institutional_news_not_osint",
  },
}));
const bbk = ["mowas", "katwarn", "biwapp"].map((provider): SourceRecord => ({
  ...base,
  id: "de-bbk-" + provider,
  name: "NINA — " + provider,
  owner: "BBK / originating warning authority",
  url: `https://warnung.bund.de/api31/${provider}/mapData.json`,
  docs: "https://warnung.bund.de/api/appdata/gsb/html/DE/app/impressum.html",
  countries: ["DE"],
  languages: ["de"],
  categories: ["official_advisory", "civil_protection"],
  family: "bbk",
  rights: rights(
    "Official warnings: unchanged sharing with attribution; AI adaptation NOT established. Non-warning app content excluded. https://warnung.bund.de/api/appdata/gsb/html/DE/app/impressum.html",
    "Source: BBK / original issuing authority; official warning reproduced unchanged",
    false,
  ),
  config: { format: "bbk", max_requests: 24 },
}));
export const METEO_COUNTRIES: Record<string, [string, string]> = {
  andorra: ["AD", "ca"],
  austria: ["AT", "de"],
  belgium: ["BE", "nl"],
  "bosnia-herzegovina": ["BA", "bs"],
  bulgaria: ["BG", "bg"],
  croatia: ["HR", "hr"],
  cyprus: ["CY", "el"],
  czechia: ["CZ", "cs"],
  denmark: ["DK", "da"],
  estonia: ["EE", "et"],
  finland: ["FI", "fi"],
  france: ["FR", "fr"],
  germany: ["DE", "de"],
  greece: ["GR", "el"],
  hungary: ["HU", "hu"],
  iceland: ["IS", "is"],
  ireland: ["IE", "en"],
  italy: ["IT", "it"],
  latvia: ["LV", "lv"],
  lithuania: ["LT", "lt"],
  luxembourg: ["LU", "fr"],
  malta: ["MT", "mt"],
  moldova: ["MD", "ro"],
  montenegro: ["ME", "sr"],
  netherlands: ["NL", "nl"],
  "republic-of-north-macedonia": ["MK", "mk"],
  norway: ["NO", "no"],
  poland: ["PL", "pl"],
  portugal: ["PT", "pt"],
  romania: ["RO", "ro"],
  serbia: ["RS", "sr"],
  slovakia: ["SK", "sk"],
  slovenia: ["SI", "sl"],
  spain: ["ES", "es"],
  sweden: ["SE", "sv"],
  switzerland: ["CH", "de"],
  ukraine: ["UA", "uk"],
  "united-kingdom": ["GB", "en"],
};
const meteo = Object.entries(METEO_COUNTRIES).map(
  ([slug, [country, lang]]): SourceRecord => ({
    ...base,
    id: "meteoalarm-" + country.toLowerCase(),
    name: "MeteoAlarm — " + slug,
    owner: "EUMETNET / national meteorological service",
    url: "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-" + slug,
    docs: "https://api.meteoalarm.org/",
    countries: [country],
    languages: [lang, "en"],
    categories: ["weather"],
    family: "rss",
    status: "license_required",
    rights: {
      access: true,
      storage: false,
      ai: false,
      display: false,
      redistribute: false,
      basis:
        "Live Atom feed declares CC BY 4.0 equivalent AND additional redistributor Terms and Conditions. Additional requirements not yet verified; no operational ingestion until reviewed.",
      attribution: "MeteoAlarm / originating national meteorological service",
      retention_days: 0,
    },
    config: {
      format: "atom_cap",
      validation:
        "HTTP 200 valid Atom on 2026-10-21; weather only, NOT demonstration coverage",
    },
  }),
);

export const FCDO_COUNTRIES: Record<string, string> = {
  AD: "andorra",
  AL: "albania",
  AT: "austria",
  BA: "bosnia-and-herzegovina",
  BE: "belgium",
  BG: "bulgaria",
  BY: "belarus",
  CH: "switzerland",
  CY: "cyprus",
  CZ: "czech-republic",
  DE: "germany",
  DK: "denmark",
  EE: "estonia",
  ES: "spain",
  FI: "finland",
  FR: "france",
  GR: "greece",
  HR: "croatia",
  HU: "hungary",
  IE: "ireland",
  IS: "iceland",
  IT: "italy",
  LI: "liechtenstein",
  LT: "lithuania",
  LU: "luxembourg",
  LV: "latvia",
  MC: "monaco",
  MD: "moldova",
  ME: "montenegro",
  MK: "north-macedonia",
  MT: "malta",
  NL: "netherlands",
  NO: "norway",
  PL: "poland",
  PT: "portugal",
  RO: "romania",
  RS: "serbia",
  SE: "sweden",
  SI: "slovenia",
  SK: "slovakia",
  SM: "san-marino",
  UA: "ukraine",
  XK: "kosovo",
};
const fcdo = Object.entries(FCDO_COUNTRIES).map(
  ([country, slug]): SourceRecord => ({
    ...base,
    id: "fcdo-" + country.toLowerCase(),
    name: "FCDO travel advice — " + slug,
    owner: "UK Foreign, Commonwealth & Development Office",
    url: "https://www.gov.uk/foreign-travel-advice/" + slug + ".atom",
    docs: "https://www.gov.uk/help/reuse-govuk-content",
    countries: [country],
    languages: ["en"],
    categories: ["official_advisory", "travel"],
    family: "rss",
    poll_seconds: 21600,
    rights: rights(
      "Open Government Licence v3.0, GOV.UK reuse policy; Atom feed republication expressly allowed by FCDO terms. This feed contains advisory change summaries only, not full destination advice.",
      "Contains public sector information licensed under the Open Government Licence v3.0. Source: FCDO / GOV.UK. Derived analysis is not official advice.",
    ),
    config: {
      format: "rss",
      coverage:
        "country travel-advice changes; no claim of local incident completeness",
      same_origin_group: "fcdo",
      queue_priority: 0,
      context_only: true,
      operational_role: "country_advisory_context_not_local_osint",
      admission_policy:
        "source-admission-3: low-priority context; explicit safety/protest retained, routine administrative changes tracked as excluded",
    },
  }),
);
const norway: SourceRecord = {
  ...base,
  id: "no-politiloggen",
  poll_seconds: 60,
  name: "Norway Politiloggen public incident messages",
  owner: "Politiet",
  url: "https://api.politiloggen.politiet.no/feeds/atom",
  docs: "https://api.politiloggen.politiet.no/index.html",
  countries: ["NO"],
  languages: ["nb"],
  categories: [
    "disruption",
    "public_order",
    "reported_violence",
    "official_advisory",
  ],
  family: "rss",
  rights: rights(
    "Norsk lisens for offentlige data (NLOD) 2.0, explicitly in current official Swagger https://api.politiloggen.politiet.no/swagger/v1/swagger.json",
    "Source: Politiet, NLOD 2.0. Derived analysis is not an official police warning.",
  ),
  config: {
    format: "rss",
    queue_priority: 80,
    coverage:
      "Selected public incident messages; not all events; source places textual, no guessed coordinates",
  },
};

export const sourceRegistry: SourceRecord[] = [
  {
    ...base,
    id: "ua-idmc-displacement-flows",
    name: "IDMC Ukraine — daily provisional displacement flows",
    owner: "Internal Displacement Monitoring Centre (IDMC), via OCHA HDX",
    url: IDMC_UKRAINE_URL,
    docs: IDMC_UKRAINE_PAGE,
    countries: ["UA"],
    languages: ["en"],
    categories: ["displacement", "daily_context"],
    family: "rss",
    poll_seconds: 86400,
    verified_at: "2026-10-21T11:53:00Z",
    rights: rights(
      "CC BY-IGO 3.0 — " +
        IDMC_LICENSE +
        ". Specific HDX package ukr-idmc-idu-events declares cc-by-igo, daily IDMC-authored provisional flow data. Only compact factual metadata and source references are retained; no upstream article bodies, personal profiles or precise individual movements. Public CSV access is independent of the credential-gated direct IDMC API.",
      "Internal Displacement Monitoring Centre (IDMC), Internal Displacement Updates (IDU), via OCHA HDX — CC BY-IGO 3.0 — " +
        IDMC_LICENSE +
        ". Derived compact factual metadata; changes/analysis indicated. Daily provisional flow estimate, not live movement or cumulative population.",
    ),
    config: {
      format: "idmc_ukraine_csv",
      queue_priority: 35,
      max_bytes: 2 * 1024 * 1024,
      max_requests: 1,
      max_records: 30,
      source_window_days: 14,
      operational_role: "daily_displacement_context",
      declared_refresh_seconds: 86400,
      coverage:
        "Latest30 unique reported flows with displacement end/date in last14days, daily source. Provisional estimates may overlap and be revised; do not sum without IDMC preprocessing. No exact source points or averaged multi-place centroid are projected. Not live city crowd monitoring.",
    },
  },
  {
    ...base,
    id: "de-demos-assemblies",
    name: "Demos — licensed public assembly calendar metadata",
    owner: "Demos Berlin e.V. (independent aggregator)",
    url: DEMOS_QUERY_URL,
    docs: "https://demonstrations.org/de/data",
    countries: ["DE", "AT", "CH"],
    languages: ["de"],
    categories: ["public_assembly", "planned_demonstration"],
    family: "rss",
    poll_seconds: 300,
    verified_at: "2026-10-21T11:55:00Z",
    rights: rights(
      "CC BY-SA 4.0 — " +
        DEMOS_LICENSE_URL +
        ". Explicit dataset grant https://demonstrations.org/de/data . Only licensed aggregator-derived factual event metadata is retained; upstream articles, private organizer/contact data, photos and generated route vertices are excluded. Record-level restrictions override dataset defaults. Derived metadata and summaries require attribution, change indication and CC BY-SA 4.0 share-alike on redistribution. This grant does not settle independent reuse of upstream articles or Berlin source-page text.",
      "Demos Berlin e.V. — CC BY-SA 4.0 — " +
        DEMOS_LICENSE_URL +
        ". Derived factual event metadata and analysis; changes indicated. Publisher-generated extraction is not independently confirmed. Per-item source and upstream reference supplied.",
    ),
    config: {
      format: "demos_json",
      queue_priority: 90,
      max_bytes: 2 * 1024 * 1024,
      max_requests: 1,
      max_records: 20,
      operational_role: "public_activity",
      declared_refresh_seconds: 10800,
      coverage:
        "Latest20 created public assembly records, checked every5min; publisher crawls approximately every3h. Not live crowd observation or complete coverage. Created-only API sorting misses older edits/deletions and bursts beyond20; no guarantee of exhaustive correction detection. Aggregator-geocoded coordinates/routes are omitted; native city/street metadata remains explicitly unconfirmed.",
    },
  },
  {
    ...base,
    id: "nl-zwaailicht-fire-clusters",
    name: "Zwaailicht.nl — unconfirmed public fire dispatch clusters",
    owner: "Zwaailicht.nl (independent publisher; not emergency authorities)",
    url: ZWAAILICHT_URL,
    docs: "https://zwaailicht.nl/api",
    countries: ["NL"],
    languages: ["nl"],
    categories: ["public_dispatch", "property_damage_fire"],
    family: "rss",
    poll_seconds: 60,
    rights: {
      ...rights(
        "Specific API/feed/content reuse grant https://zwaailicht.nl/voorwaarden permits bots, AI assistants, rewriting and translation with visible followable per-item link and Zwaailicht.nl attribution. No raw pager messages provided. No archive copying/bulk export, no higher-rate access without agreement; publisher-generated interpretations remain unconfirmed.",
        "Zwaailicht.nl — publisher-generated interpretation of public dispatch, not a confirmed incident; follow the per-item source link.",
      ),
      retention_days: 7,
      redistribute: false,
    },
    config: {
      format: "zwaailicht_incidents",
      max_bytes: 1024 * 1024,
      max_requests: 6,
      source_window_hours: 24,
      max_records: 30,
      coverage:
        "Latest30 public fire dispatch clusters in a rolling24h window, filtered against routine alarms/medical/private-person noise; no complete dispatch coverage or independent corroboration.",
    },
  },
  {
    ...base,
    id: "es-cat-bombers",
    name: "Bombers de Catalunya — public vegetation-fire services",
    owner:
      "Generalitat de Catalunya — Departament d'Interior i Seguretat Pública",
    url: CATALUNYA_BOMBERS_QUERY,
    docs: "https://interior.gencat.cat/ca/incendis-forestals/inici/index.html",
    countries: ["ES"],
    languages: ["ca"],
    categories: ["public_dispatch", "property_damage_fire", "civil_protection"],
    family: "rss",
    rights: rights(
      "Publisher-linked legal notice https://tramits.gencat.cat/ca/ajuda/avis_legal/ expressly permits reuse of contents and DATA, including derivative works, under Catalunya open-information / CC0-equivalent terms, with source/update attribution and no distortion, except specific third-party restrictions. Official Interior page embeds this public Bombers map; layer/item metadata contains no overriding restriction. Excludes basemaps, logos, private dispatch and resource tracking.",
      "Generalitat de Catalunya — Departament d'Interior i Seguretat Pública — Bombers. Source update timestamp shown per record. Derived analysis is not an official emergency instruction.",
    ),
    config: {
      format: "bombers_arcgis",
      max_bytes: 2 * 1024 * 1024,
      max_requests: 6,
      coverage:
        "Publisher-selected public vegetation-fire service records in Catalunya; not all emergency dispatch. Unknown state codes retained; null end is not proof of active fire.",
      declared_refresh_seconds: null,
    },
  },
  {
    ...base,
    id: "fr-paris-public-events",
    name: "Paris PC LUTECE — explicit public gatherings and safety events",
    owner: "Ville de Paris / PC LUTECE",
    url: "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/circulation_evenement/records?limit=100&order_by=id",
    docs: "https://opendata.paris.fr/explore/dataset/circulation_evenement/",
    countries: ["FR"],
    languages: ["fr"],
    categories: ["public_order", "gathering", "public_safety"],
    family: "rss",
    poll_seconds: 300,
    rights: rights(
      "Licence Ouverte (Etalab) in official dataset metadata https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/circulation_evenement ; https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf . Attribution and data date required; derived analysis labelled; respect municipal safe-routing policy. Not a blanket assembly/crowd-count feed.",
      "Ville de Paris / PC LUTECE — circulation_evenement, Licence Ouverte (Etalab); source event dates supplied in each record; derived analysis is not an official notice.",
    ),
    config: {
      format: "paris_json",
      queue_priority: 100,
      max_bytes: 2 * 1024 * 1024,
      max_pages: 10,
      coverage:
        "Only explicit crowd/public-order/evacuation/safety descriptions; routine roadworks and bus-lane restrictions excluded before storage; source polyline is not an invented point",
    },
  },
  {
    ...base,
    id: "se-polisen-events",
    name: "Polisen — selected public-order and safety API notices",
    owner: "Polismyndigheten",
    url: "https://polisen.se/api/events",
    docs: "https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/",
    countries: ["SE"],
    languages: ["sv"],
    categories: ["public_order", "public_safety", "official_advisory"],
    family: "rss",
    poll_seconds: 300,
    rights: {
      ...rights(
        "Specific API open-data free-use grant https://polisen.se/om-polisen/om-webbplatsen/oppna-data/ with Polismyndigheten attribution; API data only, not website article/photo copying; no CC licence asserted. HTTPS, honest User-Agent, >=10s between calls and <=60/hour under https://polisen.se/om-polisen/om-webbplatsen/oppna-data/regler-for-oppna-data/ . Derived analysis labelled.",
        "Polismyndigheten / Polisen open API — https://www.polisen.se ; derived analysis is not an official police notice.",
      ),
      retention_days: 7,
    },
    config: {
      format: "sweden_police",
      queue_priority: 80,
      admission_policy:
        "source-admission-3: narrow public-order/safety type selection before storage; excluded counts only",
      geography:
        "API municipality/county centroid is not incident location; retained as annotated source excerpt, never event point",
    },
  },
  {
    ...base,
    id: "it-mit-strikes",
    name: "MIT — Calendario scioperi dei trasporti",
    owner: "Ministero delle Infrastrutture e dei Trasporti",
    url: "https://scioperi.mit.gov.it/mit2/public/scioperi/rss",
    docs: "https://dati.mit.gov.it/catalog/dataset/scioperi-dei-trasporti",
    countries: ["IT"],
    languages: ["it"],
    categories: ["strike", "transport", "official_advisory"],
    family: "rss",
    poll_seconds: 300,
    rights: rights(
      "CC BY 4.0, official MIT dataset https://dati.mit.gov.it/catalog/dataset/scioperi-dei-trasporti explicitly licenses the official strike-calendar dataset. https://creativecommons.org/licenses/by/4.0/ ; derived analysis labelled.",
      "Ministero delle Infrastrutture e dei Trasporti — Calendario scioperi, CC BY 4.0; derived analysis is not official advice.",
    ),
    config: {
      format: "mit_strikes",
      queue_priority: 100,
      coverage:
        "Official scheduled transport strikes; calendar dates and province/region scope, not event-point coordinates",
    },
  },
  ...dpc,
  ...bbk,
  {
    ...base,
    id: "de-dwd",
    name: "DWD public weather warnings",
    owner: "Deutscher Wetterdienst",
    url: "https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json",
    docs: "https://www.dwd.de/DE/service/rechtliche_hinweise/rechtliche_hinweise_node.html",
    countries: ["DE"],
    languages: ["de"],
    categories: ["weather", "official_advisory"],
    family: "dwd",
    rights: rights(
      "CC BY 4.0 for all freely accessible geodata; DWD current legal notice defines all geographically referenced weather information as geodata. Official warning text kept unchanged; derived analysis labelled.",
      "Quelle: Deutscher Wetterdienst; derived analysis: Datenbasis Deutscher Wetterdienst, eigene Bearbeitung",
    ),
    config: {
      format: "dwd_jsonp",
      context_only: true,
      queue_priority: 0,
      operational_role: "weather_warning_context_not_osint_feed",
    },
  },
  {
    ...base,
    id: "uk-tfl-roads",
    name: "TfL live road disruptions",
    owner: "Transport for London",
    url: "https://api.tfl.gov.uk/Road/all/Disruption?stripContent=true",
    docs: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
    countries: ["GB"],
    languages: ["en"],
    categories: ["disruption", "planned_demonstration", "official_advisory"],
    family: "tfl",
    status: "awaiting_credentials",
    rights: {
      ...rights(
        "TfL amended OGL 2.0: copy/adapt/distribute allowed, licence applies from registration. Confirm existing registration before enabling.",
        "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016. Geomni UK Map data © and database rights 2019.",
      ),
      access: false,
    },
    config: {
      format: "tfl",
      registration_required: true,
      validation:
        "HTTP200 125 real disruptions including peaceful planned static protest; no API key necessary for smoke test",
    },
  },
  {
    ...base,
    id: "fr-sncf-siri",
    status: "disabled",
    name: "SNCF Voyageurs service alerts",
    owner: "SNCF Voyageurs",
    url: "https://proxy.transport.data.gouv.fr/resource/sncf-siri-lite-situation-exchange",
    docs: "https://transport.data.gouv.fr/datasets/horaires-sncf",
    countries: ["FR"],
    languages: ["fr", "en", "de", "es", "it", "nl"],
    categories: ["disruption", "transport"],
    family: "siri",
    rights: rights(
      "ODbL 1.0 + PAN Specific Conditions: https://doc.transport.data.gouv.fr/le-point-d-acces-national/cadre-juridique/conditions-dutilisation-des-donnees/licence-odbl.md ; derived database modifications of same nature/granularity/time/geography must be shared under same conditions. Keep source partition/export licence.",
      "SNCF Voyageurs, via transport.data.gouv.fr — Open Database Licence (ODbL) 1.0 with PAN Specific Conditions",
    ),
    config: {
      format: "siri_lite",
      max_bytes: 4 * 1024 * 1024,
      queue_priority: 10,
      admission_policy:
        "Disabled by user: passenger train circulation is outside the default OSINT product. Existing archive preserved; not fetched by normal collection.",
    },
  },
  norway,
  ...fcdo,
  ...meteo,
];
/** Initial country scope. Inclusion here never asserts functioning source coverage. */
export const EUROPE_SCOPE = [
  "AD",
  "AL",
  "AT",
  "BA",
  "BE",
  "BG",
  "BY",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MC",
  "MD",
  "ME",
  "MK",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "SE",
  "SI",
  "SK",
  "SM",
  "UA",
  "VA",
  "XK",
];
export const TRANSCONTINENTAL_SCOPE = ["AM", "AZ", "GE", "KZ", "RU", "TR"];
export const gatedFamilies = [
  {
    family: "bluesky",
    status: "approval_review",
    reason:
      "Jetstream retrieval public; downstream content licence/AI retention policies must be reviewed per source.",
  },
  {
    family: "mastodon",
    status: "awaiting_credentials",
    reason: "Instance-specific access and content licence required.",
  },
  {
    family: "x",
    status: "awaiting_credentials",
    reason: "Supported paid/metered access and explicit budget required.",
  },
  {
    family: "reddit",
    status: "approval_required",
    reason: "Approved access required; scraping fallback prohibited.",
  },
  {
    family: "youtube",
    status: "awaiting_credentials",
    reason: "API key/quota and developer-policy retention requirements.",
  },
  {
    family: "telegram",
    status: "license_required",
    reason:
      "Explicit channel scope and AI reuse permission required; Bot API is not a search feed.",
  },
  {
    family: "acled",
    status: "license_required",
    reason:
      "Access and dashboard redistribution licence required; periodic updates.",
  },
  {
    family: "reliefweb",
    status: "approval_required",
    reason: "Documented approved appname required.",
  },
  {
    family: "gdelt",
    status: "discovery_only",
    reason: "Candidate links only; publisher rights independently required.",
  },
  {
    family: "meta_tiktok",
    status: "approval_required",
    reason: "Special approved research/library access is not a generic feed.",
  },
];
export function configuredRegistry(
  options: { tflRegistered?: boolean; countries?: string[] } = {},
): SourceRecord[] {
  return sourceRegistry
    .map((s) =>
      s.id === "uk-tfl-roads" && options.tflRegistered
        ? {
            ...s,
            status: "enabled" as const,
            rights: { ...s.rights, access: true },
            config: { ...s.config, registration_confirmed: true },
          }
        : s,
    )
    .filter(
      (s) =>
        !options.countries ||
        s.countries.some((c) => options.countries!.includes(c)),
    );
}
