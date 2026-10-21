import type { Language } from "./locale";
export function validDate(value: string) {
  if (!value) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!m) return false;
  const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`
  )
    return false;
  return Number.isFinite(Date.parse(value));
}
/** Event precision is preserved: a date alone never acquires a guessed hour. */
export function eventTime(value: string) {
  return (
    (/^\d{4}-\d{2}-\d{2}$/.test(value) && validDate(value)) ||
    (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
      validDate(value))
  );
}
export function formatWhen(
  value: string | null | undefined,
  language: Language = "en",
) {
  const unknown = language === "it" ? "Ora sconosciuta" : "Time unknown";
  if (!value || !validDate(value)) return unknown;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", {
      timeZone: dateOnly ? "UTC" : "Europe/Rome",
      day: "2-digit",
      month: "short",
      ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
    }).format(new Date(value)) +
    (dateOnly
      ? language === "it"
        ? " · ora sconosciuta"
        : " · time unknown"
      : "")
  );
}
export function formatAge(
  value: string | null | undefined,
  language: Language = "en",
  now = Date.now(),
) {
  if (!value || !validDate(value))
    return language === "it" ? "sconosciuto" : "unknown";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return minutes < 1
    ? language === "it"
      ? "ora"
      : "now"
    : minutes < 60
      ? `${minutes}m`
      : `${Math.floor(minutes / 60)}h`;
}
export function validBounds(value: string) {
  const b = value.split(",").map(Number);
  return (
    b.length === 4 &&
    b.every(Number.isFinite) &&
    b[0] >= -180 &&
    b[2] <= 180 &&
    b[1] >= -90 &&
    b[3] <= 90 &&
    b[0] < b[2] &&
    b[1] < b[3]
  );
}
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    const parsed = value ? JSON.parse(value) : fallback;
    return Array.isArray(fallback) && !Array.isArray(parsed)
      ? fallback
      : parsed;
  } catch {
    return fallback;
  }
}
