import application, { type Env } from "./server/index";

declare const __EW_SITE_ASSETS__: Record<
  string,
  { mime: string; base64: string }
>;
type SitesEnv = Omit<Env, "ASSETS"> & { SITES_OWNER_USER_ID?: string; SITES_OWNER_EMAIL?: string };

/** Assets are bundled into the Worker ESM; Sites does not accept standalone assets. */
const assets = {
  async fetch(request: Request): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const path = new URL(request.url).pathname;
    const asset =
      __EW_SITE_ASSETS__[path] ??
      (!path.split("/").at(-1)?.includes(".")
        ? __EW_SITE_ASSETS__["/index.html"]
        : undefined);
    if (!asset) return new Response("Asset not found", { status: 404 });
    const body =
      request.method === "HEAD"
        ? null
        : Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0));
    return new Response(body, {
      headers: {
        "content-type": asset.mime,
        "cache-control": path.startsWith("/assets/")
          ? "private, max-age=31536000, immutable"
          : "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
};

export default {
  async fetch(request: Request, env: SitesEnv): Promise<Response> {
    // This entry is exclusively for the confirmed owner-private Sites deployment.
    // Dispatch authenticates visitors and consumes service access; service calls retain scoped app tokens.
    const visitor = request.headers.get("oai-authenticated-user-id");
    const visitorEmail=request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
    const ownerVisitor = !!visitor && (env.SITES_OWNER_USER_ID ? visitor===env.SITES_OWNER_USER_ID : !!env.SITES_OWNER_EMAIL && visitorEmail===env.SITES_OWNER_EMAIL.trim().toLowerCase());
    if (
      visitor &&
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return new Response(JSON.stringify({ error: "origin_mismatch" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    if (
      visitor &&
      new URL(request.url).pathname === "/api/operator/identity" &&
      ownerVisitor
    )
      return new Response(JSON.stringify({ site_user_id: visitor }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    if (
      visitor &&
      !env.SITES_OWNER_USER_ID && !env.SITES_OWNER_EMAIL &&
      !request.headers.has("authorization")
    )
      return new Response("Owner identity setup is in progress", {
        status: 503,
      });
    if (
      visitor &&
      !request.headers.has("authorization") &&
      ownerVisitor
    ) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${env.EUROPE_WATCH_OWNER_TOKEN}`);
      request = new Request(request, { headers });
    }
    return application.fetch(request, { ...env, ASSETS: assets });
  },
};
