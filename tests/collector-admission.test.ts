import test from "node:test";
import assert from "node:assert/strict";
import { sourceEligibility, collectSources } from "../src/collector/index";
import { sourceRegistry } from "../src/collector/registry";
import {
  parseFeed,
  parseSiri,
  parseMitStrikes,
  parseSwedenPolice,
  parseParisEvents,
} from "../src/collector/parsers";
import type { ObservationInput } from "../src/shared/contracts";
const clock = Date.parse("2026-10-21T12:00:00Z");
const fcdo = {
  ...sourceRegistry.find((s) => s.id === "fcdo-fr")!,
  config: {
    ...sourceRegistry.find((s) => s.id === "fcdo-fr")!.config,
    context_only: false,
  },
};
const sncf = sourceRegistry.find((s) => s.id === "fr-sncf-siri")!;
const dpc = sourceRegistry.find((s) => s.id === "it-dpc-notizia")!;
const row = (
  body: string,
  extra: Partial<ObservationInput> = {},
): ObservationInput => ({
  source_id: "fixture",
  native_id: "fixture",
  canonical_url: "https://example.invalid",
  title: body,
  original_language: "en",
  published_at: "2026-10-21T10:00:00Z",
  source_updated_at: null,
  input_coverage: "permitted_excerpt",
  excerpts: [{ id: "description", text: body }],
  ...extra,
});
test("FCDO excludes clear administrative changes but keeps public-safety and peaceful political signals", () => {
  for (const text of [
    "Updated entry requirements for passports.",
    "Changes to visa requirements.",
    "Updated information on vaccinations and travel insurance.",
  ])
    assert.equal(
      sourceEligibility(fcdo, row(text), clock).eligible,
      false,
      text,
    );
  for (const text of [
    "Updated entry requirements; demonstrations planned in Paris.",
    "Curfews and evacuation advice updated.",
    "Security information updated.",
    "A peaceful planned protest.",
    "Updated safety and health advice following an outbreak.",
    "Updated advice; nature unclear.",
  ])
    assert.equal(
      sourceEligibility(fcdo, row(text), clock).eligible,
      true,
      text,
    );
});
test("SNCF strict admission keeps public safety/strikes/major closures and rejects routine train circulation", () => {
  for (const text of [
    "Les dernières voitures ne seront pas à quai.",
    "The last coaches will not be at the platform.",
    "Die letzten Wagen sind nicht am Bahnsteig.",
    "Los últimos coches no estarán en el andén.",
    "Le ultime carrozze non sono al marciapiede.",
    "De laatste rijtuigen staan niet aan het perron.",
    "Des travaux sont prévus sur la ligne 52.",
    "Scheduled engineering works.",
    "Lavori programmati.",
  ])
    assert.equal(
      sourceEligibility(sncf, row(text), clock).eligible,
      false,
      text,
    );
  for (const text of [
    "La ligne est totalement interrompue après un incendie.",
    "Une grève est prévue demain.",
    "A peaceful planned demonstration.",
    "Des travaux urgents après un incendie.",
    "La circulation des trains est interrompue entre Paris et Lyon.",
  ])
    assert.equal(
      sourceEligibility(sncf, row(text), clock).eligible,
      true,
      text,
    );
  assert.equal(
    sourceEligibility(
      sncf,
      row("Votre train est annulé pour une panne technique."),
      clock,
    ).eligible,
    false,
  );
  assert.equal(
    sourceEligibility(sncf, row("Unknown service effect."), clock).eligible,
    false,
  );
  assert.equal(
    sourceEligibility(
      sncf,
      row("Plus d’informations.", {
        excerpts: [{ id: "summary", text: "Plus d’informations." }],
      }),
      clock,
    ).reason,
    "generic_placeholder_without_event_description",
  );
});
test("30-day archive cutoff never removes recent corrections, undated input or explicit future events", () => {
  const old = row("An old institutional announcement.", {
    published_at: "2026-01-05T00:00:00Z",
  });
  assert.equal(
    sourceEligibility(dpc, old, clock).reason,
    "archive_outside_monitoring_window",
  );
  for (const x of [
    { ...old, source_updated_at: "2026-10-21T10:00:00Z" },
    { ...old, published_at: null },
    {
      ...old,
      official: {
        issuer: "issuer",
        effective_at: "2026-10-25T00:00:00Z",
        expires_at: null,
      },
    },
    row("Evento previsto il 25 ottobre 2026.", {
      published_at: old.published_at,
    }),
    row("Planned meeting on October 25, 2026.", {
      published_at: old.published_at,
    }),
    row("Scheduled event 2026-10-25.", { published_at: old.published_at }),
  ])
    assert.equal(
      sourceEligibility(dpc, x, clock).eligible,
      true,
      JSON.stringify(x),
    );
  assert.equal(old.excerpts[0].text, "An old institutional announcement.");
});
test("trusted upstream episode identifiers group Norway updates but not unrelated SIRI situations", () => {
  const no = sourceRegistry.find((s) => s.id === "no-politiloggen")!;
  const rows = parseFeed(
    no,
    '<feed><entry><id>a</id><title>One</title><link href="https://www.politiet.no/politiloggen/hendelse/26bwwd/0"/></entry><entry><id>b</id><title>Two</title><link href="https://www.politiet.no/politiloggen/hendelse/26bwwd/2"/></entry></feed>',
  );
  assert.equal(rows[0].source_event_id, "politiloggen:26bwwd");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].native_id, "politiloggen:26bwwd");
  assert.deepEqual(
    rows[0].source_reports?.map((r) => r.native_id),
    ["a", "b"],
  );
  assert.match(rows[0].excerpts[0].text, /One/);
  assert.match(rows[0].excerpts[1].text, /Two/);
  assert.equal(rows[0].excerpts[0].id, "a:title");
  assert.equal(rows[0].input_coverage, "permitted_excerpt");
  const item = (id: string) =>
    `<PtSituationElement><SituationNumber>${id}</SituationNumber><ParticipantRef>EST</ParticipantRef><Summary>Retard</Summary><Consequences><Consequence><Affects><VehicleJourneys><VehicleJourneyRef>9561</VehicleJourneyRef></VehicleJourneys></Affects></Consequence></Consequences></PtSituationElement>`;
  const parsed = parseSiri(
    sncf,
    "<Siri><ServiceDelivery><SituationExchangeDelivery><Situations>" +
      item("one") +
      item("two") +
      "</Situations></SituationExchangeDelivery></ServiceDelivery></Siri>",
  );
  assert.notEqual(parsed[0].source_event_id, parsed[1].source_event_id);
  assert.match(
    parsed[0].excerpts.find((e) => e.id === "affects")!.text,
    /9561/,
  );
});
test("internal API dispatch counts in total operation budget and manual redirects never forward secrets", async () => {
  let dispatched = 0;
  await assert.rejects(
    () =>
      collectSources(
        {
          EW_API_URL: "https://example.chatgpt.site",
          EW_COLLECTOR_TOKEN: "fixture",
        },
        {
          sources: [],
          maxRequests: 2,
          request: async () => {
            dispatched++;
            return {};
          },
          fetch: async () => {
            throw Error("unexpected_network");
          },
        },
      ),
    /checkpoint_unavailable/,
  );
  assert.equal(dispatched, 2);
  let network = 0;
  await assert.rejects(
    () =>
      collectSources(
        {
          EW_API_URL: "https://example.chatgpt.site",
          EW_COLLECTOR_TOKEN: "fixture",
          EW_SITES_SERVICE_TOKEN: "fixture-service",
          EW_SITES_ORIGIN: "https://example.chatgpt.site",
        },
        {
          sources: [],
          fetch: async (_url, init) => {
            network++;
            assert.equal(init?.redirect, "manual");
            return new Response("", {
              status: 302,
              headers: { location: "https://untrusted.invalid" },
            });
          },
        },
      ),
    /redirect_rejected/,
  );
  assert.equal(network, 1);
});

test("MIT preserves licensed strike date precision without treating event pubDate as publication", () => {
  const source = sourceRegistry.find((s) => s.id === "it-mit-strikes")!;
  const [v] = parseMitStrikes(
    source,
    "<rss><channel><title>Elenco Scioperi in Programma</title><pubDate>Wed, 21 Oct 2026 11:13:41 +0000</pubDate><item><title>Data inizio: 21/10/2026 - Settore: Trasporto pubblico locale - Provincia: Genova</title><description>Data proclamazione: 19/10/2026; modalità: 4 ORE DALLE 11.30 ALLE 15.30</description><pubDate>Tue, 20 Oct 2026 22:00:00 +0000</pubDate><guid>http://scioperi.mit.gov.it/8609</guid></item></channel></rss>",
  );
  assert.equal(v.published_at, null);
  assert.equal(v.source_updated_at, null);
  assert.equal(v.official?.effective_at, "2026-10-21");
  assert.equal(v.official?.expires_at, null);
  assert.equal(v.source_geo, undefined);
  assert.equal(v.input_coverage, "full_licensed_text");
  assert.match(
    v.excerpts.find((e) => e.id === "record")!.text,
    /Data proclamazione: 19/,
  );
  assert.equal(v.priority, 100);
});
test("Sweden API-only signals are narrow and excluded acquisition never creates durable queue rows", async () => {
  const source = sourceRegistry.find((s) => s.id === "se-polisen-events")!;
  const data = [
    {
      id: 1,
      datetime: "2026-10-21 12:57:24 +02:00",
      name: "Brand",
      summary: "Brand i byggnad",
      url: "/aktuellt/handelser/one/",
      type: "Brand",
      location: { name: "Norrbottens län", gps: "66.830922,20.399197" },
    },
    {
      id: 2,
      datetime: "2026-10-21 12:57:24 +02:00",
      name: "Stöld",
      summary: "Stöld från person",
      url: "/aktuellt/handelser/two/",
      type: "Stöld",
    },
  ];
  const parsed = parseSwedenPolice(source, JSON.stringify(data));
  assert.equal(parsed[0].published_at, null);
  assert.equal(parsed[0].official?.effective_at, "2026-10-21T10:57:24.000Z");
  assert.equal(parsed[0].source_geo, undefined);
  assert.equal(sourceEligibility(source, parsed[1], clock).eligible, false);
  let accepted: ObservationInput[] = [];
  let health: any;
  await collectSources(
    { EW_API_URL: "http://127.0.0.1", EW_COLLECTOR_TOKEN: "fixture" },
    {
      sources: [source],
      register: async () => {},
      checkpoint: async () => ({}),
      now: () => clock,
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      recordHealth: async (_id, h) => {
        health = h;
      },
      fetch: async () =>
        new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        }),
    },
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].native_id, "1");
  assert.equal(health.checkpoint.admission.parsed, 2);
  assert.equal(health.checkpoint.admission.excluded, 1);
  assert.equal(
    health.checkpoint.admission.reasons
      .outside_selected_public_order_safety_scope,
    1,
  );
});

test("peaceful gatherings and public-access restrictions remain recognized across FR IT DE NL", () => {
  for (const body of [
    "Des manifestants se rassemblent devant la gare, accès bloqué.",
    "Manifestazione pacifica davanti alla stazione; accesso ai binari interdetto.",
    "Friedliche Kundgebung, Zugang zum Bahnhof gesperrt.",
    "Vreedzame betoging voor station; toegang tot station afgesloten.",
  ]) {
    assert.equal(
      sourceEligibility(sncf, row(body), clock).eligible,
      true,
      body,
    );
  }
});
test("default registry disables passenger/institutional feeds and context produces no acquisition jobs", () => {
  for (const id of [
    "fr-sncf-siri",
    "it-dpc-notizia",
    "it-dpc-comunicato_stampa",
  ])
    assert.equal(
      sourceRegistry.find((s) => s.id === id)?.status,
      "disabled",
      id,
    );
  for (const id of ["fcdo-fr", "de-dwd", "it-dpc-bollettino_criticita"]) {
    const s = sourceRegistry.find((s) => s.id === id)!;
    assert.equal(s.config.context_only, true, id);
    assert.equal(
      sourceEligibility(s, row("Actual context source record"), clock).eligible,
      false,
      id,
    );
  }
});
test("Paris road-closure subtype alone never becomes crowd OSINT; exact signal/geometry/source date are retained", () => {
  const source = sourceRegistry.find((s) => s.id === "fr-paris-public-events")!;
  const data = {
    results: [
      {
        id: "bus-lane",
        type: "ROAD_CLOSED",
        subtype: "ROAD_CLOSED_EVENT",
        description: "Interdit sauf BUS, Taxis",
        starttime: "2025-11-19T09:43:36+02:00",
        endtime: "2030-11-19T10:05:00+02:00",
        street: "Rivoli",
        polyline: "48.8575 2.3514 48.8580 2.3495",
      },
      {
        id: "public-gathering",
        type: "ROAD_CLOSED",
        subtype: "ROAD_CLOSED_EVENT",
        description:
          "Manifestation pacifique, rassemblement et accès public temporairement fermé.",
        starttime: "2026-10-21T12:00:00+02:00",
        endtime: "2026-10-21T15:00:00+02:00",
        street: "Rivoli",
        polyline: "48.8575 2.3514 48.8580 2.3495",
      },
    ],
  };
  const parsed = parseParisEvents(source, JSON.stringify(data));
  assert.equal(sourceEligibility(source, parsed[0], clock).eligible, false);
  assert.equal(sourceEligibility(source, parsed[1], clock).eligible, true);
  assert.equal(parsed[1].source_geo, undefined);
  assert.equal(parsed[1].published_at, null);
  assert.equal(parsed[1].official?.effective_at, "2026-10-21T10:00:00.000Z");
  assert.match(
    parsed[1].excerpts.find((e) => e.id === "event")!.text,
    /48.8575 2.3514/,
  );
  assert.equal(parsed[1].native_id, "public-gathering");
});
