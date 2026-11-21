---
slug: use-the-sk-cli-on-your-machine
summary: Hol dir die sk-CLI von deiner Engine und arbeite im Terminal.
section: work
order: 1
audience: public
---
## Die sk-CLI auf deinem Rechner verwenden

Dieses Kapitel ist für alle, die lieber im Terminal oder in Skripten arbeiten als im Cockpit.
Du installierst die Kommandozeile `sk`, meldest dich an und hältst sie aktuell.
Danach legst du Workflows, Connectors und Wissen als Dateien an und startest Runs aus dem Terminal.

Die Kommandozeile `sk` bekommst du direkt von deiner Engine. Mit ihr entwirfst, änderst und startest du Workflows als Dateien; `sk agent init` trägt SubKit in Claude Code und Codex ein.
Ein npm-Paket gibt es nicht.

### Was du brauchst

- Die Adresse deiner Engine, ohne Pfad. Die Beispiele nutzen `http://localhost:3000`.
  Für SubKit Cloud siehe „SubKit Cloud nutzen“.
- Bash und curl.
- Für die Anmeldung mit API-Schlüssel auf einer selbst betriebenen Engine: Zugriff auf den Engine-Host.

### Installieren und anmelden

1. Installiere die CLI von deiner Engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

2. Melde dich an:

   ```bash
   sk login --engine-url http://localhost:3000
   ```

   Dein Browser öffnet sich. Nach der Anmeldung gibt `sk` die Zeile `sk: signed in as …` aus und speichert die Verbindung als Profil.
3. Starte `sk`. Ohne Befehl öffnet sich eine interaktive Sitzung; `sk --help` listet alle Befehle.

Die Engine beschreibt sich auch selbst: die HTTP-API unter `/openapi.json`, die Dokumentation für KI-Clients unter `/llms.txt`.

### Mit einem API-Schlüssel anmelden

Diesen Weg nimmst du für Skripte oder für eine selbst betriebene Engine ohne Anmeldeanbieter.

1. Erstelle auf dem Engine-Host einen Admin-Schlüssel. Der Befehl gibt eine fertige `sk login`-Zeile aus:

   ```bash
   docker compose exec engine engine --issue-admin-key --tenant my-org
   ```

2. Führe die ausgegebene Zeile aus. Sie hat diese Form:

   ```bash
   sk login --engine-url http://localhost:3000 --api-key <key>
   ```

   `sk` antwortet mit `sk: profile 'default' saved` und dem Zustand der Engine.

### Mit mehreren Engines arbeiten

Ein Profil ist eine gespeicherte Anmeldung an einer Engine. So arbeitest du mit Test- und Produktions-Engine oder mit mehreren Arbeitsbereichen, ohne dich neu anzumelden.
Die Profile liegen in `~/.sk/config.json`.

| Befehl | Was er tut |
| --- | --- |
| `sk login --engine-url <adresse> --profile <name>` | Legt ein weiteres Profil an. |
| `sk profile list` | Zeigt alle Profile. |
| `sk profile use <name>` | Wechselt das aktive Profil. |
| `sk status` | Zeigt das aktive Profil und ob die Engine erreichbar ist. |
| `sk profile delete <name>` | Löscht ein Profil. |

Für einen einzelnen Befehl hängst du `--profile <name>` an, ohne das aktive Profil zu wechseln.

### Die CLI aktualisieren

`sk update` installiert die neueste Fassung, `sk update --check` meldet sie nur.
`sk` holt die Fassung zuerst von der Engine deines aktiven Profils und erst danach aus den öffentlichen Releases. Ein GitHub-Zugang ist dafür nicht nötig.
Vor dem Austausch prüft `sk` die signierten Prüfsummen. Passt eine Datei nicht, bleibt deine bisherige Installation unverändert.

Die vorherige Fassung bleibt erhalten. `sk update --rollback` stellt sie wieder her.

### Was die Installer prüfen

Jeder Installer prüft die Dateien, bevor er eine bestehende Installation ersetzt.
Fehlende Lizenzdateien, fehlende Signaturen oder nicht unterstützte Kryptografie brechen die Installation ab.

| Installer | Was er prüft | Wem er vertraut |
| --- | --- | --- |
| `/install` von der Engine | Binärdatei, `LICENSE` und `THIRD_PARTY_NOTICES.txt` gegen das Prüfsummen-Manifest der Engine oder eines ausdrücklich gewählten Mirrors | Der gewählten Engine oder dem Mirror, nicht einer Release-Signatur |
| `sk update` | Das signierte Prüfsummen-Manifest des Releases, danach Binärdatei und beide Lizenzdateien | Dem festen öffentlichen Release-Schlüssel, egal ob die Dateien von deiner Engine oder von GitHub kommen |
| `scripts/install.sh` | Das signierte Prüfsummen-Manifest, danach Binärdatei und beide Lizenzdateien | Dem festen öffentlichen Release-Schlüssel |

### Aus einem öffentlichen Release installieren

Statt von deiner Engine kannst du `sk` auch aus einem signierten öffentlichen Release installieren.
Die öffentliche Beta wird vorbereitet. Pakete und Anleitung folgen nach der Freigabe.

Sobald ein Release veröffentlicht ist, checkst du es aus, prüfst es und führst im Checkout `bash scripts/install.sh` aus.
Dafür brauchst du zusätzlich OpenSSL mit Ed25519-Unterstützung im PATH, zum Beispiel OpenSSL 3.
Das Skript installiert die passende CLI für Linux oder macOS und legt `subkit.LICENSE` und `subkit.THIRD_PARTY_NOTICES.txt` daneben.
Ein lokaler Build oder ein privates Repository genügt nicht.

### Den Arbeitsbereich auf eine andere Engine umziehen

Ein Paket bringt deine eigenen Workflows, Connectors, Connector-Vorlagen, Skills, Zeitpläne, Quellen und ihre Dateien auf eine andere Engine.
Zugangsdaten, Freigaben, Rollen, Kategorien, Einstellungen und der Verlauf bleiben zurück.
Um eine ganze selbst betriebene Installation zu kopieren, machst du stattdessen ein Backup wie in „Die Engine betreiben“ beschrieben.

Du brauchst `package:export` auf der Quell-Engine und `package:import` auf der Ziel-Engine. Beide Rechte haben Mitglieder und Administratoren.
Die Zugangsdaten nach dem Import hinterlegt jemand mit `credential:write`, in der Regel ein Administrator. Eine OAuth-Anmeldung kann auch ein Mitglied abschließen.

1. Melde dich bei beiden Engines an, jeweils mit einem eigenen Profil:

   ```bash
   sk login --engine-url https://<engine-a> --profile a
   sk login --engine-url https://<engine-b> --profile b
   ```

2. Exportiere aus Engine A:

   ```bash
   sk packages export --out workspace.zip --profile a
   ```

   `--category <kategorien>` exportiert nur einen Bereich, zum Beispiel `--category devops,cloud`. Was der Bereich braucht, kommt mit: Connectors, Connector-Vorlagen, Sub-Workflows und Zeitpläne.
   `--only <arten>` exportiert nur einige Arten. `--json` gibt das Ergebnis als JSON aus.
3. Importiere in Engine B:

   ```bash
   sk packages import workspace.zip --profile b
   ```

   `sk` zeigt zuerst den Plan: Jeder Eintrag ist `create`, `update`, `unchanged` oder `conflict`. Bestätige ihn oder gib `--yes` mit.
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
`sk packages installs` listet frühere Importe.

Im Cockpit findest du dasselbe im „…“-Menü von Workflows, Connectors, Skills, Quellen und Dateien: „Als Paket exportieren…“ und „Paket importieren…“. Ist eine Kategorie gefiltert, ist sie im Export schon ausgewählt.
Im Chat hängst du ein Paket bis 5 MB an und bittest darum, es einzuspielen. Der Chat zeigt den Plan und fragt vor dem Einspielen nach, außer die Unterhaltung läuft ohne Rückfragen. Größere Pakete bis 256 MB importierst du über das Menü.

Du kannst Bereich für Bereich umziehen: ein Paket je Kategorie, jeweils mit Vorschau, Einrichtung und Test-Run.
Ein Connector, den ein früheres Paket schon mitgebracht hat, bleibt `unchanged`, auch wenn du auf Engine B schon seine Zugangsdaten hinterlegt hast.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `sk: browser login failed` | Die Anmeldung im Browser ist nicht abgeschlossen. Versuche es erneut oder folge „Mit einem API-Schlüssel anmelden“. |
| `sk login` erreicht die Engine nicht | Prüfe die `--engine-url`. Gib die Adresse ohne Pfad an. |
| Ein Befehl landet auf der falschen Engine | Prüfe mit `sk status` das aktive Profil und wechsle mit `sk profile use <name>`. |
| `sk update` fragt nur GitHub oder verlangt ein GitHub-Token | Deine CLI ist älter als der Update-Weg über die Engine. Installiere sie einmal neu wie unter „Installieren und anmelden“. Danach laufen Updates über deine Engine. |
| `scripts/install.sh` bricht wegen einer fehlenden Lizenzdatei oder Signatur ab | Nutze ein veröffentlichtes öffentliches Release. Ein lokaler Build oder ein privates Repository funktioniert nicht. |
| `scripts/install.sh` bricht wegen nicht unterstützter Kryptografie ab | Stelle OpenSSL mit Ed25519-Unterstützung, zum Beispiel OpenSSL 3, in den PATH. |
