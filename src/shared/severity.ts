import type { EventClaim, JobInput } from "./contracts.js";

/**
 * Conservative ew-1 severity guard. It checks explicit consequence language in
 * the claim's own cited evidence; it does not establish semantic entailment.
 */
const HIGH_IMPACT = new Set(["severe", "critical"]);

/**
 * Lowercase regular-expression fragments per language. `~` stands for the
 * rest of a word. Spaced scripts match whole words, optionally with the
 * language's clitics; Chinese, Japanese and Thai match substrings. A term is
 * listed only when it is unambiguous in incident reporting, so unlisted
 * wording fails closed (unsupported_escalation). Coverage and known gaps:
 *
 * | lang  | coverage notes                                                     |
 * | ----- | ------------------------------------------------------------------ |
 * | en    | all categories                                                     |
 * | fr es | all categories                                                     |
 * | pt it | all categories                                                     |
 * | de nl | all categories                                                     |
 * | ru uk | all categories; "катастрофа" (also "crash") is not critical scale  |
 * | ar    | all; bare إصابة/مصاب (also "infection") is not a consequence       |
 * | fa ur | all categories; Persian "مرگ" (slogans) is not a consequence       |
 * | hi bn | all; critical scale is a single phrase each                        |
 * | tr    | all; verbs are listed as exact affirmative forms                   |
 * | id ms | all categories (one table)                                         |
 * | sw    | all; verbs are listed as exact affirmative forms                   |
 * | zh    | all categories, Simplified and Traditional                         |
 * | ja ko | all; negation follows the verb, so any in the clause rejects       |
 * | th    | all; Thai has no clause punctuation, so a clause is a paragraph    |
 * | vi    | all categories                                                     |
 */
type Lexicon = {
  /** Unspaced scripts match terms as substrings instead of whole words. */
  unspaced?: boolean;
  /** Optional clitics that may attach before a term (Arabic proclitics). */
  before?: string;
  /** Optional particles that may attach after a term (Korean case particles). */
  after?: string;
  /** What may sit between a preceding negation and the marker it negates. */
  scope?: string;
  /** Negation that precedes its scope ("no injuries"). */
  negation: string[];
  /** Negation that follows its scope (verb-final languages); any in the clause rejects. */
  negationAfter?: string[];
  /** Modality, plans, forecasts, drills and simulations; any in the clause rejects. */
  hypothetical: string[];
  consequence: string[];
  /** Consequences that support fire and displacement claims; also general consequences. */
  fireOrDisplacement: string[];
  criticalScale: string[];
  instruction: string[];
};

const words = (count: number) =>
  `\\s+(?:[\\p{L}\\p{M}\\p{N}'’-]+\\s+){0,${count}}`;

// prettier-ignore
const LEXICONS: Record<string, Lexicon> = {
  en: {
    negation: ["no", "not", "without", "none"],
    hypothetical: [
      "could", "may", "might", "would", "possible", "potential", "expected",
      "planned", "exercise", "drill", "simulation", "hypothetical",
    ],
    consequence: [
      "killed", "killings", "fatalities", "fatal", "dead", "deaths", "died",
      "injured", "wounded", "hospitali[sz]ed", "life[- ]threatening",
      "serious injuries",
    ],
    fireOrDisplacement: [
      "evacuat~", "displac~", "forced to flee", "made homeless",
      "homes? (?:were )?destroyed", "destroyed (?:\\d+ )?homes?",
      "buildings? (?:were )?destroyed", "destroyed (?:\\d+ )?buildings?",
      "structures? (?:were )?destroyed", "burned homes?", "burnt homes?",
      "large[- ]scale damage", "widespread damage", "devastat~",
    ],
    criticalScale: [
      "extreme(?:ly)?", "catastroph~", "mass casualties", "mass-casualty",
    ],
    instruction: [
      "evacuat~", "shelter(?: in place)?", "leave (?:the )?area",
      "avoid (?:the )?area", "stay indoors", "lockdown",
      "seek immediate (?:shelter|medical help)",
    ],
  },
  fr: {
    negation: ["aucun(?:e)?", "sans", "pas(?!\\s+moins)", "ni"],
    hypothetical: [
      "[ée]ventuel", "possible", "pr[eé]vu", "exercice", "pourrai(?:t|ent)",
      "hypoth[ée]tique",
    ],
    consequence: [
      "morts?", "d[eé]c[eè]s", "tu[eé]e?s?", "bless[eé]e?s?",
      "hospitalis[eé]e?s?",
    ],
    fireOrDisplacement: [
      "[ée]vacu~", "d[eé]plac[eé]e?s?", "sans[- ]abri", "d[eé]truit~",
      "d[ée]vast~",
    ],
    criticalScale: ["catastroph~", "victimes? en masse"],
    instruction: [
      "abrit~", "quittez? (?:la )?zone", "restez? (?:a|à) l['’ ]?int[eé]rieur",
      "h[eé]berg~", "[ée]vacuez",
    ],
  },
  es: {
    negation: ["ningun[oa]?", "ningún", "sin", "ni", "nadie"],
    hypothetical: [
      "podr[ií]an?", "pueden?", "posible", "previsto", "simulacro",
      "potencial", "hipot[ée]tic[oa]s?",
    ],
    consequence: [
      "muert[oa]s?", "fallecid[oa]s?", "herid[oa]s?", "hospitalizad[oa]s?",
    ],
    fireOrDisplacement: [
      "evacu~", "desplazad[oa]s?", "sin hogar", "destruid[oa]s?",
      "devastad[oa]s?",
    ],
    criticalScale: ["cat[aá]str[oó]f~", "v[ií]ctimas? masivas", "extrem[oa]s?"],
    instruction: [
      "refugi~", "desalojen", "permanezcan en el interior", "evacuen",
    ],
  },
  pt: {
    negation: ["não", "nenhum", "nenhuma", "sem", "nem", "ninguém"],
    hypothetical: [
      "poderiam?", "podem?", "poss[ií]vel", "potencial", "previst[oa]s?",
      "planead[oa]s?", "planejad[oa]s?", "simulacro", "simula[cç][aã]o",
      "exerc[ií]cio", "hipot[eé]tic[oa]s?",
    ],
    consequence: [
      "mort[oa]s?", "mortes", "morreu", "morreram", "[óo]bitos",
      "v[ií]timas (?:mortais|fatais)", "ferid[oa]s?", "hospitalizad[oa]s?",
      "internad[oa]s?",
    ],
    fireOrDisplacement: [
      "evacu~", "desalojad[oa]s?", "desabrigad[oa]s?", "deslocad[oa]s?",
      "sem[- ]abrigo", "destru[ií]d[oa]s?", "devasta~",
    ],
    criticalScale: [
      "cat[aá]str[oó]f~", "v[ií]timas em massa", "mortes em massa",
      "extrem[oa]s?",
    ],
    instruction: [
      "evacuem", "(?:abandonem|deixem) a [áa]rea", "fiquem em casa",
      "permane[çc]am em casa", "procurem abrigo", "abriguem-se",
    ],
  },
  it: {
    negation: ["nessun[oa]?", "senza", "non(?!\\s+meno)", "né"],
    hypothetical: [
      "potrebbe(?:ro)?", "possibile", "previsto", "esercitazione",
      "simulazione", "ipotetic~",
    ],
    consequence: ["vittime", "mort[oi]", "ferit[oi]", "ricoverat[oi]"],
    fireOrDisplacement: ["sfollat~", "distrutt~", "evacuazion[ei]"],
    criticalScale: ["catastrof~"],
    instruction: [
      "ripar~", "lasciate? (?:la )?zona", "restare? al chiuso",
    ],
  },
  de: {
    negation: ["kein(?:e|en|er|em)?", "ohne", "nicht(?!\\s+weniger)", "niemand"],
    hypothetical: [
      "k[oö]nnte(?:n)?", "m[oö]glich(?:e|en|er)?", "geplant",
      "voraussichtlich", "[uü]bung", "hypothetisch~",
    ],
    consequence: [
      "verletzte", "verletzten", "verletzt", "tote", "toten", "get[oö]tet", "todesopfer",
      "ums leben gekommen", "gestorben",
    ],
    fireOrDisplacement: ["evaku~", "vertrieben", "obdachlos", "zerst[oö]rt~"],
    criticalScale: ["massaker", "massenopfer", "katastroph~"],
    instruction: ["suchen sie schutz", "bereich verlassen", "bleiben sie im haus"],
  },
  nl: {
    negation: ["geen", "niet(?!\\s+minder)", "zonder", "niemand"],
    hypothetical: [
      "zou(?:den)?", "kan", "mogelijk", "verwacht", "gepland", "oefening",
      "simulatie", "hypothetisch~",
    ],
    consequence: [
      "doden", "dode", "gedood", "omgekomen", "gewonden", "gewond",
      "in het ziekenhuis opgenomen",
    ],
    fireOrDisplacement: [
      "ge[eë]vacueerd", "evacuatie", "dakloos", "verwoest", "ontheemd~",
    ],
    criticalScale: ["catastrof~"],
    instruction: ["ga naar binnen", "blijf binnen", "verlaat het gebied"],
  },
  ru: {
    negation: ["не(?!\\s+(?:менее|меньше|менше))", "без", "ни", "никто", "никого"],
    negationAfter: ["нет"],
    hypothetical: [
      "мо(?:жет|гут|г|гли|гла|гло)", "возможн~", "потенциальн~", "ожида~",
      "планир~", "запланирован~", "учени(?:я|ях|й|е)", "тренировк~",
      "симуляц~", "имитац~", "гипотетическ~", "бы",
    ],
    consequence: [
      "погиб(?:ли|ло|ла|ших|шие|шего|ший)?", "убит(?:а|о|ы|ых|ый|ые)?",
      "скончал~", "жертв(?:а|ы|ам|ами|ах)?", "ранен~", "травмирован~",
      "госпитализирован~",
    ],
    fireOrDisplacement: [
      "эвакуирован~", "эвакуаци~", "переселенц~", "без крова",
      "лишились крова", "разрушен~", "уничтожен~", "сгорел(?:и|о|а)?",
    ],
    criticalScale: [
      "катастрофическ~", "массов(?:ые|ых) жертв~",
      "многочисленн(?:ые|ых) жертв~", "экстремальн~",
    ],
    instruction: [
      "эвакуируйтесь", "покиньте", "оставайтесь (?:дома|в помещени(?:и|ях))",
      "укройтесь", "пройдите в укрытие", "не выходите на улицу",
    ],
  },
  uk: {
    negation: ["не(?!\\s+(?:менее|меньше|менше))", "без", "ні", "ніхто", "жодн~"],
    negationAfter: ["немає", "нема"],
    hypothetical: [
      "мо(?:же|жуть|г|гли|гла|гло)", "можлив~", "потенційн~", "очіку~",
      "планується", "запланован~", "навчання", "тренуван~", "імітаці~",
      "симуляці~", "гіпотетичн~", "би",
    ],
    consequence: [
      "загинул(?:и|а|о)?", "загинув", "загибл~", "вбит(?:а|о|і|их|ий)?",
      "жертв(?:а|и|ам|ами|ах)?", "поранен~", "травмован~",
      "госпіталізован~",
    ],
    fireOrDisplacement: [
      "евакуйован~", "евакуаці~", "внутрішньо переміщен~", "переселенц~",
      "без даху над головою", "зруйнован~", "знищен~", "згорі(?:в|ла|ло|ли)",
    ],
    criticalScale: [
      "катастрофічн~", "масов(?:і|их) жертв~", "численн(?:і|их) жертв~",
    ],
    instruction: [
      "евакуюйтеся", "залиште", "залишайтеся (?:вдома|в приміщенні)",
      "укриття",
    ],
  },
  ar: {
    before: "(?:[وف]?[بكل]?(?:ال)?|[وف]?لل)",
    scope: words(4),
    negation: [
      "لا(?!\\s+[يت]قل)", "لم", "لن", "ليس", "ليست", "دون", "بدون", "عدم",
      "غير",
    ],
    hypothetical: [
      // قد before a past verb (including تم) is affirmative emphasis, not "may".
      "قد(?=\\s+(?!تم(?![\\p{L}\\p{M}]))[يتن])", "ربما", "يمكن", "محتمل~",
      "احتمال~", "متوقع~", "يتوقع", "مقرر~", "مناور~", "تمرين~", "محاكاة",
      "افتراضي~", "لو",
    ],
    consequence: [
      "قتلى", "قتيل~", "مقتل", "مصرع~", "حتف~", "توفي", "توفيت", "وفاة",
      "وفيات", "جرحى", "جريح~", "إصابات (?:خطيرة|بالغة)",
      "نقل(?:وا)? إلى المستشفى",
    ],
    fireOrDisplacement: [
      "نزوح", "نازح~", "نزحوا", "إجلاء", "مشرد~", "دمار", "تدمير", "دمرت",
      "احترق(?:ت)?", "التهمت النيران",
    ],
    criticalScale: ["كارث~", "مجزر~", "مذبح~", "إصابات جماعية", "قتل جماعي"],
    instruction: [
      "إخلاء", "أخلوا", "غادروا", "ابقوا في (?:منازلكم|المنازل|بيوتكم)",
      "لزوم المنازل", "احتموا", "ملاجئ", "ملجأ",
    ],
  },
  fa: {
    negation: ["بدون", "هیچ", "بی"],
    negationAfter: [
      "نشد~", "نداشت~", "ندار~", "نیست", "نبود~", "نکرد~", "ندید~",
    ],
    hypothetical: [
      "ممکن", "احتمال~", "شاید", "می[\\u200c ]?توان~", "پیش[\\u200c ]?بینی",
      "قرار است", "برنامه[\\u200c ]?ریزی", "مانور", "رزمایش",
      "شبیه[\\u200c ]?سازی", "فرضی",
    ],
    consequence: [
      "کشته", "جان باخت~", "جان(?: خود را)? از دست داد~", "فوت کرد~",
      "درگذشت~", "زخمی", "مجروح~", "مصدوم~", "بستری", "تلفات",
    ],
    fireOrDisplacement: [
      "آواره~", "بی[\\u200c ]?خانمان~", "تخلیه شد(?:ند)?", "ویران~",
      "تخریب شد~",
    ],
    criticalScale: ["فاجعه~", "کشتار", "تلفات (?:گسترده|سنگین)"],
    instruction: [
      "تخلیه کنید", "منطقه را ترک کنید", "در (?:خانه|منازل) بمانید",
      "پناه بگیرید",
    ],
  },
  ur: {
    negation: ["بغیر"],
    negationAfter: ["نہیں", "نہ"],
    hypothetical: [
      "ممکن", "شاید", "سکتا", "سکتے", "سکتی", "امکان", "متوقع", "مشق",
      "فرضی",
    ],
    consequence: [
      "ہلاک~", "جاں بحق", "جان بحق", "زخمی", "مارے گئے",
      "(?:اسپتال|ہسپتال) منتقل",
    ],
    fireOrDisplacement: ["انخلا", "نقل مکانی", "بے گھر", "تباہ"],
    criticalScale: ["تباہ کن", "بڑے پیمانے پر ہلاکتیں"],
    instruction: ["انخلا", "علاقہ خالی کر~", "(?:گھروں|گھر) میں رہیں"],
  },
  hi: {
    negation: ["बिना"],
    negationAfter: ["नहीं", "न", "ना"],
    hypothetical: [
      "सकता", "सकते", "सकती", "संभव", "संभावना", "संभावित", "शायद",
      "आशंका", "उम्मीद", "योजना", "प्रस्तावित", "अभ्यास", "मॉक ड्रिल",
      "ड्रिल", "काल्पनिक",
    ],
    consequence: [
      "मौत~", "मृत~", "मारे (?:गए|गये)", "जान गंवा~", "घायल~", "ज़ख्मी",
      "जख्मी", "अस्पताल में भर्ती", "हताहत~",
    ],
    fireOrDisplacement: [
      "विस्थापित~", "बेघर", "नष्ट", "तबाह", "ध्वस्त", "जलकर (?:खाक|राख)",
      "खाली करा~",
    ],
    criticalScale: ["विनाशकारी"],
    instruction: [
      "खाली करें", "(?:घरों|घर) (?:में|के अंदर) रहें",
      "सुरक्षित स्थान(?:ों)? पर जाएं",
    ],
  },
  bn: {
    negation: [],
    negationAfter: [
      "না", "নি", "নেই", "নয়", "হয়নি", "হননি", "যায়নি", "ঘটেনি",
    ],
    hypothetical: [
      "পারে", "সম্ভাবনা", "সম্ভবত", "আশঙ্কা", "পরিকল্পনা", "মহড়া",
      "অনুশীলন", "কাল্পনিক",
    ],
    consequence: [
      "নিহত~", "মৃত্যু~", "মারা (?:গেছে|গেছেন|যান|যায়|গেল)", "আহত~",
      "হতাহত~", "প্রাণহানি~", "হাসপাতালে ভর্তি",
    ],
    fireOrDisplacement: ["বাস্তুচ্যুত~", "গৃহহীন~", "ধ্বংস~", "পুড়ে ছাই"],
    criticalScale: ["ব্যাপক প্রাণহানি"],
    instruction: ["আশ্রয়কেন্দ্র~", "নিরাপদ আশ্রয়ে", "ঘরে থাকুন"],
  },
  tr: {
    negation: ["hiçbir", "hiç"],
    negationAfter: [
      "yok(?:tur)?", "değil", "~madı(?:lar)?", "~medi(?:ler)?",
      "~mamış(?:lar)?", "~memiş(?:ler)?",
    ],
    hypothetical: [
      "~abilir~", "~ebilir~", "muhtemel~", "olası", "beklen~", "planlan~",
      "tatbikat~", "simülasyon~", "varsayımsal", "potansiyel",
    ],
    consequence: [
      "öldü(?:ler)?", "öldürüldü(?:ler)?", "hayatını kaybet~", "can kayb~",
      "ölü~", "yaralandı(?:lar)?", "yaralı~", "hastaneye kaldırıldı(?:lar)?",
    ],
    fireOrDisplacement: [
      "tahliye edil~", "evsiz kal~", "yerinden edil~", "yıkıldı",
      "(?:tamamen )?yandı", "küle döndü",
    ],
    criticalScale: ["felaket~", "katliam~", "toplu ölüm~"],
    instruction: [
      "tahliye ed~", "bölgeyi terk ed~",
      "(?:evde|evlerinizde|kapalı alanlarda) kalın",
    ],
  },
  "id/ms": {
    negation: [
      "tidak(?!\\s+kurang)", "tak(?!\\s+kurang)", "tanpa", "bukan", "belum",
      "tiada",
    ],
    negationAfter: ["nihil"],
    hypothetical: [
      "bisa", "dapat", "boleh", "mungkin", "kemungkinan", "berpotensi",
      "potensi", "diperkirakan", "dijangka", "direncanakan", "dirancang",
      "rencana", "simulasi", "latihan", "hipotetis",
    ],
    consequence: [
      "tewas", "meninggal(?: dunia)?", "korban jiwa", "terbunuh",
      "terkorban", "luka-luka", "terluka", "luka berat", "cedera",
      "dirawat di (?:rumah sakit|hospital)",
    ],
    fireOrDisplacement: [
      "dievakuasi", "evakuasi", "mengungsi", "pengungsi",
      "kehilangan tempat tinggal", "hancur", "hangus", "rusak berat",
    ],
    criticalScale: ["katastrof(?:e|ik)", "malapetaka", "korban massal", "ekstrem"],
    instruction: [
      "mengungsi", "evakuasi", "tetap (?:berada )?di dalam (?:rumah|ruangan)",
      "kekal di dalam rumah", "tinggalkan (?:area|lokasi|kawasan)",
      "(?:hindari|elakkan|jauhi) (?:area|lokasi|kawasan)",
    ],
  },
  sw: {
    negation: ["hakuna", "bila"],
    hypothetical: [
      "huenda", "inawezekana", "~weza", "~tarajiwa", "~pangwa", "zoezi",
      "mazoezi",
    ],
    consequence: [
      "(?:wali|wame|ali|ame|walio|aliye)(?:uawa|fariki|kufa|jeruhiwa)",
      "(?:wali|wame|ali|ame)lazwa hospitalini", "vifo", "majeruhi",
    ],
    fireOrDisplacement: [
      "(?:wali|wame|ali|ame)hamishwa", "(?:wali|wame)kimbia makazi(?: yao)?",
      "hawana makazi", "(?:zili|zime)(?:haribiwa|teketea)",
    ],
    criticalScale: ["maafa makubwa"],
    instruction: ["ondokeni", "hameni", "(?:kaeni|bakini) ndani"],
  },
  zh: {
    unspaced: true,
    scope: "[^,、]{0,8}",
    negation: [
      "没", "沒", "无(?!人机|人機|家可归|家可歸)", "無(?!人机|人機|家可归|家可歸)",
      "未(?!来|來|成年)", "并非", "並非", "零",
    ],
    hypothetical: [
      "可能", "或将", "或將", "或许", "或許", "也许", "也許", "恐将", "恐將",
      "预计", "預計", "预期", "預期", "计划", "計劃", "計畫", "演习", "演習",
      "演练", "演練", "模拟", "模擬", "假设", "假設", "潜在", "潛在",
    ],
    consequence: [
      "死亡", "死者", "遇难", "遇難", "罹难", "罹難", "丧生", "喪生", "身亡",
      "丧命", "喪命", "遇害", "被杀", "被殺", "受伤", "受傷", "伤者", "傷者",
      "负伤", "負傷", "伤亡", "傷亡", "住院", "送医", "送醫",
    ],
    fireOrDisplacement: [
      "撤离", "撤離", "疏散", "流离失所", "流離失所", "无家可归", "無家可歸",
      "房屋被毁", "房屋被毀", "房屋倒塌", "烧毁", "燒毀", "被毁", "被毀",
      "严重破坏", "嚴重破壞",
    ],
    criticalScale: [
      "灾难性", "災難性", "毁灭性", "毀滅性", "大量伤亡", "大量傷亡",
      "重大伤亡", "重大傷亡", "群死群伤", "群死群傷", "特别重大", "特別重大",
      "极端", "極端",
    ],
    instruction: [
      "撤离", "撤離", "疏散", "就地避难", "就地避難", "留在室内", "留在室內",
      "待在室内", "待在室內", "避免外出", "离开该地区", "離開該地區",
      "避开该区域", "避開該區域",
    ],
  },
  ja: {
    unspaced: true,
    negation: [],
    negationAfter: [
      "ない", "なかっ", "なく(?!とも)", "なし", "無し", "ません", "せず",
      "されず", "おらず", "ゼロ",
    ],
    hypothetical: [
      "可能性", "おそれ", "恐れ", "見込み", "予定", "計画", "訓練", "演習",
      "想定", "模擬", "かもしれ", "だろう", "でしょう", "予想", "予測",
    ],
    consequence: [
      "死亡", "死者", "亡くな", "犠牲者", "死傷", "殺害", "負傷", "けが人",
      "怪我人", "重傷", "重体", "心肺停止", "入院", "病院に搬送", "救急搬送",
    ],
    fireOrDisplacement: ["避難", "全焼", "焼失", "倒壊", "全壊"],
    criticalScale: ["壊滅的", "大惨事", "多数の死傷者", "多数の死者"],
    instruction: [
      "避難", "屋内退避", "屋内にとどま", "屋内に留ま", "外出を控え",
      "命を守る行動",
    ],
  },
  ko: {
    after: "(?:이|가|은|는|을|를|의|에|에서|로|으로|와|과|도|만)?",
    negation: ["안", "못"],
    negationAfter: ["~않~", "~없~"],
    hypothetical: [
      "가능성", "~우려~", "예정~", "계획~", "훈련~", "모의~", "가상~", "예상~",
      "수 있~",
    ],
    consequence: [
      "사망~", "숨졌~", "숨진", "숨지~", "목숨을 잃~", "사상자", "희생자",
      "부상자", "부상을 입~", "중상~", "다쳤~", "다친", "입원~", "살해~",
    ],
    fireOrDisplacement: ["대피~", "이재민", "피난~", "전소~", "파괴~"],
    criticalScale: ["대참사", "참사", "재앙적~", "대규모 사상자", "극심한"],
    instruction: ["대피~", "실내에 머무르~", "외출(?:을)? 자제~"],
  },
  th: {
    unspaced: true,
    scope: "[^\\s,]{0,20}",
    negation: ["ไม่(?!ต่ำกว่า)", "ไร้", "ปราศจาก"],
    hypothetical: [
      "อาจ(?!ารย์)", "คาดว่า", "คาดการณ์", "มีแผน", "ซ้อม", "จำลอง", "สมมติ",
      "เป็นไปได้",
    ],
    consequence: [
      "เสียชีวิต", "บาดเจ็บ", "ถูกสังหาร", "ถูกฆ่า", "นำส่งโรงพยาบาล",
      "รักษาตัวในโรงพยาบาล",
    ],
    fireOrDisplacement: ["อพยพ", "ไร้ที่อยู่อาศัย", "ถูกทำลาย"],
    criticalScale: ["หายนะ"],
    instruction: ["อพยพ", "อยู่ในอาคาร", "หลีกเลี่ยงพื้นที่", "ออกจากพื้นที่"],
  },
  vi: {
    negation: [
      "không(?!\\s+(?:dưới|kích|quân|phận|gian|khí))", "chưa",
    ],
    hypothetical: [
      "có thể", "khả năng", "dự kiến", "kế hoạch", "diễn tập", "mô phỏng",
      "giả định", "tiềm ẩn",
    ],
    consequence: [
      "thiệt mạng", "tử vong", "chết", "bị thương", "nhập viện", "bị giết",
      "thương vong",
    ],
    fireOrDisplacement: [
      "sơ tán", "di dời", "mất nhà cửa", "phá (?:hủy|huỷ)", "thiêu rụi",
    ],
    criticalScale: ["thảm (?:họa|hoạ)", "thảm khốc", "cực đoan"],
    instruction: [
      "sơ tán", "ở trong nhà", "rời khỏi khu vực", "tránh xa khu vực",
      "trú ẩn",
    ],
  },
};

const LETTER = "[\\p{L}\\p{M}\\p{N}]";
const CLAUSE_BOUNDARIES = [
  ".",
  "!",
  "?",
  ";",
  "\n",
  "。",
  "؟",
  "؛",
  "۔",
  "।",
  "॥",
];

/** Unicode compatibility forms plus Arabic-script spelling variation (diacritics, tatweel, alef and yeh/kaf forms). */
function fold(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[\u0622\u0623\u0625\u0671]/gu, "\u0627")
    .replace(/[\u0649\u06CC]/gu, "\u064A")
    .replace(/\u06A9/gu, "\u0643");
}

function alternation(lexicon: Lexicon, terms: string[]): string {
  const body = terms
    .map((term) => fold(term).replaceAll("~", "[\\p{L}\\p{M}]*"))
    .join("|");
  return lexicon.unspaced
    ? `(?:${body})`
    : `(?<!${LETTER})${lexicon.before ?? ""}(?:${body})${lexicon.after ?? ""}(?!${LETTER})`;
}

function compile(build: (lexicon: Lexicon) => string | null): RegExp {
  const sources = Object.values(LEXICONS)
    .map(build)
    .filter((source): source is string => source !== null);
  return new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu");
}

const category = (select: (lexicon: Lexicon) => string[] | undefined) =>
  compile((lexicon) => {
    const terms = select(lexicon);
    return terms?.length ? alternation(lexicon, terms) : null;
  });

/** Matches a clause prefix that ends inside the scope of a preceding negation. */
const NEGATION = compile((lexicon) =>
  lexicon.negation.length
    ? `${alternation(lexicon, lexicon.negation)}${lexicon.scope ?? words(3)}$`
    : null,
);
const NEGATION_AFTER = category((lexicon) => lexicon.negationAfter);
const HYPOTHETICAL = category((lexicon) => lexicon.hypothetical);
const FIRE_OR_DISPLACEMENT = category((lexicon) => lexicon.fireOrDisplacement);
const CONSEQUENCE = category((lexicon) => [
  ...lexicon.consequence,
  ...lexicon.fireOrDisplacement,
]);
const CRITICAL_SCALE = category((lexicon) => lexicon.criticalScale);
const ACTIONABLE_INSTRUCTION = category((lexicon) => lexicon.instruction);

function normalize(value: string): string {
  return fold(value).toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function affirmedExactSpan(
  text: string,
  phrase: string,
  patterns: RegExp[],
): boolean {
  const normalizedText = normalize(text);
  const normalizedPhrase = normalize(phrase);
  if (
    !normalizedPhrase ||
    patterns.some((pattern) => !pattern.test(normalizedPhrase))
  )
    return false;
  let foundAffirmed = false;
  let foundUncertain = false;
  let start = normalizedText.indexOf(normalizedPhrase);
  while (start >= 0) {
    const end = start + normalizedPhrase.length;
    const before = normalizedText.slice(0, start);
    const after = normalizedText.slice(end);
    const clauseStart =
      Math.max(
        ...CLAUSE_BOUNDARIES.map((boundary) => before.lastIndexOf(boundary)),
      ) + 1;
    const nextBoundaries = CLAUSE_BOUNDARIES.map((boundary) =>
      after.indexOf(boundary),
    ).filter((index) => index >= 0);
    const clauseEnd =
      end +
      (nextBoundaries.length ? Math.min(...nextBoundaries) : after.length);
    const clause = normalizedText.slice(clauseStart, clauseEnd);
    const markerOffsets = patterns.map((pattern) =>
      normalizedPhrase.search(pattern),
    );
    const hasNegatedMarker = markerOffsets.some((offset) => {
      const prefix = normalizedText.slice(clauseStart, start + offset);
      return NEGATION.test(prefix);
    });
    if (
      hasNegatedMarker ||
      NEGATION_AFTER.test(clause) ||
      HYPOTHETICAL.test(clause)
    )
      foundUncertain = true;
    else foundAffirmed = true;
    start = normalizedText.indexOf(normalizedPhrase, start + 1);
  }
  return foundAffirmed && !foundUncertain;
}

function groundedImpact(
  claim: EventClaim,
  citedText: string,
  pattern: RegExp,
  critical: boolean,
): boolean {
  if (!claim.impacts.length) return false;
  const normalizedEvidence = normalize(citedText);
  const required = critical ? [pattern, CRITICAL_SCALE] : [pattern];
  return claim.impacts.some((impact) => {
    const normalizedImpact = normalize(impact);
    return (
      Boolean(normalizedImpact) &&
      normalizedEvidence.includes(normalizedImpact) &&
      affirmedExactSpan(citedText, normalizedImpact, required)
    );
  });
}

function hasActionableSourceInstruction(
  claim: EventClaim,
  input: JobInput,
  citedText: string,
  critical: boolean,
): boolean {
  const instruction = claim.official_instruction;
  const source = input.official;
  if (!instruction || !source || source.cancelled) return false;
  if (
    !instruction.issuer.trim() ||
    !instruction.instruction.trim() ||
    !source.issuer.trim()
  )
    return false;
  if (normalize(instruction.issuer) !== normalize(source.issuer)) return false;
  if (
    !instruction.evidence_ids.length ||
    !instruction.evidence_ids.every((id) => claim.evidence_ids.includes(id))
  )
    return false;
  if (
    instruction.effective_at !== source.effective_at ||
    instruction.expires_at !== source.expires_at
  )
    return false;
  const ids = new Set(instruction.evidence_ids);
  const instructionEvidence = input.excerpts
    .filter((excerpt) => ids.has(excerpt.id))
    .map((excerpt) => excerpt.text)
    .join("\n");
  const exactSourceSpan = normalize(instructionEvidence).includes(
    normalize(instruction.instruction),
  );
  return (
    exactSourceSpan &&
    groundedImpact(claim, citedText, ACTIONABLE_INSTRUCTION, critical) &&
    affirmedExactSpan(instructionEvidence, instruction.instruction, [
      ACTIONABLE_INSTRUCTION,
    ]) &&
    affirmedExactSpan(citedText, instruction.instruction, [
      ACTIONABLE_INSTRUCTION,
    ])
  );
}

/** Throws the stable error used by the existing v1 result validation boundary. */
export function validateSeverity(claim: EventClaim, input: JobInput): void {
  if (!HIGH_IMPACT.has(claim.impact)) return;
  const ids = new Set(claim.evidence_ids);
  const citedText = input.excerpts
    .filter((excerpt) => ids.has(excerpt.id))
    .map((excerpt) => excerpt.text)
    .join("\n");
  const critical = claim.impact === "critical";
  const consequence = groundedImpact(
    claim,
    citedText,
    claim.activity === "property_damage_fire" ||
      claim.activity === "displacement"
      ? FIRE_OR_DISPLACEMENT
      : CONSEQUENCE,
    critical,
  );
  const instruction = hasActionableSourceInstruction(
    claim,
    input,
    citedText,
    critical,
  );
  if (claim.activity === "other_unknown" || (!consequence && !instruction))
    throw Error("unsupported_escalation");
}
