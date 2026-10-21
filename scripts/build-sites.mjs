import { build } from "esbuild";
import { readFile, readdir, mkdir, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
let hosting;
try {
  hosting = JSON.parse(
    await readFile(path.join(root, ".openai/hosting.json"), "utf8"),
  );
} catch (error) {
  if (error.code === "ENOENT")
    throw Error(
      "Sites packaging needs your own local .openai/hosting.json; configure your own project using deploy/hosting.example.json. No hosting binding is supplied by this repository.",
    );
  throw error;
}
if (
  !hosting.project_id ||
  hosting.project_id === "YOUR_PROJECT_ID" ||
  hosting.d1 !== "DB" ||
  hosting.r2 !== null
)
  throw Error("Sites requires persisted project_id, d1:DB and r2:null");
const journal = JSON.parse(
  await readFile(path.join(root, "drizzle/meta/_journal.json"), "utf8"),
);
if (!journal.entries?.length) throw Error("Sites D1 schema migrations missing");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const assets = {};
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if ([".openai", "server"].includes(item.name)) continue;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) await walk(absolute);
    else if (item.isFile())
      assets["/" + path.relative(dist, absolute).split(path.sep).join("/")] = {
        mime: mime[path.extname(item.name)] ?? "application/octet-stream",
        base64: (await readFile(absolute)).toString("base64"),
      };
    else
      throw Error(
        "Symlink or special file is not allowed in the Site asset bundle",
      );
  }
}
await walk(dist);
if (
  !assets["/index.html"] ||
  !Object.keys(assets).some((p) => p.endsWith(".js"))
)
  throw Error("Run npm run build before building the Sites Worker ESM");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/sites-entry.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { __EW_SITE_ASSETS__: JSON.stringify(assets) },
});
const worker = result.outputFiles[0].text;
// The module must parse without Node/runtime credentials or external module resolution.
const module = await import(
  "data:text/javascript;base64," + Buffer.from(worker).toString("base64")
);
if (typeof module.default?.fetch !== "function")
  throw Error("Sites Worker default.fetch missing");
// Replace only after the complete Worker has successfully bundled and validated.
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "server"), { recursive: true });
await mkdir(path.join(dist, ".openai"), { recursive: true });
await writeFile(path.join(dist, "server/index.js"), worker);
await writeFile(
  path.join(dist, ".openai/hosting.json"),
  JSON.stringify(hosting, null, 2) + "\n",
);
await cp(path.join(root, "drizzle"), path.join(dist, ".openai/drizzle"), {
  recursive: true,
});
console.log(
  JSON.stringify({
    artifact: "dist/server/index.js",
    bytes: Buffer.byteLength(worker),
    embedded_assets: Object.keys(assets).length,
    migrations: journal.entries.length,
  }),
);
