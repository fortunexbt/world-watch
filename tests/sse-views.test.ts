import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import server from "../src/server/index";
import { env, migrate, OWNER, seedStore, sqliteD1 } from "../scripts/synthetic";

/** Events up to the stream's first heartbeat, as the client's EventSource would receive them. */
async function events(db: DatabaseSync) {
  const controller = new AbortController();
  const response = await server.fetch(
    new Request("https://fixture.invalid/api/events?cursor=0", {
      headers: { authorization: "Bearer " + OWNER },
      signal: controller.signal,
    }),
    env(sqliteD1(db)),
  );
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes(": heartbeat")) text += (await reader.read()).value;
  controller.abort();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("id: "))
    .map((block) => ({
      type: block.match(/^event: (.*)$/m)![1],
      data: JSON.parse(block.match(/^data: (.*)$/m)![1]),
    }));
}

test("incident events carry the rights-checked list view, so clients need no detail read", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seedStore(db, { incidents: 6, revised: 0, rules: 0, days: 1, seed: 5 });
  const created = (await events(db)).filter((e) => e.type === "incident.created");
  assert.ok(created.length > 0);
  for (const { data } of created) {
    const stored = JSON.parse(String((db.prepare("SELECT view FROM incidents WHERE id=?").get(data.incident_id) as any).view));
    assert.equal(data.incident.id, data.incident_id);
    assert.equal(data.incident.version, data.version);
    assert.equal(data.incident.headline, stored.headline);
    assert.equal(data.incident.summary_en, undefined);
    assert.equal(data.incident.reports[0].rights.basis, undefined);
    assert.equal(typeof data.incident.reports[0].rights.display, "boolean");
  }
  // Withdrawn display rights leave the event bare; the client's detail read then refuses it.
  const source = created[0].data.incident.reports[0].source_id;
  const record = JSON.parse(String((db.prepare("SELECT record FROM sources WHERE id=?").get(source) as any).record));
  db.prepare("UPDATE sources SET record=? WHERE id=?").run(JSON.stringify({ ...record, rights: { ...record.rights, display: false } }), source);
  const withdrawn = (await events(db)).filter((e) => e.type === "incident.created");
  assert.ok(withdrawn.some((e) => e.data.incident === undefined));
  assert.ok(withdrawn.every((e) => !e.data.incident || e.data.incident.reports.every((r: any) => r.source_id !== source)));
});
