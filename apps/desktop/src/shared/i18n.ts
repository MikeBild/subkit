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
  "notify.do.open_runs": { de: "Sieh dir die letzten Runs an.", en: "Look at the latest runs." },
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
  "notify.reason.pair_approval_requested": {
    de: "Die zweite Freigabe fehlt noch.",
    en: "The second approval is still missing.",
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
    de: "Geplante Runs starten gerade nicht.",
    en: "Scheduled runs are not starting right now.",
  },
  "notify.reason.failing": {
    de: "Die letzten Runs sind gescheitert.",
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
    de: "Der Connector braucht eine Aktualisierung.",
    en: "The connector needs an update.",
  },
  "notify.reason.degraded": {
    de: "Der Connector antwortet nur eingeschränkt.",
    en: "The connector answers only in part.",
  },
  "notify.reason.unhealthy": {
    de: "Der Connector antwortet nicht.",
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
    de: "Ein Run der Aufgabe ist gescheitert.",
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

  "common.back": { de: "Zurück", en: "Back" },
  "common.next": { de: "Weiter", en: "Next" },
  "common.step": { de: "Schritt {current} von {total}", en: "Step {current} of {total}" },
  "common.report": { de: "Fehler melden", en: "Report a problem" },

  "welcome.title": { de: "Willkommen bei SubKit Desktop", en: "Welcome to SubKit Desktop" },
  "welcome.approvals": {
    de: "Sieh, was deine Freigabe braucht",
    en: "See what needs your approval",
  },
  "welcome.approvals.detail": {
    de: "Alles Wichtige auf einen Blick.",
    en: "Everything important at a glance.",
  },
  "welcome.chat": { de: "Chatte und entwirf Workflows", en: "Chat and draft workflows" },
  "welcome.chat.detail": {
    de: "Von deiner Idee zum festen Ablauf.",
    en: "From your idea to a routine that runs.",
  },
  "welcome.tasks": {
    de: "Lass Aufgaben Schritt für Schritt erledigen",
    en: "Get tasks done step by step",
  },
  "welcome.tasks.detail": {
    de: "SubKit arbeitet an deinem Ziel.",
    en: "SubKit works toward your goal.",
  },
  "welcome.control": { de: "Du behältst die Kontrolle", en: "You stay in control" },
  "welcome.control.detail": {
    de: "Änderungen brauchen dein Okay.",
    en: "Changes need your okay.",
  },
  "welcome.start": { de: "Loslegen", en: "Get started" },
  "welcome.invite": { de: "Einladungslink verwenden", en: "Use an invitation link" },
  "welcome.invite.label": { de: "Einladungslink", en: "Invitation link" },
  "welcome.invite.hint": {
    de: "Füge den Link aus deiner Einladungs-Mail ein.",
    en: "Paste the link from your invitation email.",
  },
  "welcome.invite.open": { de: "Einladung öffnen", en: "Open invitation" },
  "welcome.invite.invalid": {
    de: "Das ist kein vollständiger Einladungslink. Kopiere den ganzen Link aus der Einladungs-Mail.",
    en: "This isn’t a complete invitation link. Copy the whole link from the invitation email.",
  },

  "invite.valid": { de: "Du bist eingeladen", en: "You’re invited" },
  "invite.valid.body": {
    de: "{inviter} hat dich in den Arbeitsbereich „{workspace}“ eingeladen.",
    en: "{inviter} invited you to the workspace “{workspace}”.",
  },
  "invite.valid.anonymous": {
    de: "Du bist in den Arbeitsbereich „{workspace}“ eingeladen.",
    en: "You’re invited to the workspace “{workspace}”.",
  },
  "invite.meta": {
    de: "Einladung für {email} · gültig bis {date}",
    en: "Invitation for {email} · valid until {date}",
  },
  "invite.join": { de: "Im Browser beitreten", en: "Join in your browser" },
  "invite.expired": { de: "Diese Einladung ist abgelaufen", en: "This invitation has expired" },
  "invite.withdrawn": {
    de: "Diese Einladung wurde zurückgezogen",
    en: "This invitation was withdrawn",
  },
  "invite.used": {
    de: "Diese Einladung wurde schon verwendet",
    en: "This invitation was already used",
  },
  "invite.invalid": { de: "Diese Einladung ist ungültig", en: "This invitation isn’t valid" },
  "invite.busy": { de: "Gerade zu viele Versuche", en: "Too many attempts right now" },
  "invite.askNew": {
    de: "Bitte die Person, die dich eingeladen hat, um eine neue Einladung.",
    en: "Ask the person who invited you for a new invitation.",
  },
  "invite.signInInstead": {
    de: "Geh zurück, verbinde den Server und melde dich an.",
    en: "Go back, connect the server and sign in.",
  },
  "invite.later": {
    de: "Versuch es in ein paar Minuten erneut.",
    en: "Try again in a few minutes.",
  },

  "connect.title": { de: "Server verbinden", en: "Connect server" },
  "connect.lead": {
    de: "Gib die Adresse deines SubKit-Servers ein.",
    en: "Enter the address of your SubKit server.",
  },
  "connect.address.label": { de: "Serveradresse", en: "Server address" },
  "connect.check": { de: "Verbindung prüfen", en: "Check connection" },
  "connect.checking": { de: "Wird geprüft …", en: "Checking…" },
  "connect.examples": { de: "Beispiele:", en: "Examples:" },
  "connect.useExample": { de: "Beispiel verwenden", en: "Use the example" },

  "field.empty": { de: "Gib eine Serveradresse ein.", en: "Enter a server address." },
  "field.invalid": {
    de: "Keine gültige Adresse, zum Beispiel {example}",
    en: "Not a valid address, for example {example}",
  },
  "field.insecure": {
    de: "Nutze https://. Nur localhost darf http:// nutzen.",
    en: "Use https://. Only localhost may use http://.",
  },
  "field.credentials": {
    de: "Die Adresse darf keine Zugangsdaten enthalten.",
    en: "The address must not contain credentials.",
  },

  "slot.ok": { de: "Verbunden", en: "Connected" },
  "slot.unreachable": { de: "Server nicht erreichbar", en: "Server not reachable" },
  "slot.unreachable.help": {
    de: "Unter dieser Adresse kam keine Antwort. Prüf die Adresse und deine Internetverbindung.",
    en: "No answer came from this address. Check the address and your internet connection.",
  },
  "slot.not-subkit": { de: "Kein SubKit-Server", en: "Not a SubKit server" },
  "slot.not-subkit.help": {
    de: "Unter dieser Adresse antwortet etwas anderes.",
    en: "Something else answers at this address.",
  },
  "notice.server-too-old": {
    de: "Version {version} wird nicht unterstützt",
    en: "Version {version} isn’t supported",
  },
  "notice.server-too-old.body": {
    de: "Diese App braucht {needs} oder neuer. Geändert wurde nichts.",
    en: "This app needs {needs} or later. Nothing was changed.",
  },
  "notice.ask": { de: "Administrator fragen", en: "Ask an administrator" },
  "notice.asked": {
    de: "Nachricht für deinen Administrator kopiert",
    en: "Message for your administrator copied",
  },
  "notice.ask.text": {
    de: "Bitte aktualisiere den SubKit-Server {host} von Version {version} auf {needs} oder neuer, damit SubKit Desktop sich verbinden kann.",
    en: "Please update the SubKit server {host} from version {version} to {needs} or later so SubKit Desktop can connect.",
  },
  "slot.app-too-old": { de: "App zu alt", en: "App too old" },
  "slot.app-too-old.help": {
    de: "Aktualisiere SubKit Desktop.",
    en: "Update SubKit Desktop.",
  },
  "slot.login-unsupported": {
    de: "Anmeldung nicht unterstützt",
    en: "Sign-in not supported",
  },
  "slot.login-unsupported.help": {
    de: "Aktualisiere den Server oder SubKit Desktop.",
    en: "Update the server or SubKit Desktop.",
  },
  "chip.version": { de: "Version {version}", en: "Version {version}" },

  "err.retry": { de: "Erneut versuchen", en: "Try again" },
  "err.tech": { de: "Technische Einzelheit", en: "Technical detail" },
  "err.copy": { de: "Kopieren", en: "Copy" },
  "err.copied": { de: "Kopiert", en: "Copied" },
  "err.code": { de: "Code", en: "Code" },
  "err.url": { de: "Adresse", en: "Address" },
  "err.app": { de: "App-Version", en: "App version" },
  "err.needs": { de: "Benötigt", en: "Needs" },

  "signin.title": { de: "Anmelden im Browser", en: "Sign in with browser" },
  "signin.body": {
    de: "Zugangsdaten gibst du nur im Browser ein, nie hier.",
    en: "You enter credentials only in the browser, never here.",
  },
  "signin.open": { de: "Browser öffnen", en: "Open browser" },
  "signin.waiting": {
    de: "Warte auf Bestätigung im Browser …",
    en: "Waiting for confirmation in the browser…",
  },
  "signin.exchanging": { de: "Anmeldung wird abgeschlossen …", en: "Finishing sign-in…" },
  "signin.done": { de: "Angemeldet", en: "Signed in" },
  "signin.afterJoin": {
    de: "Schließ zuerst den Beitritt im Browser ab, dann melde dich hier an.",
    en: "First finish joining in your browser, then sign in here.",
  },
  "signin.cancel": { de: "Abbrechen", en: "Cancel" },
  "signin.doneTitle": { de: "Gerät registriert", en: "Device registered" },
  "signin.doneLead": {
    de: "Dieses Gerät ist jetzt registriert. Du kannst es jederzeit in den Einstellungen abmelden.",
    en: "This device is now registered. You can sign it out at any time in the settings.",
  },
  "signin.device": { de: "Gerätename", en: "Device name" },
  "signin.status": { de: "Status", en: "Status" },
  "signin.connected": { de: "Verbunden", en: "Connected" },
  "signin.server": { de: "Server", en: "Server" },
  "signin.enter": { de: "SubKit öffnen", en: "Open SubKit" },
  "signin.failed.cancelled": { de: "Anmeldung abgebrochen", en: "Sign-in canceled" },
  "signin.failed.expired": {
    de: "Anmeldung abgelaufen, starte sie neu",
    en: "Sign-in expired, start it again",
  },
  "signin.failed.rejected": { de: "Server hat abgelehnt", en: "The server declined" },
  "signin.failed.outdated": {
    de: "App zu alt, aktualisiere SubKit Desktop",
    en: "App too old, update SubKit Desktop",
  },
  "signin.failed.unreachable": { de: "Server nicht erreichbar", en: "Server not reachable" },
  "signin.failed.browser-failed": {
    de: "Der Browser ließ sich nicht öffnen",
    en: "The browser couldn’t be opened",
  },

  "relogin.title": { de: "Sitzung abgelaufen", en: "Session expired" },
  "relogin.body": {
    de: "Melde dich neu an, deine Einstellungen bleiben.",
    en: "Sign in again; your settings are kept.",
  },
  "relogin.button": { de: "Neu anmelden", en: "Sign in again" },
  "relogin.other": { de: "Anderen Server verbinden", en: "Connect another server" },

  "firstRun.workspace.title": { de: "Arbeitsbereich", en: "Workspace" },
  "firstRun.workspace.lead": {
    de: "Du hast Zugriff auf {count} Arbeitsbereiche. Du kannst später jederzeit wechseln.",
    en: "You have access to {count} workspaces. You can switch at any time later.",
  },
  "firstRun.workspace.failed": {
    de: "Der Wechsel hat nicht geklappt. Versuch es noch einmal.",
    en: "Switching didn’t work. Try again.",
  },
  "firstRun.workspace.keep": {
    de: "Im aktuellen Arbeitsbereich bleiben",
    en: "Stay in the current workspace",
  },
  "firstRun.role.admin": { de: "Administrator", en: "Admin" },
  "firstRun.role.member": { de: "Mitglied", en: "Member" },
  "firstRun.role.enduser": { de: "Anwender", en: "User" },
  "firstRun.notifications.title": { de: "Benachrichtigungen erlauben", en: "Allow notifications" },
  "firstRun.notifications.body": {
    de: "SubKit meldet sich, wenn ein Run fertig ist oder etwas deine Freigabe braucht.",
    en: "SubKit lets you know when a run is done or something needs your approval.",
  },
  "firstRun.notifications.allow": { de: "Erlauben", en: "Allow" },
  "firstRun.later": { de: "Jetzt nicht", en: "Not now" },
  "firstRun.diagnostics.title": { de: "Diagnosedaten", en: "Diagnostics" },
  "firstRun.diagnostics.question": {
    de: "Sollen deine Fehlerberichte Diagnosedaten enthalten?",
    en: "Should your bug reports include diagnostics?",
  },
  "firstRun.diagnostics.body": {
    de: "Dann hängt SubKit an jeden Fehlerbericht, den du sendest, einen Diagnosebericht an. Geheimnisse, Adressen und Pfade werden vorher entfernt.",
    en: "Then SubKit attaches a diagnostics report to every bug report you send. Secrets, addresses and paths are removed first.",
  },
  "firstRun.diagnostics.share": { de: "Diagnosedaten anhängen", en: "Attach diagnostics" },
  "perm.test.title": { de: "Benachrichtigungen sind an", en: "Notifications are on" },
  "perm.test.body": {
    de: "So meldet sich SubKit, wenn ein Run fertig ist oder etwas deine Freigabe braucht.",
    en: "This is how SubKit tells you when a run is done or something needs your approval.",
  },
  "strip.revoked": { de: "Abgemeldet von {host}", en: "Signed out of {host}" },
  "strip.revoked.action": { de: "Neu anmelden", en: "Sign in again" },
  "strip.revoked.body": {
    de: "Der Server hat dieses Gerät abgemeldet. Melde dich neu an, deine Einstellungen bleiben.",
    en: "The server signed this device out. Sign in again; your settings are kept.",
  },
  "strip.offline": { de: "{host} ist offline", en: "{host} is offline" },

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
