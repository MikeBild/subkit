const origin = self.location.origin;
const COCKPIT_BASE = "/cockpit/";

function cockpitWindow(client) {
  if (!client) return false;
  const url = new URL(client.url);
  if (url.origin !== origin) return false;
  return url.pathname === "/cockpit" || url.pathname.startsWith(COCKPIT_BASE);
}

function cockpitTab(client) {
  return cockpitWindow(client) && !new URL(client.url).pathname.startsWith("/cockpit/i/");
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("push", (event) => {
  event.waitUntil(self.subkitNotify.announceAttention(event, COCKPIT_BASE, cockpitTab, null));
});
self.addEventListener("notificationclick", (event) => {
  event.waitUntil(self.subkitNotify.openAttention(event, COCKPIT_BASE, cockpitTab));
});
