---
slug: cockpit-app
title: Cockpit als App
summary: Starte das Cockpit deines Arbeitsbereichs als eigene App im eigenen Fenster.
section: work
order: 9
audience: public
---
## Cockpit als App

Dieses Kapitel ist für alle, die täglich im Cockpit arbeiten und es nicht jedes Mal in einem Browser-Tab suchen wollen. Du installierst das Cockpit eines Arbeitsbereichs als App auf dem Rechner oder Handy, sofern dein Browser Web-Apps installieren kann. Danach startest du es wie jedes andere Programm, in eigenem Fenster und mit Name, Symbol und Farben des Arbeitsbereichs.

### Was du brauchst

- Zugang zu einem Arbeitsbereich in SubKit Cloud unter https://subkit-cloud.mikebild.info oder auf einer selbst betriebenen Engine.
- Ein Konto, mit dem du dich über **Mit Firmenkonto anmelden** anmeldest. Mit einem API-Schlüssel kann sich eine installierte App nicht neu anmelden.
- Einen Browser, der die Installation von Web-Apps unterstützt.
- Für das Branding: die Rechte `settings:write` und `identity:write` im Arbeitsbereich.

### Cockpit eines Arbeitsbereichs installieren

1. Öffne das Cockpit im Browser und melde dich an.
2. Öffne in der Seitenleiste das Menü des Arbeitsbereichs und wähle **Arbeitsbereich installieren**.

   ![Geöffnetes Menü der Arbeitsbereiche mit abgehaktem aktuellem Arbeitsbereich und hervorgehobenem Eintrag „Arbeitsbereich installieren“](images/cockpit-app-install.de.webp)

3. Prüfe Name und Symbol im Installationsdialog und wähle **App installieren**.
4. Das Cockpit wechselt zur eigenen Adresse dieses Arbeitsbereichs und zeigt den Dialog erneut. Wähle noch einmal **App installieren**.
5. Bestätige die Installation im Dialog deines Browsers.

Die App heißt wie der Arbeitsbereich. Sie nutzt das hinterlegte App-Icon oder das SubKit-Symbol und übernimmt die Farbe der gewählten Farbpalette.

### Mehrere Arbeitsbereiche als getrennte Apps nutzen

Arbeitest du in mehreren Arbeitsbereichen, bekommt jeder seine eigene App.

1. Wechsle im normalen Cockpit im Menü des Arbeitsbereichs zum nächsten Arbeitsbereich.
2. Installiere ihn wie oben über **Arbeitsbereich installieren**.
3. Starte jede App einzeln. Jede App öffnet immer nur ihren eigenen Arbeitsbereich.

Jede App hat ihre eigene Anmeldung. Deine Anmeldung im normalen Cockpit bleibt davon unberührt.

### In der App anmelden und abmelden

1. Zum Abmelden öffne in der App das **Benutzermenü** und wähle **Abmelden**.
2. Zum erneuten Anmelden starte die App und wähle **Mit Firmenkonto anmelden**.
3. Klappt das nicht, melde dich im normalen Cockpit an und öffne die App dort über **Arbeitsbereich installieren** erneut.

**Abmelden** meldet nur diese App ab, nicht deine anderen Apps und nicht das normale Cockpit.

### Branding eines Arbeitsbereichs festlegen

1. Öffne **Einstellungen** und darin unter **Arbeiten mit sk** den Bereich **Arbeitsbereich-Branding**.
2. Lade unter **App-Icon (1:1)** ein quadratisches PNG mit mindestens 512 Pixeln Kantenlänge hoch.
3. Wähle unter **Farbpalette** zwischen **Standard**, **Indigo** und **Teal**.

   ![Arbeitsbereich-Branding des fiktiven Arbeitsbereichs Brennwerk mit dem Organisationsnamen Brennwerk, dem Untertitel Logistik, dem dunkelgrünen App-Icon mit orangefarbener Flamme, dem hellen und dunklen Logo und der gewählten Farbpalette Teal; die Seitenleiste zeigt dasselbe Logo und die Wortmarke](images/cockpit-app-branding.de.webp)

4. Prüfe die Vorschau und wähle **Änderungen speichern**.

Ohne beide Rechte kannst du das Branding nur ansehen.
Den App-Namen bestimmt der Name des Arbeitsbereichs, nicht der **Organisationsname** im Branding.
**Branding zurücksetzen** stellt das SubKit-Erscheinungsbild für alle Mitglieder wieder her.

### Installierte App entfernen

1. Öffne das normale Cockpit im Browser und wechsle zum Arbeitsbereich der App.
2. Wähle im Menü des Arbeitsbereichs **Installation widerrufen** und bestätige. Die App ist damit auf allen ihren Geräten abgemeldet.
3. Entferne die App danach wie jede andere App von deinem Gerät.

Installierst du später neu, entsteht eine neue App-Adresse. Alte Links funktionieren nicht mehr.

### Gut zu wissen

- Benachrichtigungen schaltest du in der App unter **Benachrichtigungen** mit **Neutrale Benachrichtigungen aktivieren** ein. Die Hinweise enthalten keine Details zu Arbeitsbereich oder Workflow.
- Texte und Dateien, die du mit der App teilst, landen erst nach deiner Bestätigung im **Eingang**. Sie werden dadurch weder Wissen, noch starten sie einen Workflow.
- Name und Symbol einer installierten App kann dein Browser oder Betriebssystem auch nach dem Abmelden weiter anzeigen.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Installation nicht möglich“ | Nutze das Cockpit weiter im Browser oder öffne es in einem Browser, der Web-Apps installieren kann. |
| „Installierte Apps benötigen für die erneute Anmeldung ein bestehendes OIDC-Konto. …“ | Melde dich im normalen Cockpit an und öffne die App dort über **Arbeitsbereich installieren** erneut. |
| „Browser-Berechtigung verweigert. Bitte in den Einstellungen erlauben.“ | Erlaube Benachrichtigungen für die Cockpit-Adresse in den Einstellungen deines Browsers. |
| "Open the app, sign in and share again." | Starte die App, melde dich an und teile den Inhalt erneut. |
| „Verwende ein nicht animiertes PNG, JPEG oder WebP mit maximal 2 MiB und 4 Megapixeln.“ | Lade als App-Icon ein quadratisches PNG mit mindestens 512 Pixeln Kantenlänge und höchstens 2 MiB hoch. |
