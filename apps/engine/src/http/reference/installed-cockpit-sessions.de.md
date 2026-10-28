---
slug: installed-cockpit-sessions
summary: Installiere das Cockpit als App und erhalte neutrale Hinweise per Push.
section: operate
order: 2
audience: operator
---
## Sitzungen installierter Cockpits

Du kannst das Cockpit deines Arbeitsbereichs als Web-App auf Handy oder Rechner installieren. Das lohnt sich, wenn dein Team Hinweise per Push bekommen oder Dateien und Texte aus anderen Apps an SubKit teilen soll. Danach hat die App eine eigene Adresse, eine eigene Sitzung und ein eigenes Symbol, und sie prüft dieselben Rechte wie das normale Cockpit.

### Installation anlegen

Aus einer angemeldeten Browsersitzung legst du die Installation mit `POST /v1/cockpit/installations` und einem leeren JSON-Objekt an. Gibt es schon eine, verwendet SubKit sie wieder. Die Anfrage braucht das übliche CSRF-Token des Browsers. Die Antwort enthält die Adresse der Installation und ihres Manifests, und die Installation bekommt eine eigene Browsersitzung. Deine Sitzung im normalen Cockpit (Root-Cockpit) bleibt aktiv.

Je aktivem Arbeitsbereich und Eigentümer gibt es auf dem aktuellen Host genau eine Installation; ein anderer Arbeitsbereich bekommt eine eigene.

- `GET /v1/cockpit/installations` liest die aktuelle Installation dieses Eigentümers, ohne eine Sitzung auszustellen.
- `DELETE /v1/cockpit/installations/{id}` widerruft die Installation. Das normale Cockpit bietet diesen Widerruf an.

### Sitzung und Abmeldung

Jede App läuft unter `/cockpit/i/{installationId}/` mit einem eigenen Cookie genau für diesen Pfad: HttpOnly, SameSite=Lax und bei HTTPS zusätzlich Secure. Unter `/cockpit/i/{installationId}/api/v1/` erreicht die App dieselbe API wie das normale Cockpit. Es gelten dieselben Handler, Berechtigungen, CSRF-Prüfungen, Prüfungen des Mandantenkontexts (Mandant, im Cockpit: Arbeitsbereich) und gehosteten Kontingente.

Der Server prüft Eigentümer, Arbeitsbereich, Installation, Ablauf und Widerruf der Sitzung. Eine App-Sitzung kann den Arbeitsbereich nicht wechseln und fällt nie auf die Sitzung des normalen Cockpits zurück. Ereignisströme der App prüfen die Sitzung vor jedem ausgelieferten Abschnitt neu.

So endet eine App-Sitzung:

- Abmelden widerruft nur die vorgelegte Sitzung dieser App.
- Widerrufst du die Installation im normalen Cockpit, werden alle ihre Sitzungen ungültig. Legst du sie neu an, bekommt sie eine neue Identität; alte Links werden nicht wieder gültig.
- Eine erneute Anmeldung über OIDC (OpenID Connect, die Anmeldung über einen externen Identitätsanbieter) muss genau die bisherige Eigentümer-Identität liefern. Sie legt nie ein Konto an und verknüpft nie eines über die E-Mail-Adresse.
- Mit einem API-Schlüssel lässt sich eine App-Sitzung nicht erneuern. Öffne dann das normale Cockpit und von dort die Arbeitsbereich-App neu.

### App-Name und Symbol

Das Manifest der App ist nur angemeldet abrufbar und hat eine eigene ID, einen eigenen Scope und eine eigene Startadresse. Es nutzt den gespeicherten Namen des Arbeitsbereichs, die Palette und ein optionales quadratisches App-Symbol. Das hochgeladene Symbol muss quadratisch sein und mindestens 512 Pixel je Kante haben; es gelten die Byte- und Pixelgrenzen des Brandings. SubKit erzeugt daraus PNGs mit 192 und 512 Pixeln.

Antworten zu Name, Symbol und Manifest sind privat und landen in keinem HTTP-Cache. Einstiegsseiten ohne Anmeldung bleiben neutral. Browser oder Betriebssystem können Name und Symbol einer installierten App nach dem Abmelden trotzdem behalten.

### Teilen und Dateien

Der Service Worker der App ist ein Hintergrundskript mit eigenem Scope. Er nimmt in begrenztem Umfang Inhalte an, die du über „Teilen“ aus anderen Apps schickst, und zeigt neutrale Push-Nachrichten. Seiten, API-Antworten und private Entwürfe legt er nicht im Cache ab, und er sammelt keine Schreibvorgänge für später.

Geteilte Dateien und Texte bleiben im flüchtigen Speicher, bis du den Import ausdrücklich bestätigst. Auch danach passiert nichts von selbst: Hochladen oder Sammeln nimmt die Quelle nicht ins Wissen auf, erstellt keinen Skill, ruft kein Modell auf und startet keinen Workflow. Quellen behalten ihre ursprünglichen Verweise. Lokale Dateien und Text aus der Zwischenablage werden als Quellartefakt gespeichert.

Gehen die Anmeldung oder der flüchtige Empfang des Workers verloren, teile den Inhalt nach dem Anmelden erneut oder wähle die Datei noch einmal. Dateistart, Zwischenablage und native Dateidialoge prüft die App zur Laufzeit und nutzt sie nur nach einer ausdrücklichen Aktion von dir. Einen Zugriff auf Dateien oder Ordner speichert sie nie dauerhaft.

### Push in der installierten App

Push schaltest du je App und Gerät gesondert ein. Beim ausdrücklichen Vorbereiten erzeugt SubKit für deinen Arbeitsbereich ein verschlüsseltes VAPID-Schlüsselpaar, mit dem der Server Web-Push-Nachrichten signiert. Abonnements werden verschlüsselt gespeichert und sind an die Installation und ihren Eigentümer gebunden.

Eine Nachricht kommt innerhalb von etwa einer Minute, wenn ein Punkt, der Aufmerksamkeit braucht, neu ist oder sich ändert. Unveränderte Punkte melden sich nicht erneut. Die Nachricht enthält nur einen allgemeinen SubKit-Hinweis und öffnet oder fokussiert die Startseite der App. Branding, private Inhalte oder Freigabe-Aktionen stehen nie darin.

Wann Push endet:

- Läuft eine untätige Sitzung ab, bleibt Push aktiv. Öffnest du die App wieder, wird das bestehende Abonnement an die neue Sitzung gebunden.
- Push endet beim Abmelden, bei jedem ausdrücklichen Sitzungswiderruf und beim Widerruf der Installation.
- Push endet auch, wenn der Eigentümer deaktiviert wird, der Arbeitsbereich wechselt oder gelöscht wird, und nach 30 Tagen ohne App-Nutzung.
- Inaktive oder gelöschte Eigentümer und Arbeitsbereiche bekommen keine neuen Nachrichten.

Drei Grenzen solltest du kennen. Bereits versendete neutrale Nachrichten können nach dem Abmelden noch ankommen. Die Benachrichtigungs-Erlaubnis des Browsers kann für alle Apps auf demselben Origin gelten (Schema, Host und Port der Adresse) und wird beim Abmelden nicht automatisch entzogen. Pfadgebundene Sitzungen erzeugen keinen eigenen Origin; Browserspeicher und lokale Berechtigungen sind also nicht getrennt.

### Push im normalen Browser-Cockpit

Auch das normale Cockpit unter `/cockpit/` kann diese neutralen Hinweise ohne Installation empfangen. Die Glocke öffnet dieselbe Zustimmung. Schaltest du Push ein, fragt der Browser nach seiner Erlaubnis. SubKit registriert dann den reinen Push-Worker unter `/cockpit/sw.js` und bindet das Abonnement an dich und deinen Arbeitsbereich.

Dieselben Push-Routen akzeptieren eine Sitzung des normalen Cockpits mit CSRF-Token. API-Schlüssel und Bearer-Tokens, also Zugangsnachweise im Header `Authorization`, weist SubKit ab. Installationspfade fallen nie auf diese Sitzung zurück.

Läuft eine untätige Sitzung ab, bleibt das Abonnement bestehen. Nach der nächsten Anmeldung gilt es ohne neue Nachfrage für die neue Sitzung. Es endet:

- beim Abmelden, bei einem ausdrücklichen Sitzungswiderruf oder wenn du Push ausschaltest,
- beim Wechsel des Arbeitsbereichs oder wenn sich sein Lebenszyklus ändert,
- wenn der Benutzer deaktiviert oder gelöscht wird,
- wenn der Push-Endpunkt abläuft oder nach 30 Tagen ohne Nutzung.

Ein anderer Benutzer oder Arbeitsbereich im selben Browser muss neu zustimmen. Jedes Gerät bekommt je Änderung höchstens eine Nachricht. Ist auf dem Gerät die installierte App aktiviert, geht die Nachricht an die App und nicht an den Browser-Tab. Browser ohne Push im Tab, etwa Safari auf iOS, bieten stattdessen die Installation als App an.
