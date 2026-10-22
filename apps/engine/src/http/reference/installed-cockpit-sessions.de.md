---
slug: installed-cockpit-sessions
summary: Wie ein installiertes Cockpit seine Workspace-Sitzung erhält und behält.
section: operate
order: 2
audience: operator
---
## Sitzungen installierter Cockpits

Eine authentifizierte Browsersitzung kann ihre Workspace-Installation mit
`POST /v1/cockpit/installations` und einem leeren JSON-Objekt anlegen oder wiederverwenden. Diese
Operation erfordert das normale Browser-CSRF-Token. Sie liefert die Installationsadresse und die
Manifest-Adresse und stellt für diese Installation eine unabhängige Browsersitzung aus. Die
bestehende Root-Cockpit-Sitzung bleibt aktiv. Eine Installation ist pro aktivem Workspace und
Eigentümer auf dem aktuellen Host eindeutig; ein anderer Workspace hat seine eigene
Installationsidentität. `GET /v1/cockpit/installations` liest die aktuelle Installation dieses
Eigentümers, ohne eine Sitzung auszustellen. Das Root-Cockpit bietet das Widerrufen der Installation
über `DELETE /v1/cockpit/installations/{id}` an.

Jede App verwendet `/cockpit/i/{installationId}/` und ein eigenes HttpOnly-, SameSite=Lax-Cookie
mit genau diesem Pfad. HTTPS-Cookies sind Secure. Die API-Fassade der App unter
`/cockpit/i/{installationId}/api/v1/` führt dieselben API-Handler, Berechtigungen, CSRF-Prüfungen,
Mandantenkontext-Prüfungen und gehosteten Kontingente aus wie die normale API. Installationssitzungen
können den Workspace nicht wechseln und nicht auf die Root-Sitzung zurückfallen. Eigentümer,
Workspace, Installation, Ablauf und Widerruf der Sitzung werden auf dem Server geprüft.
Ereignisströme der App prüfen die Sitzung vor jedem ausgelieferten Abschnitt erneut. Die Abmeldung
widerruft nur die vorgelegte App-Sitzung. Das Widerrufen der Installation aus dem Root-Cockpit
macht alle ihre Sitzungen ungültig; eine Neuerstellung erzeugt eine neue Identität und belebt alte
Links nicht wieder. Die OIDC-Neuauthentifizierung erfordert genau die bestehende Eigentümeridentität
und legt nie ein Konto an und verknüpft nie eines per E-Mail. Die Anmeldung mit API-Schlüssel kann
eine installierte Sitzung nicht erneuern; öffne stattdessen das normale Cockpit und öffne
die Arbeitsbereich-App erneut.

Das authentifizierte Manifest hat eine eigene ID, einen eigenen Scope und eine eigene Startadresse
und verwendet den gespeicherten Workspace-Namen, die Palette und das optionale quadratische
App-Symbol. Symbole werden zu PNGs mit 192 und 512 Pixeln normalisiert; hochgeladene Quellen müssen
quadratisch sein und mindestens 512 Pixel pro Kante haben, innerhalb der bestehenden Byte- und
Pixelgrenzen des Brandings. Antworten zu Name, Symbol und Manifest sind privat und werden nicht im
HTTP-Cache gespeichert. Einstiegsseiten im abgemeldeten Zustand bleiben neutral. Der Browser oder
das Betriebssystem kann Name und Symbol einer bereits installierten App nach der Abmeldung
behalten.

Der Service Worker mit eigenem Scope verarbeitet begrenzte eingehende Freigaben und neutrale
Push-Nachrichten. Er legt keine Seiten, API-Antworten oder privaten Entwürfe im Cache ab und
reiht keine Offline-Schreibvorgänge ein. Eingehende Dateien und Texte bleiben bis zu einer
ausdrücklichen Importbestätigung im flüchtigen Speicher. Das Hochladen oder Sammeln einer Quelle
nimmt sie nicht in das Wissen auf, erstellt keinen Skill, ruft kein Modell auf und startet keinen
Workflow. Quellen behalten ihre ursprünglichen Verweise; lokale Dateien und Zwischenablagetext
behalten ein gespeichertes Quellartefakt. Gehen die Authentifizierung oder der flüchtige Empfang des
Workers verloren, wiederhole nach der Anmeldung die Freigabe oder Dateiauswahl. Dateistart,
Zwischenablage und native Dateidialoge erfordern Laufzeit-Fähigkeitsprüfungen und eine ausdrückliche
Benutzeraktion; kein Datei- oder Verzeichnis-Handle wird dauerhaft gespeichert.

Push erfordert eine separate Zustimmung für App und Gerät. Die ausdrückliche Vorbereitungsoperation
erstellt ein mandanteneigenes, verschlüsseltes VAPID-Schlüsselpaar; Abonnements sind verschlüsselt
und an die Installation und ihren Eigentümer gebunden. Der Ablauf einer untätigen Sitzung beendet
Push nicht; beim erneuten Öffnen der App wird das bestehende Geräteabonnement an die neue Sitzung
gebunden. Push endet bei Abmeldung, jedem ausdrücklichen Sitzungswiderruf, Widerruf der
Installation, Deaktivierung des Eigentümers, Workspace-Wechsel oder -Löschung sowie nach 30 Tagen
ohne App-Nutzung. Inaktive oder gelöschte Eigentümer und Workspaces erhalten keine neuen Sendungen.
Eine Benachrichtigung wird gesendet, sobald ein neuer oder geänderter Aufmerksamkeitspunkt
erscheint, innerhalb von etwa einer Minute; unveränderte Punkte benachrichtigen nicht erneut.
Benachrichtigungen enthalten nur einen generischen SubKit-Aufmerksamkeitshinweis und fokussieren
oder öffnen die App-Wurzel; sie enthalten kein Workspace-Branding, keine privaten Inhalte und keine
Freigabeaktionen. Bereits gesendete neutrale Nachrichten können nach der Abmeldung eintreffen. Eine
Benachrichtigungsberechtigung des Browsers kann von Apps auf demselben Origin gemeinsam genutzt
werden und wird durch die Abmeldung nicht automatisch widerrufen. Pfadgebundene Sitzungen erzeugen
keine getrennten Browser-Origins und isolieren weder den Browser-Speicher noch lokale
Berechtigungen.

Das normale Browser-Cockpit unter `/cockpit/` kann diese neutralen Benachrichtigungen auch ohne
Installation empfangen. Die Glocke öffnet dieselbe Zustimmung; das Einschalten fragt die
Browser-Berechtigung ab, registriert den reinen Push-Worker unter `/cockpit/sw.js` und bindet das
Abonnement an den angemeldeten Benutzer und Workspace. Dieselben Push-Routen akzeptieren eine
Root-Browsersitzung mit CSRF; API-Schlüssel und Bearer-Tokens werden abgewiesen, und
Installationspfade fallen nie auf die Root-Sitzung zurück. Der Ablauf einer untätigen Sitzung
beendet es nicht; eine erneute Anmeldung bindet das Abonnement ohne erneute Nachfrage an die neue
Sitzung. Es endet bei Abmeldung, ausdrücklichem Sitzungswiderruf, Workspace-Wechsel, Deaktivierung
oder Löschung des Benutzers, Workspace-Lebenszyklus, Ausschalten, einem abgelaufenen Endpunkt und
nach 30 Tagen ohne Nutzung. Ein anderer Benutzer oder Workspace im selben Browser muss erneut
zustimmen. Jedes Gerät erhält pro Aufmerksamkeitsänderung höchstens eine Benachrichtigung; ist die
installierte App auf demselben Gerät aktiviert, wird die App benachrichtigt und der Browser-Tab
übersprungen. Browser ohne Push im Tab, etwa Safari auf iOS, bieten stattdessen den
Installationsweg an.

