import test from "node:test";
import assert from "node:assert/strict";
import { previewDestination } from "../src/operator/preview-url.js";
const origin = "https://operator.example";
test("owner preview rejects URL-normalization host escapes before credentials can be attached", () => {
  for (const path of [
    "//attacker.invalid/steal",
    "/\\attacker.invalid/steal",
    "/\t/attacker.invalid/steal",
    "/\n/attacker.invalid/steal",
    "/\r/attacker.invalid/steal",
    " /api/snapshot",
    "https://attacker.invalid/steal",
    "/\u0000/attacker.invalid/steal",
    "/\u007f/attacker.invalid/steal",
  ])
    assert.throws(
      () => previewDestination(path, origin),
      /invalid_preview_request_path/,
    );
});
test("owner preview resolves ordinary paths/query and encoded path bytes only to configured origin", () => {
  for (const path of [
    "/",
    "/api/snapshot?hours=24",
    "/?incident=fixture&query=two%20words",
    "/%2f%2fattacker.invalid/steal",
    "/%5cattacker.invalid/steal",
  ]) {
    const target = previewDestination(path, origin);
    assert.equal(target.origin, origin);
    assert.equal(target.username, "");
    assert.equal(target.password, "");
  }
  assert.equal(
    previewDestination("/api/snapshot", "http://127.0.0.1:8787").href,
    "http://127.0.0.1:8787/api/snapshot",
  );
  for (const base of [
    "https://user:pass@operator.example",
    "https://operator.example/path",
    "https://operator.example?x=1",
    "https://operator.example#fragment",
    "file:///tmp/private",
  ])
    assert.throws(
      () => previewDestination("/api/snapshot", base),
      /invalid_preview_upstream_origin/,
    );
});
