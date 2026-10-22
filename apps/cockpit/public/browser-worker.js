const origin = self.location.origin;
const NOTICE = { en: "New entries need you", de: "Neue Einträge brauchen dich" };

function cockpitWindow(client) {
  if (!client) return false;
  const url = new URL(client.url);
  if (url.origin !== origin) return false;
  return url.pathname === "/cockpit" || url.pathname.startsWith("/cockpit/");
}

function notice() {
  const language = String(self.navigator?.language ?? "").toLowerCase();
  return language.startsWith("de") ? NOTICE.de : NOTICE.en;
}

async function attention(tag) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = windows.filter(
    (client) => cockpitWindow(client) && client.visibilityState === "visible",
  );
  if (visible.length > 0) {
    for (const client of visible) client.postMessage({ type: "attention" });
    return;
  }
  return self.registration.showNotification("SubKit", {
    body: notice(),
    icon: "/cockpit/app-icon-192.png",
    tag,
    renotify: true,
  });
}

function cockpitTab(client) {
  return cockpitWindow(client) && !new URL(client.url).pathname.startsWith("/cockpit/i/");
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("push", (event) => {
  event.waitUntil(attention("/cockpit/"));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find(cockpitTab);
      return client ? client.focus() : self.clients.openWindow("/cockpit/");
    })(),
  );
});
