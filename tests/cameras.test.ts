import test from "node:test";
import assert from "node:assert/strict";
import {
  FINLAND_CAMERAS_URL,
  NORWAY_CAMERAS_URL,
  parseDigitrafficCatalog,
  parseVegvesenCatalog,
  listPublicCameras,
  getPublicCamera,
} from "../src/server/cameras";
const fc = (features: any[]) => ({ type: "FeatureCollection", features });
const fi = (id = "C01503", extra: any = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [23.99616, 60.05374, 0] },
  properties: {
    id,
    name: "kt51_Inkoo",
    collectionStatus: "GATHERING",
    state: null,
    dataUpdatedTime: "2026-10-21T03:25:44Z",
    presets: [
      { id: id + "02", inCollection: true },
      { id: id + "01", inCollection: true },
    ],
    ...extra,
  },
});
const no = (id = "1429037_1", extra: any = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [10.1, 60.1] },
  properties: {
    cameraId: id,
    stillImageUrl: "https://kamera.atlas.vegvesen.no/api/images/" + id,
    description: "E6 road camera",
    "status.stillImageAvailability": "videoOrImagesAvailable",
    lastUpdateTime: "2026-10-21T13:23:56+0200",
    videoServiceLevel: 1,
    videoEncodingStandard: "hls",
    videoUrl: "https://kamera.vegvesen.no/public/" + id + "/manifest.m3u8",
    ...extra,
  },
});
const json = (value: any) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function mock(
  extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url === FINLAND_CAMERAS_URL) return json(fc([fi()]));
    if (url === NORWAY_CAMERAS_URL) return json(fc([no()]));
    if (url === FINLAND_CAMERAS_URL + "/C01503")
      return json({
        ...fi("C01503", {
          collectionInterval: 600,
          names: { en: "Road 51 Inkoo" },
          presets: [
            {
              id: "C0150301",
              inCollection: true,
              imageUrl: "https://weathercam.digitraffic.fi/C0150301.jpg",
            },
          ],
        }),
      });
    if (url === FINLAND_CAMERAS_URL + "/C01503/data")
      return json({
        id: "C01503",
        dataUpdatedTime: "2026-10-21T11:18:57Z",
        presets: [{ id: "C0150301", measuredTime: "2026-10-21T11:18:11Z" }],
      });
    if (url.endsWith("/manifest.m3u8"))
      return new Response(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nhls_1_stream_1_orig.m3u8\n",
      );
    if (url.endsWith("/hls_1_stream_1_orig.m3u8"))
      return new Response(
        "#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\nsegment-53295.ts\n",
      );
    throw Error("unexpected request " + url);
  }) as typeof fetch;
  return { fetcher, calls };
}
test("Finnish catalog accepts null state, chooses one active preset and never invents capture time", () => {
  const rows = parseDigitrafficCatalog(
    fc([
      fi(),
      fi("C01504", { collectionStatus: "REMOVED_TEMPORARILY" }),
      fi("C01505", { presets: [{ id: "C0999901", inCollection: true }] }),
    ]),
  );
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].image_url,
    "https://weathercam.digitraffic.fi/C0150301.jpg",
  );
  assert.equal(rows[0].updated_at, null);
  assert.equal(rows[0].cadence_seconds, null);
});
test("Norwegian catalog keeps only available official images and source-declared matching HLS", () => {
  const rows = parseVegvesenCatalog(
    fc([
      no(),
      no("2_1", {
        "status.stillImageAvailability":
          "videoOrImagesUnavailableDueToCameraFault",
      }),
      no("3_1", { stillImageUrl: "https://attacker.example/image.jpg" }),
      no("4_1", {
        stillImageUrl: "https://kamera.atlas.vegvesen.no/api/images/5_1",
      }),
      no("6_1", {
        videoUrl: "https://kamera.vegvesen.no/public/7_1/manifest.m3u8",
      }),
    ]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "video");
  assert.equal(rows[0].has_audio, null);
  assert.equal(rows[0].updated_at, null);
  assert.equal(rows[1].kind, "snapshot");
  assert.equal(rows[1].video_url, undefined);
});
test("catalog caches two provider calls; partial failure is visible and never healthy fake zero", async () => {
  const { fetcher, calls } = mock((url) =>
    url === NORWAY_CAMERAS_URL
      ? new Response("unavailable", { status: 503 })
      : undefined,
  );
  const a = await listPublicCameras(fetcher),
    b = await listPublicCameras(fetcher);
  assert.equal(a, b);
  assert.equal(calls.length, 2);
  assert.equal(a.cameras.length, 1);
  assert.equal(a.sources.find((v) => v.id === "vegvesen")?.status, "error");
  assert.match(a.sources.find((v) => v.id === "vegvesen")?.error ?? "", /503/);
});
test("selected Finland detail uses actual preset measurement, caches, and never fetches an image", async () => {
  const { fetcher, calls } = mock();
  const a = await getPublicCamera("digitraffic:C01503", fetcher),
    b = await getPublicCamera("digitraffic:C01503", fetcher);
  assert.equal(a, b);
  assert.equal(a?.updated_at, "2026-10-21T11:18:11.000Z");
  assert.equal(a?.cadence_seconds, 600);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => !c.url.endsWith(".jpg")));
  assert.ok(
    calls.every(
      (c) => new Headers(c.init?.headers).get("Authorization") === null,
    ),
  );
  assert.ok(calls.every((c) => c.init?.redirect === "manual"));
  assert.equal(
    new Headers(calls[0].init?.headers).get("Accept-Encoding"),
    "gzip",
  );
});
test("metadata update cannot substitute for missing capture measurement", async () => {
  const { fetcher } = mock((url) =>
    url.endsWith("/C01503/data")
      ? json({
          id: "C01503",
          dataUpdatedTime: "2026-10-21T11:18:57Z",
          presets: [],
        })
      : undefined,
  );
  assert.equal(
    (await getPublicCamera("digitraffic:C01503", fetcher))?.updated_at,
    null,
  );
});
test("HLS selected detail validates master and child without fetching segments or inventing audio", async () => {
  const { fetcher, calls } = mock();
  const camera = await getPublicCamera("vegvesen:1429037_1", fetcher);
  assert.equal(camera?.kind, "video");
  assert.equal(camera?.has_audio, null);
  assert.equal(camera?.updated_at, null);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => !c.url.endsWith(".ts")));
});
test("encrypted or external HLS references fall back to snapshot without fetching unsafe targets", async () => {
  for (const body of [
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nsegment.ts\n',
    "#EXTM3U\nhttps://attacker.example/live.m3u8\n",
  ]) {
    const { fetcher, calls } = mock((url) =>
      url.endsWith("/manifest.m3u8") ? new Response(body) : undefined,
    );
    const camera = await getPublicCamera("vegvesen:1429037_1", fetcher);
    assert.equal(camera?.kind, "snapshot");
    assert.equal(camera?.video_url, undefined);
    assert.ok(camera?.video_error);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => !c.url.includes("attacker")));
  }
});
test("upstream redirects are rejected without following or forwarding secrets", async () => {
  const { fetcher, calls } = mock((url) =>
    url === FINLAND_CAMERAS_URL
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/" },
        })
      : undefined,
  );
  const result = await listPublicCameras(fetcher);
  assert.match(
    result.sources.find((v) => v.id === "digitraffic")?.error ?? "",
    /redirect_rejected/,
  );
  assert.equal(calls.length, 2);
});
test("payload size and MIME failures remain per-provider health errors", async () => {
  for (const response of [
    new Response("{}", { headers: { "Content-Type": "text/html" } }),
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1),
      },
    }),
  ]) {
    const { fetcher } = mock((url) =>
      url === FINLAND_CAMERAS_URL ? response : undefined,
    );
    const result = await listPublicCameras(fetcher);
    assert.equal(result.cameras.length, 1);
    assert.equal(
      result.sources.find((v) => v.id === "digitraffic")?.status,
      "error",
    );
  }
});
test("429 pauses provider requests across distinct camera selections", async () => {
  const { fetcher, calls } = mock((url) =>
    url === FINLAND_CAMERAS_URL
      ? json(fc([fi(), fi("C01504")]))
      : url.endsWith("/C01503")
        ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
        : undefined,
  );
  await assert.rejects(getPublicCamera("digitraffic:C01503", fetcher), /429/);
  // A different valid catalog camera shares the provider backoff, rather than bypassing per-ID cache.
  await assert.rejects(
    getPublicCamera("digitraffic:C01504", fetcher),
    /camera_provider_backoff/,
  );
  assert.equal(calls.filter((c) => c.url.includes("/C01504")).length, 0);
});
test("invalid identifiers cause no network access and malformed catalog types fail clearly", async () => {
  const { fetcher, calls } = mock();
  assert.equal(
    await getPublicCamera("https://attacker.example", fetcher),
    null,
  );
  assert.equal(calls.length, 0);
  assert.throws(() => parseDigitrafficCatalog({ features: [] }), /invalid/);
  assert.throws(() => parseVegvesenCatalog({}), /invalid/);
});

test("invalid calendar measurement remains unknown rather than normalizing", async () => {
  const { fetcher } = mock((url) =>
    url.endsWith("/C01503/data")
      ? json({
          id: "C01503",
          presets: [{ id: "C0150301", measuredTime: "2026-02-30T11:18:11Z" }],
        })
      : undefined,
  );
  assert.equal(
    (await getPublicCamera("digitraffic:C01503", fetcher))?.updated_at,
    null,
  );
});
