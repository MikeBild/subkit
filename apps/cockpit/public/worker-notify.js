const NOTICE = {
  en: "New entries need you",
  de: "Neue Einträge brauchen dich",
};
const ATTENTION_TITLES = {
  en: {
    stopped: "Something is on hold",
    failing: "Something is failing",
    decide: "A decision is waiting for you",
  },
  de: {
    stopped: "Ein Ablauf wurde angehalten",
    failing: "Etwas schlägt fehl",
    decide: "Eine Entscheidung wartet auf dich",
  },
};
const ATTENTION_STEPS = {
  en: {
    review: "Review the change and decide.",
    answer: "Answer so it can continue.",
    reauth: "Sign the connection in again.",
    renew: "Renew the approval.",
    open_runs: "Look at the latest runs.",
    chat: "Sort it out in the chat.",
    open: "Open the item in SubKit.",
  },
  de: {
    review: "Prüf die Änderung und entscheide.",
    answer: "Antworte, damit es weitergeht.",
    reauth: "Melde die Verbindung neu an.",
    renew: "Erneuere die Freigabe.",
    open_runs: "Sieh dir die letzten Läufe an.",
    chat: "Klär es im Chat.",
    open: "Öffne den Eintrag in SubKit.",
  },
};
const PAUSED_SUMMARY = {
  en: { title: "{count} schedules were paused", body: "See why, then resume them." },
  de: {
    title: "{count} Zeitpläne wurden pausiert",
    body: "Sieh dir an, warum, und setz sie fort.",
  },
};
const DIGEST_SUMMARY = {
  en: {
    title: "{count} items need you",
    stopped: "{count} on hold",
    failing: "{count} failing",
    decideOne: "1 decision",
    decide: "{count} decisions",
  },
  de: {
    title: "{count} Einträge brauchen dich",
    stopped: "{count} angehalten",
    failing: "{count} Fehler",
    decideOne: "1 Entscheidung",
    decide: "{count} Entscheidungen",
  },
};
const DIGEST_CLASSES = ["stopped", "failing", "decide"];
const PAUSED_SUMMARY_MAX = 999;
const NOTIFICATION_SETTLE_MS = 1000;
const NOTIFICATION_BURST = 3;
const NOTIFICATION_ICON = "/cockpit/app-icon-192.png";
const PUSH_ITEMS_MAX = 8;
const ATTENTION_ID = /^[a-z][a-z_-]{0,31}(?::[A-Za-z0-9_.-]{1,64})?$/;
const ATTENTION_HREF = /^\/cockpit(?:[/?#][A-Za-z0-9/_.~?=&%:#-]{0,500})?$/;

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

function pushText(event) {
  try {
    return event.data ? String(event.data.text()) : "";
  } catch {
    return "";
  }
}

function attentionTargets(text) {
  const none = { items: [], more: 0, paused: 0, digest: null };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return none;
  }
  if (payload?.type !== "attention" || !Array.isArray(payload.items)) return none;
  const items = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of payload.items.slice(0, PUSH_ITEMS_MAX)) {
    const known =
      raw &&
      typeof raw.id === "string" &&
      ATTENTION_ID.test(raw.id) &&
      !seen.has(raw.id) &&
      Object.hasOwn(ATTENTION_TITLES.en, raw.class);
    if (!known) {
      dropped += 1;
      continue;
    }
    seen.add(raw.id);
    const href =
      typeof raw.href === "string" &&
      ATTENTION_HREF.test(raw.href) &&
      !raw.href.startsWith("/cockpit/i/")
        ? raw.href
        : null;
    items.push({
      id: raw.id,
      class: raw.class,
      severity: raw.severity === "critical" || raw.severity === "urgent" ? raw.severity : "notice",
      href,
    });
  }
  const more = Number.isSafeInteger(payload.more) && payload.more > 0 ? payload.more : 0;
  return {
    items,
    more: more + dropped + Math.max(0, payload.items.length - PUSH_ITEMS_MAX),
    paused: pausedCount(payload.summary),
    digest: digestCounts(payload.summary),
  };
}

function digestCounts(summary) {
  const total = summary?.total;
  if (!Number.isSafeInteger(total) || total < 2) return null;
  const byClass = {};
  for (const name of DIGEST_CLASSES) {
    const count = summary?.by_class?.[name];
    if (Number.isSafeInteger(count) && count > 0)
      byClass[name] = Math.min(count, PAUSED_SUMMARY_MAX);
  }
  return { total: Math.min(total, PAUSED_SUMMARY_MAX), byClass };
}

function digestNotification(targets, locale, base) {
  const text = DIGEST_SUMMARY[locale];
  const parts = DIGEST_CLASSES.filter((name) => targets.digest.byClass[name]).map((name) => {
    const count = targets.digest.byClass[name];
    const template = name === "decide" && count === 1 ? text.decideOne : text[name];
    return template.replace("{count}", String(count));
  });
  return {
    title: text.title.replace("{count}", String(targets.digest.total)),
    options: {
      body: parts.join(", "),
      icon: NOTIFICATION_ICON,
      tag: `${base}#summary`,
      renotify: true,
      data: { href: scopedHref(targets.items[0]?.href, base) },
    },
  };
}

function pausedCount(summary) {
  const count = summary?.schedules_paused;
  return Number.isSafeInteger(count) && count >= 2 ? Math.min(count, PAUSED_SUMMARY_MAX) : 0;
}

function scopedHref(href, base) {
  if (typeof href !== "string" || !ATTENTION_HREF.test(href)) return base;
  const rest = href.slice("/cockpit".length);
  if (rest.startsWith("/i/")) return base;
  return rest.startsWith("/") ? `${base}${rest.slice(1)}` : `${base}${rest}`;
}

function attentionNotifications(targets, locale, base, steps) {
  if (targets.digest) return [digestNotification(targets, locale, base)];
  const paused = targets.paused >= 2 ? targets.paused : 0;
  const shown = targets.items.slice(0, NOTIFICATION_BURST - (paused ? 1 : 0));
  const rest = targets.items.length - shown.length + targets.more;
  const summary = paused
    ? [
        {
          title: PAUSED_SUMMARY[locale].title.replace("{count}", String(paused)),
          options: {
            body: PAUSED_SUMMARY[locale].body,
            icon: NOTIFICATION_ICON,
            tag: `${base}#schedules-paused`,
            renotify: true,
            data: { href: base },
          },
        },
      ]
    : [];
  const items = shown.map((item) => {
    const step = steps && Object.hasOwn(steps, item.id) ? steps[item.id] : "open";
    return {
      title: ATTENTION_TITLES[locale][item.class],
      options: {
        body: Object.hasOwn(ATTENTION_STEPS[locale], step)
          ? ATTENTION_STEPS[locale][step]
          : ATTENTION_STEPS[locale].open,
        icon: NOTIFICATION_ICON,
        tag: `${base}#${item.id}`,
        renotify: true,
        silent: item.severity === "notice",
        data: { href: scopedHref(item.href, base) },
      },
    };
  });
  const list = [...summary, ...items];
  if (list.length === 0 || rest > 0)
    list.push({
      title: "SubKit",
      options: { body: NOTICE[locale], icon: NOTIFICATION_ICON, tag: base, renotify: true },
    });
  return list;
}

function notificationTarget(notification, base) {
  const href = notification?.data?.href;
  return typeof href === "string" && href.startsWith(base) && !href.startsWith("//") ? href : base;
}

async function announceAttention(event, base, ownWindow, details) {
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
  const targets = attentionTargets(pushText(event));
  const steps = details ? await details(targets) : null;
  const locale = await noticeLocale();
  for (const notice of attentionNotifications(targets, locale, base, steps))
    await self.registration.showNotification(notice.title, notice.options);
  await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_SETTLE_MS));
}

async function openAttention(event, base, ownWindow) {
  const target = notificationTarget(event.notification, base);
  event.notification.close();
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const client = windows.find(ownWindow);
  if (!client) return self.clients.openWindow(new URL(target, self.registration.scope).href);
  if (target !== base) client.postMessage({ type: "open", href: target });
  return client.focus();
}

self.subkitNotify = {
  announceAttention,
  openAttention,
  attentionTargets,
  attentionNotifications,
  scopedHref,
  noticeLocale,
};
