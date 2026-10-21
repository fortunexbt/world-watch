/** Explicit operator-owned trust pin; never infer it from a request destination. */
export function configuredSiteOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.origin === value
    )
      return value;
  } catch {}
  throw Error("EW_SITES_ORIGIN_requires_exact_https_origin");
}
export function siteServiceHeaders(
  destination: string,
  token?: string,
  configuredOrigin?: string,
): Record<string, string> {
  const origin = configuredSiteOrigin(configuredOrigin);
  if (token && !origin)
    throw Error("EW_SITES_ORIGIN_required_for_service_token");
  return token && destination === origin
    ? { "OAI-Sites-Authorization": "Bearer " + token }
    : {};
}
