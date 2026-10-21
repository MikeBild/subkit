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
Die Adresse ist `https://subkit-cloud.mikebild.info`. Das Cockpit findest du unter
`https://subkit-cloud.mikebild.info/cockpit`.

Die Cloud ist eine Beta. Du kommst nur mit einer Einladung hinein. Eine öffentliche Registrierung gibt es nicht.

### Zugang erhalten

Eine Administratorin oder ein Administrator eines Arbeitsbereichs lädt dich ein. Vorher brauchst du nichts.

1. Die einladende Person öffnet im Cockpit **Personen & Rechte** und wählt **Person einladen**.
2. Du erhältst eine E-Mail von „Upraft Auth“.
3. Öffne den Link in dieser E-Mail und lege ein Passwort fest.
4. Öffne das Cockpit unter `https://subkit-cloud.mikebild.info/cockpit`.

Melde dich mit derselben E-Mail-Adresse an, an die die Einladung ging.
Mit einer anderen Adresse wird die Einladung nicht angenommen.

### Anmelden

SubKit Cloud meldet dich über Upraft Auth an.

1. Öffne `https://subkit-cloud.mikebild.info/cockpit`.
2. Melde dich mit deinem Passwort an oder lass dir einen Anmeldelink per E-Mail schicken.
3. Du landest in deinem Arbeitsbereich im Cockpit.

Passwort vergessen? Upraft Auth schickt dir eine E-Mail, mit der du es zurücksetzt.

Die Anmeldung mit einem API-Schlüssel gibt es nur für selbst betriebene Installationen ohne Anmeldeanbieter.

### Arbeitsbereiche

Ein Arbeitsbereich enthält deine Workflows, Konnektoren, dein Wissen, deine Skills und Läufe.
Wer in einem Arbeitsbereich arbeitet, sieht keinen anderen Arbeitsbereich.

- Du kannst Mitglied in mehreren Arbeitsbereichen sein.
- Mit **Arbeitsbereich wechseln** wechselst du zwischen ihnen.
- Arbeitsbereiche, die dir gehören, sind mit **Eigener** markiert und zeigen deine Rolle als **Inhaber**.
  Bei den anderen zeigt die Liste deine Rolle, etwa Administrator oder Mitglied.
- Nur der Inhaber kann einen Arbeitsbereich löschen.

### Erste Schritte im Cockpit

1. Öffne **Chat** und beschreibe in eigenen Worten, was SubKit tun soll.
   Beispiel: „Sammle jeden Montag die neuen GitHub-Issues der letzten Woche und schick mir eine Zusammenfassung.“
2. Verbinde unter **Konnektoren** die Dienste, die du brauchst.
3. Prüfe den Workflow, den der Chat für dich vorbereitet, und führe ihn aus.
4. Lade Kolleginnen und Kollegen über **Personen & Rechte** ein.

### Was anders ist als beim Selbstbetrieb

SubKit Cloud nutzt dieselbe Engine wie eine selbst betriebene Installation.
Einige Einstellungen verwaltet aber der Betreiber, nicht du.

- **Modelle, Budgets und Limits.** Der Betreiber legt die KI-Modelle, Budgets und Limits fest.
  Du kannst keinen eigenen KI-Schlüssel hinterlegen und diese Einstellungen für deinen Arbeitsbereich nicht ändern.
- **Nur Textmodelle.** Die Cloud nutzt Textmodelle. Bilder, Audio und andere
  Eingaben, die kein Text sind, werden nicht unterstützt.
- **Keine eingebaute Websuche.** Die Websuche des Modells steht nicht zur Verfügung.
- **Nur öffentliche Adressen.** Konnektoren erreichen nur Dienste im öffentlichen Internet.
  Adressen in einem privaten Netz, etwa `localhost` oder ein interner Firmenserver, sind gesperrt.
- **Slack und Google Chat sind gesperrt.** Slack- und Google-Chat-Workspaces bleiben gesperrt,
  bis bestätigt ist, wem der Workspace gehört. Nutze stattdessen den Chat im Cockpit im Browser.

### Die sk-CLI verwenden

Die Cloud liefert die sk-CLI aus, genau wie eine selbst betriebene Engine.

1. Installiere die CLI:

   ```bash
   curl -fsSL https://subkit-cloud.mikebild.info/install | bash
   ```

2. Melde dich an:

   ```bash
   sk login --engine-url https://subkit-cloud.mikebild.info
   ```

3. Dein Browser öffnet sich. Melde dich an wie im Cockpit.
   Die CLI erhält danach einen persönlichen Schlüssel und speichert ihn für dich.
4. Starte mit `sk`. `sk --help` zeigt alle Befehle.

Gib die Adresse ohne Pfad an. `https://subkit-cloud.mikebild.info/cockpit` funktioniert hier nicht.

### Einen MCP-Client verbinden

KI-Clients wie ChatGPT, Claude oder Cursor können sich über MCP mit SubKit Cloud verbinden.

1. Füge in deinem Client einen entfernten MCP-Server mit dieser Adresse hinzu:
   `https://subkit-cloud.mikebild.info/mcp`
2. Der Client öffnet eine Anmeldung im Browser.
3. Melde dich mit deinem SubKit-Cloud-Konto an und erlaube den Zugriff.

Einen API-Schlüssel musst du dafür nicht kopieren.

### Den Web-Clipper verwenden

Der Web-Clipper sammelt Webseiten im **Eingang**. So nutzt du ihn mit der Cloud:

1. Melde dich zuerst mit der sk-CLI an, wie oben beschrieben.
2. Führe `sk clipper install` aus. Der Befehl übernimmt die Cloud-Adresse aus deinem sk-Profil.
3. Lade die Erweiterung in Chrome, wie im Kapitel „Web Clipper“ beschrieben.
4. Öffne im Cockpit **API-Zugang**, wähle **Schlüssel erstellen** und nimm die Vorlage **Web Clipper**.
5. Trage diesen Schlüssel in den Einstellungen der Erweiterung ein und erlaube den Zugriff auf `subkit-cloud.mikebild.info`.

Zeigt der Clipper eine andere Adresse, ändere sie in seinen Einstellungen auf `https://subkit-cloud.mikebild.info`.

### Limits und die Meldungen, die du siehst

Jeder Arbeitsbereich hat Limits. Die Werte legt der Betreiber fest.
Erreichst du eines, zeigt SubKit eine Meldung. Die Meldungen der Engine sind auf Englisch.

| Limit | Meldung |
| --- | --- |
| Zu viele Anfragen in kurzer Zeit | "Too many requests. Try again shortly." |
| Monatliches Anfragekontingent | "The monthly request allowance is exhausted." |
| Speicher für Dateien und gespeicherte Inhalte | "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds." |
| Anzahl der Ressourcen | "The workspace resource limit is exhausted. Ask the engine operator to review retained resources." |
| Monatliches KI-Budget (im Chat) | „Das monatliche KI-Budget dieser Installation ist aufgebraucht.“ |

Was du tun kannst:

- Bei „Too many requests“ wartest du kurz und versuchst es erneut.
- Bei den monatlichen Limits und dem KI-Budget wartest du auf den nächsten Monat oder wendest dich an den Betreiber.
- Bei Speicher und Ressourcen löschst du, was du nicht mehr brauchst, oder wendest dich an den Betreiber.

### Einen Arbeitsbereich löschen

Nur der Inhaber kann einen Arbeitsbereich löschen.

1. Öffne im Cockpit **Einstellungen**.
2. Wähle **Arbeitsbereich löschen**.
3. Gib zur Bestätigung den Namen des Arbeitsbereichs ein.

Was dann passiert:

- Der Zugriff wird sofort gesperrt. Eingeladene Mitglieder verlieren ihren Zugriff.
- Sitzungen, API-Schlüssel, Einladungen und Verbindungen von MCP-Clients werden widerrufen.
- Deine anderen Arbeitsbereiche sind nicht betroffen.
- Du hast 7 Tage Zeit, es dir anders zu überlegen. Melde dich erneut an und wähle **Löschung rückgängig machen**.
- Nach 7 Tagen werden alle Daten endgültig entfernt. Sie lassen sich dann nicht mehr wiederherstellen.

Hast du eine Löschung rückgängig gemacht, bleiben alte Schlüssel und Verbindungen widerrufen.
Melde die sk-CLI und deine MCP-Clients neu an. Für den Clipper erstellst du einen neuen Schlüssel.

### Daten exportieren

Ein Export der Daten eines Arbeitsbereichs folgt später. Er ist noch nicht verfügbar.
