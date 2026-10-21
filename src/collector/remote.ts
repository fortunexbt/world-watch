import {
  configuredSiteOrigin,
  siteServiceHeaders,
} from "../shared/transport.js";
export type RemoteCollectorEnv = {
  EW_API_URL?: string;
  EW_SITES_ORIGIN?: string;
  EW_COLLECTION_PAUSED?: string;
  EW_COLLECTOR_TOKEN?: string;
  EUROPE_WATCH_COLLECTOR_TOKEN?: string;
  EW_SITES_SERVICE_TOKEN: string;
  EW_TFL_REGISTERED?: string;
  EW_COUNTRIES?: string;
};
type CycleOptions = { fetch?: typeof fetch };
/** The 10ms Free cron is only a trigger; parsing, hashing, ingestion and maintenance execute in managed Sites. */
export async function runCollectionCycle(
  env: RemoteCollectorEnv,
  options: CycleOptions = {},
) {
  if (env.EW_COLLECTION_PAUSED === "1") return { skipped: "paused" };
  const origin = configuredSiteOrigin(env.EW_SITES_ORIGIN);
  if (!origin || env.EW_API_URL !== origin)
    throw Error("collector_site_origin_mismatch");
  const token = env.EW_COLLECTOR_TOKEN ?? env.EUROPE_WATCH_COLLECTOR_TOKEN;
  if (!token || !env.EW_SITES_SERVICE_TOKEN)
    throw Error("collector_site_access_missing");
  const response = await (options.fetch ?? fetch)(
    origin + "/api/collector/run",
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + token,
        ...siteServiceHeaders(
          origin,
          env.EW_SITES_SERVICE_TOKEN,
          env.EW_SITES_ORIGIN,
        ),
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(120000),
    },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Error("collector_run_redirect_rejected");
  }
  if (!response.ok) throw Error(`collector_run_${response.status}`);
  return response.json();
}
export default {
  async fetch(request: Request, env: RemoteCollectorEnv): Promise<Response> {
    const origin = configuredSiteOrigin(env.EW_SITES_ORIGIN);
    if (!origin)
      return Response.json(
        { error: "site_origin_not_configured" },
        { status: 503 },
      );
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/"))
      return Response.json(
        {
          error: "api_moved",
          message: "Europe Watch API is hosted on the private Site.",
          site: origin,
        },
        {
          status: 503,
          headers: { "cache-control": "no-store", "retry-after": "3600" },
        },
      );
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    // Credentials, cookies and service secrets are never proxied to a caller-selected URL.
    return Response.redirect(origin + url.pathname + url.search, 302);
  },
  async scheduled(_event: unknown, env: RemoteCollectorEnv): Promise<void> {
    await runCollectionCycle(env);
  },
};
