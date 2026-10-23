import { createHash } from "node:crypto";

/**
 * Deterministic, model-free steps that run before headline triage: language
 * identification, exact and near-duplicate grouping, and a conservative noise
 * filter. Nothing here decides that an item is relevant; it only removes what
 * cannot need a model call.
 */

export function normaliseTitle(title: string) {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Wire copies differ mostly by outlet suffixes and live-blog prefixes. A
// suffix is dropped only when it is short and the remaining story is not.
function storyText(title: string) {
  const plain = title.replace(
      /^\s*(?:update \d+|live|breaking|watch|video)\s*[-:–—]\s*/iu,
      "",
    ),
    cut = plain.match(/^(.*\S)\s+[-|–—]\s+([^-|–—]+)$/u),
    words = (text: string) => normaliseTitle(text).split(" ").length;
  return normaliseTitle(
    cut && words(cut[2]) <= 4 && words(cut[1]) >= 4 ? cut[1] : plain,
  );
}

const SCRIPTS: [RegExp, string][] = [
  [/[぀-ヿ]/u, "ja"],
  [/\p{Script=Hangul}/u, "ko"],
  [/\p{Script=Han}/u, "zh"],
  [/[іїєґ]/iu, "uk"],
  [/\p{Script=Cyrillic}/u, "ru"],
  [/[پچژگ]/u, "fa"],
  [/\p{Script=Arabic}/u, "ar"],
  [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Greek}/u, "el"],
  [/\p{Script=Devanagari}/u, "hi"],
  [/\p{Script=Thai}/u, "th"],
];
// Function words and letters that headlines keep even when telegraphic.
const LATIN: [string, Set<string>, RegExp | null][] = (
  [
    [
      "en",
      "the of in on for and after over as to with from amid says against is are at near",
      null,
    ],
    [
      "fr",
      "le la les des du un une et à au aux en pour sur contre après dans",
      /[çœ]/u,
    ],
    [
      "de",
      "der die das und in im mit nach gegen für von auf bei ein eine",
      /[ßäöü]/u,
    ],
    ["es", "el los las del y en con por para contra tras una un se", /[ñ¿¡]/u],
    [
      "it",
      "il lo gli della dei del e in con per contro dopo una un di nel",
      /[àèìòù]$/u,
    ],
    [
      "pt",
      "o os as da do das dos e em com por para contra após uma um no na",
      /[ãõ]/u,
    ],
    ["nl", "de het een en in van met na tegen voor bij op", /ij/u],
    ["pl", "w we na i z po przeciw dla od do się", /[ąćęłńśźż]/u],
  ] as const
).map(([code, words, letters]) => [code, new Set(words.split(" ")), letters]);

/** ISO 639-1 code from script, distinctive letters and function words; "und" when undecided. */
export function detectLanguage(title: string) {
  for (const [re, code] of SCRIPTS) if (re.test(title)) return code;
  const words = title
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const scores = LATIN.map(([code, list, letters]) => ({
    code,
    score:
      words.filter((w) => list.has(w)).length +
      (letters && words.some((w) => letters.test(w)) ? 2 : 0),
  })).sort((a, b) => b.score - a.score);
  return scores[0].score > scores[1].score ? scores[0].code : "und";
}

const terms = (list: string) =>
  new RegExp("\\b(?:" + list.trim().split(/\s+/).join("|") + ")\\b", "u");
// Matched on diacritic-free lower case. Any of these keeps an item for the model.
const EVENT = terms(`
  protest\\w* march\\w* rall(?:y|ies) demonstrat\\w* strike\\w* walkout riot\\w* clash\\w*
  attack\\w* bomb\\w* explosion\\w* blast\\w* shoot\\w* shot kill\\w* dead death\\w* injur\\w* wounded
  evacuat\\w* flood\\w* earthquake\\w* quake\\w* storm\\w* hurricane\\w* typhoon\\w* cyclone\\w* tornado\\w*
  wildfire\\w* fire\\w* blaze\\w* landslide\\w* erupt\\w* drought\\w* heatwave\\w* displac\\w* refugee\\w*
  curfew\\w* clos(?:ed|ure|ures) shut\\w* cancel\\w* disrupt\\w* outage\\w* blackout\\w* warning\\w* alert\\w*
  emergenc\\w* police troops army missile\\w* drone\\w* shelling airstrike\\w* ceasefire hostage\\w*
  manif\\w* greve\\w* emeute\\w* incendie\\w* inondation\\w* seisme\\w* tempete\\w* evacu\\w* attentat\\w* blesse\\w* morts?
  demo\\w* kundgebung\\w* streik\\w* brand\\w* hochwasser uberschwemmung\\w* erdbeben sturm\\w* unwetter\\w* polizei verletzt\\w* tote
  huelga\\w* protesta\\w* incendio\\w* inundacion\\w* terremoto\\w* sismo\\w* heridos? muertos?
  sciopero\\w* corteo\\w* alluvion\\w* feriti morti
  greve protesto\\w* enchente\\w* feridos? mortos?
  strajk\\w* pozar\\w* powodz\\w* rann\\w* zgin\\w*
  staking\\w* betoging\\w* overstroming\\w* doden gewond\\w*
`);
// Unambiguous sport, entertainment and market phrasing.
const NOISE = terms(`
  premier\\sleague champions\\sleague europa\\sleague la\\s?liga serie\\sa bundesliga ligue\\s1 eredivisie ekstraklasa
  nba nfl mlb nhl grand\\sprix formula\\s1 f1 match\\sreport transfer\\swindow calciomercato fichaje\\w* hat\\strick
  box\\soffice album trailer netflix oscars? grammys? red\\scarpet fashion\\sweek horoscope\\w* recipe\\w*
  stocks? shares earnings quarterly\\sresults dow\\sjones nasdaq ftse dax cac\\s40 ibex bourse borsa borse aktie\\w* dividend\\w*
  \\d+\\s\\d+\\s(?:win|victory|defeat|draw)
`);

export type Prefiltered<T> =
  | { record: T; language: string; status: "kept" | "noise" | "no_text" }
  | {
      record: T;
      language: string;
      status: "exact_duplicate" | "near_duplicate";
      duplicate_of: string;
    };

function jaccard(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
function fnv(text: string, seed: number) {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
const BANDS = 16,
  ROWS = 2;

/**
 * Groups exact and near-duplicate headlines (MinHash over word sets, verified
 * by Jaccard >= 0.75 with identical numbers, so different magnitudes or tolls
 * stay apart) and removes items that match sport, entertainment or market
 * phrasing with no event word. The first occurrence of a story is kept.
 */
export function prefilterHeadlines<
  T extends { id: string; title: string; language?: string | null },
>(records: T[]): Prefiltered<T>[] {
  const exact = new Map<string, string>(),
    buckets = new Map<
      string,
      { id: string; words: Set<string>; numbers: string }[]
    >();
  return records.map((record): Prefiltered<T> => {
    const language = record.language || detectLanguage(record.title),
      story = storyText(record.title);
    if ((story.match(/\p{L}/gu) ?? []).length < 3)
      return { record, language, status: "no_text" };
    const key = createHash("sha256").update(story).digest("hex"),
      same = exact.get(key);
    if (same)
      return {
        record,
        language,
        status: "exact_duplicate",
        duplicate_of: same,
      };
    exact.set(key, record.id);
    const words = new Set(story.split(" ")),
      numbers = (record.title.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(" "),
      bands = Array.from(
        { length: BANDS },
        (_, b) =>
          b +
          ":" +
          Array.from({ length: ROWS }, (_, r) =>
            Math.min(...[...words].map((w) => fnv(w, b * ROWS + r))),
          ).join(","),
      );
    for (const band of bands)
      for (const other of buckets.get(band) ?? [])
        if (other.numbers === numbers && jaccard(words, other.words) >= 0.75)
          return {
            record,
            language,
            status: "near_duplicate",
            duplicate_of: other.id,
          };
    for (const band of bands) {
      const list = buckets.get(band) ?? [];
      list.push({ id: record.id, words, numbers });
      buckets.set(band, list);
    }
    const full = normaliseTitle(record.title);
    return {
      record,
      language,
      status: NOISE.test(full) && !EVENT.test(full) ? "noise" : "kept",
    };
  });
}
