// Web Push (RFC 8030) with VAPID application server keys (RFC 8292) and aes128gcm message
// encryption (RFC 8291), on WebCrypto alone so the same code runs in a Worker and in Node. The
// browser's own push service relays the message; no push provider account or library is involved.
import type { IncidentView } from "../shared/contracts";
import { clip } from "./feeds";

export type PushKeys = { publicKey: string; privateKey: string; subject: string };
export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
/** Everything a notification shows. No notes, rule names or evidence leave the server. */
export type PushMessage = {
  v: 1;
  incident_id: string;
  title: string;
  body: string;
  correction: boolean;
  url: string;
};

/** Undelivered alerts older than this are dropped, by the push service and by the outbox alike. */
export const PUSH_TTL_SECONDS = 6 * 3600;
const RECORD_SIZE = 4096;
const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

/** Keys come only from the environment. Without all three, Web Push is off and nothing is queued. */
export function pushKeys(e: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): PushKeys | null {
  return e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY && e.VAPID_SUBJECT
    ? {
        publicKey: e.VAPID_PUBLIC_KEY,
        privateKey: e.VAPID_PRIVATE_KEY,
        subject: e.VAPID_SUBJECT,
      }
    : null;
}

export function base64url(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(text: string) {
  const plain = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(plain.padEnd(Math.ceil(plain.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
}
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A P-256 JWK from an uncompressed public point, with the private scalar when signing. */
export function p256Jwk(publicKey: string, d?: string): JsonWebKey {
  const point = fromBase64url(publicKey);
  if (point.length !== 65 || point[0] !== 4) throw Error("invalid_p256_public_key");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64url(point.slice(1, 33)),
    y: base64url(point.slice(33)),
    ...(d ? { d } : {}),
  };
}

/** The RFC 8292 Authorization value for one push service: an ES256 JWT for its origin, valid 12 hours. */
export async function vapidAuthorization(
  endpoint: string,
  keys: PushKeys,
  now = Date.now(),
) {
  const part = (value: unknown) =>
    base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: keys.subject,
  })}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(keys.publicKey, keys.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/**
 * One aes128gcm record for a subscription's keys (RFC 8291 section 3). Tests fix the salt and
 * the sender's ephemeral key pair to reproduce the RFC's example; otherwise both are fresh.
 */
export async function encryptPush(
  plaintext: Bytes,
  subscription: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  salt = crypto.getRandomValues(new Uint8Array(16)),
  sender?: CryptoKeyPair,
) {
  const receiver = fromBase64url(subscription.p256dh);
  const pair =
    sender ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const local = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          receiver,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      pair.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    fromBase64url(subscription.auth),
    shared,
    concat(encoder.encode("WebPush: info\0"), receiver, local),
    32,
  );
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  // A single, final record: the content, then the 0x02 delimiter, without padding.
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]),
    concat(plaintext, new Uint8Array([2])),
  );
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = local.length;
  return concat(header, local, new Uint8Array(ciphertext));
}

/** The notification for an eligible notice: headline, impact and place, and whether it corrects an earlier one. */
export function pushMessage(i: IncidentView, correction: string | null): PushMessage {
  return {
    v: 1,
    incident_id: i.id,
    title: (correction ? "Correction: " : "") + clip(i.headline, 120),
    body: clip(
      [
        correction,
        `Impact ${i.impact.replaceAll("_", " ")}`,
        i.location?.name,
      ]
        .filter(Boolean)
        .join(" · "),
      200,
    ),
    correction: !!correction,
    url: "/?incident=" + encodeURIComponent(i.id),
  };
}

/** POSTs one encrypted message. A later message for the same incident replaces one still waiting at the push service. */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  message: PushMessage,
  keys: PushKeys,
  request: typeof fetch = fetch,
) {
  const topic = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(message.incident_id)),
    ),
  ).slice(0, 32);
  return request(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(subscription.endpoint, keys),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(PUSH_TTL_SECONDS),
      urgency: "high",
      topic,
    },
    body: await encryptPush(encoder.encode(JSON.stringify(message)), subscription),
    signal: AbortSignal.timeout(10000),
  });
}
