const origin = self.location.origin;

function cockpitTab(client) {
  if (!client) return false;
  const url = new URL(client.url);
  if (url.origin !== origin) return false;
  if (url.pathname.startsWith("/cockpit/i/")) return false;
  return url.pathname === "/cockpit" || url.pathname.startsWith("/cockpit/");
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("SubKit", {
      body: "SubKit needs your attention.",
      icon: "/cockpit/app-icon-192.png",
      tag: "/cockpit/",
      renotify: true,
    }),
  );
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
