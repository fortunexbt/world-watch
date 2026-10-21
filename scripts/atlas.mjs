import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { isIP } from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const folder = resolve(root, "research/world-atlas");
// 193 UN members plus Holy See and State of Palestine. Territories and other
// monitoring areas may be retained separately without silently changing the gate.
export const targetCountries =
  "AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW".split(
    " ",
  );
assert.equal(new Set(targetCountries).size, 195);

export function canonicalHost(raw) {
  const u = new URL(raw);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.includes(".") ||
    Boolean(isIP(u.hostname.replace(/^\[|\]$/g, ""))) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(
      u.hostname,
    ) ||
    u.hostname.endsWith(".invalid") ||
    u.hostname.endsWith(".example")
  )
    throw new Error("not_public_source_url");
  return u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export function normalizeRows(rows) {
  const records = new Map();
  for (const [index, row] of rows.entries()) {
    const country = String(row.country_code || "").toUpperCase();
    if (
      !/^[A-Z]{2}$/.test(country) ||
      !row.name ||
      !row.source_family ||
      !row.provenance_url ||
      row.status !== "discovered"
    )
      throw new Error(`invalid_candidate_row_${index + 1}`);
    const host = canonicalHost(row.url);
    const provenance = new URL(row.provenance_url);
    if (
      !["https:", "http:"].includes(provenance.protocol) ||
      provenance.username ||
      provenance.password
    )
      throw new Error(`invalid_provenance_${index + 1}`);
    const id = createHash("sha256").update(host).digest("hex").slice(0, 20);
    let record = records.get(host);
    if (!record) {
      record = {
        id,
        host,
        name: row.name,
        url: row.url,
        country_memberships: [],
        source_families: [],
        provenance_urls: [],
        status: "discovered",
        content_rights: "unreviewed",
        integration: "none",
        origin_independence: "unknown",
        records: [],
      };
      records.set(host, record);
    }
    for (const [key, value] of [
      ["country_memberships", country],
      ["source_families", row.source_family],
      ["provenance_urls", row.provenance_url],
    ])
      if (!record[key].includes(value)) record[key].push(value);
    const signature = JSON.stringify([
      country,
      row.name,
      row.url,
      row.provenance_url,
    ]);
    if (
      !record.records.some(
        (r) =>
          JSON.stringify([r.country_code, r.name, r.url, r.provenance_url]) ===
          signature,
      )
    )
      record.records.push(row);
  }
  return [...records.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export function researchCandidate(record) {
  return (
    record.source_families.some((f) =>
      ["news_agency", "newspaper", "online_news"].includes(f),
    ) ||
    record.records.some(
      (r) => r.research_lane && r.research_lane !== "catalog-candidates.jsonl",
    )
  );
}

export function coverage(records) {
  const codes = new Set([
    ...targetCountries,
    ...records.flatMap((r) => r.country_memberships),
  ]);
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  return [...codes].sort().map((code) => {
    const sources = records.filter((r) => r.country_memberships.includes(code));
    const focused = sources.filter(researchCandidate);
    return {
      country_code: code,
      name: names.of(code),
      target_country: targetCountries.includes(code),
      target: targetCountries.includes(code) ? 50 : null,
      discovered_unique_hosts: sources.length,
      news_or_curated_candidates: focused.length,
      other_media_review_only: sources.length - focused.length,
      target_shortfall: targetCountries.includes(code)
        ? Math.max(0, 50 - focused.length)
        : null,
      access_verified: 0,
      rights_approved: 0,
      live_integrations: 0,
    };
  });
}

if (process.argv.includes("--self-test")) {
  const sample = {
    country_code: "IT",
    name: "Test publisher",
    url: "https://www.publisher.test/news",
    source_family: "reporting",
    provenance_url: "https://catalog.test/item",
    status: "discovered",
    research_lane: "curated-test",
  };
  const records = normalizeRows([
    sample,
    { ...sample, url: "https://publisher.test/feed" },
    { ...sample, country_code: "FR" },
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].country_memberships, ["IT", "FR"]);
  assert.equal(coverage(records).filter((r) => r.target_country).length, 195);
  assert.equal(
    coverage(records).find((r) => r.country_code === "IT").target_shortfall,
    49,
  );
  assert.throws(() => normalizeRows([{ ...sample, status: "live" }]));
  for (const url of [
    "https://user:secret@publisher.test/",
    "file:///etc/passwd",
    "http://127.0.0.1/data",
  ])
    assert.throws(() => canonicalHost(url));
  console.log(
    "Atlas checks passed: identity, country membership, honest gate counts and URL/status validation.",
  );
} else if (process.argv.includes("--build")) {
  const inputs = [
    "catalog-candidates.jsonl",
    "asia-oceania.jsonl",
    "americas-africa.jsonl",
  ];
  const rows = inputs
    .filter((name) => existsSync(resolve(folder, name)))
    .flatMap((name) =>
      readFileSync(resolve(folder, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ ...JSON.parse(line), research_lane: name })),
    );
  if (!rows.length) throw new Error("no_candidate_inputs");
  const rejected = [];
  const retained = rows.filter((row) => {
    try {
      canonicalHost(row.url);
      return true;
    } catch {
      rejected.push({
        country_code: row.country_code,
        name: row.name,
        url: row.url,
        provenance_url: row.provenance_url,
        reason: "unsupported_literal_address_or_invalid_hostname",
      });
      return false;
    }
  });
  const records = normalizeRows(retained);
  const table = coverage(records);
  const stats = {
    scope: "publisher/source-country candidates, not verified event coverage",
    target_countries: 195,
    target_memberships: 9750,
    candidate_input_rows: rows.length,
    rejected_candidate_rows: rejected.length,
    unique_hosts: records.length,
    news_or_curated_candidate_hosts: records.filter(researchCandidate).length,
    other_media_review_only_hosts: records.filter((r) => !researchCandidate(r))
      .length,
    country_codes_with_candidates: table.filter(
      (r) => r.discovered_unique_hosts > 0,
    ).length,
    countries_at_discovery_target: table.filter(
      (r) => r.target_country && r.news_or_curated_candidates >= 50,
    ).length,
    countries_below_discovery_target: table.filter(
      (r) => r.target_country && r.news_or_curated_candidates < 50,
    ).length,
    access_verified: 0,
    rights_approved: 0,
    live_integrations: 0,
  };
  writeFileSync(
    resolve(folder, "rejected-candidates.json"),
    JSON.stringify(rejected, null, 2) + "\n",
  );
  writeFileSync(
    resolve(folder, "sources.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(folder, "coverage.json"),
    JSON.stringify({ stats, countries: table }, null, 2) + "\n",
  );
  writeFileSync(
    resolve(folder, "COVERAGE.md"),
    "# Source-atlas coverage\n\nGenerated by `node scripts/atlas.mjs --build`. Counts are deduplicated hosts associated with a country in a discovery catalogue or curated record. The research target counts news-agency/newspaper/online-news candidates plus curated specialist sources; bulk magazines, radio, television and other broadcasters require review and do not count toward it. They do not establish operational access, original reporting, country-wide coverage, publisher independence or permission to process content.\n\n```json\n" +
      JSON.stringify(stats, null, 2) +
      "\n```\n\n| Country | Code | Target | News / curated leads | Other media review | Research shortfall |\n| --- | --- | ---: | ---: | ---: | ---: |\n" +
      table
        .map(
          (c) =>
            `| ${c.name} | ${c.country_code} | ${c.target ?? "separate area"} | ${c.news_or_curated_candidates} | ${c.other_media_review_only} | ${c.target_shortfall ?? "—"} |`,
        )
        .join("\n") +
      "\n",
  );
  console.log(JSON.stringify(stats));
} else {
  console.log(
    "node scripts/atlas.mjs --self-test | --build (local metadata only; no fetches, models or application jobs)",
  );
}
