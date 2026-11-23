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

  "report.title": { de: "Fehler melden", en: "Report a problem" },
  "report.lead": {
    de: "Beschreib kurz, was passiert ist. Die Meldung geht an {host}.",
    en: "Briefly describe what happened. The report goes to {host}.",
  },
  "report.lead.signedIn": {
    de: "Beschreib kurz, was passiert ist. Die Meldung geht mit deiner Anmeldung an {host}.",
    en: "Briefly describe what happened. The report goes to {host} under your sign-in.",
  },
  "report.description": { de: "Was ist passiert?", en: "What happened?" },
  "report.description.placeholder": {
    de: "Zum Beispiel: Nach ‚Verbindung prüfen‘ passiert nichts.",
    en: "For example: nothing happens after ‘Check connection’.",
  },
  "report.description.hint": {
    de: "Optional, höchstens 5.000 Zeichen.",
    en: "Optional, up to 5,000 characters.",
  },
  "report.attach": { de: "Diagnose anhängen", en: "Attach diagnostics" },
  "report.attach.hint": {
    de: "Zugangsdaten, Pfade und URL-Parameter sind entfernt.",
    en: "Credentials, paths and URL parameters are removed.",
  },
  "report.preview": { de: "Was die Diagnose enthält", en: "What the diagnostics contain" },
  "report.preview.more": {
    de: "Dazu Signatur, Status von Engine und Runner und Berechtigungen.",
    en: "Plus the signature, engine and runner status, and permissions.",
  },
  "report.fact.app": { de: "App-Version", en: "App version" },
  "report.fact.system": { de: "Betriebssystem", en: "Operating system" },
  "report.fact.server": { de: "Server-Version", en: "Server version" },
  "report.fact.errors": { de: "Fehler und Abstürze", en: "Errors and crashes" },
  "report.fact.log": { de: "Log-Zeilen", en: "Log lines" },
  "report.send": { de: "Senden", en: "Send" },
  "report.sending": { de: "Wird gesendet …", en: "Sending…" },
  "report.retry": { de: "Noch einmal senden", en: "Send again" },
  "report.cancel": { de: "Abbrechen", en: "Cancel" },
  "report.close": { de: "Schließen", en: "Close" },
  "report.copy": { de: "Diagnose kopieren", en: "Copy diagnostics" },
  "report.save": { de: "Als Datei speichern …", en: "Save as file…" },
  "report.reference": { de: "Meldungs-ID", en: "Report ID" },
  "report.trace": { de: "Trace-ID", en: "Trace ID" },
  "report.sent": { de: "Danke, deine Meldung ist angekommen.", en: "Thanks, your report arrived." },
  "report.sent.detail": {
    de: "Wer {host} betreibt, findet sie im Eingang. Nenn bei Rückfragen die Meldungs-ID.",
    en: "Whoever runs {host} finds it in the inbox. Mention the report ID if they ask.",
  },
  "report.no_server": { de: "Noch kein Server verbunden.", en: "No server connected yet." },
  "report.no_server.detail": {
    de: "Kopier die Diagnose oder speichere sie als Datei und schick sie an die Person, die deinen Server betreibt.",
    en: "Copy the diagnostics or save them as a file and send them to the person who runs your server.",
  },
  "report.rate_limited": {
    de: "Gerade gehen zu viele Meldungen ein.",
    en: "Too many reports are coming in right now.",
  },
  "report.rate_limited.detail": {
    de: "Versuch es in ein paar Minuten noch einmal oder kopier die Diagnose.",
    en: "Try again in a few minutes or copy the diagnostics.",
  },
  "report.rate_limited.until": {
    de: "Versuch es ab {time} Uhr noch einmal oder kopier die Diagnose.",
    en: "Try again after {time} or copy the diagnostics.",
  },
  "report.refused": {
    de: "Der Server hat die Meldung nicht angenommen.",
    en: "The server didn’t accept the report.",
  },
  "report.refused.detail": {
    de: "Lass die Diagnose weg und versuch es noch einmal, oder speichere sie als Datei und schick sie an die Person, die deinen Server betreibt.",
    en: "Leave out the diagnostics and try again, or save them as a file and send them to the person who runs your server.",
  },
  "report.unavailable": {
    de: "Dieser Server nimmt keine Meldungen ohne Anmeldung an.",
    en: "This server takes no reports without sign-in.",
  },
  "report.unavailable.detail": {
    de: "Melde dich an und versuch es noch einmal, oder kopier die Diagnose und schick sie an die Person, die deinen Server betreibt.",
    en: "Sign in and try again, or copy the diagnostics and send them to the person who runs your server.",
  },
  "report.offline": { de: "{host} ist nicht erreichbar.", en: "{host} can’t be reached." },
  "report.offline.detail": {
    de: "Prüf deine Verbindung und versuch es noch einmal, oder kopier die Diagnose.",
    en: "Check your connection and try again, or copy the diagnostics.",
  },
  "report.failed": { de: "Die Meldung wurde nicht gesendet.", en: "The report wasn’t sent." },
  "report.failed.detail": {
    de: "Versuch es noch einmal oder kopier die Diagnose. Nenn bei Rückfragen die Trace-ID.",
    en: "Try again or copy the diagnostics. Mention the trace ID if anyone asks.",
  },

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
    de: "Dieser Workflow braucht deine Freigabe, bevor er laufen kann.",
    en: "This workflow needs your approval before it can run.",
  },
  "notify.reason.execution_authority_expired": {
    de: "Die Freigabe für diesen Workflow ist abgelaufen. Gib ihn erneut frei, damit er wieder läuft.",
    en: "The approval for this workflow has expired. Approve it again to let it run.",
  },
  "notify.reason.execution_authority_exhausted": {
    de: "Die freigegebene Anzahl an Runs ist aufgebraucht. Gib ihn erneut frei, damit er wieder läuft.",
    en: "The approved number of runs is used up. Approve it again to let it run.",
  },
  "notify.reason.execution_authority_revoked": {
    de: "Die Freigabe für diesen Workflow wurde widerrufen. Gib ihn erneut frei, damit er wieder läuft.",
    en: "The approval for this workflow was revoked. Approve it again to let it run.",
  },
  "notify.reason.execution_authority_changed": {
    de: "Der Workflow wurde seit der Freigabe geändert. Prüfe die neue Version und gib sie frei.",
    en: "The workflow changed since it was approved. Review and approve the new version.",
  },
  "notify.reason.input_required": {
    de: "Dieser Run wartet auf eine Angabe von dir.",
    en: "This run is waiting for information from you.",
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
  "notify.reason.spend_warning": {
    de: "80 % des KI-Budgets sind ausgegeben.",
    en: "80 % of the AI budget is spent.",
  },
  "notify.reason.spend_limit_unset": {
    de: "Leg ein monatliches KI-Budget fest.",
    en: "Set a monthly AI budget.",
  },
  "notify.reason.spend_limit_reached": {
    de: "Das KI-Budget ist erreicht. Chat und Aufgaben pausieren.",
    en: "The AI budget is reached. Chat and tasks pause.",
  },
  "notify.reason.ai_access_missing": {
    de: "Der KI-Zugang fehlt.",
    en: "The AI access is missing.",
  },
  "notify.reason.model_tools_missing": {
    de: "Das lokale Modell kann keine Werkzeuge aufrufen.",
    en: "The local model can’t call tools.",
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
  "notify.reason.device_offline_waiting": {
    de: "Ein Run wartet, bis sein Gerät online ist.",
    en: "A run is waiting for its device to come online.",
  },
  "notify.reason.local_confirmation_needed": {
    de: "Bestätige eine Aktion auf deinem Gerät.",
    en: "Confirm an action on your device.",
  },
  "notify.reason.device_permission_missing": {
    de: "Diesem Gerät fehlt eine Systemberechtigung.",
    en: "This device is missing a system permission.",
  },
  "notify.reason.device_handover_waiting": {
    de: "Ein Browser-Schritt wartet auf diesem Gerät auf dich.",
    en: "A browser step is waiting for you on this device.",
  },
  "notify.reason.knowledge_review_due": {
    de: "Mindestens eine Wissensquelle ist zur Prüfung fällig.",
    en: "At least one knowledge source is due for a review.",
  },
  "notify.handover.body": {
    de: "Ein Browser-Schritt wartet auf {device} auf dich. Übernimm, erledige ihn und gib dann zurück.",
    en: "A browser step is waiting for you on {device}. Take over, finish it, then hand back.",
  },
  "notify.handover.thisDevice": { de: "diesem Gerät", en: "this device" },
  "notify.reason.folder_changed": {
    de: "Ein freigegebener Ordner wurde ersetzt. Gib ihn neu frei.",
    en: "An allowed folder was replaced. Allow it again.",
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
  "welcome.create": { de: "Neuen Arbeitsbereich anlegen", en: "Create a new workspace" },
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
  "invite.join": { de: "Beitreten und anmelden", en: "Join and sign in" },
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
  "connect.examples": { de: "Bekannte Server:", en: "Known servers:" },
  "connect.ownServer": {
    de: "Eigener Server? Gib seine Adresse ein, z. B. {example}",
    en: "Your own server? Enter its address, e.g. {example}",
  },
  "connect.ownServer.example": {
    de: "https://subkit.deine-firma.de",
    en: "https://subkit.your-company.com",
  },
  "connect.useExample": { de: "SubKit Cloud verwenden", en: "Use SubKit Cloud" },

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
  "signin.join": {
    de: "Tritt im Browser bei und bestätige dort dieses Gerät.",
    en: "Join in your browser and confirm this device there.",
  },
  "signin.create": {
    de: "Melde dich im Browser an. Dort gibst du deinem neuen Arbeitsbereich einen Namen.",
    en: "Sign in in your browser. There you give your new workspace a name.",
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

  "permissions.title": { de: "Damit SubKit Apps bedienen kann", en: "So SubKit can use apps" },
  "permissions.name.accessibility": { de: "Bedienungshilfen", en: "Accessibility" },
  "permissions.name.screen": { de: "Bildschirmaufnahme", en: "Screen Recording" },
  "permissions.why.accessibility": {
    de: "Mit dieser Berechtigung liest und bedient SubKit Knöpfe und Felder in den Apps, die du erlaubt hast.",
    en: "With this permission, SubKit reads and uses buttons and fields in the apps you have allowed.",
  },
  "permissions.why.screen": {
    de: "Mit dieser Berechtigung macht SubKit Bildschirmfotos des App-Fensters, auf denen Passwortfelder geschwärzt sind.",
    en: "With this permission, SubKit takes screenshots of the app window with password fields blacked out.",
  },
  "permissions.granted": { de: "Erteilt", en: "Granted" },
  "permissions.missing": { de: "Fehlt", en: "Missing" },
  "permissions.open": { de: "Systemeinstellungen öffnen", en: "Open System Settings" },
  "permissions.check": { de: "Erneut prüfen", en: "Check again" },
  "permissions.checking": { de: "Wird geprüft …", en: "Checking …" },
  "permissions.restart": { de: "SubKit neu starten", en: "Restart SubKit" },
  "permissions.restarting": { de: "SubKit startet neu …", en: "SubKit is restarting …" },
  "permissions.done": { de: "Fertig", en: "Done" },
  "permissions.later": { de: "Später", en: "Later" },
  "permissions.unsupported": {
    de: "Diese Berechtigungen gibt es nur auf dem Mac.",
    en: "These permissions exist only on the Mac.",
  },
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

  "local.title": { de: "Lokale Fähigkeiten", en: "Local capabilities" },
  "local.macOnly.title": {
    de: "Nur auf einem Mac mit Apple Silicon",
    en: "Only on a Mac with Apple Silicon",
  },
  "local.macOnly.body": {
    de: "Dateien in erlaubten Ordnern, erlaubte Websites und erlaubte Apps kann SubKit vorerst nur auf einem Mac mit Apple Silicon nutzen. Auf diesem Computer greift SubKit nicht auf deine Dateien, Websites oder Apps zu.",
    en: "SubKit can use files in allowed folders, allowed websites and allowed apps only on a Mac with Apple Silicon for now. On this computer SubKit does not reach your files, websites or apps.",
  },
  "local.manage": { de: "Verwalten", en: "Manage" },
  "local.toggle": {
    de: "Chat und Aufgaben dürfen diesen Mac nutzen",
    en: "Let chat and tasks use this Mac",
  },
  "local.explain": {
    de: "Workflows, Aufgaben und Chat nutzen auf diesem Mac nur, was du hier erlaubst.",
    en: "Workflows, tasks and chat use only what you allow here on this Mac.",
  },
  "local.tabs": { de: "Lokale Erlaubnisse", en: "Local allowances" },
  "local.tab.folders": { de: "Ordner", en: "Folders" },
  "local.tab.websites": { de: "Websites", en: "Websites" },
  "local.tab.apps": { de: "Apps", en: "Apps" },
  "local.tab.keepOut": { de: "Tabu für SubKit", en: "Off limits for SubKit" },
  "local.permissions": { de: "macOS-Berechtigungen", en: "macOS permissions" },
  "local.permissions.hint": {
    de: "Für Apps braucht SubKit Bedienungshilfen und Bildschirmaufnahme.",
    en: "To work in apps, SubKit needs Accessibility and Screen Recording.",
  },
  "local.permissions.open": { de: "Berechtigungen prüfen", en: "Check permissions" },
  "local.chooseFolder": { de: "Ordner auswählen …", en: "Choose folder…" },
  "local.chooseApp": { de: "App auswählen …", en: "Choose app…" },
  "local.access": { de: "Zugriff", en: "Access" },
  "local.read": { de: "Lesen", en: "Read" },
  "local.readWrite": { de: "Lesen und schreiben", en: "Read and write" },
  "local.status.available": { de: "Erreichbar", en: "Available" },
  "local.status.changed": { de: "Ordner geändert", en: "Folder changed" },
  "local.status.missing": { de: "Fehlt", en: "Missing" },
  "local.private": { de: "Privat – nur von dir eingegeben", en: "Private – entered by you only" },
  "local.offLimits": { de: "Tabu", en: "Off limits" },
  "local.blocked": { de: "Immer gesperrt", en: "Always blocked" },
  "local.empty": {
    de: "Noch keine Einträge. Füge unten den ersten hinzu.",
    en: "No entries yet. Add the first one below.",
  },
  "local.origin": { de: "Website", en: "Website" },
  "local.origin.placeholder": { de: "https://host:port", en: "https://host:port" },
  "local.origin.error": {
    de: "Gib nur eine Origin ein, z. B. https://host:port oder http://192.168.1.20 – ohne Pfad, Anmeldung, Abfrage oder Fragment.",
    en: "Enter only an origin, e.g. https://host:port or http://192.168.1.20 – without a path, credentials, query or fragment.",
  },
  "local.add": { de: "Hinzufügen", en: "Add" },
  "local.folder.error": {
    de: "Diesen Ordner kann SubKit nicht freigeben. Wähle einen Unterordner – keine ganzen Laufwerke, keine System- oder versteckten Ordner und nicht deinen ganzen Benutzerordner.",
    en: "SubKit can’t allow this folder. Choose a subfolder – not a whole disk, a system or hidden folder, or your entire home folder.",
  },
  "local.folder.error.tooMany": {
    de: "Hier sind schon 200 Einträge. Entferne einen, dann wähle neu.",
    en: "There are already 200 entries. Remove one, then choose again.",
  },
  "local.folder.error.missing": {
    de: "Diesen Ordner gibt es nicht mehr. Wähle einen anderen.",
    en: "This folder no longer exists. Choose another one.",
  },
  "local.remove.label": { de: "„{name}“ entfernen", en: "Remove “{name}”" },
  "local.remove.title": { de: "„{name}“ entfernen?", en: "Remove “{name}”?" },
  "local.remove.action": { de: "Entfernen", en: "Remove" },
  "local.remove.body": {
    de: "Workflows, Aufgaben und Chat können diesen Eintrag danach nicht mehr nutzen.",
    en: "Workflows, tasks and chat can no longer use this entry afterwards.",
  },
  "local.remove.folderBody": {
    de: "Workflows, Aufgaben und Chat können danach nicht mehr auf diesen Ordner zugreifen.",
    en: "Workflows, tasks and chat can no longer access this folder afterwards.",
  },
  "local.remove.keepOutBody": {
    de: "Dieser Eintrag ist danach nicht mehr tabu. Er wird dadurch nicht automatisch erlaubt.",
    en: "This entry will no longer be off limits. It will not automatically be allowed.",
  },
  "local.error.title": {
    de: "Lokale Erlaubnisse nicht geladen",
    en: "Local allowances not loaded",
  },
  "local.error.body": {
    de: "Die Erlaubnisse auf diesem Mac sind gerade nicht verfügbar. Geändert wurde nichts.",
    en: "Allowances on this Mac are currently unavailable. Nothing was changed.",
  },
  "local.blockedApp.subkit": { de: "SubKit", en: "SubKit" },
  "local.blockedApp.security_prompt": {
    de: "Sicherheitsabfragen und Anmeldefenster",
    en: "Security prompts and sign-in windows",
  },
  "local.blockedApp.password_manager": { de: "Passwort-Manager", en: "Password managers" },
  "local.blockedApp.crypto_wallet": { de: "Krypto-Wallets", en: "Crypto wallets" },
  "local.blockedApp.payment_banking": { de: "Banking und Zahlungen", en: "Banking and payments" },
  "local.blockedApp.terminal": { de: "Terminal und Shells", en: "Terminal and shells" },
  "local.blockedApp.automation": {
    de: "Skripte und Automatisierung",
    en: "Scripts and automation",
  },
  "local.blockedApp.system": {
    de: "Systemeinstellungen und Installationsprogramme",
    en: "System Settings and installers",
  },
  "local.blockedApp.remote_support": { de: "Fernwartung", en: "Remote support" },
  "local.blockedApp.file_manager": { de: "Finder", en: "Finder" },
  "workspace.choice.server": { de: "Mit einem Server verbinden", en: "Connect to a server" },
  "workspace.choice.local": { de: "Nur auf diesem Mac", en: "Only on this Mac" },
  "workspace.local.macOnly": {
    de: "Ein Workspace nur auf diesem Computer ist vorerst nur auf einem Mac mit Apple Silicon verfügbar.",
    en: "A workspace only on this computer is available only on a Mac with Apple Silicon for now.",
  },
  "workspace.workspace": { de: "Auf diesem Mac", en: "On this Mac" },
  "workspace.step.folder": { de: "Datenordner", en: "Data folder" },
  "workspace.step.you": { de: "Du", en: "You" },
  "workspace.step.ai": { de: "KI-Zugang", en: "AI access" },
  "workspace.step.setting": { de: "Einrichten", en: "Setting up" },
  "workspace.starting": { de: "Lokaler Arbeitsbereich startet", en: "Local workspace is starting" },
  "workspace.phase.database": { de: "Datenbank", en: "Database" },
  "workspace.phase.engine": { de: "Engine", en: "Engine" },
  "workspace.phase.workspace": { de: "Arbeitsbereich", en: "Workspace" },
  "workspace.chooseFolder": { de: "Anderen Ordner wählen …", en: "Choose another folder…" },
  "workspace.folderError": {
    de: "Hier kann die Datenbank nicht laufen. Wähle einen Ordner auf diesem Mac, der nicht synchronisiert wird.",
    en: "The database can’t run here. Choose a folder on this Mac that isn’t synced.",
  },
  "workspace.name": { de: "Dein Name", en: "Your name" },
  "workspace.providerKey": { de: "Anbieter-Schlüssel", en: "Provider key" },
  "workspace.model": { de: "Lokaler Modell-Server", en: "Local model server" },
  "workspace.provider": { de: "Anbieter", en: "Provider" },
  "workspace.key": { de: "API-Schlüssel", en: "API key" },
  "workspace.keyHint": {
    de: "Der Schlüssel wird verschlüsselt in deinem lokalen Arbeitsbereich gespeichert.",
    en: "The key is stored encrypted in your local workspace.",
  },
  "workspace.keyError": {
    de: "Der Anbieter hat den Schlüssel nicht angenommen. Prüf ihn und versuch es noch einmal.",
    en: "The provider didn’t accept the key. Check it and try again.",
  },
  "workspace.address": { de: "Adresse", en: "Address" },
  "workspace.originError": {
    de: "Gib die Adresse des Modell-Servers auf diesem Mac ein, etwa http://localhost:11434, ohne Pfad.",
    en: "Enter the address of the model server on this Mac, such as http://localhost:11434, without a path.",
  },
  "startup.title": { de: "SubKit startet nicht", en: "SubKit doesn’t start" },
  "startup.openLogs": { de: "Log-Ordner öffnen", en: "Open log folder" },
  "startup.logs": { de: "Log-Ordner: {folder}", en: "Log folder: {folder}" },
  "startup.port.title": { de: "Der Port ist belegt", en: "The port is in use" },
  "startup.port.next": {
    de: "Beende das andere Programm, das den Port nutzt, und starte SubKit neu.",
    en: "Quit the other program that uses the port, then restart SubKit.",
  },
  "startup.database.title": {
    de: "Die Datenbank startet nicht",
    en: "The database doesn’t start",
  },
  "startup.database.next": {
    de: "Starte deinen Computer neu und öffne SubKit noch einmal. Hilft das nicht, kopier die Diagnose und schick sie an den SubKit-Support.",
    en: "Restart your computer and open SubKit again. If that doesn’t help, copy the diagnostics and send them to SubKit support.",
  },
  "startup.engine.title": { de: "Die Engine startet nicht", en: "The engine doesn’t start" },
  "startup.engine.next": {
    de: "Öffne SubKit noch einmal. Hilft das nicht, kopier die Diagnose und schick sie an den SubKit-Support.",
    en: "Open SubKit again. If that doesn’t help, copy the diagnostics and send them to SubKit support.",
  },
  "startup.version.title": {
    de: "Deine Daten stammen aus einer neueren Version",
    en: "Your data comes from a newer version",
  },
  "startup.version.next": {
    de: "Installier die neueste Version von SubKit. Deine Daten bleiben unverändert.",
    en: "Install the latest version of SubKit. Your data stays unchanged.",
  },
  "startup.disk.title": { de: "Nicht genug Speicherplatz", en: "Not enough disk space" },
  "startup.disk.next": {
    de: "Gib Speicher auf diesem Computer frei und öffne SubKit dann noch einmal.",
    en: "Free up space on this computer, then open SubKit again.",
  },
  "startup.permission.title": {
    de: "Kein Zugriff auf den Datenordner",
    en: "No access to the data folder",
  },
  "startup.permission.next": {
    de: "Prüf die Zugriffsrechte des Datenordners und öffne SubKit dann noch einmal.",
    en: "Check the access rights of the data folder, then open SubKit again.",
  },
  "startup.folder.title": { de: "Datenordner nicht geeignet", en: "Data folder not suitable" },
  "startup.folder.next": {
    de: "Wähle einen lokalen Ordner, der nicht in der Cloud synchronisiert wird.",
    en: "Choose a local folder that isn’t synced to the cloud.",
  },
  "startup.window.title": {
    de: "Das Fenster lässt sich nicht öffnen",
    en: "The window doesn’t open",
  },
  "startup.window.next": {
    de: "Installier SubKit neu. Hilft das nicht, kopier die Diagnose und schick sie an den SubKit-Support.",
    en: "Reinstall SubKit. If that doesn’t help, copy the diagnostics and send them to SubKit support.",
  },
  "startup.app.title": { de: "SubKit startet nicht", en: "SubKit doesn’t start" },
  "startup.app.next": {
    de: "Öffne SubKit noch einmal. Hilft das nicht, kopier die Diagnose und schick sie an den SubKit-Support.",
    en: "Open SubKit again. If that doesn’t help, copy the diagnostics and send them to SubKit support.",
  },

  "workspace.private": { de: "Nur auf diesem Mac", en: "Only on this Mac" },
  "workspace.hint": {
    de: "Läuft, solange die App offen und der Mac wach ist. Vor jedem Update wird gesichert.",
    en: "Runs while the app is open and the Mac is awake. Backed up before every update.",
  },
  "workspace.done": { de: "Fertig", en: "Done" },
  "workspace.err.port.title": { de: "Port ist belegt", en: "Port is busy" },
  "workspace.err.port.body": {
    de: "Die Engine konnte nicht starten. Nichts wurde geändert.",
    en: "The engine couldn’t start. Nothing was changed.",
  },
  "workspace.err.port.action": { de: "Anderen Port verwenden", en: "Use another port" },
  "workspace.err.disk.title": { de: "Nicht genug Speicherplatz", en: "Not enough disk space" },
  "workspace.err.disk.body": {
    de: "Gib Speicher auf diesem Mac frei und versuch es dann noch einmal. Nichts wurde geändert.",
    en: "Free up space on this Mac, then try again. Nothing was changed.",
  },
  "workspace.err.permission.title": {
    de: "Kein Zugriff auf den Ordner",
    en: "No access to the folder",
  },
  "workspace.err.permission.body": {
    de: "SubKit darf in diesem Ordner nicht schreiben. Wähle einen anderen Ordner. Nichts wurde geändert.",
    en: "SubKit can’t write to this folder. Choose another folder. Nothing was changed.",
  },
  "workspace.err.folder.title": { de: "Ordner nicht geeignet", en: "Folder not suitable" },
  "workspace.err.failed.title": {
    de: "Lokaler Arbeitsbereich startet nicht",
    en: "Local workspace doesn’t start",
  },
  "workspace.err.failed.body": {
    de: "Datenbank oder Engine sind nicht gestartet. Nichts wurde geändert.",
    en: "The database or the engine didn’t start. Nothing was changed.",
  },
  "workspace.err.database.title": {
    de: "Die Datenbank startet nicht",
    en: "The database doesn’t start",
  },
  "workspace.err.database.body": {
    de: "Nichts wurde geändert. Versuch es noch einmal. Hilft das nicht, kopier die Diagnose für den SubKit-Support.",
    en: "Nothing was changed. Try again. If that doesn’t help, copy the diagnostics for SubKit support.",
  },
  "workspace.err.version.title": {
    de: "Deine Daten stammen aus einer neueren Version",
    en: "Your data comes from a newer version",
  },
  "workspace.err.version.body": {
    de: "Installier die neueste Version von SubKit. Deine Daten bleiben unverändert.",
    en: "Install the latest version of SubKit. Your data stays unchanged.",
  },
  "workspace.err.keyRejected.title": { de: "Schlüssel nicht angenommen", en: "Key not accepted" },
  "workspace.err.restore.title": {
    de: "Sicherung nicht wiederhergestellt",
    en: "Backup not restored",
  },
  "workspace.err.restore.body": {
    de: "Die Sicherung konnte nicht gelesen werden. Nichts wurde geändert.",
    en: "The backup couldn’t be read. Nothing was changed.",
  },
  "workspace.err.move.title": { de: "Export nicht möglich", en: "Export failed" },
  "workspace.err.move.body": {
    de: "Das Bundle konnte nicht geschrieben werden. Nichts wurde geändert.",
    en: "The bundle couldn’t be written. Nothing was changed.",
  },
  "workspace.section": { de: "Lokaler Arbeitsbereich", en: "Local workspace" },
  "workspace.size": { de: "{n} MB", en: "{n} MB" },
  "workspace.running": { de: "Läuft", en: "Running" },
  "workspace.stopped": { de: "Gestoppt", en: "Stopped" },
  "workspace.backups": { de: "Sicherungen", en: "Backups" },
  "workspace.createBackup": { de: "Sicherung erstellen", en: "Create backup" },
  "workspace.automatic": { de: "Automatisch vor Update", en: "Automatic before update" },
  "workspace.beforeRestore": {
    de: "Automatisch vor Wiederherstellen",
    en: "Automatic before restore",
  },
  "workspace.manual": { de: "Manuell", en: "Manual" },
  "workspace.restore": { de: "Wiederherstellen", en: "Restore" },
  "workspace.restoreTitle": {
    de: "Sicherung „{name}“ wiederherstellen?",
    en: "Restore backup “{name}”?",
  },
  "workspace.restoreBody": {
    de: "Der lokale Arbeitsbereich wird durch diese Sicherung ersetzt. Neuere Änderungen gehen verloren. Erlaubte Ordner bleiben erhalten.",
    en: "The local workspace will be replaced by this backup. Newer changes will be lost. Allowed folders stay.",
  },
  "workspace.noBackups": { de: "Noch keine Sicherungen", en: "No backups yet" },
  "workspace.move": { de: "Auf einen Server umziehen", en: "Move to a server" },
  "workspace.moveHint": {
    de: "Dieser Mac bleibt als Gerät mit seinen erlaubten Ordnern verbunden. Freigaben musst du erneuern.",
    en: "This Mac stays connected as a device with its allowed folders. You renew approvals.",
  },
  "workspace.export": { de: "Bundle exportieren", en: "Export bundle" },
  "workspace.exported": { de: "Gespeichert unter {path}", en: "Saved to {path}" },
  "workspace.import": {
    de: "In deinen Server-Arbeitsbereich importieren",
    en: "Import into your server workspace",
  },
  "workspace.signin": { de: "Anmelden", en: "Sign in" },
  "workspace.serverError": {
    de: "Gib eine Serveradresse mit https:// ein.",
    en: "Enter a server address with https://.",
  },
  "workspace.cancel": { de: "Abbrechen", en: "Cancel" },
  "workspace.later": { de: "Später einrichten", en: "Set up later" },
  "workspace.openAtLogin": { de: "Bei der Anmeldung öffnen", en: "Open at login" },
  "workspace.modelTools.title": {
    de: "Modell kann keine Werkzeuge aufrufen",
    en: "Model can’t call tools",
  },
  "workspace.modelTools.body": {
    de: "Chat und Aufgaben funktionieren mit diesem Modell nicht, Workflows laufen weiter. Wähle in den Einstellungen ein Modell mit Werkzeugaufrufen oder einen Anbieter-Schlüssel.",
    en: "Chat and tasks don’t work with this model; workflows keep running. In Settings, choose a model that calls tools or a provider key.",
  },
  "workspace.aiMissing.title": { de: "KI-Zugang fehlt", en: "AI access missing" },
  "workspace.aiMissing.body": {
    de: "Richte ihn in SubKit unter Einstellungen › KI ein. Workflows ohne KI laufen weiter.",
    en: "Set it up in SubKit under Settings › AI. Workflows without AI keep running.",
  },
  "workspace.moved.title": { de: "Arbeitsbereich ist umgezogen", en: "Workspace has moved" },
  "workspace.moved.body": {
    de: "Er läuft jetzt auf {server}. Auf diesem Mac läuft nichts mehr, die lokalen Daten bleiben bis zum Entfernen erhalten.",
    en: "It now runs on {server}. Nothing runs on this Mac anymore; the local data stays until you remove it.",
  },
  "workspace.moveConfirm": {
    de: "SubKit exportiert den Arbeitsbereich für {server} und stoppt ihn auf diesem Mac. Danach meldest du dich beim Server an.",
    en: "SubKit exports the workspace for {server} and stops it on this Mac. Then you sign in to the server.",
  },
  "workspace.moved.action": { de: "Beim Server anmelden", en: "Sign in to the server" },
  "workspace.moveNow": { de: "Jetzt umziehen", en: "Move now" },
  "workspace.removeAll": { de: "Alle lokalen Daten entfernen", en: "Remove all local data" },
  "workspace.removeAll.hint": {
    de: "Legt die Daten in den Papierkorb und vergisst die Schlüssel.",
    en: "Moves the data to the Trash and forgets the keys.",
  },
  "workspace.removeAll.title": {
    de: "Alle lokalen Daten in „{folder}“ entfernen?",
    en: "Remove all local data in “{folder}”?",
  },
  "workspace.removeAll.body": {
    de: "Die Engine stoppt und die Daten kommen in den Papierkorb. Workflows, Runs und Sicherungen auf diesem Mac sind danach weg.",
    en: "The engine stops and the data moves to the Trash. Workflows, runs and backups on this Mac are gone afterwards.",
  },
  "workspace.removeAll.action": { de: "Daten entfernen", en: "Remove data" },
  "workspace.update.title": { de: "Runs sind noch aktiv", en: "Runs are still active" },
  "workspace.update.body": {
    de: "Noch aktive Runs im lokalen Arbeitsbereich: {count}. Ein Neustart bricht sie ab.",
    en: "Runs still active in the local workspace: {count}. A restart stops them.",
  },
  "workspace.update.restart": { de: "Trotzdem neu starten", en: "Restart anyway" },

  "tray.pausedUntil": { de: "Pausiert bis {time} Uhr", en: "Paused until {time}" },
  "tray.quietUntil": { de: "Ruhezeit bis {time} Uhr", en: "Quiet hours until {time}" },
  "tray.paused": { de: "Pausiert bis zum Fortsetzen", en: "Paused until resumed" },
  "tray.quiet": { de: "Ruhezeit", en: "Quiet hours" },
  "tray.quickCapture": { de: "Schnellnotiz …", en: "Quick note …" },
  "tray.liveView": { de: "Live-Ansicht öffnen", en: "Open live view" },

  "status.offline.title": { de: "Server offline", en: "Server offline" },
  "status.offline.body": {
    de: "SubKit versucht automatisch, die Verbindung wiederherzustellen.",
    en: "SubKit tries to restore the connection automatically.",
  },
  "status.online.title": { de: "Wieder verbunden", en: "Connected again" },
  "status.online.body": {
    de: "Die Verbindung zum Server steht wieder.",
    en: "The connection to the server is back.",
  },
  "status.expired.title": { de: "Sitzung abgelaufen", en: "Session expired" },
  "status.expired.body": {
    de: "Melde dich erneut an, um weiterzuarbeiten.",
    en: "Sign in again to keep working.",
  },
  "status.revoked.title": { de: "Gerät abgemeldet", en: "Device signed out" },
  "status.revoked.body": {
    de: "Dieses Gerät wurde vom Server abgemeldet. Verbinde dich erneut.",
    en: "This device was signed out by the server. Connect again.",
  },
  "status.update.title": { de: "Update verfügbar", en: "Update available" },
  "status.update.body": {
    de: "SubKit Desktop {version} wird geladen.",
    en: "SubKit Desktop {version} is downloading.",
  },

  "common.close": { de: "Schließen", en: "Close" },
  "common.cancel": { de: "Abbrechen", en: "Cancel" },
  "common.offline": { de: "Offline", en: "Offline" },
  "key.ctrl": { de: "Strg", en: "Ctrl" },
  "key.space": { de: "Leertaste", en: "Space" },

  "quick.title": { de: "Schnellnotiz", en: "Quick note" },
  "quick.hint": { de: "{key} – SubKit schnell öffnen", en: "{key} – open SubKit quickly" },
  "quick.ph": { de: "Was willst du festhalten?", en: "What do you want to capture?" },
  "quick.send": { de: "In den Eingang", en: "Into the inbox" },
  "quick.label": { de: "Notiz", en: "Note" },
  "quick.keys": { de: "{mod} ↩ sendet · Esc schließt", en: "{mod} ↩ sends · Esc closes" },
  "quick.sent": { de: "Notiz im Eingang", en: "Note in the inbox" },
  "quick.failed": { de: "Nicht gesendet. Versuch es noch einmal.", en: "Not sent. Try again." },

  "drop.title": { de: "Wohin damit?", en: "Where should this go?" },
  "drop.lead.one": { de: "Eine Datei ist angekommen.", en: "One file has arrived." },
  "drop.lead.many": { de: "{count} Dateien sind angekommen.", en: "{count} files have arrived." },
  "drop.via.window": { de: "In das Fenster gezogen", en: "Dragged into the window" },
  "drop.via.dock": { de: "Auf das Dock-Symbol gezogen", en: "Dragged onto the dock icon" },
  "drop.via.tray": { de: "Auf das Tray-Symbol gezogen", en: "Dragged onto the tray icon" },
  "drop.choice.file": { de: "Als Datei ablegen", en: "Store as file" },
  "drop.choice.file.hint": {
    de: "Unter Dateien, mit @attachment:-Verweis",
    en: "Under Files, with an @attachment: reference",
  },
  "drop.choice.source": { de: "Als Quelle einlesen", en: "Ingest as source" },
  "drop.choice.source.hint": {
    de: "SubKit teilt sie in Abschnitte",
    en: "SubKit splits it into sections",
  },
  "drop.choice.chat": { de: "Im Chat anhängen", en: "Attach in chat" },
  "drop.choice.chat.hint": { de: "An deine nächste Nachricht", en: "To your next message" },
  "drop.choice.inbox": { de: "In den Eingang", en: "Into the inbox" },
  "drop.choice.inbox.hint": {
    de: "SubKit prüft sie und schlägt vor, was daraus wird",
    en: "SubKit reviews it and suggests what it becomes",
  },
  "drop.reason.tooLarge": { de: "Größer als {max}", en: "Larger than {max}" },
  "drop.reason.unsupported": { de: "Dateityp nicht unterstützt", en: "File type not supported" },
  "drop.reason.tooMany": { de: "Höchstens {max} Dateien", en: "At most {max} files" },
  "drop.reason.offline": { de: "Offline", en: "Offline" },
  "drop.failed": { de: "Nicht abgelegt. Versuch es noch einmal.", en: "Not placed. Try again." },

  "browser.label": { de: "Systembrowser", en: "System browser" },
  "browser.reauthTitle": {
    de: "SubKit den Zugriff auf {name} erlauben",
    en: "Allow SubKit to access {name}",
  },
  "browser.reauthBody": {
    de: "SubKit erhält dieselben Rechte wie zuvor. Du kannst sie jederzeit widerrufen.",
    en: "SubKit gets the same permissions as before. You can revoke them at any time.",
  },
  "browser.reauthConfirm": {
    de: "Zugriff im Browser erlauben",
    en: "Allow access in browser",
  },
  "browser.cancel": { de: "Abbrechen", en: "Cancel" },
  "browser.succeeded": { de: "Verbunden. SubKit lädt neu …", en: "Connected. SubKit reloads …" },
  "browser.failed": {
    de: "Anmeldung fehlgeschlagen. Versuch es noch einmal.",
    en: "Sign-in failed. Try again.",
  },

  "live.entry": { de: "Live-Ansicht", en: "Live view" },
  "live.using": { de: "SubKit bedient „{name}“", en: "SubKit is using “{name}”" },
  "live.stop": { de: "Stoppen", en: "Stop" },
  "live.shortcut": { de: "⌘⇧⎋", en: "⌘⇧⎋" },
  "live.close": { de: "Schließen", en: "Close" },
  "live.source.chat": { de: "Von dir im Chat gestartet", en: "Started by you in chat" },
  "live.source.schedule": { de: "Aus deinem Zeitplan", en: "From your schedule" },
  "live.source.task": { de: "Aus deiner Aufgabe", en: "From your task" },
  "live.redacted": { de: "Geschwärzt", en: "Redacted" },
  "live.screenshot": {
    de: "Letztes geschwärztes Bildschirmfoto",
    en: "Latest redacted screenshot",
  },
  "live.timeline": { de: "Schritte", en: "Steps" },
  "live.status.idle": { de: "Bereit", en: "Ready" },
  "live.status.running": { de: "Läuft", en: "Running" },
  "live.status.asking": { de: "Wartet auf dich", en: "Waiting for you" },
  "live.status.typing": {
    de: "Wartet, bis du nicht mehr tippst",
    en: "Waiting until you stop typing",
  },
  "live.status.handover": {
    de: "Du bist dran – melde dich an, dann „Zurück an SubKit“",
    en: "Your turn – sign in, then “Hand back to SubKit”",
  },
  "live.status.stopped": {
    de: "Gestoppt. Spätere Schritte laufen nicht.",
    en: "Stopped. Later steps won’t run.",
  },
  "live.status.lost": { de: "Gerät nicht erreichbar", en: "Device unavailable" },
  "live.status.finished": { de: "Fertig", en: "Finished" },
  "live.result.queued": { de: "Nicht ausgeführt", en: "Not run" },
  "live.result.running": { de: "Läuft", en: "Running" },
  "live.result.done": { de: "Erledigt", en: "Done" },
  "live.result.waiting": { de: "Wartet auf dich", en: "Waiting for you" },
  "live.result.refused": { de: "Abgelehnt", en: "Refused" },
  "live.result.failed": { de: "Fehlgeschlagen", en: "Failed" },
  "live.result.stopped": { de: "Gestoppt", en: "Stopped" },
  "live.result.notRun": { de: "Nicht ausgeführt", en: "Not run" },
  "live.action.open": { de: "Öffnen", en: "Open" },
  "live.action.fill": { de: "Ausfüllen", en: "Fill in" },
  "live.action.press": { de: "Drücken", en: "Press" },
  "live.action.read": { de: "Lesen", en: "Read" },
  "live.action.wait": { de: "Warten", en: "Wait" },
  "live.action.download": { de: "Herunterladen", en: "Download" },
  "live.action.screenshot": { de: "Bildschirmfoto", en: "Screenshot" },
  "live.action.signin": { de: "Anmelden", en: "Sign in" },
  "live.action.focus": { de: "Auswählen", en: "Select" },
  "live.action.files": { de: "Datei", en: "File" },
  "live.field.target": { de: "Aktion", en: "Action" },
  "live.handBack": { de: "Zurück an SubKit", en: "Hand back to SubKit" },
  "live.injection": {
    de: "Die Seite enthält eine Anweisung. SubKit folgt ihr nicht.",
    en: "The page contains an instruction. SubKit does not follow it.",
  },
  "live.pageChanged": {
    de: "Die Seite hat sich geändert. Prüfe die Aktion erneut.",
    en: "The page changed. Review the action again.",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES;
export type Messages = Record<MessageKey, string>;

export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function t(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return fill(MESSAGES[key][locale], vars);
}

export function resolveLocale(setting: LocaleSetting, systemLocale: string): Locale {
  if (setting === "de" || setting === "en") return setting;
  return systemLocale.toLowerCase().startsWith("de") ? "de" : "en";
}

export function messageKeys(): MessageKey[] {
  return Object.keys(MESSAGES) as MessageKey[];
}

export function dictionary(locale: Locale): Messages {
  const out = {} as Messages;
  for (const key of messageKeys()) out[key] = MESSAGES[key][locale];
  return out;
}

export function clockLabel(locale: Locale, at: Date): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: locale !== "de",
  }).format(at);
}
