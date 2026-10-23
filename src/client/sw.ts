// The owner app's service worker. It shows each Web Push notice and opens the incident it
// names. It caches nothing and is built only for the owner app, never the public demo.
export {};
type Lasting<T> = T & { waitUntil(work: Promise<unknown>): void };
type PushMessage = { incident_id: string; title: string; body: string; url: string };
declare const self: {
  location: Location;
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: "window" }): Promise<{ focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: "push", listener: (event: Lasting<{ data: { json(): PushMessage } | null }>) => void): void;
  addEventListener(type: "notificationclick", listener: (event: Lasting<{ notification: Notification }>) => void): void;
};

self.addEventListener("push", (event) => {
  const message = event.data?.json();
  if (!message) return;
  // One notification per incident: a correction replaces the notice it corrects.
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.incident_id,
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window" })
      .then(([open]) => (open ? open.navigate(url).then(() => open.focus()) : self.clients.openWindow(url))),
  );
});
