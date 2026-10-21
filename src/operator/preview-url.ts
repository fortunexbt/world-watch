/** Resolve an owner-preview request without letting URL normalization change its credential destination. */
export function previewDestination(requestPath: string, upstream: string): URL {
  const base = new URL(upstream);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw Error("invalid_preview_upstream_origin");
  if (
    !requestPath.startsWith("/") ||
    requestPath.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(requestPath)
  )
    throw Error("invalid_preview_request_path");
  const destination = new URL(requestPath, base);
  if (
    destination.origin !== base.origin ||
    destination.username ||
    destination.password
  )
    throw Error("preview_destination_origin_mismatch");
  return destination;
}
