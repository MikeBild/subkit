const scope = new URL(self.registration.scope);
const origin = scope.origin;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const pending = new Map();

function matchingClient(client) {
  if (!client) return false;
  const url = new URL(client.url);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

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

function clearPending() {
  pending.clear();
}

async function readShare(request) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BYTES) throw new Error("share_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("share_missing");
  const chunks = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new Error("share_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const form = await new Response(bytes, {
    headers: { "content-type": request.headers.get("content-type") || "" },
  }).formData();
  const files = form.getAll("files").filter((value) => value instanceof File);
  if (files.length > MAX_FILES) throw new Error("share_too_many_files");
  if (files.some((file) => !file.size || file.size > 5 * 1024 * 1024))
    throw new Error("share_file_too_large");
  const string = (name) => (typeof form.get(name) === "string" ? form.get(name) : "");
  const title = string("title");
  const text = string("text");
  const url = string("url");
  if (title.length > 1000 || text.length > 2_000_000 || url.length > 8192)
    throw new Error("share_too_large");
  return { title, text, url, files };
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "POST" ||
    url.origin !== scope.origin ||
    url.pathname !== `${scope.pathname}incoming/share`
  )
    return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(new URL("api/v1/cockpit/bootstrap", scope), {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return Response.redirect(new URL("?incoming=sign-in", scope), 303);
        const bootstrap = await response.json();
        const value = await readShare(event.request);
        clearPending();
        const id = crypto.randomUUID();
        pending.set(id, {
          ...value,
          tenantId: bootstrap.tenant.id,
          userId: bootstrap.principal.id,
          expires: Date.now() + 5 * 60 * 1000,
        });
        return Response.redirect(new URL(`?incoming=${id}`, scope), 303);
      } catch {
        return Response.redirect(new URL("?incoming=retry", scope), 303);
      }
    })(),
  );
});
self.addEventListener("message", (event) => {
  event.waitUntil(
    (async () => {
      const client = event.source?.id ? await self.clients.get(event.source.id) : null;
      if (!matchingClient(client)) return;
      if (event.data?.type === "clear-incoming") {
        clearPending();
        return;
      }
      if (event.data?.type !== "take-incoming" || typeof event.data.id !== "string") return;
      const value = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (!value || value.expires < Date.now()) {
        client.postMessage({ type: "incoming-unavailable" });
        return;
      }
      client.postMessage({ type: "incoming", value });
    })(),
  );
});
self.addEventListener("push", (event) => {
  event.waitUntil(attention(scope.pathname));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find(matchingClient);
      return client ? client.focus() : self.clients.openWindow(scope.href);
    })(),
  );
});
