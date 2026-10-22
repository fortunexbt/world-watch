import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// A release guard for tracked source, not a replacement for credential rotation,
// a history audit, or review of dataset redistribution rights.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbiddenPath =
  /(^|\/)(?:\.openai|\.runtime|\.wrangler|work|node_modules|dist|test-results|playwright-report|evidence)(?:\/|$)|(^|\/)\.(?:worker\.env|dev\.vars(?:\..*)?|env(?:\..*)?)$|\.(?:sqlite(?:3)?|db|pem|p12|key|log)$/i;
// Screenshots reviewed for public release on 22 October 2026. They show only
// public source data and the app UI, with no browser chrome, tokens or paths.
// A new binary fails until it is reviewed and listed here.
const reviewedBinaries = new Set([
  "docs/media/world.jpg",
  "docs/media/thermal.jpg",
  "docs/media/detail.jpg",
  "docs/media/mobile.jpg",
]);
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["provider-token", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ["credential-url", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  [
    "local-home-path",
    /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/(?!ew\/)[A-Za-z0-9._-]+\/)/,
  ],
  ["provider-project-binding", /\bappgprj_[a-f0-9]{20,}\b/],
];
const failures = [];
for (const file of files) {
  if (forbiddenPath.test(file) && ![".env.example"].includes(file))
    failures.push(`${file}: private/generated path`);
  if (!existsSync(file)) {
    failures.push(
      `${file}: tracked file missing (stage deletions before auditing)`,
    );
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.includes(0)) {
    if (!reviewedBinaries.has(file))
      failures.push(`${file}: binary requires explicit public-release review`);
    continue;
  }
  const content = bytes.toString("utf8");
  // Exact negative URL vectors and the Docker image's /home/ew are public fixtures.
  // Do not exempt test files: every other value is scanned normally.
  const syntheticCredentialVectors = [
    "https://user:pass@operator.example",
    "https://user:pass@example.chatgpt.site",
    "https://user:secret@publisher.test/",
    "https://user:secret@example.org/",
  ];
  let scanContent = content;
  for (const vector of syntheticCredentialVectors)
    scanContent = scanContent.replaceAll(vector, "synthetic-invalid-url");
  for (const [label, pattern] of patterns)
    if (pattern.test(scanContent)) failures.push(`${file}: ${label}`);
  if (file.endsWith(".md")) {
    for (const [, raw] of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(?:[a-z]+:|#|\/)/i.test(raw)) continue;
      const target = decodeURIComponent(raw.split("#")[0]);
      if (target && !existsSync(resolve(dirname(file), target)))
        failures.push(`${file}: missing link ${target}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Public-source guard passed for ${files.length} tracked files. History and data-rights review remain separate.`,
  );
}
