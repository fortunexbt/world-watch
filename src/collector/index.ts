import { siteServiceHeaders } from "../shared/transport.js";
import { parseIdmcUkraine } from "./adapters/idmc.js";
import { parseDemos } from "./adapters/demos.js";
import type { ObservationInput, SourceRecord } from "../shared/contracts.js";
import { fetchSource, type FetchOptions, type FetchState } from "./fetch.js";
import {
  parseFeed,
  parseTfl,
  parseBbk,
  parseDwd,
  parseSiri,
  parseDpcArticle,
  parseMitStrikes,
  parseSwedenPolice,
  parseParisEvents,
} from "./parsers.js";
import { configuredRegistry } from "./registry.js";
import { parseCatalunyaBombers } from "./adapters/catalunya-bombers.js";
import { parseUsgs } from "./adapters/usgs.js";
import { parseGdacs } from "./adapters/gdacs.js";
import {
  parseZwaailicht,
  zwaailichtEligibleTitle,
  zwaailichtQueryURL,
} from "./adapters/zwaailicht.js";
export type CollectorEnv = {
  EW_API_URL: string;
  EW_COLLECTOR_TOKEN: string;
  EW_SITES_SERVICE_TOKEN?: string;
  EW_SITES_ORIGIN?: string;
  EW_TFL_REGISTERED?: string;
  EW_COUNTRIES?: string;
};
type SourceHealth = {
  checked_at: string;
  last_success_at: string | null;
  error: string | null;
  received: number;
  checkpoint: FetchState;
};
export type CollectorOptions = FetchOptions & {
  /** Trusted in-process Site API dispatch. Counted against the same operation budget. */
  request?: (path: string, payload?: unknown) => Promise<any>;
  sources?: SourceRecord[];
  maxRequests?: number;
  now?: () => number;
  checkpoint?: (sourceId: string) => Promise<FetchState>;
  recordHealth?: (sourceId: string, health: SourceHealth) => Promise<void>;
  ingest?: (observations: ObservationInput[]) => Promise<unknown>;
  register?: (sources: SourceRecord[]) => Promise<unknown>;
};
export type CollectorResult = {
  source_id: string;
  status: "ok" | "not_modified" | "skipped" | "error";
  received: number;
  error?: string;
};
export async function collectSources(
  env: CollectorEnv,
  options: CollectorOptions = {},
) {
  const api = env.EW_API_URL.replace(/\/$/, "");
  if (!env.EW_COLLECTOR_TOKEN) throw Error("missing_collector_token");
  const serviceHeaders = siteServiceHeaders(
    api,
    env.EW_SITES_SERVICE_TOKEN,
    env.EW_SITES_ORIGIN,
  );
  const rawFetch = options.fetch ?? fetch;
  let requests = 0;
  const maxRequests = options.maxRequests ?? 40;
  const fetcher: typeof fetch = async (...args) => {
    if (requests >= maxRequests) throw Error("collector_request_budget");
    requests++;
    return rawFetch(...args);
  };
  async function request(path: string, payload?: unknown) {
    if (options.request) {
      if (requests >= maxRequests) throw Error("collector_request_budget");
      requests++;
      return options.request(path, payload);
    }
    const r = await fetcher(api + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + env.EW_COLLECTOR_TOKEN,
        "Content-Type": "application/json",
        ...serviceHeaders,
      },
      redirect: "manual",
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      throw Error("collector_api_redirect_rejected");
    }
    if (!r.ok) throw Error(`collector_api_${r.status}`);
    return r.json() as Promise<any>;
  }
  const sources =
    options.sources ??
    configuredRegistry({
      tflRegistered: env.EW_TFL_REGISTERED === "true",
      countries: env.EW_COUNTRIES?.split(",").map((c) =>
        c.trim().toUpperCase(),
      ),
    });
  // One durable metadata row prevents full registry upserts every scheduled pass.
  // Publish the marker only after every registration chunk was accepted.
  if (options.register) {
    for (let i = 0; i < sources.length; i += 40)
      await options.register(sources.slice(i, i + 40));
  } else {
    const registryHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(
              [...sources].sort((a, b) => a.id.localeCompare(b.id)),
            ),
          ),
        ),
      ),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    const config = await request("/api/collector/config");
    if (config.registry_hash !== registryHash) {
      for (let i = 0; i < sources.length; i += 40)
        await request("/api/sources", { sources: sources.slice(i, i + 40) });
      await request("/api/collector/config", { registry_hash: registryHash });
    }
  }
  let prior: any[] = [];
  if (!options.checkpoint) {
    try {
      const response = await request("/api/sources");
      prior = Array.isArray(response) ? response : (response.sources ?? []);
    } catch (error) {
      // A missing durable checkpoint could re-ingest an entire unchanged feed. Wait for storage recovery.
      throw Error("collector_checkpoint_unavailable", { cause: error });
    }
  }
  const checkpoint =
    options.checkpoint ??
    (async (id: string) => {
      const x = prior.find((s) => s.id === id);
      let value = x?.health?.checkpoint ?? x?.checkpoint ?? {};
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          value = {};
        }
      }
      return value as FetchState;
    });
  const health =
    options.recordHealth ??
    ((id: string, h: SourceHealth) =>
      request("/api/sources/" + encodeURIComponent(id) + "/health", h));
  const ingest =
    options.ingest ??
    ((items: ObservationInput[]) =>
      request("/api/ingest", { observations: items }));
  const results: CollectorResult[] = [];
  const now = options.now ?? Date.now;
  const ordered = [...sources].sort((a, b) => {
    const health = (id: string) => prior.find((s) => s.id === id)?.health;
    return (
      Date.parse(health(a.id)?.checked_at ?? "1970-01-01") -
      Date.parse(health(b.id)?.checked_at ?? "1970-01-01")
    );
  });
  // Sequential sources bound upstream load and make per-source quotas predictable. All source records remain durable.
  for (const source of ordered) {
    if (
      source.status !== "enabled" ||
      !source.rights.access ||
      !source.rights.storage ||
      !source.rights.display
    ) {
      results.push({ source_id: source.id, status: "skipped", received: 0 });
      continue;
    }
    if (requests >= maxRequests - 5) break;
    const before = await checkpoint(source.id);
    if (before.next_attempt_at && Date.parse(before.next_attempt_at) > now()) {
      results.push({ source_id: source.id, status: "skipped", received: 0 });
      continue;
    }
    if (
      before.last_success_at &&
      Date.parse(before.last_success_at) + source.poll_seconds * 1000 > now()
    ) {
      results.push({ source_id: source.id, status: "skipped", received: 0 });
      continue;
    }
    let received = 0;
    try {
      const requestURL =
        source.config.format === "zwaailicht_incidents"
          ? zwaailichtQueryURL(now())
          : source.url;
      const response = await fetchSource(requestURL, before, {
        ...options,
        fetch: fetcher,
        demosQuery: source.config.format === "demos_json",
        maxBytes: Number(source.config.max_bytes) || options.maxBytes,
      });
      if (response.notModified) {
        await health(source.id, {
          checked_at: new Date(now()).toISOString(),
          last_success_at: new Date(now()).toISOString(),
          error: null,
          received: 0,
          checkpoint: { ...response.state, next_attempt_at: undefined },
        });
        results.push({
          source_id: source.id,
          status: "not_modified",
          received: 0,
        });
        continue;
      }
      let observations: ObservationInput[] = [];
      switch (source.config.format) {
        case "idmc_ukraine_csv":
          observations = parseIdmcUkraine(source, response.text, now());
          break;
        case "demos_json":
          observations = parseDemos(source, JSON.parse(response.text));
          break;
        case "zwaailicht_incidents":
          observations = parseZwaailicht(source, JSON.parse(response.text));
          break;
        case "bombers_arcgis":
          observations = parseCatalunyaBombers(
            source,
            JSON.parse(response.text),
          );
          break;
        case "usgs_geojson":
          observations = parseUsgs(source, JSON.parse(response.text));
          break;
        case "gdacs_geojson":
          observations = parseGdacs(source, JSON.parse(response.text));
          break;
        case "paris_json": {
          const first = JSON.parse(response.text);
          let all = Array.isArray(first.results) ? first.results : [];
          const total = Number(first.total_count);
          if (!Array.isArray(first.results) || !Number.isFinite(total))
            throw Error("invalid_paris_page");
          let offset = all.length;
          let pages = 1;
          while (offset < total) {
            if (pages >= Number(source.config.max_pages ?? 10))
              throw Error("paris_source_page_budget");
            const next = new URL(source.url);
            next.searchParams.set("offset", String(offset));
            const page = await fetchSource(
              next.href,
              {},
              {
                ...options,
                fetch: fetcher,
                maxBytes: Number(source.config.max_bytes) || options.maxBytes,
              },
            );
            const data = JSON.parse(page.text);
            if (!Array.isArray(data.results) || !data.results.length)
              throw Error("paris_incomplete_page");
            all.push(...data.results);
            offset += data.results.length;
            pages++;
          }
          observations = parseParisEvents(
            source,
            JSON.stringify({
              results: [...new Map(all.map((v: any) => [v.id, v])).values()],
            }),
          );
          break;
        }
        case "sweden_police":
          observations = parseSwedenPolice(source, response.text);
          break;
        case "mit_strikes":
          observations = parseMitStrikes(source, response.text);
          break;
        case "tfl":
          observations = parseTfl(source, response.text);
          break;
        case "dwd_jsonp":
          observations = parseDwd(source, response.text);
          break;
        case "siri_lite":
          observations = parseSiri(source, response.text);
          break;
        case "bbk": {
          const items = JSON.parse(response.text);
          if (!Array.isArray(items)) throw Error("invalid_bbk_index");
          const budget = Number(source.config.max_requests) || 24;
          if (items.length * 2 > budget)
            throw Error("source_request_budget_exceeded");
          for (const item of items) {
            if (
              typeof item.id !== "string" ||
              !/^[-.a-zA-Z0-9_]+$/.test(item.id)
            )
              throw Error("invalid_bbk_id");
            const detail = await fetchSource(
              `https://warnung.bund.de/api31/warnings/${item.id}.json`,
              {},
              { ...options, fetch: fetcher },
            );
            const geo = await fetchSource(
              `https://warnung.bund.de/api31/warnings/${item.id}.geojson`,
              {},
              { ...options, fetch: fetcher },
            );
            observations.push(
              ...parseBbk(source, detail.text, JSON.parse(geo.text)),
            );
          }
          break;
        }
        default:
          observations = parseFeed(source, response.text);
      }
      observations = observations.map((o) => {
        let priority = Number(source.config.queue_priority ?? o.priority ?? 10);
        const freshness = Math.max(
          Date.parse(o.published_at ?? "") || 0,
          Date.parse(o.source_updated_at ?? "") || 0,
        );
        if (
          freshness > 0 &&
          freshness < now() - 7 * 86400000 &&
          !(o.official?.expires_at && Date.parse(o.official.expires_at) > now())
        )
          priority = Math.min(priority, 0);
        return {
          ...o,
          priority,
          eligibility: sourceEligibility(source, o, now()),
        };
      });
      if (
        source.id === "it-dpc-notizia" ||
        source.id === "it-dpc-comunicato_stampa"
      )
        for (const observation of observations.slice(0, 2)) {
          const u = new URL(observation.canonical_url);
          if (
            u.hostname !== "www.protezionecivile.gov.it" ||
            !/^\/(?:it|en)\/(?:notizia|comunicato-stampa)\//.test(u.pathname)
          )
            continue;
          const article = await fetchSource(
            u.href,
            {},
            {
              ...options,
              fetch: fetcher,
              allowHTML: true,
              maxBytes: 2 * 1024 * 1024,
            },
          );
          observation.excerpts = [
            { id: "title", text: observation.title },
            { id: "article", text: parseDpcArticle(article.text) },
          ];
          observation.input_coverage = "full_licensed_text";
          observation.original_language = u.pathname.startsWith("/en/")
            ? "en"
            : "it";
          observation.priority = Math.min(observation.priority ?? 20, 20);
        }
      // Detail expansion can reveal an explicit future event; evaluate against the complete permitted text.
      observations = observations.map((o) => ({
        ...o,
        eligibility: sourceEligibility(source, o, now()),
      }));
      const admission: NonNullable<FetchState["admission"]> = {
        policy_version: "source-admission-4",
        parsed: observations.length,
        source_messages: observations.reduce(
          (n, o) => n + (o.source_reports?.length ?? 1),
          0,
        ),
        admitted: 0,
        excluded: 0,
        reasons: {},
        evaluated_at: new Date(now()).toISOString(),
      };
      observations = observations.filter((o) => {
        if (o.eligibility?.eligible === false) {
          admission.excluded++;
          admission.reasons[o.eligibility.reason] =
            (admission.reasons[o.eligibility.reason] ?? 0) + 1;
          return false;
        }
        admission.admitted++;
        return true;
      });
      // Commit every chunk before checkpointing. A partial API failure causes refetch; native revision dedup absorbs accepted chunks.
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(observations)),
          ),
        ),
      )
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      const fingerprints = await Promise.all(
        observations.map(async (o) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(
                  JSON.stringify({
                    title: o.title,
                    excerpts: o.excerpts,
                    geo: o.source_geo,
                    official: o.official,
                    published: o.published_at,
                  }),
                ),
              ),
            ),
          )
            .map((x) => x.toString(16).padStart(2, "0"))
            .join(""),
        ),
      );
      const acceptedItems: Record<string, string> = {
        ...before.accepted_items,
      };
      if (!before.accepted_items && before.pending_hash === hash)
        for (
          let i = 0;
          i < Math.min(before.pending_offset ?? 0, observations.length);
          i++
        )
          acceptedItems[observations[i].native_id] = fingerprints[i];
      const missing = observations
        .map((observation, index) => ({ observation, index }))
        .filter(
          (x) =>
            acceptedItems[x.observation.native_id] !== fingerprints[x.index],
        );
      let offset = 0;
      while (offset < missing.length && requests < maxRequests - 5) {
        const batch = missing.slice(offset, offset + 3);
        await ingest(batch.map((x) => x.observation));
        for (const x of batch)
          acceptedItems[x.observation.native_id] = fingerprints[x.index];
        received += batch.length;
        offset += batch.length;
      }
      const currentIds = new Set(observations.map((o) => o.native_id));
      for (const id of Object.keys(acceptedItems))
        if (!currentIds.has(id)) delete acceptedItems[id];
      let complete = offset >= missing.length;
      if (complete && source.config.format === "bbk") {
        let more = true;
        while (more && requests < maxRequests - 3) {
          const result = await request(
            "/api/sources/" + encodeURIComponent(source.id) + "/reconcile",
            {
              complete: true,
              active_native_ids: observations.map((o) => o.native_id),
            },
          );
          more = result.more === true;
        }
        if (more) complete = false;
      }
      await health(source.id, {
        checked_at: new Date(now()).toISOString(),
        last_success_at: complete
          ? new Date(now()).toISOString()
          : (before.last_success_at ?? null),
        error: complete ? null : "partial_fetch_accepted_resume_pending",
        received,
        checkpoint: complete
          ? {
              ...response.state,
              accepted_items: acceptedItems,
              admission,
              pending_hash: undefined,
              pending_offset: undefined,
              next_attempt_at: undefined,
            }
          : {
              ...before,
              accepted_items: acceptedItems,
              admission,
              pending_hash: hash,
              pending_offset: Object.keys(acceptedItems).length,
              next_attempt_at: undefined,
            },
      });
      results.push({ source_id: source.id, status: "ok", received });
    } catch (caught) {
      const e = caught as Error & { retryAfter?: number };
      const failures = (before.failures ?? 0) + 1;
      const delay = Math.max(
        e.retryAfter ?? 0,
        Math.max(
          source.poll_seconds,
          Math.min(3600, 15 * 2 ** Math.min(failures, 8)),
        ) *
          (0.9 + Math.random() * 0.2),
      );
      const next = {
        ...before,
        failures,
        next_attempt_at: new Date(now() + delay * 1000).toISOString(),
      };
      try {
        await health(source.id, {
          checked_at: new Date(now()).toISOString(),
          last_success_at: before.last_success_at ?? null,
          error: e.message,
          received,
          checkpoint: next,
        });
      } catch {
        /* Failure is returned and logged even when the health API itself is unavailable. */
      }
      results.push({
        source_id: source.id,
        status: "error",
        received,
        error: e.message,
      });
    }
  }
  return results;
}

/** A cheap, deliberately narrow admission policy. Unknown wording stays eligible. Source evidence is never rewritten. */
export function sourceEligibility(
  source: SourceRecord,
  observation: ObservationInput,
  clock = Date.now(),
) {
  const policy_version = "source-admission-4";
  const text = [observation.title, ...observation.excerpts.map((e) => e.text)]
    .join("\n")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const keep = (reason: string) => ({ eligible: true, reason, policy_version });
  const exclude = (reason: string) => ({
    eligible: false,
    reason,
    policy_version,
  });
  if (source.id === "ua-idmc-displacement-flows")
    return keep("daily_provisional_displacement_flow_context");
  if (source.id === "de-demos-assemblies")
    return observation.source_event_id
      ? keep("licensed_aggregator_planned_public_assembly")
      : exclude("missing_assembly_native_identity");
  if (source.id === "nl-zwaailicht-fire-clusters") {
    const observed = Date.parse(observation.source_updated_at ?? "");
    if (!Number.isFinite(observed) || observed < clock - 86400000)
      return exclude("public_dispatch_outside_24h_window");
    return zwaailichtEligibleTitle(observation.title)
      ? keep("selected_unconfirmed_public_fire_dispatch_cluster")
      : exclude("routine_alarm_medical_or_private_person_noise");
  }
  if (source.id === "es-cat-bombers")
    return observation.source_event_id
      ? keep("publisher_selected_public_fire_service")
      : exclude("missing_public_fire_episode_identity");
  if (
    source.id === "global-usgs-earthquakes" ||
    source.id === "global-gdacs-alerts"
  )
    return observation.source_event_id
      ? keep("structured_natural_hazard_record")
      : exclude("missing_hazard_native_identity");
  if (source.id === "fr-paris-public-events") {
    const crowd =
      /\b(?:manifestant\w*|manifestation\w*|rassembl\w*|cortege\w*|foule\w*|greve\w*|emeute\w*|evacuat\w*|incendie\w*|explosion\w*|mouvement social|perimetre de securite)\b/u;
    const dispatch =
      /(?:intervention|operation|incident|perimetre).{0,50}(?:police|pompiers|secours)|(?:police|pompiers|secours).{0,50}(?:intervention|operation|incident)/su;
    return crowd.test(text) || dispatch.test(text)
      ? keep("explicit_city_public_gathering_or_safety_signal")
      : exclude("routine_city_traffic_not_public_order_signal");
  }
  if (source.config.context_only === true)
    return exclude("context_source_outside_incident_ai_pipeline");
  const lastKnown = Math.max(
    Date.parse(observation.published_at ?? "") || 0,
    Date.parse(observation.source_updated_at ?? "") || 0,
  );
  const officialFuture = [
    observation.official?.effective_at,
    observation.official?.expires_at,
  ].some((v) => v && Date.parse(v) > clock);
  if (
    source.rights.ai &&
    lastKnown > 0 &&
    lastKnown < clock - 30 * 86400000 &&
    !officialFuture &&
    !mentionsCurrentOrFutureDate(text, clock)
  )
    return exclude("archive_outside_monitoring_window");
  if (source.id === "se-polisen-events") {
    if (
      observation.official?.effective_at &&
      Date.parse(observation.official.effective_at) < clock - 7 * 86400000
    )
      return exclude("source_event_outside_7_day_window");
    const category =
      observation.excerpts
        .find((e) => e.id === "event_type")
        ?.text.normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .trim() ?? "";
    if (
      /^(?:demonstration|ordningslagen|brak|farligt foremal, misstankt|brand|trafikhinder|raddningsinsats)$/u.test(
        category,
      )
    )
      return keep("selected_public_order_or_public_safety_type");
    if (
      category === "information" &&
      /demonstration|strejk|avsparr|utrym|evaku|explosi|farligt|brand|trafikhinder|skottlossning|sprang/u.test(
        text,
      )
    )
      return keep("explicit_public_safety_information");
    return exclude("outside_selected_public_order_safety_scope");
  }
  // Peaceful protest, strikes and explicit broad safety effects override routine operational notices.
  const relevant =
    /\b(protests?|demonstrations?|manifestations?|manifestant\w*|rassembl\w*|manifestaciones|manifestazion[ei]|kundgebung\w*|betoging\w*|streiks?|strikes?|greves?|huelgas?|scioper[oi]|staking|curfews?|couvre.feu|toque de queda|coprifuoco|evacuat\w*|evacuaz\w*|evaku\w*|violence|violent|gewalt|unrest|riots?|emeutes?|troubles|terror\w*|safety|security|danger|hazards?|shelter|outbreak\w*|epidem\w*|kidnap\w*|shoot\w*|bomb\w*|roadblocks?|attacks?|attentats?|incend\w*|fire|flood\w*|inond\w*|accident\w*|derail\w*|entgleis\w*)\b/u;
  if (relevant.test(text))
    return keep("explicit_public_safety_protest_or_strike");
  if (
    /(?:acces|accesso|zugang|toegang).{0,80}(?:bloqu\w*|interdit\w*|gesperrt|afgesloten)/su.test(
      text,
    )
  )
    return keep("explicit_public_access_restriction");
  if (source.id.startsWith("fcdo-")) {
    const administrative =
      /(?:updated?|changes?|information|advice|requirements?|restrictions?).{0,100}(?:entry requirements?|visa(?:s)?|passport(?:s)?|vaccination(?:s)?|health(?:care)?|travel insurance|customs|currency|money|embassy contact|consular contact)|(?:entry requirements?|visa(?:s)?|passport(?:s)?|vaccination(?:s)?|travel insurance).{0,80}(?:updated?|changes?|information|requirements?)/su;
    if (administrative.test(text))
      return exclude("routine_travel_entry_health_or_administrative_change");
    return keep("advisory_change_unclear_keep_for_analysis");
  }
  if (source.id === "fr-sncf-siri") {
    const broadClosure =
      /(?:ligne|line|route|reseau|network|strecke|circulation des trains).{0,100}(?:ferme\w*|interromp\w*|suspend\w*|coupee|closed|closure|gesperrt|eingestellt|chius\w*|interrott\w*|cerrad\w*|unterbrochen)|(?:fermeture|interruption|closure|suspension|sperrung).{0,70}(?:ligne|line|route|reseau|network|strecke)|(?:aucun train|no trains|kein zug|nessun treno|ningun tren|geen treinen).{0,100}(?:entre|between|zwischen|tra|tussen)/su;
    if (broadClosure.test(text)) return keep("explicit_major_route_closure");
    if (
      /mouvement social|mobilitazione sindacale|sociale actie|arbeitskampf|disturbios|confrontation|affrontement|securite|sicurezza|sicherheit|seguridad|veiligheid/u.test(
        text,
      )
    )
      return keep("explicit_multilingual_unrest_strike_or_safety");
    const description = observation.excerpts
      .find((e) => e.id === "description")
      ?.text.trim();
    if (
      !description &&
      /^(?:plus d['’ ]information(?:s)?|more information|weitere informationen|informazioni|mas informacion)[.! ]*$/u.test(
        observation.title
          .normalize("NFD")
          .replace(/\p{M}/gu, "")
          .toLowerCase()
          .trim(),
      )
    )
      return exclude("generic_placeholder_without_event_description");
    const affects =
      observation.excerpts.find((e) => e.id === "affects")?.text ?? "";
    let singleJourney = false;
    try {
      const journeys = new Set<string>();
      const visit = (value: any) => {
        if (!value || typeof value !== "object") return;
        for (const [k, v] of Object.entries(value)) {
          if (k === "VehicleJourneyRef" && typeof v === "string")
            journeys.add(v);
          else if (typeof v === "object") visit(v);
        }
      };
      if (affects) visit(JSON.parse(affects));
      singleJourney = journeys.size === 1;
    } catch {}
    const individual =
      /\b(?:votre train|your train|il (?:suo|tuo) treno|ihr zug|el tren|uw trein|train\s+\d{3,7})\b/u.test(
        text,
      );
    const cancellation =
      /\b(?:annul\w*|supprim\w*|cancel\w*|ausfall|fallt aus|cancell\w*|uitgevallen)\b/u.test(
        text,
      );
    const routineCause =
      /\b(?:panne|defaut|defaillance|techni\w*|materiel|malfunction|breakdown|guasto|tecnic\w*|averia|storing|defekt|technisch\w*|lack of (?:staff|crew)|manque de personnel)\b/u.test(
        text,
      );
    const broader =
      /\b(?:ligne|line|route|reseau|network|strecke|bahnstrecke|liaison|verkehr|linje)\b/u.test(
        text,
      );
    if (
      cancellation &&
      routineCause &&
      (singleJourney || individual) &&
      !broader
    )
      return exclude("routine_individual_train_technical_cancellation");
    const platform =
      /(?:dernier\w* voitures?|voitures? de queue).{0,160}quai|(?:last|rear) (?:coaches|carriages|cars).{0,160}platform|letzten wagen.{0,160}bahnsteig|ultimos coches.{0,160}anden|ultime carrozze.{0,160}(?:binario|marciapiede)|laatste rijtuigen.{0,160}perron/su;
    if (platform.test(text))
      return exclude("routine_platform_carriage_position_notice");
    const engineering =
      /travaux (?:sont )?(?:prevus|programmes|planifies)|(?:scheduled|planned) (?:engineering|maintenance|track|rail|works)|geplante(?:n)? bauarbeiten|obras programadas|lavori programmati|geplande werkzaamheden/su;
    if (engineering.test(text))
      return exclude("explicitly_planned_routine_engineering");
    return exclude("routine_train_circulation_outside_signal_scope");
  }
  return keep("source_not_subject_to_cheap_exclusion");
}

function mentionsCurrentOrFutureDate(text: string, clock: number) {
  const today = new Date(clock);
  const cutoff = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const validFuture = (y: number, m: number, d: number) => {
    const v = new Date(Date.UTC(y, m - 1, d));
    return (
      v.getUTCFullYear() === y &&
      v.getUTCMonth() === m - 1 &&
      v.getUTCDate() === d &&
      v.getTime() >= cutoff
    );
  };
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))
    if (validFuture(+m[1], +m[2], +m[3])) return true;
  for (const m of text.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/g))
    if (validFuture(+m[3], +m[2], +m[1]) || validFuture(+m[3], +m[1], +m[2]))
      return true;
  const months = [
    ["january", "janvier", "gennaio", "januar", "enero", "januari"],
    ["february", "fevrier", "febbraio", "februar", "febrero", "februari"],
    ["march", "mars", "marzo", "marz", "maart"],
    ["april", "avril", "aprile", "abril"],
    ["may", "mai", "maggio", "mayo", "mei"],
    ["june", "juin", "giugno", "juni", "junio"],
    ["july", "juillet", "luglio", "juli", "julio"],
    ["august", "aout", "agosto", "augustus"],
    ["september", "septembre", "settembre", "septiembre"],
    ["october", "octobre", "ottobre", "oktober", "octubre"],
    ["november", "novembre", "noviembre"],
    ["december", "decembre", "dicembre", "dezember", "diciembre", "desember"],
  ];
  for (let index = 0; index < months.length; index++)
    for (const name of months[index]) {
      const r = new RegExp(
        `\\b(\\d{1,2})(?:er)?[ .-]+${name}[ ,.-]+(20\\d{2})\\b`,
        "g",
      );
      for (const m of text.matchAll(r))
        if (validFuture(+m[2], index + 1, +m[1])) return true;
      const english = new RegExp(
        `\\b${name} +(\\d{1,2})(?:st|nd|rd|th)?[, ]+(20\\d{2})\\b`,
        "g",
      );
      for (const m of text.matchAll(english))
        if (validFuture(+m[2], index + 1, +m[1])) return true;
    }
  return (
    /\b(?:planned|scheduled|previst\w*|programmat\w*|prochain\w*|geplant\w*)\b/u.test(
      text,
    ) &&
    [...text.matchAll(/\b(20\d{2})\b/g)].some(
      (m) => +m[1] > today.getUTCFullYear(),
    )
  );
}
