import { ArrowUpRight, Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { translate, type Language } from "./locale";

type PushStatus = { configured: boolean; public_key: string | null };
type Rule = {
  id: string;
  rule: { name?: string };
  feeds: { atom: string; geojson: string };
};

async function owner(path: string, init: RequestInit = {}) {
  const r = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) throw Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

/** The owner's out-of-app channels for server watch rules: Web Push on this device, and each rule's feeds. */
export default function Notifications({ language }: { language: Language }) {
  const tr = (text: string) => translate(language, text);
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const [push, setPush] = useState<PushStatus | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    owner("/api/push").then(setPush, (e) => setStatus(String(e)));
    owner("/api/alert-rules").then((v) => setRules(v.rules), (e) => setStatus(String(e)));
    if (supported)
      navigator.serviceWorker
        .getRegistration("/")
        .then((r) => r?.pushManager.getSubscription() ?? null)
        .then(setSubscription, (e) => setStatus(String(e)));
  }, [supported]);
  const subscribe = async () => {
    if ((await Notification.requestPermission()) !== "granted") {
      setStatus(tr("Notifications are blocked for this site in the browser settings."));
      return;
    }
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const next = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: push!.public_key!,
    });
    await owner("/api/push", { method: "POST", body: JSON.stringify(next.toJSON()) });
    setSubscription(next);
    setStatus(tr("This device will be notified."));
  };
  const unsubscribe = async () => {
    await owner("/api/push", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription!.endpoint }),
    });
    await subscription!.unsubscribe();
    setSubscription(null);
    setStatus(tr("This device will no longer be notified."));
  };
  const act = (action: () => Promise<void>) => () =>
    action().catch((e) => setStatus(String(e)));
  return (
    <div className="context-section">
      <h2>{tr("Server watch rules")}</h2>
      <p>
        {tr(
          "Notices from the server's watch rules reach this device by Web Push, one per situation, with corrections for notices it received. Each rule also has private Atom and GeoJSON feeds; anyone with a feed link can read it.",
        )}
      </p>
      {!supported ? (
        <p className="caution">{tr("This browser doesn't support Web Push.")}</p>
      ) : push && !push.configured ? (
        <p className="caution">
          {tr("Web Push isn't configured on this server. It needs VAPID keys in its environment.")}
        </p>
      ) : push && subscription ? (
        <button onClick={act(unsubscribe)}>
          <BellOff size={16} />
          {tr("Stop notifying this device")}
        </button>
      ) : push ? (
        <button onClick={act(subscribe)}>
          <Bell size={16} />
          {tr("Notify this device")}
        </button>
      ) : null}
      {status && <p role="status">{status}</p>}
      {rules.length === 0 && (
        <p>{tr("No server watch rules yet. Create one through the alert rules API.")}</p>
      )}
      {rules.map((r) => (
        <article className="source" key={r.id}>
          <strong>{r.rule.name ?? r.id}</strong>
          <small>
            <a href={r.feeds.atom} target="_blank" rel="noreferrer">
              Atom <ArrowUpRight size={14} />
            </a>{" "}
            ·{" "}
            <a href={r.feeds.geojson} target="_blank" rel="noreferrer">
              GeoJSON <ArrowUpRight size={14} />
            </a>
          </small>
        </article>
      ))}
    </div>
  );
}
