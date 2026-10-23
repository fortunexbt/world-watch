import test from "node:test";
import assert from "node:assert/strict";
import { WorkerError, type Backend } from "../src/worker/adapter.js";
import { detectLanguage, prefilterHeadlines } from "../src/worker/prefilter.js";
import {
  headlineInput,
  triageHeadlines,
  triageSchema,
  validateTriage,
} from "../src/worker/triage.js";

const h = (id: string, title: string) => ({
  id,
  title,
  url: "https://publisher.example/" + id,
});
const run = {
  requested_model: "m",
  requested_tier: "default",
  actual_model: "m",
  actual_tier: null,
  client_version: "test",
  usage: { completion_tokens: 10 },
  tool_attempts: 0,
};
const item = (i: number, update: Record<string, unknown> = {}) => ({
  i,
  relevant: true,
  code: "current_event",
  category: "strike",
  places: [],
  review: false,
  ...update,
});

test("prefilter groups wire copies but keeps different magnitudes and stories apart", () => {
  const out = prefilterHeadlines([
    h("a", "Rail strike halts trains across Belgium - Reuters"),
    h("b", "Rail strike halts trains across Belgium | The Brussels Times"),
    h("c", "UPDATE 1-RAIL STRIKE HALTS TRAINS ACROSS BELGIUM"),
    h("d", "Magnitude 5.1 earthquake hits eastern Turkey"),
    h("e", "Magnitude 6.3 earthquake hits eastern Turkey"),
    h("f", "Magnitude 5.1 earthquake strikes eastern Turkey"),
    h("g", "Rome - Thousands march against cuts"),
    h("i", "Paris - Thousands march against cuts"),
    h("j", "?!"),
  ]);
  assert.deepEqual(
    out.map((o) => [
      o.record.id,
      o.status,
      "duplicate_of" in o ? o.duplicate_of : null,
    ]),
    [
      ["a", "kept", null],
      ["b", "exact_duplicate", "a"],
      ["c", "exact_duplicate", "a"],
      ["d", "kept", null],
      ["e", "kept", null],
      ["f", "near_duplicate", "d"],
      ["g", "kept", null],
      ["i", "kept", null],
      ["j", "no_text", null],
    ],
  );
});

test("noise filter removes only items with no event word", () => {
  const status = (title: string) =>
    prefilterHeadlines([h("x", title)])[0].status;
  assert.equal(
    status("Liverpool beat Chelsea 2-1 in Premier League thriller"),
    "noise",
  );
  assert.equal(status("Taylor Swift album breaks streaming record"), "noise");
  assert.equal(status("Messi strike seals Champions League win"), "kept");
  assert.equal(status("Fans clash with police after Bundesliga match"), "kept");
  assert.equal(status("Thousands march in Nairobi against tax hikes"), "kept");
  assert.equal(status("Bahnstreik legt Fernverkehr lahm"), "kept");
});

test("language detection uses script, letters and function words", () => {
  assert.equal(detectLanguage("Обстріл Харкова: є загиблі"), "uk");
  assert.equal(detectLanguage("Землетрясение в Казахстане"), "ru");
  assert.equal(detectLanguage("台風10号、九州に上陸"), "ja");
  assert.equal(detectLanguage("مظاهرات في بغداد"), "ar");
  assert.equal(
    detectLanguage(
      "Miles de personas se manifiestan en Valencia por la vivienda",
    ),
    "es",
  );
  assert.equal(detectLanguage("Rolnicy protestują w Warszawie"), "pl");
  assert.equal(
    detectLanguage("Tausende demonstrieren in Berlin gegen Rechtsextremismus"),
    "de",
  );
  assert.equal(detectLanguage("Strike halts trains"), "und");
  assert.equal(
    prefilterHeadlines([
      { ...h("x", "Strike halts trains"), language: "en" },
    ])[0].language,
    "en",
  );
});

test("triage validation keeps relevance, code and category consistent and marks ungrounded places", () => {
  const title = "Rolnicy protestują w Warszawie";
  assert.deepEqual(
    validateTriage(
      item(0, {
        category: "ongoing_demonstration",
        places: [
          { name: "Warszawa", cc: "PL" },
          { name: "Warsaw", cc: "PL" },
        ],
      }),
      title,
      "x",
    ),
    {
      id: "x",
      relevant: true,
      code: "current_event",
      category: "ongoing_demonstration",
      places: [
        { name: "Warszawa", cc: "PL", grounded: true },
        { name: "Warsaw", cc: "PL", grounded: false },
      ],
      review: true,
    },
  );
  const japanese = validateTriage(
    item(0, {
      category: "tropical_cyclone",
      places: [{ name: "九州", cc: "JP" }],
    }),
    "台風10号、九州に上陸",
    "y",
  );
  assert.deepEqual(japanese.places, [
    { name: "九州", cc: "JP", grounded: true },
  ]);
  assert.equal(japanese.review, false);
  assert.throws(
    () => validateTriage(item(0, { code: "sports" }), title, "x"),
    /inconsistent_code/,
  );
  assert.throws(
    () => validateTriage(item(0, { category: null }), title, "x"),
    /inconsistent_category/,
  );
  assert.deepEqual(
    validateTriage(
      item(0, {
        relevant: false,
        code: "politics",
        category: null,
        places: [{ name: "Warszawie", cc: "PL" }],
      }),
      title,
      "x",
    ).places,
    [],
  );
  assert.throws(() =>
    validateTriage(
      item(0, { places: [{ name: "Warszawa", cc: "pl" }] }),
      title,
      "x",
    ),
  );
  assert.deepEqual(
    triageSchema(3).properties.items.items.properties.i.enum,
    [0, 1, 2],
  );
});

test("many headlines share one call, carry only index, language and title, and fail per item", async () => {
  const requests: any[] = [];
  const backend: Backend = async (request) => {
    requests.push(request);
    return {
      output: {
        items: [
          item(0, { places: [{ name: "Belgium", cc: "BE" }] }),
          item(1, { code: "sports" }),
          item(3, { relevant: false, code: "business", category: null }),
        ],
      },
      run,
    };
  };
  const out = await triageHeadlines(
    [
      h("a", "Rail strike halts trains across Belgium"),
      h("b", "Rail strike halts trains across Belgium - Reuters"),
      h("c", "Doctors to strike across England next week"),
      h("d", "Le gouvernement présente son plan pour l'école"),
      h("e", "Central bank holds interest rates as protests loom"),
      h("f", "Liverpool beat Chelsea 2-1 in Premier League thriller"),
    ],
    { backend, batchSize: 10 },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload, {
    headlines: [
      { i: 0, title: "Rail strike halts trains across Belgium" },
      { i: 1, lang: "en", title: "Doctors to strike across England next week" },
      {
        i: 2,
        lang: "fr",
        title: "Le gouvernement présente son plan pour l'école",
      },
      { i: 3, title: "Central bank holds interest rates as protests loom" },
    ],
  });
  assert(!JSON.stringify(requests[0].payload).includes("publisher.example"));
  assert.deepEqual(
    out.map((o) => [
      o.id,
      o.status,
      o.status === "rejected"
        ? o.rule
        : o.status === "accepted"
          ? o.relevant
          : null,
    ]),
    [
      ["a", "accepted", true],
      ["b", "duplicate", null],
      ["c", "rejected", "inconsistent_code"],
      ["d", "rejected", "missing_result"],
      ["e", "accepted", false],
      ["f", "filtered", null],
    ],
  );
  assert.deepEqual(out[1], {
    id: "b",
    status: "duplicate",
    duplicate_of: "a",
    kind: "exact",
  });
  assert.equal(
    out[0].status === "accepted" && out[0].run.prompt_version,
    "triage-1",
  );
});

test("an unreadable batch is retried in halves and a lone bad item is rejected, not thrown", async () => {
  let calls = 0;
  const backend: Backend = async (request) => {
    calls++;
    const headlines = (request.payload as any).headlines;
    if (headlines.some((x: any) => x.title.includes("poison")))
      throw new WorkerError("invalid", "invalid_json_output");
    return { output: { items: headlines.map((x: any) => item(x.i)) }, run };
  };
  const titles = [
    "Strike one in Lyon",
    "Strike two in Lille",
    "poison strike headline",
    "Strike four in Nice",
  ];
  const out = await triageHeadlines(
    titles.map((t, i) => h(String(i), t)),
    { backend, batchSize: 4 },
  );
  assert.deepEqual(
    out.map((o) => o.status),
    ["accepted", "accepted", "rejected", "accepted"],
  );
  assert.equal(
    out[2].status === "rejected" && out[2].rule,
    "invalid_json_output",
  );
  assert.equal(calls, 5);
  await assert.rejects(
    triageHeadlines([h("q", "Strike in Lyon")], {
      backend: async () => {
        throw new WorkerError("quota", "all_providers_exhausted");
      },
    }),
    (e: any) => e.kind === "quota",
  );
});

test("batch size bounds each call", async () => {
  const sizes: number[] = [];
  const backend: Backend = async (request) => {
    const headlines = (request.payload as any).headlines;
    sizes.push(headlines.length);
    return { output: { items: headlines.map((x: any) => item(x.i)) }, run };
  };
  await triageHeadlines(
    Array.from({ length: 23 }, (_, i) =>
      h(String(i), `Strike number ${i} closes port of city ${i}`),
    ),
    { backend, batchSize: 10 },
  );
  assert.deepEqual(sizes, [10, 10, 3]);
});

test("a triaged headline becomes a title-only extraction job", () => {
  const job = headlineInput({
    ...h("g1", "Thousands march in Nairobi"),
    seen_at: "2026-10-23T08:15:00Z",
  });
  assert.equal(job.input_coverage, "title_only");
  assert.deepEqual(job.excerpts, [
    { id: "title", text: "Thousands march in Nairobi" },
  ]);
  assert.equal(job.published_at, null);
  assert.equal(job.first_observed_at, "2026-10-23T08:15:00Z");
  assert.throws(() =>
    headlineInput({ id: "bad", title: "x", url: "not a url" }),
  );
});
