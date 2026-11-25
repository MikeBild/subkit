---
slug: use-the-subkit-cli-on-your-machine
summary: Hol dir die subkit-CLI von deiner Engine und arbeite im Terminal.
section: work
order: 1
audience: public
---
## Die subkit-CLI auf deinem Rechner verwenden

Dieses Kapitel ist für alle, die lieber im Terminal oder in Skripten arbeiten als im Cockpit.
Du installierst die Kommandozeile `subkit`, meldest dich an und hältst sie aktuell.
Danach legst du Workflows, Connectors und Wissen als Dateien an und startest Runs aus dem Terminal.

Die Kommandozeile `subkit` bekommst du aus dem neuesten Release oder direkt von deiner Engine. Mit ihr entwirfst, änderst und startest du Workflows als Dateien; `subkit agent init` trägt SubKit in Claude Code und Codex ein.
Ein npm-Paket gibt es nicht. Builds gibt es für macOS mit Apple-Chip, Linux (x64 und arm64) und Windows (x64).

### Was du brauchst

- Die Adresse deiner Engine, ohne Pfad. Die Beispiele nutzen `http://localhost:3000`.
  Für SubKit Cloud siehe „SubKit Cloud nutzen“.
- Auf macOS und Linux: Bash und curl. Unter Windows: PowerShell 7.
- Für die Anmeldung mit API-Schlüssel auf einer selbst betriebenen Engine: Zugriff auf den Engine-Host.

### Installieren und anmelden

1. Installiere die CLI von deiner Engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

   Die Engine liefert den Installer mit ihrer eigenen Version aus, so passt die CLI zu deiner Engine.
   Hast du keine Engine zur Hand, installierst du stattdessen das neueste Release:

   ```bash
   curl -fsSL https://github.com/MikeBild/subkit/releases/latest/download/install.sh | bash
   ```

   Beide legen `subkit` in `~/.local/bin` ab. Mit `SUBKIT_INSTALL_DIR` wählst du einen anderen Ordner, mit `SUBKIT_VERSION` legst du eine Version fest.

   Unter Windows führst du das in PowerShell 7 als du selbst aus, nicht als Administrator:

   ```powershell
   irm http://localhost:3000/install.ps1 | iex
   ```

   Hast du keine Engine zur Hand, nimmst du das neueste Release:

   ```powershell
   irm https://github.com/MikeBild/subkit/releases/latest/download/install.ps1 | iex
   ```

   Er legt `subkit.exe` in `%LOCALAPPDATA%\Programs\subkit` ab und nimmt den Ordner in deinen Benutzer-`PATH` auf. Öffne danach ein neues Terminal.

2. Melde dich an:

   ```bash
   subkit login --engine-url http://localhost:3000
   ```

   Dein Browser öffnet sich. Nach der Anmeldung gibt `subkit` die Zeile `subkit: signed in as …` aus und speichert die Verbindung als Profil.
3. Starte `subkit`. Ohne Befehl öffnet sich eine interaktive Sitzung; `subkit --help` listet alle Befehle.

Die Engine beschreibt sich auch selbst: die HTTP-API unter `/openapi.json`, die Dokumentation für KI-Clients unter `/llms.txt`.

### Mit einem API-Schlüssel anmelden

Diesen Weg nimmst du für Skripte oder für eine selbst betriebene Engine ohne Anmeldeanbieter.

1. Erstelle auf dem Engine-Host einen Admin-Schlüssel. Der Befehl gibt eine fertige `subkit login`-Zeile aus:

   ```bash
   docker compose exec engine engine --issue-admin-key --tenant my-org
   ```

2. Führe die ausgegebene Zeile aus. Sie hat diese Form:

   ```bash
   subkit login --engine-url http://localhost:3000 --api-key <key>
   ```

   `subkit` antwortet mit `subkit: profile 'default' saved` und dem Zustand der Engine.

### Mit mehreren Engines arbeiten

Ein Profil ist eine gespeicherte Anmeldung an einer Engine. So arbeitest du mit Test- und Produktions-Engine oder mit mehreren Arbeitsbereichen, ohne dich neu anzumelden.
Die Profile liegen in `~/.subkit/config.json`.

| Befehl | Was er tut |
| --- | --- |
| `subkit login --engine-url <adresse> --profile <name>` | Legt ein weiteres Profil an. |
| `subkit profile list` | Zeigt alle Profile. |
| `subkit profile use <name>` | Wechselt das aktive Profil. |
| `subkit status` | Zeigt das aktive Profil und ob die Engine erreichbar ist. |
| `subkit profile delete <name>` | Löscht ein Profil. |

Für einen einzelnen Befehl hängst du `--profile <name>` an, ohne das aktive Profil zu wechseln.

### Die CLI aktualisieren

`subkit update` installiert das neueste Release, `subkit update --check` meldet es nur.
`subkit update --match-engine` installiert die Version, mit der die Engine deines aktiven Profils läuft – von der Engine selbst, wenn sie die CLI mitbringt.
Vor dem Austausch prüft `subkit` die signierten Prüfsummen. Passt eine Datei nicht, bleibt deine bisherige Installation unverändert.
Die vorherige Fassung bleibt erhalten. `subkit update --rollback` stellt sie wieder her.

Einmal am Tag prüft `subkit` im Hintergrund, ob es ein neueres Release gibt, und zeigt dann nach dem Befehl eine Zeile an. Von sich aus aktualisiert `subkit` nie.
Um die Prüfung abzuschalten, trägst du `"updateCheck": false` in `~/.subkit/settings.json` ein.

Spricht `subkit` mit einer Engine einer anderen Minor- oder Major-Version, zeigt es eine Warnung mit dem Befehl, der beide angleicht.

### Was die Installer prüfen

Jeder Installer prüft die Dateien, bevor er eine bestehende Installation ersetzt.
Eine fehlende Lizenzdatei oder eine abweichende Prüfsumme bricht die Installation ab.

| Installer | Was er prüft | Wem er vertraut |
| --- | --- | --- |
| `install.sh` aus dem Release oder `/install` der Engine | Binärdatei, `LICENSE` und `THIRD_PARTY_NOTICES.txt` gegen `SHA256SUMS`, dazu die Signatur von `SHA256SUMS`, wenn sie veröffentlicht ist und OpenSSL 3 im PATH liegt | Dem Release oder der Engine, von der du lädst, und dem festen öffentlichen Release-Schlüssel, wenn er die Signatur prüfen kann |
| `install.ps1` aus dem Release oder `/install.ps1` der Engine | Binärdatei, `LICENSE` und `THIRD_PARTY_NOTICES.txt` gegen `SHA256SUMS`; die Signatur kann PowerShell nicht prüfen | Dem Release oder der Engine, von der du lädst |
| `subkit update` | Das signierte Prüfsummen-Manifest des Releases, danach Binärdatei und beide Lizenzdateien | Dem festen öffentlichen Release-Schlüssel, egal ob die Dateien von deiner Engine oder von GitHub kommen |

### Eine Nachricht diktieren

In der interaktiven Sitzung drückst du `Ctrl-D`, sprichst und drückst wieder `Ctrl-D`. Der Text landet an der Cursorposition in der Eingabe, du kannst ihn also vor dem Senden prüfen und ändern. `Esc` verwirft die Aufnahme.

Zum Diktieren braucht dein Rechner ein Aufnahmeprogramm: SoX (`rec` oder `sox`) oder ffmpeg, unter Linux auch `arecord`. `subkit doctor` zeigt, welches gefunden wurde. Unter Windows mit ffmpeg nimmt die CLI das erste Mikrofon; ein anderes wählst du mit `SUBKIT_MICROPHONE`. `SUBKIT_DICTATION_LANGUAGE` legt die gesprochene Sprache fest, zum Beispiel `de`; sonst gilt deine Systemsprache.

### Den Arbeitsbereich auf eine andere Engine umziehen

Ein Paket bringt deine eigenen Workflows, Connectors, Connector-Vorlagen, Skills, Zeitpläne, Quellen und ihre Dateien auf eine andere Engine.
Zugangsdaten, Freigaben, Rollen, Kategorien, Einstellungen und der Verlauf bleiben zurück.
Um eine ganze selbst betriebene Installation zu kopieren, machst du stattdessen ein Backup wie in „Die Engine betreiben“ beschrieben.

Du brauchst `package:export` auf der Quell-Engine und `package:import` auf der Ziel-Engine. Beide Rechte haben Mitglieder und Administratoren.
Die Zugangsdaten nach dem Import hinterlegt jemand mit `vault:write`, in der Regel ein Administrator. Eine OAuth-Anmeldung kann auch ein Mitglied abschließen.

1. Melde dich bei beiden Engines an, jeweils mit einem eigenen Profil:

   ```bash
   subkit login --engine-url https://<engine-a> --profile a
   subkit login --engine-url https://<engine-b> --profile b
   ```

2. Exportiere aus Engine A:

   ```bash
   subkit packages export --out workspace.zip --profile a
   ```

   `--category <kategorien>` exportiert nur einen Bereich, zum Beispiel `--category devops,cloud`. Was der Bereich braucht, kommt mit: Connectors, Connector-Vorlagen, Sub-Workflows und Zeitpläne.
   `--only <arten>` exportiert nur einige Arten. `--json` gibt das Ergebnis als JSON aus.
3. Importiere in Engine B:

   ```bash
   subkit packages import workspace.zip --profile b
   ```

   `subkit` zeigt zuerst den Plan: Jeder Eintrag ist `create`, `update`, `unchanged` oder `conflict`. Bestätige ihn oder gib `--yes` mit.
   Hat sich Engine B nach dem Plan geändert, bricht der Import ab und ändert nichts. Starte ihn dann erneut.
4. Schließe auf Engine B ab. Bis dahin läuft und schreibt nichts:
   - Hinterlege die Zugangsdaten jedes Connectors. Das Paket enthält keine.
   - Aktiviere die Skills. Sie kommen als Entwürfe an.
   - Bestätige das Wissen in der Prüfung im Cockpit. Es kommt als Vorschlag an und wird nie automatisch übernommen.
   - Prüfe die Workflows und erteile ihre Freigaben. Sie kommen als inaktive Entwürfe an.
   - Setze die Zeitpläne fort. Sie kommen pausiert an.
   - Starte einen Test-Run.

Importierst du dasselbe Paket erneut, ist jeder Eintrag `unchanged`.
Einen Eintrag, den du auf Engine B geändert hast, zeigt der Import als `conflict` und überschreibt ihn nie.
`subkit packages installs` listet frühere Importe.

Im Cockpit findest du dasselbe im „…“-Menü von Workflows, Connectors, Skills, Quellen und Dateien: „Als Paket exportieren…“ und „Paket importieren…“. Ist eine Kategorie gefiltert, ist sie im Export schon ausgewählt.
Im Chat hängst du ein Paket bis 5 MB an und bittest darum, es einzuspielen. Der Chat zeigt den Plan und fragt vor dem Einspielen nach, außer die Unterhaltung läuft ohne Rückfragen. Größere Pakete bis 256 MB importierst du über das Menü.

Du kannst Bereich für Bereich umziehen: ein Paket je Kategorie, jeweils mit Vorschau, Einrichtung und Test-Run.
Ein Connector, den ein früheres Paket schon mitgebracht hat, bleibt `unchanged`, auch wenn du auf Engine B schon seine Zugangsdaten hinterlegt hast.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `subkit: browser login failed` | Die Anmeldung im Browser ist nicht abgeschlossen. Versuche es erneut oder folge „Mit einem API-Schlüssel anmelden“. |
| `subkit login` erreicht die Engine nicht | Prüfe die `--engine-url`. Gib die Adresse ohne Pfad an. |
| Ein Befehl landet auf der falschen Engine | Prüfe mit `subkit status` das aktive Profil und wechsle mit `subkit profile use <name>`. |
| `subkit update` findet kein Release | Prüfe deine Verbindung zu github.com oder gleiche dich mit `subkit update --match-engine` an deine Engine an. |
| Der Installer meldet `signature: skipped` | Dein OpenSSL kann Ed25519 nicht prüfen. Die Prüfsummen sind geprüft; mit OpenSSL 3 im PATH prüft er auch die Signatur. |
| Eine Warnung meldet, dass die CLI älter oder neuer als die Engine ist | Führe `subkit update --match-engine` aus oder aktualisiere die Engine. |
