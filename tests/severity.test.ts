import test from "node:test";
import assert from "node:assert/strict";
import { validateResult, type JobInput } from "../src/shared/contracts.js";

function fixture(text: string, opts: { official?: JobInput["official"] } = {}) {
  const input: JobInput = {
    source_id: "fixture-source",
    native_id: "item-1",
    canonical_url: "https://example.invalid/item-1",
    title: "Fixture report",
    original_language: "en",
    published_at: null,
    source_updated_at: null,
    input_coverage: "permitted_excerpt",
    excerpts: [{ id: "e1", text }],
    official: opts.official,
    report_id: "report-1",
    content_revision: "revision-1",
    contract_version: "ew-1",
    first_observed_at: "2026-10-21T12:00:00Z",
    ingested_at: "2026-10-21T12:00:00Z",
  };
  const result = {
    report_id: input.report_id,
    content_revision: input.content_revision,
    input_coverage: input.input_coverage,
    original_language: "en",
    relevant: true,
    relevance_reason: "The report describes an event.",
    summary_en: "A source report describes an event.",
    summary_it: null,
    published_at: input.published_at,
    source_updated_at: input.source_updated_at,
    claims: [{
      id: "claim-1",
      activity: "reported_violence" as const,
      summary: "The report describes an event.",
      evidence_ids: ["e1"],
      places: [],
      event_start: null,
      event_end: null,
      timezone: null,
      temporal_status: "unknown" as const,
      time_uncertainty: null,
      impacts: ["14 people injured"],
      violence_mentioned: "yes" as const,
      impact: "severe" as const,
      impact_uncertainty: null,
      official_instruction: null,
      relationships: [],
    }],
    candidate_incident_ids: [],
    uncertainty_flags: [],
    targeted_review: false,
  };
  return { input, result };
}

function withClaim(text: string, update: Record<string, unknown> = {}, options: { official?: JobInput["official"] } = {}) {
  const { input, result } = fixture(text, options);
  Object.assign(result.claims[0], update);
  return validateResult(result, input);
}

test("explicit cited public-order consequences still support severe impact", () => {
  assert.doesNotThrow(() => withClaim("Police said 14 people were injured during the clash.", { impacts: ["14 people were injured"] }));
});

test("a violence flag alone does not support severe impact", () => {
  assert.throws(() => withClaim("A clash was reported in the city.", { impacts: [] }), /unsupported_escalation/);
});

test("nonviolent fire and displacement can reach high impact with explicit cited consequences", () => {
  assert.doesNotThrow(() => withClaim(
    "The wildfire destroyed 120 homes and forced 400 residents to evacuate.",
    { activity: "property_damage_fire", violence_mentioned: "no", impacts: ["destroyed 120 homes"], impact: "severe" },
  ));
  assert.doesNotThrow(() => withClaim(
    "A catastrophic flood displaced 800 residents.",
    { activity: "displacement", violence_mentioned: "no", impacts: ["catastrophic flood displaced 800 residents"], impact: "critical" },
  ));
});

test("activity switching cannot create fire or displacement severity without matching consequences", () => {
  assert.throws(() => withClaim(
    "A peaceful march took place in the city.",
    { activity: "displacement", violence_mentioned: "no", impacts: ["peaceful march"] },
  ), /unsupported_escalation/);
});

test("negative, hypothetical, exercise, and uncited consequences do not support escalation", () => {
  for (const text of [
    "No injuries were reported and no evacuation was needed.",
    "The fire could cause injuries and might require evacuation.",
    "The evacuation was part of a school exercise and simulation.",
  ]) {
    assert.throws(() => withClaim(text, { activity: "property_damage_fire", violence_mentioned: "no", impacts: [text] }), /unsupported_escalation/);
  }
  const { input, result } = fixture("A peaceful march took place.");
  input.excerpts.push({ id: "e2", text: "Last year, 800 residents were displaced by floods." });
  Object.assign(result.claims[0], { activity: "displacement", violence_mentioned: "no", impacts: ["800 residents were displaced"] });
  assert.throws(() => validateResult(result, input), /unsupported_escalation/);
});

test("a quoted consequence subspan keeps its full clause negation and modality", () => {
  for (const [text, impact] of [
    ["No people were injured.", "people were injured"],
    ["The fire could have destroyed 120 homes.", "destroyed 120 homes"],
    ["The fire drill destroyed 120 homes.", "destroyed 120 homes"],
    ["No people were injured at one site. Separately, 14 people were injured at another.", "people were injured"],
  ]) {
    assert.throws(() => withClaim(text, { activity: "property_damage_fire", violence_mentioned: "no", impacts: [impact] }), /unsupported_escalation/);
  }
  assert.doesNotThrow(() => withClaim(
    "The fire destroyed 120 homes.",
    { activity: "property_damage_fire", violence_mentioned: "no", impacts: ["destroyed 120 homes"] },
  ));
});

test("high impact requires grounded claim-local impact text, not a citation borrowed from another excerpt", () => {
  const { input, result } = fixture("The city council met on Tuesday.");
  input.excerpts.push({ id: "e2", text: "A separate source says 800 residents were displaced last year." });
  Object.assign(result.claims[0], { activity: "displacement", evidence_ids: ["e1"], violence_mentioned: "no", impacts: ["800 residents were displaced"] });
  assert.throws(() => validateResult(result, input), /unsupported_escalation/);
});

test("a cited, actionable source instruction needs exact text and matching trusted source context", () => {
  const official = { issuer: "Regional Authority", effective_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-21T18:00:00Z" };
  const { input, result } = fixture("The Regional Authority ordered residents to evacuate immediately.", { official });
  Object.assign(result.claims[0], {
    activity: "official_advisory",
    violence_mentioned: "no",
    impacts: ["evacuate immediately"],
    official_instruction: {
      issuer: "Regional Authority",
      instruction: "evacuate immediately",
      effective_at: official.effective_at,
      expires_at: official.expires_at,
      evidence_ids: ["e1"],
    },
  });
  assert.doesNotThrow(() => validateResult(result, input));
  assert.throws(() => withClaim(
    "The Regional Authority issued a routine notice.",
    { activity: "official_advisory", violence_mentioned: "no", impacts: ["routine notice"], official_instruction: { issuer: "Regional Authority", instruction: "", effective_at: null, expires_at: null, evidence_ids: [] } },
    { official: { issuer: "Regional Authority", effective_at: null, expires_at: null } },
  ), /unsupported_escalation/);
});

test("unclassified claims cannot escalate, and critical requires explicit scale evidence", () => {
  assert.throws(() => withClaim("14 people were injured.", { activity: "other_unknown", impacts: ["14 people were injured"] }), /unsupported_escalation/);
  assert.throws(() => withClaim("800 residents were displaced.", { activity: "displacement", impacts: ["800 residents were displaced"], impact: "critical" }), /unsupported_escalation/);
  assert.doesNotThrow(() => withClaim("A catastrophic flood displaced 800 residents.", { activity: "displacement", impacts: ["catastrophic flood displaced 800 residents"], impact: "critical", violence_mentioned: "no" }));
  const official = { issuer: "Regional Authority", effective_at: null, expires_at: null };
  assert.throws(() => withClaim(
    "The Regional Authority ordered residents to evacuate immediately.",
    { activity: "official_advisory", impacts: ["evacuate immediately", "thousands of residents"], impact: "critical", violence_mentioned: "no", official_instruction: { issuer: official.issuer, instruction: "evacuate immediately", effective_at: null, expires_at: null, evidence_ids: ["e1"] } },
    { official },
  ), /unsupported_escalation/);
});

test("a matching official directive supports severe impact without a stated consequence", () => {
  const official = { issuer: "Regional Authority", effective_at: null, expires_at: null };
  const claim = {
    activity: "official_advisory",
    violence_mentioned: "no",
    impacts: ["stay indoors"],
    official_instruction: { issuer: "Regional Authority", instruction: "stay indoors", effective_at: null, expires_at: null, evidence_ids: ["e1"] },
  };
  assert.doesNotThrow(() => withClaim("The Regional Authority told residents to stay indoors.", claim, { official }));
  assert.throws(() => withClaim("The Regional Authority told residents to stay indoors.", claim), /unsupported_escalation/);
  assert.throws(() => withClaim("Residents may need to stay indoors later.", claim, { official }), /unsupported_escalation/);
});

type Case = [text: string, impact: string];
const languages: Record<string, { affirmed: Case[]; negated: Case; hypothetical: Case; critical: Case }> = {
  fr: { affirmed: [["L'incendie a fait 3 morts.", "3 morts"], ["Pas moins de 10 morts ont été recensés.", "10 morts"]], negated: ["Il n'y a pas eu de blessés.", "blessés"], hypothetical: ["L'incendie pourrait faire des morts.", "morts"], critical: ["Une catastrophe a fait 50 morts.", "catastrophe a fait 50 morts"] },
  es: { affirmed: [["El incendio dejó 3 muertos.", "3 muertos"]], negated: ["No hubo heridos.", "heridos"], hypothetical: ["El sismo podría causar muertos.", "muertos"], critical: ["Una catástrofe dejó 50 muertos.", "catástrofe dejó 50 muertos"] },
  pt: { affirmed: [["O incêndio deixou 12 mortos e 30 feridos.", "12 mortos"]], negated: ["Não houve feridos.", "feridos"], hypothetical: ["O sismo poderia ter causado mortes.", "mortes"], critical: ["Uma catástrofe deixou 80 mortos.", "catástrofe deixou 80 mortos"] },
  it: { affirmed: [["L'esplosione ha causato 3 morti.", "3 morti"], ["Non meno di 10 feriti in ospedale.", "10 feriti"]], negated: ["Non ci sono feriti.", "feriti"], hypothetical: ["La frana potrebbe causare morti.", "morti"], critical: ["Una catastrofe con 50 morti.", "catastrofe con 50 morti"] },
  de: { affirmed: [["Bei dem Brand wurden 3 Menschen getötet.", "3 menschen getötet"]], negated: ["Es gab keine Verletzten.", "verletzten"], hypothetical: ["Der Sturm könnte Tote fordern.", "tote"], critical: ["Eine Katastrophe mit 50 Toten.", "katastrophe mit 50 toten"] },
  nl: { affirmed: [["Bij de brand vielen 3 doden.", "3 doden"]], negated: ["Er vielen geen gewonden.", "gewonden"], hypothetical: ["De storm kan doden veroorzaken.", "doden"], critical: ["Een catastrofale overstroming eiste 50 doden.", "catastrofale overstroming eiste 50 doden"] },
  ru: { affirmed: [["При пожаре погибли пять человек.", "погибли пять человек"], ["Не менее 10 человек погибли.", "10 человек погибли"]], negated: ["Погибших нет.", "погибших"], hypothetical: ["Ураган может привести к жертвам.", "жертвам"], critical: ["Произошла катастрофическая авария, погибли 50 человек.", "катастрофическая авария, погибли 50 человек"] },
  uk: { affirmed: [["Внаслідок обстрілу загинули троє людей.", "загинули троє людей"]], negated: ["Загиблих немає.", "загиблих"], hypothetical: ["Обстріл може спричинити жертви.", "жертви"], critical: ["Масові жертви: загинули 40 людей.", "масові жертви: загинули 40 людей"] },
  ar: { affirmed: [["وأعلنت الشرطة سقوط 12 قتيلاً في الهجوم.", "12 قتيلاً"], ["سقط ما لا يقل عن 10 قتلى.", "10 قتلى"], ["وقد تم نقل الجرحى. وأفادت الشرطة بسقوط قَتْلَى.", "قتلى"]], negated: ["لم يسفر الحادث عن سقوط قتلى.", "قتلى"], hypothetical: ["قد يؤدي الحريق إلى سقوط قتلى.", "سقوط قتلى"], critical: ["أسفرت مجزرة مروعة عن مقتل 40 شخصا.", "مجزرة مروعة عن مقتل 40 شخصا"] },
  fa: { affirmed: [["در این حمله ۵ نفر کشته شدند.", "۵ نفر کشته شدند"]], negated: ["در این حادثه کسی کشته نشد.", "کشته"], hypothetical: ["ممکن است این سیل تلفات داشته باشد.", "تلفات"], critical: ["این فاجعه ۵۰ کشته بر جای گذاشت.", "فاجعه ۵۰ کشته"] },
  ur: { affirmed: [["دھماکے میں 5 افراد ہلاک ہو گئے۔", "5 افراد ہلاک"]], negated: ["واقعے میں کوئی زخمی نہیں ہوا۔", "زخمی"], hypothetical: ["سیلاب سے ہلاکتوں کا امکان ہے۔", "ہلاکتوں"], critical: ["تباہ کن زلزلے میں 100 افراد ہلاک ہو گئے۔", "تباہ کن زلزلے میں 100 افراد ہلاک"] },
  hi: { affirmed: [["हमले में 5 लोगों की मौत हो गई।", "5 लोगों की मौत"]], negated: ["हादसे में कोई घायल नहीं हुआ।", "घायल"], hypothetical: ["बाढ़ से मौतों की आशंका है।", "मौतों"], critical: ["विनाशकारी भूकंप में 200 लोगों की मौत हो गई।", "विनाशकारी भूकंप में 200 लोगों की मौत"] },
  bn: { affirmed: [["অগ্নিকাণ্ডে ৫ জন নিহত হয়েছেন।", "৫ জন নিহত"]], negated: ["দুর্ঘটনায় কেউ আহত হয়নি।", "আহত"], hypothetical: ["ঘূর্ণিঝড়ে প্রাণহানির আশঙ্কা রয়েছে।", "প্রাণহানির"], critical: ["ভূমিকম্পে ব্যাপক প্রাণহানি হয়েছে।", "ব্যাপক প্রাণহানি"] },
  tr: { affirmed: [["Saldırıda 4 kişi hayatını kaybetti.", "4 kişi hayatını kaybetti"]], negated: ["Kazada ölü yok.", "ölü"], hypothetical: ["Fırtına can kaybına neden olabilir.", "can kaybına"], critical: ["Felaket boyutundaki selde 30 kişi öldü.", "felaket boyutundaki selde 30 kişi öldü"] },
  "id/ms": { affirmed: [["Sebanyak 7 orang tewas dalam kebakaran itu.", "7 orang tewas"], ["Tidak kurang dari 10 orang tewas.", "10 orang tewas"]], negated: ["Tidak ada korban jiwa dalam kejadian itu.", "korban jiwa"], hypothetical: ["Banjir berpotensi menyebabkan korban jiwa.", "korban jiwa"], critical: ["Gempa itu menyebabkan korban massal dan 300 orang tewas.", "korban massal dan 300 orang tewas"] },
  sw: { affirmed: [["Watu watano waliuawa katika shambulio hilo.", "watano waliuawa"]], negated: ["Hakuna aliyejeruhiwa katika ajali hiyo.", "aliyejeruhiwa"], hypothetical: ["Mafuriko huenda yakasababisha vifo.", "vifo"], critical: ["Maafa makubwa yalitokea na watu 40 walifariki.", "maafa makubwa yalitokea na watu 40 walifariki"] },
  zh: { affirmed: [["火灾已造成3人死亡。", "3人死亡"], ["无人机袭击造成5人死亡。", "5人死亡"], ["大火造成5人受傷！", "5人受傷"]], negated: ["事故未造成人员伤亡。", "人员伤亡"], hypothetical: ["暴雨可能造成人员伤亡。", "人员伤亡"], critical: ["地震造成重大伤亡，至少50人死亡。", "重大伤亡"] },
  ja: { affirmed: [["火災で3人が死亡した。", "3人が死亡"], ["少なくとも3人が死亡した。", "3人が死亡"]], negated: ["この事故によるけが人はいない。", "けが人"], hypothetical: ["建物が倒壊するおそれがある。", "倒壊"], critical: ["地震で多数の死者が確認された。", "多数の死者"] },
  ko: { affirmed: [["화재로 3명이 사망했다.", "3명이 사망했다"]], negated: ["이번 사고로 인한 사상자는 없었다.", "사상자"], hypothetical: ["태풍으로 이재민이 발생할 우려가 있다.", "이재민"], critical: ["이번 참사로 150명이 숨졌다.", "참사로 150명이 숨졌다"] },
  th: { affirmed: [["เหตุไฟไหม้ทำให้มีผู้เสียชีวิต 3 ราย", "ผู้เสียชีวิต 3 ราย"]], negated: ["ไม่มีผู้ได้รับบาดเจ็บ", "บาดเจ็บ"], hypothetical: ["พายุอาจทำให้มีผู้เสียชีวิต", "ผู้เสียชีวิต"], critical: ["หายนะครั้งนี้มีผู้เสียชีวิตกว่า 100 ราย", "หายนะครั้งนี้มีผู้เสียชีวิต"] },
  vi: { affirmed: [["Vụ cháy khiến 5 người thiệt mạng.", "5 người thiệt mạng"], ["Cuộc không kích khiến 5 người thiệt mạng.", "5 người thiệt mạng"]], negated: ["Không có ai bị thương.", "bị thương"], hypothetical: ["Bão có thể gây thương vong.", "thương vong"], critical: ["Thảm họa khiến 100 người thiệt mạng.", "thảm họa khiến 100 người thiệt mạng"] },
};

for (const [language, { affirmed, negated, hypothetical, critical }] of Object.entries(languages)) {
  test(`${language}: affirmed consequences escalate; negated, hypothetical and unscaled critical claims do not`, () => {
    for (const [text, impact] of affirmed) {
      assert.doesNotThrow(() => withClaim(text, { impacts: [impact] }), `${text} / ${impact}`);
      assert.throws(() => withClaim(text, { impacts: [impact], impact: "critical" }), /unsupported_escalation/, `${text} critical`);
    }
    for (const [text, impact] of [negated, hypothetical]) {
      assert.doesNotThrow(() => withClaim(impact, { impacts: [impact] }), `${impact} is a recognized consequence on its own`);
      assert.throws(() => withClaim(text, { impacts: [impact] }), /unsupported_escalation/, `${text} / ${impact}`);
    }
    assert.doesNotThrow(() => withClaim(critical[0], { impacts: [critical[1]], impact: "critical" }), critical[0]);
  });
}

test("ambiguous or out-of-lexicon wording fails closed", () => {
  for (const [text, impact] of [
    ["10 إصابات جديدة بكورونا.", "10 إصابات"],
    ["Pengunjuk rasa membayar maut.", "maut"],
    ["参赞参加了会议。", "参赞"],
    ["대사관 참사관이 회의에 참석했다.", "참사관이"],
  ])
    assert.throws(() => withClaim(text, { impacts: [impact] }), /unsupported_escalation/, text);
  assert.throws(
    () => withClaim("Авиакатастрофа: погибли 2 человека.", { impacts: ["погибли 2 человека"], impact: "critical" }),
    /unsupported_escalation/,
  );
});

test("drills are hypothetical in non-European scripts", () => {
  for (const [text, impact] of [
    ["避難訓練で住民が避難した。", "住民が避難"],
    ["消防演练中疏散了200人。", "疏散了200人"],
    ["대피 훈련으로 주민들이 대피했다.", "주민들이 대피했다"],
    ["Tatbikatta bina tahliye edildi.", "tahliye edildi"],
  ]) {
    const claim = { activity: "displacement", violence_mentioned: "no", impacts: [impact] };
    assert.doesNotThrow(() => withClaim(impact, claim), impact);
    assert.throws(() => withClaim(text, claim), /unsupported_escalation/, text);
  }
});

test("official directives are recognized in source-language wording", () => {
  const official = { issuer: "Authority", effective_at: null, expires_at: null };
  for (const [text, instruction] of [
    ["Authorityは住民に直ちに避難してくださいと呼びかけた。", "直ちに避難してください"],
    ["Authority: أخلوا المنطقة فوراً.", "أخلوا المنطقة"],
    ["Authority: оставайтесь дома.", "оставайтесь дома"],
    ["Authority: 就地避难。", "就地避难"],
  ]) {
    const claim = {
      activity: "official_advisory",
      violence_mentioned: "no",
      impacts: [instruction],
      official_instruction: { issuer: "Authority", instruction, effective_at: null, expires_at: null, evidence_ids: ["e1"] },
    };
    assert.doesNotThrow(() => withClaim(text, claim, { official }), text);
  }
});
