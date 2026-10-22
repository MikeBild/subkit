const origin = self.location.origin;

function cockpitWindow(client) {
  if (!client) return false;
  const url = new URL(client.url);
  if (url.origin !== origin) return false;
  return url.pathname === "/cockpit" || url.pathname.startsWith("/cockpit/");
}

const NOTICE = {
  en: "New entries need you",
  de: "Neue Einträge brauchen dich",
};
const NOTIFICATION_SETTLE_MS = 1000;

function supportedLocale(value) {
  const base = String(value ?? "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  return base === "de" || base === "en" ? base : null;
}

async function noticeLocale() {
  try {
    const chosen = supportedLocale((await self.cookieStore?.get("sk_locale"))?.value);
    if (chosen) return chosen;
  } catch {}
  const languages = self.navigator?.languages?.length
    ? self.navigator.languages
    : [self.navigator?.language];
  for (const language of languages) {
    const locale = supportedLocale(language);
    if (locale) return locale;
  }
  return "en";
}

async function attention(tag, ownWindow) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const visible = windows.filter(
    (client) => ownWindow(client) && client.visibilityState === "visible",
  );
  if (visible.length > 0) {
    for (const client of visible) client.postMessage({ type: "attention" });
    return;
  }
  await self.registration.showNotification("SubKit", {
    body: NOTICE[await noticeLocale()],
    icon: "/cockpit/app-icon-192.png",
    tag,
    renotify: true,
  });
  await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_SETTLE_MS));
}

function cockpitTab(client) {
  return cockpitWindow(client) && !new URL(client.url).pathname.startsWith("/cockpit/i/");
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("push", (event) => {
  event.waitUntil(attention("/cockpit/", cockpitTab));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const client = windows.find(cockpitTab);
      return client ? client.focus() : self.clients.openWindow("/cockpit/");
    })(),
  );
});
