---
slug: subkit-cloud
summary: Nutze SubKit im Browser, ohne einen eigenen Server zu betreiben.
section: start
path_choice: hosting
order: 2
audience: public
---
## SubKit Cloud nutzen

> Cloud (Preview, offene Registrierung)

Mit SubKit Cloud läuft SubKit für dich. Du installierst nichts und betreibst keine eigene Engine.
Du meldest dich im Browser an und arbeitest im Cockpit deines Arbeitsbereichs.

### Kurz und knapp

1. Öffne `https://subkit-cloud.mikebild.dev` und wähle **Mit Firmenkonto anmelden**.
2. Wähle bei Upraft Auth **Konto anlegen**, gib deine E-Mail-Adresse und ein Passwort ein und bestätige deine Adresse mit dem Link aus der E-Mail.
3. Melde dich mit deinem neuen Konto an.
4. Gib deinen Namen, einen Namen für deinen Arbeitsbereich und deine Zeitzone an.
5. Wähle deinen KI-Anbieter, gib deinen API-Schlüssel ein und wähle **Loslegen**.
6. Bau deinen ersten Workflow mit dem Kapitel „Dein erster Workflow“.

Hat dich jemand in einen bestehenden Arbeitsbereich eingeladen? Dann öffne stattdessen den Einladungslink, wie unter „Einem Arbeitsbereich beitreten“ beschrieben.

### Was du brauchst

- Ein Konto bei Upraft Auth, dem Anmeldedienst der Plattform, auf der SubKit Cloud läuft. Du legst es bei der ersten Anmeldung selbst an.
- Einen Einladungslink zu einem bestehenden Arbeitsbereich oder einen API-Schlüssel deines KI-Anbieters, um einen eigenen Arbeitsbereich anzulegen.
- Die Adresse `https://subkit-cloud.mikebild.dev`. Die Adresse führt dich direkt ins Cockpit.

### Zugang erhalten

Es gibt zwei Wege in SubKit Cloud: Du trittst einem Arbeitsbereich bei, in den dich jemand eingeladen hat, oder du legst einen eigenen an.

#### Einem Arbeitsbereich beitreten

Eine Administratorin oder ein Administrator lädt dich unter **Personen & Rechte** > **Person einladen** ein und gibt dir den Einladungslink weiter.
SubKit verschickt keine E-Mail.

1. Öffne den Einladungslink.
2. Wähle **Anmelden und beitreten**.
3. Melde dich bei Upraft Auth mit der E-Mail-Adresse an, für die die Einladung gilt.
4. Prüfe deinen Namen und wähle **Beitreten**.

Der Link funktioniert nur einmal, nur für diese Adresse und bis zu dem Datum, das die Seite zeigt.
Funktioniert er nicht mehr, bitte die Person, die dich eingeladen hat, um einen neuen.

#### Einen eigenen Arbeitsbereich anlegen

Hast du noch kein Konto, legst du es bei Upraft Auth an. Nach der ersten Anmeldung zeigt SubKit eine Willkommensseite.

1. Öffne `https://subkit-cloud.mikebild.dev` und wähle **Mit Firmenkonto anmelden**.
2. Wähle **Konto anlegen**, gib deinen Namen, deine E-Mail-Adresse und ein Passwort mit mindestens 12 Zeichen ein und wähle **Konto anlegen**.
3. Öffne den Link aus der E-Mail, um deine Adresse zu bestätigen, und melde dich dann an.
4. Gib auf der Willkommensseite deinen Namen, einen Namen für deinen Arbeitsbereich und deine Zeitzone an.
5. Wähle deinen KI-Anbieter und gib deinen API-Schlüssel ein, wie unter „Dein KI-Zugang“ beschrieben.
6. Wähle **Loslegen**.

### Anmelden

1. Öffne `https://subkit-cloud.mikebild.dev`.
2. Wähle **Mit Firmenkonto anmelden**.
3. Melde dich bei Upraft Auth mit deiner E-Mail-Adresse und deinem Passwort an.

Das Cockpit öffnet sich in deinem Arbeitsbereich.
Deine Sitzung endet nach 8 Stunden Inaktivität, spätestens nach 24 Stunden.

Deinen ersten Workflow baust du mit dem Kapitel „Dein erster Workflow“.

### Dein KI-Zugang

SubKit arbeitet mit dem KI-Dienst deiner Wahl. Die Nutzung rechnet der Anbieter direkt mit dir ab.

Wenn du einen Arbeitsbereich anlegst, wählst du den Anbieter und gibst deinen API-Schlüssel ein:

1. Wähle **Anthropic**, **OpenAI** oder **Google**.
2. Gib den API-Schlüssel aus deinem Konto bei diesem Anbieter ein.
3. Wähle die Schaltfläche, die den Arbeitsbereich anlegt.

SubKit prüft den Schlüssel einmal beim Anbieter und speichert ihn verschlüsselt. Er wird nie wieder angezeigt.
Lehnt der Anbieter den Schlüssel ab, wird nichts angelegt. Prüfe den Schlüssel und sende das Formular noch einmal ab.

Personen, die du einlädst, geben nie einen Schlüssel ein. Sie arbeiten mit dem Schlüssel des Arbeitsbereichs.

So änderst du später Anbieter, Modell oder Schlüssel:

1. Öffne im Cockpit **Einstellungen** > **KI-Assistent**.
2. Wähle Anbieter und Modell oder gib einen neuen Schlüssel ein.
3. Wähle **Speichern**. SubKit prüft den neuen Schlüssel zuerst. Lehnt der Anbieter ihn ab, bleibt der hinterlegte Schlüssel aktiv.

Den KI-Zugang ändern nur die Person, der der Arbeitsbereich gehört, und Personen, die ihn verwalten.

### Konto wechseln

Beim Abmelden im Cockpit meldet SubKit dich auch bei Upraft Auth ab.

1. Wähle im Cockpit **Abmelden**.
2. Melde dich mit dem anderen Konto neu an.

### Arbeitsbereich wechseln

Ein Arbeitsbereich enthält deine Workflows, Connectors, dein Wissen, deine Skills und Runs.
Wer in einem Arbeitsbereich arbeitet, sieht keinen anderen Arbeitsbereich.

1. Wähle im Cockpit **Arbeitsbereich wechseln**.
2. Wähle den gewünschten Arbeitsbereich.

Arbeitsbereiche, die dir gehören, sind mit **Eigener** markiert und zeigen deine Rolle als **Inhaber**.
Bei den anderen zeigt die Liste deine Rolle, etwa Administrator oder Mitglied.

### Einen Arbeitsbereich löschen

> Nach 7 Tagen sind alle Daten des Arbeitsbereichs endgültig gelöscht. Danach lassen sich die Daten nicht mehr wiederherstellen.

Nur der Inhaber kann einen Arbeitsbereich löschen.

1. Öffne im Cockpit **Einstellungen**.
2. Wähle **Arbeitsbereich löschen**.
3. Gib zur Bestätigung den Namen des Arbeitsbereichs ein.
4. Wähle **Löschen**.

Was dann passiert:

- Der Zugriff wird sofort gesperrt. Eingeladene Mitglieder verlieren ihren Zugriff.
- Sitzungen, API-Schlüssel, Einladungen und Verbindungen von MCP-Clients werden widerrufen.
- Deine anderen Arbeitsbereiche sind nicht betroffen.
- 7 Tage lang kannst du es dir anders überlegen. Melde dich erneut an und wähle **Löschung rückgängig machen**.

Hast du eine Löschung rückgängig gemacht, bleiben alte Schlüssel und Verbindungen widerrufen.
Melde die subkit-CLI und deine MCP-Clients neu an. Für den Web Clipper erstellst du einen neuen Schlüssel.

### Mit der subkit-CLI anmelden

Die `subkit`-CLI meldet dich wie das Cockpit über den Browser an.

1. Installiere die CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.dev/install | bash
   ```

2. Melde dich an. Nutze die Adresse ohne `/cockpit`:

   ```bash
   subkit login --engine-url https://subkit-cloud.mikebild.dev
   ```

3. Wähle im geöffneten Browser **Mit Firmenkonto anmelden**.

Die CLI speichert danach einen persönlichen Schlüssel. Starte mit `subkit`.
Alles Weitere steht im Kapitel „Die subkit-CLI auf deinem Rechner verwenden“.

### Einen MCP-Client verbinden

KI-Clients wie ChatGPT, Claude oder Cursor können sich über MCP mit SubKit Cloud verbinden.

1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://subkit-cloud.mikebild.dev/mcp` hinzu.
2. Wähle in der Browser-Anmeldung, die sich öffnet, **Mit Firmenkonto anmelden**.
3. Wähle auf **Zugriff erlauben** den Button **Erlauben**.

Einen API-Schlüssel musst du nicht kopieren. Mehr dazu im Kapitel „KI-Clients per MCP anbinden“.

### Webseiten sammeln

Der Web Clipper sammelt Webseiten im **Eingang**.
Richte ihn ein, wie im Kapitel „Webseiten mit dem Web Clipper sammeln“ beschrieben.
In SubKit Cloud ist die Engine-Adresse `https://subkit-cloud.mikebild.dev`.

### Was anders ist als beim Selbstbetrieb

SubKit Cloud nutzt dieselbe Engine wie eine selbst betriebene Installation.
Einige Einstellungen verwaltet aber der Betreiber, nicht du.

- **Eigener KI-Zugang.** Jeder Arbeitsbereich bringt seinen eigenen KI-Anbieter und API-Schlüssel mit. Siehe „Dein KI-Zugang“.
  Der Schlüssel ist die einzige Einstellung, die du für deinen Arbeitsbereich änderst; alle Limits legt der Betreiber fest.
- **Keine KI ohne eigenen Schlüssel.** Ein Arbeitsbereich ohne eigenen API-Schlüssel kann weder den Chat nutzen noch KI-Schritte ausführen.
  Der KI-Zugang des Betreibers wird für deinen Arbeitsbereich nie verwendet.
- **Die eingebaute Websuche läuft über deinen Schlüssel.** Mit einem Anthropic-Modell kann der Assistent die eingebaute Websuche des Modells nutzen.
  Anthropic rechnet jede Suche mit dir ab. Der Betreiber kann das für alle Arbeitsbereiche abschalten.
- **Nur öffentliche Adressen.** Connectors erreichen nur Dienste im öffentlichen Internet.
  Adressen in einem privaten Netz, etwa `localhost` oder ein interner Firmenserver, sind gesperrt.
- **Slack und Google Chat sind gesperrt.** Chat-Arbeitsbereiche auf diesen Plattformen bleiben gesperrt,
  bis bestätigt ist, wem der Arbeitsbereich gehört. Nutze stattdessen den Chat im Cockpit.
- **API-Schlüssel nur für Werkzeuge.** API-Schlüssel funktionieren weiter für die subkit-CLI, den Web Clipper,
  die HTTP-API (Bearer) und MCP-Clients mit Schlüssel. Die Browser-Anmeldung mit einem API-Schlüssel
  gibt es nur bei selbst betriebenen Installationen ohne Anmeldeanbieter.
- **Export als Paket.** Du kannst deine eigenen Workflows, Connectors, Skills, Zeitpläne, Quellen und Dateien als Paket exportieren und in eine andere Engine importieren.
  Zugangsdaten, Freigaben und der Run-Verlauf sind nicht enthalten. Siehe „Die subkit-CLI auf deinem Rechner verwenden“.

### Limits und ihre Meldungen

Jeder Arbeitsbereich hat Limits. Die Werte legt der Betreiber fest.
Erreichst du eines, zeigt SubKit eine Meldung. Die meisten dieser Meldungen erscheinen auf Englisch; die Tabelle zitiert sie wörtlich.

| Was du siehst | Was du tust |
| --- | --- |
| "Too many requests. Try again shortly." | Zu viele Anfragen in kurzer Zeit. Warte kurz und versuche es erneut. |
| "The monthly request allowance is exhausted." | Das Anfragekontingent des Monats ist aufgebraucht. Warte auf den nächsten Monat oder wende dich an den Betreiber. |
| "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds." | Der Speicher ist voll. Lösche Dateien und gespeicherte Inhalte, die du nicht mehr brauchst, oder wende dich an den Betreiber. |
| "The workspace resource limit is exhausted. Ask the engine operator to review retained resources." | Zu viele Ressourcen. Lösche Workflows oder Connectors, die du nicht mehr brauchst, oder wende dich an den Betreiber. |
| "Für diesen Arbeitsbereich ist noch kein KI-Zugang eingerichtet. Trag unter Einstellungen → KI-Assistent deinen Anbieter und deinen API-Schlüssel ein." (im Chat) | Dein Arbeitsbereich hat keinen eigenen API-Schlüssel. Hinterlege Anbieter und Schlüssel unter **Einstellungen** > **KI-Assistent**. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Der Einladungslink oder die Anmeldung funktioniert nicht | Melde dich mit der E-Mail-Adresse an, für die die Einladung gilt. Ist der Link abgelaufen, bitte um einen neuen. Ist er schon benutzt, gibt es dein Konto bereits: Melde dich an. |
| Du hast dein Passwort vergessen | Upraft Auth schickt dir eine E-Mail, mit der du es zurücksetzt. |
| Du willst ein anderes Konto nutzen | Folge „Konto wechseln“. |
| Du wirst unerwartet abgemeldet | Deine Sitzung ist nach 8 Stunden Inaktivität oder 24 Stunden abgelaufen. Melde dich erneut an. |
| `subkit login` oder der MCP-Client kann sich nicht verbinden | Nutze `https://subkit-cloud.mikebild.dev` und `https://subkit-cloud.mikebild.dev/mcp`, ohne `/cockpit`. |
