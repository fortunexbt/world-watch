import { IDMC_UKRAINE_URL } from "./adapters/idmc.js";
import { DEMOS_QUERY_URL, DEMOS_READ_QUERY } from "./adapters/demos.js";
/** Only registry-approved HTTPS origins may be contacted. Never accept source URLs from reports. */
export const APPROVED_HOSTS = new Set([
  "api.protezionecivile.it",
  "www.protezionecivile.gov.it",
  "mappe.protezionecivile.gov.it",
  "api.tfl.gov.uk",
  "warnung.bund.de",
  "www.dwd.de",
  "feeds.meteoalarm.org",
  "proxy.transport.data.gouv.fr",
  "www.gov.uk",
  "api.politiloggen.politiet.no",
  "scioperi.mit.gov.it",
  "polisen.se",
  "opendata.paris.fr",
  "services7.arcgis.com",
  "zwaailicht.nl",
  "api.demonstrations.org",
  "data.humdata.org",
  "earthquake.usgs.gov",
  "www.gdacs.org",
  "api.weather.gov",
]);
function idmcFilestore(u: URL) {
  return (
    u.hostname === "s3.us-east-1.amazonaws.com" &&
    u.pathname ===
      "/hdx-production-filestore/resources/ee65f9fe-f1c7-4466-9f83-620b50eccdc6/ukr_idmc_idu_events.csv" &&
    [...u.searchParams.keys()].every((k) =>
      [
        "AWSAccessKeyId",
        "Signature",
        "x-amz-security-token",
        "Expires",
      ].includes(k),
    )
  );
}
export function checkedURL(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    (!APPROVED_HOSTS.has(u.hostname) && !idmcFilestore(u))
  )
    throw Error("unapproved_source_url");
  return u;
}
export type FetchState = {
  admission?: {
    policy_version: string;
    parsed: number;
    source_messages: number;
    admitted: number;
    excluded: number;
    reasons: Record<string, number>;
    evaluated_at: string;
  };
  etag?: string;
  last_modified?: string;
  next_attempt_at?: string;
  failures?: number;
  last_success_at?: string;
  pending_hash?: string;
  pending_offset?: number;
  accepted_items?: Record<string, string>;
};
export type FetchOptions = {
  fetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
  allowHTML?: boolean;
  /** A paged API that answers 204 past its last page; the result text is empty. */
  allowNoContent?: boolean;
  /** Replaces the default Accept header for an API that negotiates its format, such as NWS returning Atom unless GeoJSON is asked for. */
  accept?: string;
  /** Only the documented public, read-only Demos event query; never arbitrary POST. */
  demosQuery?: boolean;
};
export function isPublicAddress(ip: string) {
  return (
    !/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|224\.|240\.|255\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::|fc|fd|fe80|ff)/i.test(
      ip,
    ) && !ip.includes(":ffff:")
  );
}
export async function fetchSource(
  url: string,
  state: FetchState = {},
  options: FetchOptions = {},
) {
  const fetcher = options.fetch ?? fetch;
  let target = checkedURL(url);
  if (options.demosQuery && target.href !== DEMOS_QUERY_URL)
    throw Error("unapproved_public_event_query");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15000,
  );
  const headers: Record<string, string> = {
    "User-Agent": "EuropeWatch/0.1 (public-source incident awareness)",
    Accept:
      options.accept ??
      "application/atom+xml, application/rss+xml, application/xml, text/xml, application/json",
  };
  if (options.demosQuery) headers["Content-Type"] = "application/json";
  if (state.etag) headers["If-None-Match"] = state.etag;
  if (state.last_modified) headers["If-Modified-Since"] = state.last_modified;
  try {
    for (let redirects = 0; redirects < 4; redirects++) {
      if (options.resolveHost) {
        const addresses = await options.resolveHost(target.hostname);
        if (!addresses.length || addresses.some((a) => !isPublicAddress(a)))
          throw Error("private_source_dns");
      }
      const r = await fetcher(target, {
        ...(options.demosQuery
          ? { method: "POST", body: JSON.stringify(DEMOS_READ_QUERY) }
          : {}),
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        if (options.demosQuery) {
          await r.body?.cancel();
          throw Error("source_query_redirect_rejected");
        }
        const location = r.headers.get("location");
        if (!location) throw Error("invalid_source_redirect");
        const next = checkedURL(new URL(location, target).href);
        if (
          next.hostname !== target.hostname &&
          !(
            url === IDMC_UKRAINE_URL &&
            target.hostname === "data.humdata.org" &&
            idmcFilestore(next)
          )
        )
          throw Error("cross_host_source_redirect");
        await r.body?.cancel();
        target = next;
        continue;
      }
      if (r.status === 304)
        return {
          notModified: true,
          text: "",
          state: {
            ...state,
            last_success_at: new Date().toISOString(),
            failures: 0,
          },
          contentType: "",
        };
      if (!r.ok) {
        const retry = r.headers.get("retry-after");
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
              : null;
        const error = new Error(`source_http_${r.status}`) as Error & {
          retryAfter?: number;
        };
        if (seconds !== null) error.retryAfter = seconds;
        throw error;
      }
      if (r.status === 204 && options.allowNoContent) {
        await r.body?.cancel();
        return {
          notModified: false,
          text: "",
          contentType: "",
          state: { last_success_at: new Date().toISOString(), failures: 0 },
        };
      }
      const mime = r.headers.get("content-type") ?? "";
      const licensedIdmcCsv =
        ((target.hostname === "data.humdata.org" &&
          target.pathname ===
            "/dataset/52880c3a-715d-4e01-b75a-1fc3f64babf6/resource/ee65f9fe-f1c7-4466-9f83-620b50eccdc6/download/ukr_idmc_idu_events.csv") ||
          idmcFilestore(target)) &&
        /^text\/csv\b/i.test(mime);
      if (
        !licensedIdmcCsv &&
        !/(?:xml|json|protobuf)/i.test(mime) &&
        !(options.allowHTML && /^text\/html\b/i.test(mime))
      )
        throw Error("unsupported_source_mime");
      const limit = options.maxBytes ?? 4 * 1024 * 1024;
      if (Number(r.headers.get("content-length")) > limit)
        throw Error("source_size_limit");
      const reader = r.body?.getReader();
      if (!reader) throw Error("empty_source_body");
      let size = 0;
      const parts: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw Error("source_size_limit");
        }
        parts.push(value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const p of parts) {
        data.set(p, offset);
        offset += p.length;
      }
      return {
        notModified: false,
        text: new TextDecoder().decode(data),
        contentType: mime,
        state: {
          etag: r.headers.get("etag") ?? undefined,
          last_modified: r.headers.get("last-modified") ?? undefined,
          last_success_at: new Date().toISOString(),
          failures: 0,
        },
      };
    }
    throw Error("source_redirect_limit");
  } finally {
    clearTimeout(timer);
  }
}
