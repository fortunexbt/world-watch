// Writes the public demo's static data files. Usage:
//   tsx scripts/public-snapshot.ts --out <dir> [--previous <published site URL>]
// --previous lets a run build on the published snapshot: it reuses a recent
// thermal and mapping catalogue and keeps a failed source's last records up for
// a bounded time. No model runs and no private file is read.
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildPublicSnapshot } from "../src/public/snapshot.js";
import { MANIFEST, PUBLIC_FILE_LIMITS } from "../src/shared/public-snapshot.js";

const { values } = parseArgs({
  options: { out: { type: "string" }, previous: { type: "string" } },
});
if (!values.out)
  throw Error("usage: public-snapshot --out <dir> [--previous <url>]");
const out = path.resolve(values.out);

/** One published file, or nothing when it is missing, unreadable or over its ceiling. */
async function published(site: string, name: keyof typeof PUBLIC_FILE_LIMITS) {
  try {
    const r = await fetch(new URL("data/" + name, site), {
      signal: AbortSignal.timeout(15000),
    });
    const text = r.ok ? await r.text() : "";
    return text && Buffer.byteLength(text) <= PUBLIC_FILE_LIMITS[name]
      ? JSON.parse(text)
      : undefined;
  } catch {
    // A first deployment or an unreachable site starts from the sources alone.
    return undefined;
  }
}

const site = values.previous;
const snapshot = await buildPublicSnapshot({
  resolveHost: async (host) =>
    (await lookup(host, { all: true })).map((x) => x.address),
  previous: site
    ? {
        manifest: await published(site, MANIFEST),
        incidents: await published(site, "incidents.json"),
        geospatial: await published(site, "geospatial.json"),
      }
    : undefined,
});
await mkdir(out, { recursive: true });
for (const [name, text] of snapshot.files)
  await writeFile(path.join(out, name), text);
for (const s of snapshot.manifest.sources)
  console.log(
    `${s.id}: ${s.status}, ${s.received} records${s.error ? ` (${s.error})` : ""}${s.carried_forward ? `, ${s.carried_forward} kept from the previous snapshot` : ""}`,
  );
for (const layer of snapshot.manifest.layers)
  console.log(
    `${layer.id}: ${layer.status}, ${layer.features_count} of ${layer.total_available}, checked ${layer.checked_at}${layer.error ? ` (${layer.error})` : ""}`,
  );
for (const [name, { bytes }] of Object.entries(snapshot.manifest.files))
  console.log(`${name}: ${bytes} bytes`);
console.log(`Snapshot ${snapshot.manifest.generated_at} written to ${out}`);
