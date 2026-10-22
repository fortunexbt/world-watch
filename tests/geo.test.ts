import test from "node:test";
import assert from "node:assert/strict";
import {
  gazetteerIndexed,
  resolveClaimLocation,
  resolveClaimLocations,
} from "../src/server/geo";
import type { EventClaim, JobInput } from "../src/shared/contracts";
const place = (
  name: string,
  country: string | null = null,
  admin: string | null = null,
) => ({ name, country, admin, evidence_ids: ["e1"], uncertainty: null });
const claim = (places: EventClaim["places"]) =>
  ({ places, evidence_ids: ["e1"] }) as EventClaim;
const input = (text: string) =>
  ({ excerpts: [{ id: "e1", text }] }) as JobInput;
// First in the file: later tests build the index.
test("importing geo leaves the gazetteer index to the first lookup, outside Worker start-up", () => {
  assert.equal(gazetteerIndexed(), false);
  resolveClaimLocations(claim([place("Paris", "FR")]), input("À Paris."));
  assert.equal(gazetteerIndexed(), true);
});
test("two explicitly sourced cities yield separate city pins and no synthetic single location", () => {
  const c = claim([place("Paris", "FR"), place("Lyon", "FR")]);
  const i = input("Des rassemblements à Paris et Lyon.");
  assert.deepEqual(
    resolveClaimLocations(c, i).map((x) => x.name),
    ["Paris", "Lyon"],
  );
  assert.equal(resolveClaimLocation(c, i), null);
});
test("same supported city repeated via multilingual aliases is deduplicated", () => {
  const out = resolveClaimLocations(
    claim([place("Roma", "IT"), place("Rome", "IT")]),
    input("Una manifestazione a Roma."),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Rome");
  assert.equal(out[0].accuracy, "city");
  assert.equal(out[0].radius_km, 8);
});
test("explicit source city in structured admin resolves unknown street only at broad city accuracy", () => {
  const c = claim([place("Holskogveien", "NO", "Kristiansand")]);
  assert.equal(
    resolveClaimLocation(
      c,
      input("Politiet i Kristiansand undersøker skade i Holskogveien."),
    )?.name,
    "Kristiansand",
  );
  assert.equal(resolveClaimLocation(c, input("Skade i Holskogveien.")), null);
});
test("unresolved street does not erase independent source-supported city", () => {
  assert.equal(
    resolveClaimLocation(
      claim([place("Kristiansand", "NO"), place("Holskogveien", "NO")]),
      input("I Kristiansand, på Holskogveien, er politiet på stedet."),
    )?.name,
    "Kristiansand",
  );
});
test("ambiguous city, wrong country, unquoted model city and substring do not create pins", () => {
  assert.deepEqual(
    resolveClaimLocations(claim([place("Bergen")]), input("Bergen")),
    [],
  );
  assert.equal(
    resolveClaimLocation(claim([place("Paris", "IT")]), input("Paris")),
    null,
  );
  assert.equal(
    resolveClaimLocation(
      claim([place("Rome", "IT")]),
      input("A meeting at an unknown location."),
    ),
    null,
  );
  assert.equal(
    resolveClaimLocation(
      claim([place("Rome", "IT")]),
      input("Jerome attended."),
    ),
    null,
  );
  const c = claim([place("Paris", "FR")]);
  c.places[0].evidence_ids = ["missing"];
  assert.equal(resolveClaimLocation(c, input("Paris")), null);
});
test("country name supports coarse country scope but source remit alone cannot", () => {
  const out = resolveClaimLocation(
    claim([place("France", "FR")]),
    input("Advice for France."),
  );
  assert.equal(out?.accuracy, "country");
  assert.equal(out?.country, "FR");
  assert.equal(
    resolveClaimLocation(
      claim([place("unknown station", "FR")]),
      input("Unknown station."),
    ),
    null,
  );
});
test("issuer-supplied geometry remains supported; distant multi-city claims stay separate", () => {
  const i = input("Paris and Lyon");
  i.source_geo = {
    name: "Issuer warning area",
    lat: 48.85,
    lon: 2.35,
    accuracy: "area",
    radius_km: 20,
  };
  assert.equal(resolveClaimLocation(claim([]), i)?.name, "Issuer warning area");
  assert.equal(
    resolveClaimLocations(claim([place("Paris", "FR"), place("Lyon", "FR")]), i)
      .length,
    2,
  );
});

test('a strike calendar province or operator name is not municipal incident geometry',()=>{const i={...input('Regione: Veneto Provincia: Venezia Sindacati: SGB. Personale ATVO di Venezia.'),source_id:'it-mit-strikes'} as JobInput;assert.equal(resolveClaimLocation(claim([place('Venice','IT')]),i),null);assert.deepEqual(resolveClaimLocations(claim([place('Venezia','IT')]),i),[]);});

test("worldwide cities resolve from source-quoted names, aliases and other scripts", () => {
  for (const [name, country, text, lat] of [
    ["Lagos", "NG", "Traders marched in Lagos on Monday.", 6.45407],
    ["Jakarta", "ID", "Unjuk rasa di Jakarta, Selasa.", -6.21462],
    ["Sao Paulo", "BR", "Ato em São Paulo nesta tarde.", -23.5475],
    ["Dhaka", "BD", "ঢাকা, মঙ্গলবার: শিক্ষার্থীদের মিছিল।", 23.7104],
    ["Karachi", "PK", "Strike called in Karachi.", 24.8608],
    ["Suva", "FJ", "Flooding closed roads in Suva.", -18.13683],
    ["東京都", "JP", "東京都、抗議集会。", 35.6895],
  ] as const) {
    const out = resolveClaimLocation(
      claim([place(name, country)]),
      input(text),
    );
    assert.equal(out?.accuracy, "city", name);
    assert.equal(out?.country, country, name);
    assert.equal(out?.lat, lat, name);
  }
});
test("names shared across continents stay ambiguous until country or admin context decides", () => {
  for (const name of ["Lagos", "San José", "Córdoba", "Hyderabad", "Paris"])
    assert.deepEqual(
      resolveClaimLocations(claim([place(name)]), input(`News from ${name}.`)),
      [],
      name,
    );
  assert.equal(
    resolveClaimLocation(claim([place("Hyderabad", "PK")]), input("Hyderabad"))
      ?.lat,
    25.39689,
  );
  assert.equal(
    resolveClaimLocation(claim([place("Córdoba", "AR")]), input("Córdoba"))
      ?.country,
    "AR",
  );
  // GeoNames lists two Costa Rican San José localities; only the province code separates them.
  assert.equal(
    resolveClaimLocation(claim([place("San José", "CR")]), input("San José")),
    null,
  );
  assert.equal(
    resolveClaimLocation(
      claim([place("San José", "CR", "08")]),
      input("San José"),
    )?.country,
    "CR",
  );
});
test("machine romanisations and numeric codes are not source support", () => {
  assert.equal(
    resolveClaimLocation(claim([place("Dhaka", "BD")]), input("thaka")),
    null,
  );
  assert.equal(
    resolveClaimLocation(claim([place("Kyiv", "UA")]), input("kiv")),
    null,
  );
  assert.deepEqual(
    resolveClaimLocations(claim([place("4")]), input("4 people")),
    [],
  );
});
test("small states fall back to their own country scope rather than a 250 km circle", () => {
  const out = resolveClaimLocation(
    claim([place("Bahrain", "BH")]),
    input("Protests across Bahrain."),
  );
  assert.equal(out?.accuracy, "country");
  assert.equal(out?.country, "BH");
  assert.ok(out!.radius_km < 50);
  assert.equal(
    resolveClaimLocation(claim([place("Russia", "RU")]), input("Russia"))
      ?.radius_km,
    250,
  );
});
