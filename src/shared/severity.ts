import type { EventClaim, JobInput } from "./contracts.js";

/**
 * Conservative ew-1 severity guard. It checks explicit consequence language in
 * the claim's own cited evidence; it does not establish semantic entailment.
 */
const HIGH_IMPACT = new Set(["severe", "critical"]);
const NEGATION =
  /(?:\bno\b|\bnot\b|\bwithout\b|\bnone\b|\bkein(?:e|en|er)?\b|\bohne\b|\baucun(?:e)?\b|\bsans\b|\bningun[oa]?\b|\bsin\b|\bnessun[oa]?\b|\bsenza\b)\s+(?:\w+\s+){0,3}$/iu;
const HYPOTHETICAL =
  /\b(?:could|may|might|would|possible|potential|expected|planned|exercise|drill|simulation|hypothetical|podr[ií]a|posible|previsto|simulacro|potrebbe|possibile|previsto|esercitazione|k[oö]nnte|m[oö]glich|geplant|[ée]ventuel|possible|pr[eé]vu|exercice)\b/iu;

const CONSEQUENCE =
  /\b(?:killed|killings|fatalities|fatal|dead|deaths|died|injured|wounded|hospitali[sz]ed|life[- ]threatening|serious injuries|homes? (?:were )?destroyed|destroyed (?:\d+ )?homes?|buildings? (?:were )?destroyed|destroyed (?:\d+ )?buildings?|structures? (?:were )?destroyed|evacuat\w*|displaced|forced to flee|made homeless|burned homes?|burnt homes?|large[- ]scale damage|widespread damage|devastat\w*|morts?|d[eé]c[eè]s|tu[eé]s?|bless[eé]s?|hospitalis[eé]s?|d[eé]plac[eé]s?|sans[- ]abri|d[eé]truit\w*|sfollat\w*|distrutt\w*|vittime|verletzte|tote|get[oö]tet|evaku\w*|vertrieben|obdachlos|zerst[oö]rt\w*)\b/iu;
const FIRE_OR_DISPLACEMENT =
  /\b(?:evacuat\w*|displac\w*|forced to flee|made homeless|homes? (?:were )?destroyed|destroyed (?:\d+ )?homes?|buildings? (?:were )?destroyed|destroyed (?:\d+ )?buildings?|structures? (?:were )?destroyed|burned homes?|burnt homes?|large[- ]scale damage|widespread damage|devastat\w*|d[eé]plac[eé]s?|sans[- ]abri|d[eé]truit\w*|sfollat\w*|distrutt\w*|vertrieben|obdachlos|zerst[oö]rt\w*)\b/iu;
const CRITICAL_SCALE =
  /\b(?:extreme(?:ly)?|catastroph\w*|mass casualties|mass-casualty|victimes? en masse|massaker|catastrofic\w*|catastrof\w*|massenopfer|katastroph\w*|v[ií]ctimas? masivas)\b/iu;
const ACTIONABLE_INSTRUCTION =
  /\b(?:evacuat\w*|shelter(?: in place)?|leave (?:the )?area|avoid (?:the )?area|stay indoors|lockdown|seek immediate (?:shelter|medical help)|abrit\w*|quittez? (?:la )?zone|restez? (?:a|à) l[' ]?int[eé]rieur|ripar\w*|lasciate? (?:la )?zona|restare? al chiuso|suchen sie schutz|bereich verlassen|bleiben sie im haus|h[eé]berg\w*|refugi\w*|desalojen|permanezcan en el interior)\b/iu;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
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
        before.lastIndexOf("."),
        before.lastIndexOf("!"),
        before.lastIndexOf("?"),
        before.lastIndexOf(";"),
        before.lastIndexOf("\n"),
      ) + 1;
    const nextBoundaries = [".", "!", "?", ";", "\n"]
      .map((boundary) => after.indexOf(boundary))
      .filter((index) => index >= 0);
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
    if (hasNegatedMarker || HYPOTHETICAL.test(clause)) foundUncertain = true;
    else foundAffirmed = true;
    start = normalizedText.indexOf(normalizedPhrase, start + 1);
  }
  return foundAffirmed && !foundUncertain;
}

function groundedImpact(
  claim: EventClaim,
  citedText: string,
  patterns: RegExp[],
  critical: boolean,
): boolean {
  if (!claim.impacts.length) return false;
  const normalizedEvidence = normalize(citedText);
  const required = critical ? [...patterns, CRITICAL_SCALE] : patterns;
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
    groundedImpact(claim, citedText, [ACTIONABLE_INSTRUCTION], critical) &&
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
  const consequence =
    claim.activity === "property_damage_fire" ||
    claim.activity === "displacement"
      ? groundedImpact(
          claim,
          citedText,
          [FIRE_OR_DISPLACEMENT, CONSEQUENCE],
          critical,
        )
      : groundedImpact(claim, citedText, [CONSEQUENCE], critical);
  const instruction = hasActionableSourceInstruction(
    claim,
    input,
    citedText,
    critical,
  );
  if (claim.activity === "other_unknown" || (!consequence && !instruction))
    throw Error("unsupported_escalation");
}
