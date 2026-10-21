import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parse } from "dotenv";
// Manual smoke harness: explicitly local, never a production acceptance test.
const target = new URL(process.env.EW_BROWSER_URL || "http://127.0.0.1:8787");
if (
  !["http:", "https:"].includes(target.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
  target.username ||
  target.password ||
  target.pathname !== "/" ||
  target.search ||
  target.hash
) {
  throw new Error("browser_smoke_requires_loopback_origin");
}
const base = target.origin;
const env = parse(await readFile(".dev.vars", "utf8"));
const output = "work/browser-smoke";
await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
  ],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const auth = await context.request.post(base + "/api/session", {
    data: { token: env.EUROPE_WATCH_OWNER_TOKEN },
    maxRedirects: 0,
  });
  if (!auth.ok()) throw Error("owner_session_failed");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Contextual controls" })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: output + "/desktop.png" });
  const result: any = {
    base,
    desktop: {
      title: await page.title(),
      map: await page.locator(".maplibregl-canvas").count(),
      panel: await page.locator(".panel").count(),
      items: await page.locator(".feed-item").count(),
      auth_gate: await page.locator("#token").count(),
    },
    errors,
  };
  await page.getByRole("button", { name: "Contextual controls" }).click();
  await page.getByRole("button", { name: "Source health" }).click();
  await page.screenshot({ path: output + "/health.png" });
  result.health = await page
    .getByRole("heading", { name: "Collection & analysis" })
    .count();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Switch incoming reports and incidents" })
    .click();
  result.incoming = await page.locator(".report").count();
  await page.screenshot({ path: output + "/incoming.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "/mobile.png" });
  result.mobile = {
    horizontal_overflow: await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    panel_width: await page
      .locator(".panel")
      .evaluate((e) => e.getBoundingClientRect().width),
    min_button_target: await page
      .locator(".topbar button")
      .evaluateAll((es) =>
        Math.min(...es.map((e) => e.getBoundingClientRect().height)),
      ),
  };
  await page.getByRole("button", { name: "Change panel height" }).click();
  result.mobile.full_sheet_height = await page
    .locator(".panel")
    .evaluate((e) => e.getBoundingClientRect().height);
  await page.emulateMedia({ reducedMotion: "reduce" });
  result.reduced_motion = await page.evaluate(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  await writeFile(output + "/browser.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
