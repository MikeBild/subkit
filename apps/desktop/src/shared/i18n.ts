export type Locale = "de" | "en";
export type LocaleSetting = Locale | "system";

const MESSAGES = {
  "app.name": { de: "SubKit", en: "SubKit" },
  "app.version": { de: "SubKit Desktop {version}", en: "SubKit Desktop {version}" },

  "tray.open": { de: "SubKit öffnen", en: "Open SubKit" },
  "tray.needsYou": { de: "Braucht dich ({count})", en: "Needs you ({count})" },
  "tray.needsYou.none": { de: "Nichts braucht dich gerade", en: "Nothing needs you right now" },
  "tray.pause": {
    de: "Benachrichtigungen 1 Stunde pausieren",
    en: "Pause notifications for 1 hour",
  },
  "tray.resume": { de: "Benachrichtigungen fortsetzen", en: "Resume notifications" },
  "tray.paused": { de: "Benachrichtigungen pausiert", en: "Notifications paused" },
  "tray.launchAtLogin": { de: "Beim Anmelden starten", en: "Launch at login" },
  "tray.checkUpdates": { de: "Nach Updates suchen", en: "Check for updates" },
  "tray.quit": { de: "SubKit beenden", en: "Quit SubKit" },
  "tray.status.offline": { de: "Keine Verbindung zum Server", en: "No connection to the server" },
  "tray.status.signedOut": { de: "Nicht angemeldet", en: "Not signed in" },
  "tray.status.reconnect": { de: "Neu anmelden …", en: "Sign in again…" },

  "menu.about": { de: "Über SubKit", en: "About SubKit" },
  "menu.settings": { de: "Einstellungen …", en: "Settings…" },
  "menu.servers": { de: "Server", en: "Servers" },
  "menu.addServer": { de: "Server hinzufügen …", en: "Add server…" },
  "menu.edit": { de: "Bearbeiten", en: "Edit" },
  "menu.view": { de: "Darstellung", en: "View" },
  "menu.window": { de: "Fenster", en: "Window" },
  "menu.help": { de: "Hilfe", en: "Help" },
  "menu.reload": { de: "Neu laden", en: "Reload" },
  "menu.reportProblem": { de: "Fehler melden …", en: "Report a problem…" },

  "report.title": { de: "Diagnosedaten", en: "Diagnostics" },
  "report.detail": {
    de: "Die Diagnosedaten enthalten App-Version, Betriebssystem, Server-Version und die letzten 10 Fehler. Zugangsdaten, Pfade und URL-Parameter sind entfernt. Füg sie deiner Fehlermeldung bei.",
    en: "The diagnostics contain the app version, operating system, server version and the last 10 errors. Credentials, paths and URL parameters are removed. Add them to your problem report.",
  },
  "report.copy": { de: "Diagnose kopieren", en: "Copy diagnostics" },
  "report.save": { de: "Als Datei speichern …", en: "Save as file…" },
  "report.cancel": { de: "Abbrechen", en: "Cancel" },

  "updates.title": { de: "Updates", en: "Updates" },
  "updates.ready.title": { de: "Update bereit", en: "Update ready" },
  "updates.ready.body": {
    de: "SubKit Desktop {version} ist geladen. Starte neu, um das Update zu installieren, oder es wird beim nächsten Beenden installiert.",
    en: "SubKit Desktop {version} is downloaded. Restart to install the update, or it is installed the next time you quit.",
  },
  "updates.restart": { de: "Jetzt neu starten", en: "Restart now" },
  "updates.later": { de: "Später", en: "Later" },
  "updates.disabled": {
    de: "Automatische Updates sind in diesem Build nicht aktiv.",
    en: "Automatic updates are not enabled in this build.",
  },
  "updates.state.idle": {
    de: "SubKit Desktop {version} ist installiert.",
    en: "SubKit Desktop {version} is installed.",
  },
  "updates.state.checking": { de: "Suche nach Updates …", en: "Checking for updates…" },
  "updates.state.current": {
    de: "Du nutzt die aktuelle Version {version}.",
    en: "You’re on the latest version, {version}.",
  },
  "updates.state.available": {
    de: "Version {version} ist verfügbar. Der Download beginnt gleich.",
    en: "Version {version} is available. The download starts shortly.",
  },
  "updates.state.downloading": {
    de: "Version {version} wird geladen: {percent} %",
    en: "Downloading version {version}: {percent}%",
  },
  "updates.state.ready": {
    de: "Version {version} ist geladen. Starte SubKit neu, um sie zu installieren.",
    en: "Version {version} is downloaded. Restart SubKit to install it.",
  },
  "updates.state.failed.check": {
    de: "Die Suche nach Updates ist fehlgeschlagen. Prüf deine Internetverbindung und versuch es noch einmal.",
    en: "Checking for updates failed. Check your internet connection and try again.",
  },
  "updates.state.failed.download": {
    de: "Das Update ließ sich nicht laden. Versuch es noch einmal.",
    en: "The update could not be downloaded. Try again.",
  },
  "updates.state.failed.unverified": {
    de: "Das Update ließ sich nicht prüfen und wurde nicht installiert. Deine Version bleibt unverändert, versuch es später noch einmal.",
    en: "The update could not be verified and was not installed. Your version stays as it is; try again later.",
  },
  "updates.menu.downloading": {
    de: "Update wird geladen: {percent} %",
    en: "Downloading update: {percent}%",
  },
  "updates.menu.restart": {
    de: "Neu starten und Update installieren",
    en: "Restart and install update",
  },

  "notify.title.stopped.named": { de: "„{name}“ wurde angehalten", en: "“{name}” was stopped" },
  "notify.title.stopped.plain": { de: "Ein Ablauf wurde angehalten", en: "Something was stopped" },
  "notify.title.failing.named": { de: "„{name}“ schlägt fehl", en: "“{name}” is failing" },
  "notify.title.failing.plain": { de: "Etwas schlägt fehl", en: "Something is failing" },
  "notify.title.decide.named": {
    de: "„{name}“ wartet auf deine Entscheidung",
    en: "“{name}” is waiting for your decision",
  },
  "notify.title.decide.plain": {
    de: "Eine Entscheidung wartet auf dich",
    en: "A decision is waiting for you",
  },
  "notify.do.review": {
    de: "Prüf die Änderung und entscheide.",
    en: "Review the change and decide.",
  },
  "notify.do.answer": { de: "Antworte, damit es weitergeht.", en: "Answer so it can continue." },
  "notify.do.reauth": { de: "Melde die Verbindung neu an.", en: "Sign the connection in again." },
  "notify.do.renew": { de: "Erneuere die Freigabe.", en: "Renew the approval." },
  "notify.do.open_runs": { de: "Sieh dir die letzten Läufe an.", en: "Look at the latest runs." },
  "notify.do.chat": { de: "Klär es im Chat.", en: "Sort it out in the chat." },
  "notify.do.open": { de: "Öffne den Eintrag in SubKit.", en: "Open the item in SubKit." },

  "notify.reason.awaiting_answer": {
    de: "SubKit hat eine Frage an dich.",
    en: "SubKit has a question for you.",
  },
  "notify.reason.execution_authority_required": {
    de: "Für die aktuelle Version fehlt die Freigabe, automatische Starts warten.",
    en: "The current version has no approval, so automatic starts wait.",
  },
  "notify.reason.execution_authority_unavailable": {
    de: "Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen, automatische Starts warten.",
    en: "The approval expired, is used up or was revoked, so automatic starts wait.",
  },
  "notify.reason.version_awaiting_approval": {
    de: "Eine neue Version wartet auf deine Freigabe.",
    en: "A new version is waiting for your approval.",
  },
  "notify.reason.version_needs_repair": {
    de: "Eine Version lässt sich so nicht freigeben und braucht eine Korrektur.",
    en: "A version cannot be approved as it is and needs a fix.",
  },
  "notify.reason.approval_expiring": {
    de: "Eine Freigabe läuft bald ab.",
    en: "An approval expires soon.",
  },
  "notify.reason.schedule_auto_paused": {
    de: "Der Zeitplan wurde nach wiederholten Fehlern pausiert.",
    en: "The schedule was paused after repeated failures.",
  },
  "notify.reason.scheduler_stale": {
    de: "Geplante Läufe starten gerade nicht.",
    en: "Scheduled runs are not starting right now.",
  },
  "notify.reason.failing": {
    de: "Die letzten Läufe sind gescheitert.",
    en: "The latest runs failed.",
  },
  "notify.reason.patch_proposed": {
    de: "Eine Korrektur liegt bereit.",
    en: "A fix is ready.",
  },
  "notify.reason.needs_reauth": {
    de: "Der verbundene Dienst verlangt eine neue Anmeldung.",
    en: "The connected service asks for a new sign-in.",
  },
  "notify.reason.needs_update": {
    de: "Der Konnektor braucht eine Aktualisierung.",
    en: "The connector needs an update.",
  },
  "notify.reason.degraded": {
    de: "Der Konnektor antwortet nur eingeschränkt.",
    en: "The connector answers only in part.",
  },
  "notify.reason.unhealthy": {
    de: "Der Konnektor antwortet nicht.",
    en: "The connector does not answer.",
  },
  "notify.reason.refresh_refused": {
    de: "Der Dienst hat die Verlängerung der Anmeldung abgelehnt.",
    en: "The service refused to renew the sign-in.",
  },
  "notify.reason.refresh_failed": {
    de: "Die Anmeldung ließ sich nicht verlängern.",
    en: "The sign-in could not be renewed.",
  },
  "notify.reason.expired_no_refresh": {
    de: "Die Anmeldung ist abgelaufen.",
    en: "The sign-in expired.",
  },
  "notify.reason.secret_unreadable": {
    de: "Ein gespeichertes Geheimnis ist nicht mehr lesbar.",
    en: "A stored secret can no longer be read.",
  },
  "notify.reason.secret_prepared": {
    de: "Ein vorbereitetes Geheimnis wartet auf deine Bestätigung.",
    en: "A prepared secret is waiting for your confirmation.",
  },
  "notify.reason.skills_proposed": {
    de: "Neue Skills sind vorgeschlagen.",
    en: "New skills are proposed.",
  },
  "notify.reason.intake_collected": {
    de: "Im Eingang liegen neue Einträge.",
    en: "New entries are in the Inbox.",
  },
  "notify.reason.budget_critical": {
    de: "Das Token-Kontingent ist fast aufgebraucht.",
    en: "The token allowance is almost used up.",
  },
  "notify.reason.ai_access_missing": {
    de: "Der KI-Zugang fehlt.",
    en: "The AI access is missing.",
  },
  "notify.reason.risk_critical": {
    de: "Ein Risiko ist kritisch geworden.",
    en: "A risk has become critical.",
  },
  "notify.reason.task_run_failed": {
    de: "Ein Lauf der Aufgabe ist gescheitert.",
    en: "A run of the task failed.",
  },
  "notify.reason.task_result_ready": {
    de: "Ein Ergebnis liegt für dich bereit.",
    en: "A result is ready for you.",
  },
  "notify.reason.task_grant_required": {
    de: "Die Aufgabe braucht deine Freigabe.",
    en: "The task needs your approval.",
  },
  "notify.reason.task_grant_expiring": {
    de: "Die Freigabe der Aufgabe läuft bald ab.",
    en: "The task’s approval expires soon.",
  },
  "notify.reason.task_owner_unavailable": {
    de: "Die Aufgabe hat niemanden mehr, der sie verantwortet.",
    en: "The task no longer has anyone responsible for it.",
  },
  "notify.summary.schedulesPaused": {
    de: "{count} Zeitpläne wurden pausiert",
    en: "{count} schedules were paused",
  },
  "notify.summary.schedulesPaused.do": {
    de: "Sieh dir an, warum, und setz sie fort.",
    en: "See why, then resume them.",
  },
  "notify.summary.title": { de: "{count} Einträge brauchen dich", en: "{count} items need you" },
  "notify.summary.stopped": { de: "{count} angehalten", en: "{count} on hold" },
  "notify.summary.failing": { de: "{count} Fehler", en: "{count} failing" },
  "notify.summary.decide.one": { de: "1 Entscheidung", en: "1 decision" },
  "notify.summary.decide.other": { de: "{count} Entscheidungen", en: "{count} decisions" },

  "connect.title": { de: "Mit SubKit verbinden", en: "Connect to SubKit" },
  "connect.lead": {
    de: "Gib die Adresse deines SubKit-Servers ein. Danach meldest du dich in deinem Browser an.",
    en: "Enter the address of your SubKit server. You then sign in in your browser.",
  },
  "connect.address.label": { de: "Server-Adresse", en: "Server address" },
  "connect.address.hint": {
    de: "Zum Beispiel subkit.example.com. Lokal geht auch localhost:3000.",
    en: "For example subkit.example.com. Locally, localhost:3000 works too.",
  },
  "connect.check": { de: "Server prüfen", en: "Check server" },
  "connect.checking": { de: "Server wird geprüft …", en: "Checking server…" },
  "connect.signIn": { de: "Im Browser anmelden", en: "Sign in in the browser" },

  "status.compatible": {
    de: "SubKit {version} gefunden. Du kannst dich anmelden.",
    en: "Found SubKit {version}. You can sign in.",
  },
  "status.server-too-old": {
    de: "Dieser Server läuft mit SubKit {version}. Die App braucht mindestens {min}. Bitte deine Administration, den Server zu aktualisieren.",
    en: "This server runs SubKit {version}. The app needs at least {min}. Ask your administrator to update the server.",
  },
  "status.app-too-old": {
    de: "Der Server verlangt mindestens Version {min} der App, installiert ist {version}. Aktualisiere SubKit Desktop und versuch es erneut.",
    en: "The server requires at least version {min} of the app and you have {version}. Update SubKit Desktop and try again.",
  },
  "status.login-unsupported": {
    de: "Dieser Server bietet die Anmeldung, die diese App braucht, nicht an. Aktualisiere SubKit Desktop oder bitte deine Administration, den Server zu prüfen.",
    en: "This server doesn’t offer the sign-in this app needs. Update SubKit Desktop or ask your administrator to check the server.",
  },
  "status.unreachable": {
    de: "Der Server ist nicht erreichbar. Prüf die Adresse und deine Internetverbindung.",
    en: "The server can’t be reached. Check the address and your internet connection.",
  },
  "status.not-subkit": {
    de: "Unter dieser Adresse antwortet kein SubKit-Server. Prüf die Adresse.",
    en: "No SubKit server answers at this address. Check the address.",
  },
  "status.invalid": {
    de: "Das ist keine gültige Adresse. Beispiel: subkit.example.com",
    en: "That’s not a valid address. Example: subkit.example.com",
  },
  "status.empty": { de: "Gib eine Server-Adresse ein.", en: "Enter a server address." },
  "status.insecure": {
    de: "Die Adresse muss mit https:// beginnen. Nur localhost darf http:// nutzen.",
    en: "The address must start with https://. Only localhost may use http://.",
  },
  "status.credentials": {
    de: "Die Adresse darf keine Zugangsdaten enthalten.",
    en: "The address must not contain credentials.",
  },

  "login.waiting": {
    de: "Dein Browser ist geöffnet. Melde dich dort an, dann geht es hier automatisch weiter.",
    en: "Your browser is open. Sign in there and you’ll continue here automatically.",
  },
  "login.cancel": { de: "Anmeldung abbrechen", en: "Cancel sign-in" },
  "login.exchanging": { de: "Anmeldung wird abgeschlossen …", en: "Finishing sign-in…" },
  "login.cancelled": {
    de: "Die Anmeldung wurde abgebrochen. Du kannst sie jederzeit neu starten.",
    en: "Sign-in was cancelled. You can start it again at any time.",
  },
  "login.expired": {
    de: "Die Anmeldung ist abgelaufen. Starte sie noch einmal.",
    en: "The sign-in expired. Start it again.",
  },
  "login.rejected": {
    de: "Der Server hat die Anmeldung abgelehnt. Starte sie noch einmal.",
    en: "The server rejected the sign-in. Start it again.",
  },
  "login.outdated": {
    de: "Diese Version der App ist für diesen Server zu alt. Aktualisiere SubKit Desktop und melde dich dann erneut an.",
    en: "This version of the app is too old for this server. Update SubKit Desktop, then sign in again.",
  },
  "login.unreachable": {
    de: "Der Server war beim Abschluss der Anmeldung nicht erreichbar. Versuch es noch einmal.",
    en: "The server couldn’t be reached while finishing the sign-in. Try again.",
  },
  "login.browser-failed": {
    de: "Der Browser ließ sich nicht öffnen. Versuch es noch einmal.",
    en: "The browser couldn’t be opened. Try again.",
  },

  "notice.expired": {
    de: "Deine Sitzung ist abgelaufen. Melde dich neu an, deine Einstellungen bleiben erhalten.",
    en: "Your session expired. Sign in again; your settings are kept.",
  },
  "notice.revoked": {
    de: "Dieses Gerät wurde in SubKit abgemeldet. Melde dich neu an, um es wieder zu verbinden.",
    en: "This device was signed out in SubKit. Sign in again to reconnect it.",
  },
  "notice.offline": {
    de: "SubKit ist gerade nicht erreichbar. Die App versucht es weiter, du kannst es auch selbst erneut versuchen.",
    en: "SubKit can’t be reached right now. The app keeps trying, and you can retry yourself.",
  },

  "profiles.title": { de: "Deine Server", en: "Your servers" },
  "profiles.open": { de: "Öffnen", en: "Open" },
  "profiles.signIn": { de: "Anmelden", en: "Sign in" },
  "profiles.remove": { de: "Entfernen", en: "Remove" },
  "profiles.remove.label": { de: "{name} entfernen", en: "Remove {name}" },
  "profiles.remove.confirm": { de: "„{name}“ entfernen?", en: "Remove “{name}”?" },
  "profiles.remove.detail": {
    de: "Die App löscht die lokale Sitzung für diesen Server. Auf dem Server ändert sich nichts.",
    en: "The app deletes the local session for this server. Nothing changes on the server.",
  },
  "profiles.remove.cancel": { de: "Abbrechen", en: "Cancel" },

  "settings.title": { de: "Einstellungen", en: "Settings" },
  "settings.launchAtLogin": {
    de: "Beim Anmelden am Computer starten",
    en: "Launch when you log in to your computer",
  },
  "settings.quiet": { de: "Ruhezeiten", en: "Quiet hours" },
  "settings.quiet.hint": {
    de: "In den Ruhezeiten zählt SubKit weiter, zeigt aber keine Benachrichtigungen.",
    en: "During quiet hours SubKit keeps counting but shows no notifications.",
  },
  "settings.quiet.from": { de: "Von", en: "From" },
  "settings.quiet.to": { de: "Bis", en: "To" },
  "settings.language": { de: "Sprache", en: "Language" },
  "settings.language.system": { de: "Wie das System", en: "Same as system" },
  "settings.back": { de: "Zurück", en: "Back" },
  "settings.open": { de: "Einstellungen", en: "Settings" },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function t(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return MESSAGES[key][locale].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function resolveLocale(setting: LocaleSetting, systemLocale: string): Locale {
  if (setting === "de" || setting === "en") return setting;
  return systemLocale.toLowerCase().startsWith("de") ? "de" : "en";
}

export function messageKeys(): MessageKey[] {
  return Object.keys(MESSAGES) as MessageKey[];
}

export function dictionary(locale: Locale): Record<MessageKey, string> {
  const out = {} as Record<MessageKey, string>;
  for (const key of messageKeys()) out[key] = MESSAGES[key][locale];
  return out;
}
