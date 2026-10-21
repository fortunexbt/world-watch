import { validEventTime } from "../shared/contracts";
import type {
  PublicCamera,
  PublicCameraCatalog,
  CameraSourceHealth,
} from "../shared/media";
export type {
  PublicCamera,
  PublicCameraCatalog,
  CameraSourceHealth,
} from "../shared/media";
export const FINLAND_CAMERAS_URL =
  "https://tie.digitraffic.fi/api/weathercam/v1/stations";
export const NORWAY_CAMERAS_URL =
  "https://ogckart-sn1.atlas.vegvesen.no/ogc/features/v1/collections/datex_3_1:CctvSimple/items?f=application%2Fgeo%2Bjson&limit=1000";
const FI_LICENSE = "https://www.digitraffic.fi/en/terms-of-service/";
const NO_LICENSE = "https://dataut.vegvesen.no/en/dataset/webkamera";
const FI_ATTRIBUTION = "Fintraffic / Digitraffic — CC BY 4.0";
const NO_ATTRIBUTION =
  "Statens vegvesen — Norsk lisens for offentlige data (NLOD)";
const CATALOG_TTL = 600000,
  DETAIL_TTL = 60000,
  MAX_BYTES = 2 * 1024 * 1024;
const catalogCache = new WeakMap<
  typeof fetch,
  { expires: number; promise: Promise<PublicCameraCatalog> }
>();
const upstreamLimits = new WeakMap<
  typeof fetch,
  Map<string, { calls: number[]; retryAt: number }>
>();
const detailCache = new Map<
  string,
  {
    fetcher: typeof fetch;
    expires: number;
    promise: Promise<PublicCamera | null>;
  }
>();
function point(feature: any): [number, number] | null {
  const c = feature?.geometry?.coordinates;
  return feature?.geometry?.type === "Point" &&
    Array.isArray(c) &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    Math.abs(c[0]) <= 180 &&
    Math.abs(c[1]) <= 90
    ? [c[0], c[1]]
    : null;
}
function safeUrl(value: unknown, host: string, path: RegExp): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === host &&
      !u.username &&
      !u.password &&
      !u.port &&
      path.test(u.pathname) &&
      !u.search &&
      !u.hash
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function presetOf(properties: any) {
  return (Array.isArray(properties?.presets) ? properties.presets : [])
    .filter(
      (p: any) =>
        p.inCollection === true &&
        /^C\d{7}$/.test(p.id) &&
        typeof properties?.id === "string" &&
        p.id.startsWith(properties.id),
    )
    .sort((a: any, b: any) => a.id.localeCompare(b.id))[0];
}
export function parseDigitrafficCatalog(value: any): PublicCamera[] {
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features))
    throw Error("invalid_digitraffic_catalog");
  const cameras: PublicCamera[] = [];
  for (const feature of value.features) {
    const p = feature.properties,
      coordinates = point(feature),
      preset = presetOf(p);
    if (
      !coordinates ||
      p?.collectionStatus !== "GATHERING" ||
      !/^C\d{5}$/.test(p?.id) ||
      !preset
    )
      continue;
    // This is the official image-URL template for an API-supplied preset ID, not camera discovery.
    const image = "https://weathercam.digitraffic.fi/" + preset.id + ".jpg";
    cameras.push({
      id: "digitraffic:" + p.id,
      provider: "digitraffic",
      name: String(p.name ?? p.id),
      country: "FI",
      lon: coordinates[0],
      lat: coordinates[1],
      kind: "snapshot",
      image_url: image,
      source_url: FINLAND_CAMERAS_URL + "/" + p.id,
      license_url: FI_LICENSE,
      attribution: FI_ATTRIBUTION,
      updated_at: null,
      cadence_seconds: null,
    });
    if (cameras.length === 1000) break;
  }
  return cameras;
}
export function parseVegvesenCatalog(value: any): PublicCamera[] {
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features))
    throw Error("invalid_vegvesen_catalog");
  const cameras: PublicCamera[] = [];
  for (const feature of value.features) {
    const p = feature.properties,
      coordinates = point(feature);
    if (
      !coordinates ||
      !/^\d{1,12}_\d{1,3}$/.test(String(p?.cameraId)) ||
      p["status.stillImageAvailability"] !== "videoOrImagesAvailable"
    )
      continue;
    const image = safeUrl(
      p.stillImageUrl,
      "kamera.atlas.vegvesen.no",
      /^\/api\/images\/\d{1,12}_\d{1,3}$/,
    );
    if (!image || !image.endsWith("/" + p.cameraId)) continue;
    const declared =
      p.videoServiceLevel === 1 &&
      String(p.videoEncodingStandard).toLowerCase() === "hls";
    const video = declared
      ? safeUrl(
          p.videoUrl,
          "kamera.vegvesen.no",
          new RegExp("^/public/" + p.cameraId + "/manifest\\.m3u8$"),
        )
      : null;
    const name =
      [p.roadNumber, p.description, p.orientationDescription]
        .filter((v) => typeof v === "string" && v)
        .join(" · ") || p.cameraId;
    cameras.push({
      id: "vegvesen:" + p.cameraId,
      provider: "vegvesen",
      name,
      country: "NO",
      lon: coordinates[0],
      lat: coordinates[1],
      kind: video ? "video" : "snapshot",
      image_url: image,
      ...(video ? { video_url: video, has_audio: null } : {}),
      source_url: NO_LICENSE,
      license_url: NO_LICENSE,
      attribution: NO_ATTRIBUTION,
      updated_at: null,
      cadence_seconds: null,
    });
    if (cameras.length === 1000) break;
  }
  return cameras;
}
function allowedRequest(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash)
    throw Error("unapproved_camera_url");
  if (
    u.hostname === "tie.digitraffic.fi" &&
    /^\/api\/weathercam\/v1\/stations(?:\/C\d{5}(?:\/data)?)?$/.test(
      u.pathname,
    ) &&
    !u.search
  )
    return u;
  if (u.href === NORWAY_CAMERAS_URL) return u;
  if (
    u.hostname === "kamera.vegvesen.no" &&
    /^\/public\/\d{1,12}_\d{1,3}\/[A-Za-z0-9_.-]+\.m3u8$/.test(u.pathname) &&
    !u.search
  )
    return u;
  throw Error("unapproved_camera_url");
}
async function getText(
  url: string,
  fetcher: typeof fetch,
  maxBytes = MAX_BYTES,
  manifest = false,
) {
  const u = allowedRequest(url);
  let limits = upstreamLimits.get(fetcher);
  if (!limits) {
    limits = new Map();
    upstreamLimits.set(fetcher, limits);
  }
  const limit = limits.get(u.hostname) ?? { calls: [], retryAt: 0 };
  limits.set(u.hostname, limit);
  limit.calls = limit.calls.filter((t) => t > Date.now() - 60000);
  if (limit.retryAt > Date.now()) throw Error("camera_provider_backoff");
  if (u.hostname === "tie.digitraffic.fi" && limit.calls.length >= 50)
    throw Error("camera_provider_request_budget");
  limit.calls.push(Date.now());

  const response = await fetcher(u.href, {
    redirect: "manual",
    headers: {
      Accept: manifest
        ? "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain"
        : "application/geo+json, application/json",
      "User-Agent": "WorldWatch/0.1 (public provider camera context)",
      "Accept-Encoding": "gzip",
      ...(u.hostname === "tie.digitraffic.fi"
        ? { "Digitraffic-User": "WorldWatch/0.1" }
        : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Error("camera_redirect_rejected");
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry)
          : retry
            ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
            : 60;
      limit.retryAt =
        Date.now() +
        Math.max(60, Number.isFinite(seconds) ? seconds : 60) * 1000;
    }
    await response.body?.cancel();
    throw Error("camera_provider_http_" + response.status);
  }
  const mime = response.headers.get("content-type") ?? "";
  if (!manifest && !/json/i.test(mime)) {
    await response.body?.cancel();
    throw Error("camera_provider_not_json");
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw Error("camera_payload_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("camera_empty_response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Error("camera_payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export function listPublicCameras(
  fetcher: typeof fetch = fetch,
): Promise<PublicCameraCatalog> {
  const cached = catalogCache.get(fetcher);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const sources: CameraSourceHealth[] = [];
    const providers = [
      {
        id: "digitraffic" as const,
        url: FINLAND_CAMERAS_URL,
        parse: parseDigitrafficCatalog,
        attribution: FI_ATTRIBUTION,
        license_url: FI_LICENSE,
      },
      {
        id: "vegvesen" as const,
        url: NORWAY_CAMERAS_URL,
        parse: parseVegvesenCatalog,
        attribution: NO_ATTRIBUTION,
        license_url: NO_LICENSE,
      },
    ];
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const checked_at = new Date().toISOString();
        try {
          const raw = JSON.parse(await getText(provider.url, fetcher));
          const cameras = provider.parse(raw);
          sources.push({
            id: provider.id,
            status: "ok",
            attribution: provider.attribution,
            license_url: provider.license_url,
            checked_at,
            cadence_seconds: 600,
            catalog_count: raw.features.length,
            cameras_count: cameras.length,
          });
          return cameras;
        } catch (error) {
          sources.push({
            id: provider.id,
            status: "error",
            attribution: provider.attribution,
            license_url: provider.license_url,
            checked_at,
            cadence_seconds: 600,
            error:
              error instanceof Error
                ? error.message
                : "camera_provider_unavailable",
          });
          return [];
        }
      }),
    );
    return {
      cameras: [
        ...new Map(lists.flat().map((camera) => [camera.id, camera])).values(),
      ].slice(0, 2000),
      sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
    };
  })();
  catalogCache.set(fetcher, { expires: Date.now() + CATALOG_TTL, promise });
  return promise;
}
function captureTime(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validEventTime(value)
  )
    return null;
  return new Date(value).toISOString();
}
function validateManifest(text: string, url: string) {
  if (!text.trimStart().startsWith("#EXTM3U"))
    throw Error("camera_invalid_hls_manifest");
  if (/#EXT-X-(?:SESSION-)?KEY\s*:/i.test(text))
    throw Error("camera_encrypted_hls_not_supported");
  const base = new URL(url),
    prefix = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const attributes = [...text.matchAll(/\bURI\s*=\s*["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  for (const ref of [...lines, ...attributes]) {
    const next = new URL(ref, url);
    if (
      next.protocol !== "https:" ||
      next.host !== base.host ||
      next.username ||
      next.password ||
      next.search ||
      next.hash ||
      !next.pathname.startsWith(prefix)
    )
      throw Error("camera_hls_external_reference");
  }
  if (!lines.length) throw Error("camera_empty_hls_manifest");
  return lines.map((ref) => new URL(ref, url).href);
}
export function getPublicCamera(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicCamera | null> {
  if (!/^(?:digitraffic:C\d{5}|vegvesen:\d{1,12}_\d{1,3})$/.test(id))
    return Promise.resolve(null);
  const cached = detailCache.get(id);
  if (cached && cached.fetcher === fetcher && cached.expires > Date.now())
    return cached.promise;
  const promise = (async () => {
    const catalog = await listPublicCameras(fetcher);
    const camera = catalog.cameras.find((v) => v.id === id);
    if (!camera) {
      if (
        catalog.sources.find((s) => id.startsWith(s.id + ":"))?.status ===
        "error"
      )
        throw Error("camera_provider_unavailable");
      return null;
    }
    if (camera.provider === "digitraffic") {
      const station = id.split(":")[1];
      const [detail, data] = await Promise.all([
        getText(FINLAND_CAMERAS_URL + "/" + station, fetcher).then(JSON.parse),
        getText(FINLAND_CAMERAS_URL + "/" + station + "/data", fetcher).then(
          JSON.parse,
        ),
      ]);
      if (detail?.properties?.id !== station || data?.id !== station)
        throw Error("camera_station_identity_mismatch");
      if (detail.properties.collectionStatus !== "GATHERING")
        throw Error("camera_not_currently_collecting");
      const preferred = camera.image_url.split("/").pop()!.replace(".jpg", "");
      const preset =
        (detail.properties.presets ?? []).find(
          (p: any) => p.id === preferred && p.inCollection === true,
        ) ?? presetOf(detail.properties);
      const image = safeUrl(
        preset?.imageUrl,
        "weathercam.digitraffic.fi",
        /^\/C\d{7}\.jpg$/,
      );
      if (!preset || !image || !image.endsWith("/" + preset.id + ".jpg"))
        throw Error("camera_image_unavailable");
      const measured = Array.isArray(data.presets)
        ? data.presets.find((v: any) => v.id === preset.id)?.measuredTime
        : null;
      const cadence = detail.properties.collectionInterval;
      return {
        ...camera,
        name: detail.properties.names?.en ?? camera.name,
        image_url: image,
        updated_at: captureTime(measured),
        cadence_seconds:
          Number.isFinite(cadence) && cadence >= 1 && cadence <= 86400
            ? cadence
            : null,
      };
    }
    if (camera.video_url) {
      try {
        const master = await getText(
          camera.video_url,
          fetcher,
          128 * 1024,
          true,
        );
        const references = validateManifest(master, camera.video_url);
        const child = references.find((v) =>
          new URL(v).pathname.endsWith(".m3u8"),
        );
        if (child)
          validateManifest(
            await getText(child, fetcher, 128 * 1024, true),
            child,
          );
        return { ...camera, has_audio: null };
      } catch (error) {
        const { video_url, ...snapshot } = camera;
        return {
          ...snapshot,
          kind: "snapshot" as const,
          has_audio: null,
          video_error:
            error instanceof Error ? error.message : "camera_video_unavailable",
        };
      }
    }
    return camera;
  })();
  for (const [key, entry] of detailCache) {
    if (entry.expires <= Date.now()) detailCache.delete(key);
  }
  while (detailCache.size >= 32)
    detailCache.delete(detailCache.keys().next().value!);
  detailCache.set(id, { fetcher, expires: Date.now() + DETAIL_TTL, promise });
  return promise;
}
