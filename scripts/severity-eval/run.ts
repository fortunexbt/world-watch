import { readFile, writeFile } from "node:fs/promises";
import { evaluate, type Dataset } from "./lib.js";

const dataset = JSON.parse(
  await readFile(new URL("../../eval/severity/dataset.json", import.meta.url), "utf8"),
) as Dataset;
const results = evaluate(dataset);
await writeFile(
  new URL("../../eval/severity/results.json", import.meta.url),
  JSON.stringify(results, null, 1) + "\n",
);

const pct = (m: { value: number | null; ci95: [number, number] | null }) =>
  m.value === null ? "n/a" : `${(m.value * 100).toFixed(1)}% [${((m.ci95?.[0] ?? NaN) * 100).toFixed(1)}, ${((m.ci95?.[1] ?? NaN) * 100).toFixed(1)}]`;
console.log(`${results.documents} documents, ${results.events} events (${results.severe_events} PAGER orange/red)`);
for (const p of results.proposers) {
  console.log(`\n${p.proposer}`);
  for (const k of ["ungated", "gated"] as const)
    console.log(
      `  ${k.padEnd(8)} FER ${pct(p[k].false_escalation_rate)}  precision ${pct(p[k].precision)}  recall ${pct(p[k].recall)}  (tp ${p[k].tp} fp ${p[k].fp} fn ${p[k].fn} tn ${p[k].tn})`,
    );
  console.log(`  FER change ${pct(p.false_escalation_change)}`);
}
