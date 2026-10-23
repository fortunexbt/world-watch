// The public demo's stand-in for the API: the read paths the app uses, answered
// from the static snapshot files. There is no write path and no credential.
import {
  MANIFEST,
  type PublicBriefs,
  type PublicFile,
  type PublicIncidents,
  type PublicManifest,
} from "../shared/public-snapshot";
import { textMatch, viewFilter } from "../shared/view";

const DATA = import.meta.env.BASE_URL + "data/";
let manifest: { read: number; value: Promise<PublicManifest> } | undefined;
const files = new Map<string, Promise<any>>();

async function json(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  if (!r.ok) throw Error(`Public snapshot unavailable (${r.status})`);
  return r.json();
}
/** Revalidated at most every 30 seconds; each generation's files are then fetched once. */
export function publicManifest() {
  if (!manifest || Date.now() - manifest.read > 30000) {
    const value = json(DATA + MANIFEST, { cache: "no-cache" });
    manifest = { read: Date.now(), value };
    value.catch(() => (manifest = undefined));
  }
  return manifest.value;
}
async function file<T>(name: PublicFile): Promise<T> {
  const { generated_at } = await publicManifest();
  const url = `${DATA}${name}?v=${encodeURIComponent(generated_at)}`;
  let read = files.get(url);
  if (!read) {
    for (const key of files.keys())
      if (key.startsWith(DATA + name + "?")) files.delete(key);
    read = json(url);
    files.set(url, read);
    read.catch(() => files.delete(url));
  }
  return read;
}

export async function publicRequest(path: string): Promise<any> {
  const u = new URL(path, location.href);
  if (u.pathname === "/api/snapshot") {
    const [{ generated_at }, data] = await Promise.all([
      publicManifest(),
      file<PublicIncidents>("incidents.json"),
    ]);
    const query = (u.searchParams.get("q") ?? "").trim();
    const bbox = u.searchParams.get("bbox")?.split(",").map(Number);
    const view = viewFilter(u.searchParams, bbox);
    return {
      incidents: data.incidents.filter(
        (i) => (!query || textMatch(i, query)) && view(i),
      ),
      incoming: [],
      status: { generated_at },
      cursor: "0",
      sources: data.sources,
      limited: data.limited,
    };
  }
  if (u.pathname === "/api/brief") {
    const briefs = await file<PublicBriefs>("brief.json");
    const hours = u.searchParams.get("hours") as keyof PublicBriefs;
    return { current: briefs[hours] ?? null, pending: false, updated_at: null };
  }
  const detail = u.pathname.match(/^\/api\/incidents\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    const found = (
      await file<PublicIncidents>("incidents.json")
    ).incidents.find((i) => i.id === id);
    if (!found) throw Error("404: not in the current public snapshot");
    return found;
  }
  if (u.pathname === "/api/geospatial") return file("geospatial.json");
  throw Error("Not available in the public demo");
}
