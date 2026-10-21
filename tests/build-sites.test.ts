import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
test("Sites packaging without an operator manifest fails clearly before writing any bundle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-public-packaging-"));
  try {
    await mkdir(path.join(dir, "scripts"));
    await copyFile(
      "scripts/build-sites.mjs",
      path.join(dir, "scripts/build-sites.mjs"),
    );
    await symlink(
      path.resolve("node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(dir, "scripts/build-sites.mjs")],
      { cwd: dir, encoding: "utf8", timeout: 15000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Sites packaging needs your own local \.openai\/hosting\.json/,
    );
    assert.match(result.stderr, /deploy\/hosting\.example\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
