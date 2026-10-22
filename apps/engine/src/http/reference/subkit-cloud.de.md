---
slug: subkit-cloud
summary: Nutze SubKit als Dienst, ohne eine eigene Engine zu betreiben.
section: start
path_choice: hosting
order: 2
audience: public
---
## SubKit Cloud nutzen

> Cloud (Hosted Beta, auf Einladung)

SubKit Cloud ist SubKit als Dienst, du installierst und betreibst also keine eigene Engine.
Du meldest dich im Browser an und arbeitest im Cockpit deines Arbeitsbereichs.

### Was du brauchst

- Eine Einladung von einer Administratorin oder einem Administrator des Arbeitsbereichs. Eine öffentliche Registrierung gibt es nicht.
- Die Adresse `https://subkit-cloud.mikebild.info`. Die Adresse führt dich direkt ins Cockpit.

### Zugang erhalten

Eine Administratorin oder ein Administrator lädt dich unter **Personen & Rechte** > **Person einladen** ein.

1. Öffne die E-Mail von „Upraft Auth“.
2. Wähle den Link und lege ein Passwort fest.
3. Melde dich an, wie unter „Anmelden“ beschrieben.

Nutze dieselbe E-Mail-Adresse, an die die Einladung ging. Mit einer anderen Adresse klappt es nicht.

### Anmelden

1. Öffne `https://subkit-cloud.mikebild.info`.
2. Wähle **Mit Firmenkonto anmelden**.
3. Melde dich bei Upraft Auth mit deiner E-Mail-Adresse und deinem Passwort an.

Das Cockpit öffnet sich in deinem Arbeitsbereich.
Deine Sitzung endet nach 8 Stunden Inaktivität, spätestens nach 24 Stunden.

Deinen ersten Workflow baust du mit dem Kapitel „Dein erster Workflow“.

### Konto wechseln

Beim Abmelden im Cockpit meldet SubKit dich auch bei Upraft Auth ab.

1. Wähle im Cockpit **Abmelden**.
2. Melde dich mit dem anderen Konto neu an.

### Arbeitsbereich wechseln

Ein Arbeitsbereich enthält deine Workflows, Konnektoren, dein Wissen, deine Skills und Läufe.
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
Melde die sk-CLI und deine MCP-Clients neu an. Für den Web Clipper erstellst du einen neuen Schlüssel.

### Mit der sk-CLI anmelden

Die `sk`-CLI meldet dich wie das Cockpit über den Browser an.

1. Installiere die CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.info/install | bash
   ```

2. Melde dich an. Nutze die Adresse ohne `/cockpit`:

   ```bash
   sk login --engine-url https://subkit-cloud.mikebild.info
   ```

3. Wähle im geöffneten Browser **Mit Firmenkonto anmelden**.

Die CLI speichert danach einen persönlichen Schlüssel. Starte mit `sk`.
Alles Weitere steht im Kapitel „Die sk-CLI auf deinem Rechner verwenden“.

### Einen MCP-Client verbinden

KI-Clients wie ChatGPT, Claude oder Cursor können sich über MCP mit SubKit Cloud verbinden.

1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://subkit-cloud.mikebild.info/mcp` hinzu.
2. Wähle in der Browser-Anmeldung, die sich öffnet, **Mit Firmenkonto anmelden**.
3. Wähle auf **Zugriff erlauben** den Button **Erlauben**.

Einen API-Schlüssel musst du nicht kopieren. Mehr dazu im Kapitel „KI-Clients per MCP anbinden“.

### Webseiten sammeln

Der Web Clipper sammelt Webseiten im **Eingang**.
Richte ihn ein, wie im Kapitel „Webseiten mit dem Web Clipper sammeln“ beschrieben.
In SubKit Cloud ist die Engine-Adresse `https://subkit-cloud.mikebild.info`.

### Was anders ist als beim Selbstbetrieb

SubKit Cloud nutzt dieselbe Engine wie eine selbst betriebene Installation.
Einige Einstellungen verwaltet aber der Betreiber, nicht du.

- **Modelle, Budgets und Limits.** Der Betreiber legt sie fest.
  Du kannst keinen eigenen KI-Schlüssel hinterlegen und diese Einstellungen für deinen Arbeitsbereich nicht ändern.
- **Nur Textmodelle.** Bilder, Audio und andere Eingaben, die kein Text sind, werden nicht unterstützt.
- **Keine eingebaute Websuche.** Die Websuche des Modells steht nicht zur Verfügung.
- **Nur öffentliche Adressen.** Konnektoren erreichen nur Dienste im öffentlichen Internet.
  Adressen in einem privaten Netz, etwa `localhost` oder ein interner Firmenserver, sind gesperrt.
- **Slack und Google Chat sind gesperrt.** Chat-Arbeitsbereiche auf diesen Plattformen bleiben gesperrt,
  bis bestätigt ist, wem der Arbeitsbereich gehört. Nutze stattdessen den Chat im Cockpit.
- **API-Schlüssel nur für Werkzeuge.** API-Schlüssel funktionieren weiter für die sk-CLI, den Web Clipper,
  die HTTP-API (Bearer) und MCP-Clients mit Schlüssel. Die Browser-Anmeldung mit einem API-Schlüssel
  gibt es nur bei selbst betriebenen Installationen ohne Anmeldeanbieter.
- **Noch kein Datenexport.** Ein Export der Daten eines Arbeitsbereichs kommt später.

### Limits und ihre Meldungen

Jeder Arbeitsbereich hat Limits. Die Werte legt der Betreiber fest.
Erreichst du eines, zeigt SubKit eine Meldung. Die meisten Meldungen sind auf Englisch.

| Was du siehst | Was du tust |
| --- | --- |
| "Too many requests. Try again shortly." | Zu viele Anfragen in kurzer Zeit. Warte kurz und versuche es erneut. |
| "The monthly request allowance is exhausted." | Das Anfragekontingent des Monats ist aufgebraucht. Warte auf den nächsten Monat oder wende dich an den Betreiber. |
| "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds." | Der Speicher ist voll. Lösche Dateien und gespeicherte Inhalte, die du nicht mehr brauchst, oder wende dich an den Betreiber. |
| "The workspace resource limit is exhausted. Ask the engine operator to review retained resources." | Zu viele Ressourcen. Lösche Workflows oder Konnektoren, die du nicht mehr brauchst, oder wende dich an den Betreiber. |
| "Das monatliche KI-Budget dieser Installation ist aufgebraucht." (im Chat) | Warte auf den nächsten Monat oder wende dich an den Betreiber. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Der Einladungslink oder die Anmeldung funktioniert nicht | Nutze die E-Mail-Adresse, an die die Einladung ging. |
| Du hast dein Passwort vergessen | Upraft Auth schickt dir eine E-Mail, mit der du es zurücksetzt. |
| Du willst ein anderes Konto nutzen | Folge „Konto wechseln“. |
| Du wirst unerwartet abgemeldet | Deine Sitzung ist nach 8 Stunden Inaktivität oder 24 Stunden abgelaufen. Melde dich erneut an. |
| `sk login` oder der MCP-Client kann sich nicht verbinden | Nutze `https://subkit-cloud.mikebild.info` und `https://subkit-cloud.mikebild.info/mcp`, ohne `/cockpit`. |
