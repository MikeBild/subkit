---
slug: desktop-sign-in
title: Desktop-Anmeldung betreiben
summary: Stelle SubKit Desktop für dein Team bereit und lege fest, welche App-Version dein Server annimmt.
section: operate
order: 11
audience: operator
---
## Desktop-Anmeldung betreiben

Dieses Kapitel ist für alle, die einen SubKit-Server betreiben und ihrem Team SubKit Desktop anbieten wollen.
Danach weißt du, was dein Server der App mitteilt, welche zwei Einstellungen du setzen kannst, wie die Anmeldung abläuft und wie du ein Gerät widerrufst.
Wie Personen die App benutzen, steht in „SubKit Desktop“.

### Was du brauchst

- Eine Engine ab Version @@DESKTOP_MIN_SERVER_VERSION@@. Das Update führt die Migrationen für die Anmeldung der App aus.
- Eine Adresse mit `https://`. Die App verbindet sich nur mit `https`; `http` erlaubt sie allein für `localhost`.
- Einen eingerichteten Weg, sich im Browser am Cockpit anzumelden. Die App nutzt genau diese Anmeldung und keinen API-Schlüssel.
- Die App selbst. SubKit Desktop läuft auf einem Mac mit Apple Silicon ab macOS 13; die App für Windows folgt. [Lade sie für den Mac herunter](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-mac-arm64.dmg); der Link liefert immer das neueste Release. Wie du sie selbst baust und verteilst, steht unten. Das Cockpit als installierte Web-App funktioniert auf jedem System.
- Für die lokalen Fähigkeiten (Dateien, Browser und Apps auf dem Mac) eine Engine ab Version @@DESKTOP_MIN_SERVER_VERSION@@.

### Was der Server der App mitteilt

Die App liest vor jeder Verbindung `GET /.well-known/service-descriptor.json`. Der Abschnitt `clients.desktop` sagt ihr, ob und wie sie sich anmelden kann.

```json
{
  "version": "<version>",
  "clients": {
    "desktop": {
      "min_version": "@@DESKTOP_MIN_APP_VERSION@@",
      "login": {
        "start": "/v1/identity/desktop-login/start",
        "session": "/v1/identity/desktop-session",
        "callback": "subkit://callback",
        "callbacks": ["subkit://callback"],
        "code_challenge_methods": ["S256"]
      },
      "feedback_path": "/cockpit?feedback=1",
      "anonymous_feedback_path": "/v1/feedback/anonymous"
    }
  }
}
```

| Feld | Bedeutung |
| --- | --- |
| `version` | Die Version der Engine. Die App verlangt mindestens @@DESKTOP_MIN_SERVER_VERSION@@. |
| `clients.desktop.min_version` | Die älteste App-Version, die dieser Server annimmt. Eine ältere App bittet um ein Update, statt sich anzumelden. |
| `clients.desktop.login.start` | Die Adresse, die die App im Browser öffnet. |
| `clients.desktop.login.session` | Die Adresse, an der die App ihren Code gegen eine Sitzung tauscht. |
| `clients.desktop.login.callback` | Das Ziel, an das der Browser nach der Bestätigung zurückgibt. |
| `clients.desktop.login.callbacks` | Alle Ziele, die dieser Server annimmt. Eine App, deren Ziel fehlt, meldet sich nicht an. |
| `clients.desktop.login.code_challenge_methods` | Die angenommenen Verfahren. Es gibt nur `S256`. |
| `clients.desktop.feedback_path` | Die Cockpit-Adresse, die den Dialog „Fehler melden“ öffnet. |
| `clients.desktop.anonymous_feedback_path` | Die Route, die einen Bericht annimmt, bevor die App angemeldet ist, siehe „Einen Fehler melden“. |

Fehlt `clients.desktop`, meldet die App den Server als zu alt. Fehlt darin `login`, meldet sie, dass der Server die nötige Anmeldung nicht anbietet.

### Die zwei Einstellungen

Beide stehen im Cockpit unter **Einstellungen** und gelten für die ganze Engine, ohne Neustart.

| Einstellung | Anzeige im Cockpit | Standard | Wirkung |
| --- | --- | --- | --- |
| `server.desktop_min_version` | **Mindestversion der Desktop-App** | `@@DESKTOP_MIN_APP_VERSION@@` | Wird als `clients.desktop.min_version` veröffentlicht. Format: drei Zahlen wie `@@SUBKIT_VERSION@@`. |
| `server.desktop_dev_callback` | **Entwicklungs-Builds der Desktop-App annehmen** | `false` | Nimmt zusätzlich `subkit-dev://callback` als Ziel an. Außerhalb von `NODE_ENV=production` gilt das ohne diese Einstellung. |

So hebst du die Mindestversion an:

1. Verteile zuerst die neue App an dein Team.
2. Setze `server.desktop_min_version` auf diese Version.
3. Personen mit einer älteren App lesen beim nächsten Verbinden „Der Server verlangt mindestens Version … der App, installiert ist ….“

Die Mindestversion setzen App und Engine durch. Die App prüft den veröffentlichten Wert beim Verbinden. Die Engine prüft die Version, die die App bei der Anmeldung als `app_version` nennt, an drei Stellen:

| Stelle | Antwort bei einer älteren App oder ohne `app_version` |
| --- | --- |
| `GET /v1/identity/desktop-login/start` | `426` mit einer Seite „SubKit Desktop ist zu alt“, die die Mindestversion nennt, und dem Header `X-SubKit-Error: desktop_app_outdated`. Es entsteht keine Anmeldung. |
| Bestätigungsseite, beim Anzeigen und beim Absenden | Dieselbe Seite mit `426`. Es entsteht kein Code. |
| `POST /v1/identity/desktop-session` | `426` mit dem Code `desktop_app_outdated`. Der Anmeldecode wird dabei nicht verbraucht. Die App zeigt „Diese Version der App ist für diesen Server zu alt. …“ |

Eine Vorabversion wie `@@SUBKIT_VERSION@@-beta.1` gilt als älter als `@@SUBKIT_VERSION@@`. Die Prüfung gilt für neue Anmeldungen: Eine bereits angemeldete ältere App behält ihre Sitzung, bis sie abläuft oder du das Gerät widerrufst. Die Version nennt die App selbst; die Grenze hält ehrliche ältere Apps fern und ersetzt keine Zugriffskontrolle.

Lass `server.desktop_dev_callback` im Echtbetrieb ausgeschaltet. Entwicklungs-Builds heißen „SubKit Dev“, nutzen das Schema `subkit-dev://` und sind nur zum Entwickeln der App gedacht.

### So läuft die Anmeldung ab

1. Die App öffnet im Browser `GET /v1/identity/desktop-login/start` mit einer PKCE-Challenge (`S256`), einem `state`, der ID und dem Namen des Geräts und ihrer Version als `app_version`.
2. Die Engine leitet auf die Bestätigungsseite weiter. Ist die Person im Browser nicht angemeldet, meldet sie sich zuerst wie gewohnt an.
3. Die Seite nennt Gerät, Arbeitsbereich und Konto. Die Person wählt **Anmelden** oder **Abbrechen**.
4. Bei **Anmelden** gibt der Browser mit einem Code a `subkit://callback` zurück. Bei **Abbrechen** gibt er `error=access_denied` zurück.
5. Die App tauscht den Code mit `POST /v1/identity/desktop-session`, ihrem `code_verifier` und ihrer `app_version` gegen eine Sitzung. Die Antwort setzt ein HttpOnly-Cookie für `/cockpit/i/{installationId}/` und enthält nie einen API-Schlüssel.

Was dabei gilt:

| Regel | Wert |
| --- | --- |
| Gültigkeit der Bestätigungsseite | 10 Minuten |
| Gültigkeit des Codes | 60 Sekunden, einmal verwendbar. Jeder Versuch verbraucht ihn. |
| Bindung des Codes | An die Challenge, den Arbeitsbereich, die Person und das Gerät. Ein neuer Code für dasselbe Gerät macht ältere ungültig. |
| Begrenzung je Adresse | 30 Aufrufe pro Minute für den Start, 30 für die Bestätigung, 10 für den Tausch. Danach `429` mit `Retry-After`. |
| Tausch aus einer Webseite | Abgelehnt mit `403 cross_origin_rejected`. Nur die App selbst kann tauschen. |
| Bestätigung von einer fremden Seite | Abgelehnt mit `403 csrf_rejected`. |
| Arbeitsbereich gewechselt oder neu angemeldet, nachdem die Seite offen war | Die Seite öffnet sich erneut für den aktuellen Arbeitsbereich. Ausgestellt wird erst, wenn du noch einmal bestätigst. |
| Arbeitsbereich-Kontext des Browsers | Nicht nötig. Die Seite zeigt immer den Arbeitsbereich der aktuellen Browser-Sitzung, auch wenn ein Cockpit-Tab einen anderen Arbeitsbereich offen hat. |

Die Begrenzungen zählt die Engine in der Datenbank. Sie gelten über alle Engine-Prozesse zusammen und überstehen einen Neustart.

### Wie lange eine Desktop-Sitzung gilt

| Regel | Desktop-Gerät | Browser und installierte Web-App |
| --- | --- | --- |
| Ohne Nutzung | 30 Tage. Jede Anfrage der App, auch der offene Ereignisstrom, beginnt die Frist neu. | 8 Stunden |
| Höchstens seit der Anmeldung | 90 Tage | 24 Stunden |
| Widerruf des Geräts, **Abmelden**, deaktivierte Person | Sofort beendet | Sofort beendet |

Das Cookie der Desktop-Sitzung gilt 90 Tage; ob die Sitzung noch gilt, entscheidet die Engine bei jeder Anfrage. Nach Ablauf antwortet sie mit `401`, und die App bittet um eine neue Anmeldung im Browser. Die Fristen sind fest und keine Einstellung. Auch Freigaben, die eine lebende Sitzung der Person verlangen, nehmen die Desktop-Sitzung innerhalb dieser Fristen an.

### Geräte ansehen und widerrufen

Jeder Rechner ist eine eigene Installation der Art `desktop` mit eigener Sitzung. Dieselbe Geräte-ID nutzt ihre Installation wieder; ein neuer Rechner bekommt eine neue.

Das Cockpit zeigt die Geräte einer Person unter **Einstellungen** › **Dein Profil** › **Wo bist du angemeldet?** und widerruft sie dort mit einer Rückfrage, die das Gerät und die Folge nennt. Dieselben Routen kannst du direkt nutzen. Sie nehmen eine Sitzung des Cockpits an, mit ihrem CSRF-Token, und keinen API-Schlüssel. Eine Person sieht und widerruft damit nur ihre eigenen Geräte:

| Route | Bewirkt |
| --- | --- |
| `GET /v1/cockpit/installations` | Listet unter `installations` bis zu 50 eigene Installationen mit `id`, `kind` (`browser` oder `desktop`), `device_label`, `created_at`, `last_used_at` (letzte Anfrage einer Sitzung dieser Installation, sonst `null`) und `current` (`true` für die Installation, aus der die Anfrage kommt). |
| `DELETE /v1/cockpit/installations/{installationId}` | Widerruft die Installation. Antwortet mit `204`. Die Sitzung des normalen Cockpits im Browser widerruft jede eigene Installation; die Sitzung einer Installation nur sich selbst, sonst `403 own_installation_only`. |

Was der Widerruf bewirkt:

- Alle Sitzungen des Geräts enden, und sein Push endet.
- Die Engine prüft die Sitzung offener Ereignisströme alle drei Sekunden. Die App erfährt den Widerruf deshalb innerhalb weniger Sekunden und meldet sich lokal ab.
- Spätere Anfragen mit dem alten Cookie bekommen `403 installation_revoked`. Eine abgelaufene Sitzung bekommt dagegen `401 installation_session_required`; dann bleibt das Profil in der App, und die Person meldet sich neu an.
- Meldet sich die Person auf dem Rechner erneut an, entsteht eine neue Installation.

**Installation widerrufen** im Menü des Arbeitsbereichs widerruft nur die installierte Web-App. Der Dialog sagt das: Desktop-Geräte bleiben angemeldet und werden unter **Einstellungen** › **Dein Profil** abgemeldet. Jede Installation wird einzeln widerrufen; einen Widerruf aller Geräte auf einmal gibt es nicht.

Wird eine Person deaktiviert, lehnt der Tausch mit `403 user_inactive` ab.

### Die App bauen und verteilen

Die meisten Teams nutzen die signierten Builds aus dem [neuesten Release](https://github.com/MikeBild/subkit/releases/latest). Dieser Abschnitt ist für alle, die die App selbst aus dem Repository bauen. Sie liegt dort unter `apps/desktop`. Ein Build für die Verteilung entsteht dort mit `bun run package`. Folgendes bringt das Repository nicht mit; du lieferst es selbst:

| Wofür | Was du bereitstellst |
| --- | --- |
| Signatur für macOS | Ein Developer-ID-Zertifikat und die Zugangsdaten für die Notarisierung. |
| Signatur für Windows | Ein Code-Signing-Zertifikat (Authenticode) mit Zeitstempel oder einen Cloud-Signing-Dienst. |
| Updates | Einen Ort, an dem du Versionen über `https` veröffentlichst, und die Entscheidung, Updates einzuschalten (`SUBKIT_DESKTOP_UPDATES=1` beim Bauen). |

Ohne eingeschaltete Updates zeigt die App „Automatische Updates sind in diesem Build nicht aktiv.“ Eine unsignierte App kann sich weder unter macOS noch unter Windows selbst aktualisieren. Keiner dieser Werte gehört ins Repository. Die Einzelheiten stehen in der README-Datei unter `apps/desktop`.

### Was im Audit-Trail steht

| Aktion | Wann |
| --- | --- |
| `desktop_login.code_issued` | Die Person hat das Gerät im Browser bestätigt. |
| `desktop_login.denied` | Die Person hat abgebrochen (`declined_by_user`), oder der Tausch ist gescheitert, zum Beispiel `replayed`, `expired`, `invalid_verifier`, `state_mismatch` oder `user_inactive`. |
| `desktop_login.completed` | Die App hat ihre Sitzung bekommen. |
| `cockpit_installation.created` | Ein neues Gerät ist entstanden, mit `kind`, Geräte-ID und Namen. |
| `cockpit_installation.revoked` | Ein Gerät wurde widerrufen, mit der Zahl der beendeten Sitzungen. |
| `session.revoked` | Je beendeter Sitzung, mit dem Grund `installation_revoked`. |

Ein Tausch mit unbekanntem Code steht nur im Log der Engine, nicht im Audit-Trail. Die drei Aktionen `desktop_login.*` zeigt das Cockpit bisher mit ihrem technischen Namen.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Die App meldet, der Server sei zu alt | Prüfe `version` im Service-Descriptor. Die App braucht @@DESKTOP_MIN_SERVER_VERSION@@ oder neuer und den Abschnitt `clients.desktop`. |
| Die App meldet, der Server biete die nötige Anmeldung nicht an | Die App ist ein Entwicklungs-Build und dein Server nimmt `subkit-dev://callback` nicht an, oder `login` fehlt im Descriptor. |
| `400 invalid_redirect_uri` beim Start | Das Ziel der App steht nicht in `callbacks`. Nutze einen Produktions-Build oder schalte `server.desktop_dev_callback` ein. |
| `401 invalid_grant` beim Tausch | Der Code ist unbekannt, verbraucht, abgelaufen oder passt nicht zum `code_verifier`. Die Person startet die Anmeldung neu. |
| `429` bei der Anmeldung | Zu viele Versuche von einer Adresse. Warte die Zeit aus `Retry-After` ab. |
| Der Browser kehrt nicht zur App zurück | Das System kennt das Schema `subkit://` nicht. Installiere die App neu, damit sie es anmeldet. |
| `401 browser_session_required` beim Auflisten der Geräte | Die Route nimmt nur eine Sitzung des Cockpits an und keinen API-Schlüssel. |
| `403 own_installation_only` beim Widerrufen | Die Anfrage kommt aus einer Installation und nennt eine andere. Widerrufe das andere Gerät im Browser. |
| `426 desktop_app_outdated` bei der Anmeldung | Die App ist älter als `server.desktop_min_version` oder nennt keine Version. Aktualisiere die App. |
