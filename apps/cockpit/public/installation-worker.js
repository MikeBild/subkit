const scope = new URL(self.registration.scope);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const pending = new Map();

function matchingClient(client) {
  if (!client) return false;
  const url = new URL(client.url);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

const BUILD = typeof self.COCKPIT_BUILD === "string" ? self.COCKPIT_BUILD : "dev";
const SHELL = Array.isArray(self.COCKPIT_SHELL) ? self.COCKPIT_SHELL : [];
const CACHE_PREFIX = "subkit-cockpit:";
const ASSET_PATH = "/cockpit/assets/";
const UNREACHABLE = new Set([502, 504]);
const OFFLINE = {
  en: {
    title: "No connection to the server",
    body: "SubKit cannot be reached right now. Check your connection and try again.",
    retry: "Try again",
  },
  de: {
    title: "Keine Verbindung zum Server",
    body: "SubKit ist gerade nicht erreichbar. Prüf deine Verbindung und versuch es noch einmal.",
    retry: "Erneut versuchen",
  },
};

function cacheName(scopePath, build) {
  return `${CACHE_PREFIX}${scopePath}:${build}`;
}

function staleCaches(names, scopePath, build) {
  const own = `${CACHE_PREFIX}${scopePath}:`;
  return names.filter((name) => name.startsWith(own) && name !== cacheName(scopePath, build));
}

function requestRoute(request, scopeUrl) {
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin) return "pass";
  if (request.method === "POST" && url.pathname === `${scopeUrl.pathname}incoming/share`)
    return "share";
  if (request.method !== "GET") return "pass";
  if (url.pathname.startsWith(ASSET_PATH) && !url.search) return "asset";
  if (
    request.mode === "navigate" &&
    url.pathname.startsWith(scopeUrl.pathname) &&
    !url.pathname.startsWith(`${scopeUrl.pathname}api/`)
  )
    return "page";
  return "pass";
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function offlineDocument(locale, retryHref) {
  const copy = OFFLINE[locale];
  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '<meta name="robots" content="noindex,nofollow,noarchive" />',
    '<meta name="color-scheme" content="light dark" />',
    `<title>${escapeHtml(copy.title)}</title>`,
    "<style>",
    ":root{--page:#ffffff;--text:#0f172a;--muted:#475569;--action:#0f172a;--on-action:#f8fafc}",
    "@media (prefers-color-scheme:dark){:root{--page:#020817;--text:#f8fafc;--muted:#94a3b8;--action:#f8fafc;--on-action:#0f172a}}",
    "*{box-sizing:border-box}",
    "html,body{height:100%;margin:0}",
    "body{display:grid;place-items:center;padding:24px;background:var(--page);color:var(--text);font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
    "main{max-width:26rem;text-align:center}",
    "svg{width:48px;height:48px;border-radius:11px}",
    ".plate{fill:var(--action)}",
    ".glyph{fill:none;stroke:var(--on-action);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}",
    "h1{margin:20px 0 8px;font-size:1.25rem;line-height:1.3;text-wrap:balance}",
    "p{margin:0 0 24px;color:var(--muted);text-wrap:pretty}",
    "a{display:inline-block;min-height:44px;padding:10px 20px;border-radius:8px;background:var(--action);color:var(--on-action);font-weight:600;text-decoration:none}",
    "a:focus-visible{outline:2px solid var(--text);outline-offset:3px}",
    "</style>",
    "</head>",
    '<body data-offline="true">',
    '<main role="alert">',
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect class="plate" width="32" height="32" /><g class="glyph" transform="translate(5 5) scale(0.9167)"><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></g></svg>',
    `<h1>${escapeHtml(copy.title)}</h1>`,
    `<p>${escapeHtml(copy.body)}</p>`,
    `<a href="${escapeHtml(retryHref)}" data-testid="offline-retry">${escapeHtml(copy.retry)}</a>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

async function offlinePage(request) {
  const url = new URL(request.url);
  return new Response(
    offlineDocument(await self.subkitNotify.noticeLocale(), `${url.pathname}${url.search}`),
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function servePage(request) {
  try {
    const response = await fetch(request);
    return UNREACHABLE.has(response.status) ? await offlinePage(request) : response;
  } catch {
    return await offlinePage(request);
  }
}

async function serveAsset(request) {
  const cache = await caches.open(cacheName(scope.pathname, BUILD));
  const cached = await cache.match(request.url);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200 && response.type === "basic")
    await cache.put(request.url, response.clone());
  return response;
}

async function precacheShell() {
  const cache = await caches.open(cacheName(scope.pathname, BUILD));
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (response.status === 200) await cache.put(url, response);
      } catch {}
    }),
  );
}

async function showBadge(count) {
  try {
    if (count === 0) await self.navigator.clearAppBadge?.();
    else if (count === null) await self.navigator.setAppBadge?.();
    else await self.navigator.setAppBadge?.(count);
  } catch {}
}

function attentionSteps(attention) {
  const steps = {};
  for (const item of Array.isArray(attention?.items) ? attention.items : []) {
    if (!item || typeof item.id !== "string" || !Array.isArray(item.actions)) continue;
    const action = item.actions.find((entry) => entry?.primary) ?? item.actions[0];
    if (typeof action?.verb === "string") steps[item.id] = action.verb;
  }
  return steps;
}

function openAttentionCount(attention) {
  return Array.isArray(attention?.items) ? attention.items.length : null;
}

async function attentionDetails(targets) {
  const pushed = targets.items.length + targets.more;
  try {
    const response = await fetch(new URL("api/v1/attention", scope), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      await showBadge(pushed || null);
      return null;
    }
    const attention = await response.json();
    await showBadge(openAttentionCount(attention));
    return attentionSteps(attention);
  } catch {
    await showBadge(pushed || null);
    return null;
  }
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of staleCaches(await caches.keys(), scope.pathname, BUILD))
        await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const route = requestRoute(event.request, scope);
  if (route === "page") event.respondWith(servePage(event.request));
  if (route === "asset") event.respondWith(serveAsset(event.request));
  if (route !== "share") return;
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
  if (event.origin !== scope.origin) return;
  event.waitUntil(
    (async () => {
      const client = event.source?.id ? await self.clients.get(event.source.id) : null;
      if (!matchingClient(client)) return;
      if (event.data?.type === "describe-build") {
        event.ports?.[0]?.postMessage({ build: BUILD, shell: SHELL });
        return;
      }
      if (event.data?.type === "activate-update") {
        await self.skipWaiting();
        return;
      }
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
  event.waitUntil(
    self.subkitNotify.announceAttention(event, scope.pathname, matchingClient, attentionDetails),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.waitUntil(self.subkitNotify.openAttention(event, scope.pathname, matchingClient));
});
