---
slug: use-the-sk-cli-on-your-machine
summary: Installiere die sk-CLI von deiner Engine und arbeite damit im Terminal.
section: work
order: 1
audience: public
---
## Die sk-CLI auf deinem Rechner verwenden

Deine Engine liefert die CLI selbst aus. Es gibt kein npm-Paket.
Du installierst `sk` einmal, meldest dich an und arbeitest dann im Terminal mit Workflows, Läufen und Konnektoren.

### Was du brauchst

- Die Adresse deiner Engine, ohne Pfad. Die Beispiele nutzen `http://localhost:3000`.
  Für SubKit Cloud siehe das Kapitel „SubKit Cloud nutzen“.
- Bash und curl.
- Für einen API-Schlüssel auf einer selbst betriebenen Engine: Zugriff auf den Engine-Host.

### Installieren und anmelden

1. Installiere die CLI von deiner Engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

2. Melde dich an:

   ```bash
   sk login --engine-url http://localhost:3000
   ```

   Dein Browser öffnet sich. Nach der Anmeldung gibt `sk` die Zeile `sk: signed in as …` aus und speichert das Profil.
3. Starte mit `sk`. `sk --help` listet alle Befehle.

Die Engine beschreibt sich selbst unter `/openapi.json` und `/llms.txt`.

### Mit einem API-Schlüssel anmelden

Nutze diesen Weg für Skripte oder für eine selbst betriebene Engine ohne Anmeldeanbieter.

1. Erstelle auf dem Engine-Host einen Admin-Schlüssel. Der Befehl gibt eine fertige `sk login`-Zeile aus:

   ```bash
   docker compose exec engine engine --issue-admin-key --tenant my-org
   ```

2. Führe die ausgegebene Zeile aus. Die Zeile hat diese Form:

   ```bash
   sk login --engine-url http://localhost:3000 --api-key <key>
   ```

   `sk` gibt `sk: profile 'default' saved` und den Zustand der Engine aus.

### Aus einem öffentlichen GitHub-Release installieren

Nutze diesen Weg, um ein signiertes öffentliches Release statt des Downloads von deiner Engine zu installieren.
Du brauchst Bash, curl und OpenSSL mit Ed25519-Unterstützung, zum Beispiel OpenSSL 3 im PATH.

1. Checke das veröffentlichte öffentliche Release aus und prüfe es.
2. Führe im Checkout den Installer aus:

   ```bash
   bash scripts/install.sh
   ```

Das Skript installiert die passende CLI für Linux oder macOS und legt den lokalen `subkit`-Kompatibilitätslink an.
Neben die CLI legt es `subkit.LICENSE` und `subkit.THIRD_PARTY_NOTICES.txt`.
Die Release-Dateien müssen öffentlich herunterladbar sein. Ein lokaler Build oder ein privates Repository genügt nicht.

### Was die Installer prüfen

Jeder Installer prüft die Dateien, bevor er eine bestehende Installation ersetzt.
Fehlende Lizenzdateien, fehlende Signaturen oder nicht unterstützte Kryptografie stoppen die Installation.

| Installer | Was er prüft | Wem er vertraut |
| --- | --- | --- |
| `scripts/install.sh` | Das signierte Prüfsummen-Manifest, danach die gewählte Binärdatei und beide Lizenzdateien | Dem festgelegten öffentlichen Release-Schlüssel |
| `/install` von der Engine | Die Binärdatei, `LICENSE` und `THIRD_PARTY_NOTICES.txt` aus demselben Engine-Bundle oder einem ausdrücklichen Mirror, gegen das Prüfsummen-Manifest dieser Quelle | Der gewählten Engine oder dem gewählten Mirror, nicht einer Release-Signatur |
| `sk update` | Das signierte Prüfsummen-Manifest des Releases, danach die Binärdatei und beide Lizenzdateien. Er liest Version und Dateien von der Engine deines aktiven Profils und fällt auf GitHub-Releases zurück. Die bestehenden Hinweise behält er mit ihren Prüfsummen für den Rollback. | Dem festgelegten öffentlichen Release-Schlüssel, egal ob die Dateien von deiner Engine oder von GitHub kommen |

### Die CLI aktualisieren

`sk update` installiert die neueste Version, `sk update --check` meldet sie nur.
`sk` fragt zuerst die Engine deines aktiven Profils. Ein privates Repository oder ein fehlendes GitHub-Token blockiert das Update deshalb nicht. Die Engine liefert die signierten Release-Prüfsummen, und `sk` prüft sie, bevor es die Binärdatei ersetzt.
Versionen vor 10.15.1 fragen nur GitHub. Installiere einmal neu mit `curl -fsSL <engine-url>/install | bash`; danach funktionieren Updates ohne Token.

Ältere behaltene Versionen ohne Hinweis-Metadaten können fehlende historische Lizenzdateien nicht rekonstruieren.
Das Rollback dieser Versionen funktioniert weiter wie bisher.

### Den Arbeitsbereich auf eine andere Engine umziehen

Ein Paket bringt deine eigenen Workflows, Konnektoren, Konnektor-Vorlagen, Skills, Zeitpläne, Knowledge Sources und ihre Dateien auf eine andere Engine.
Zugangsdaten, Freigaben, Rollen, Kategorien, Einstellungen und der Laufverlauf bleiben zurück.
Um eine ganze selbst betriebene Installation zu kopieren, mach stattdessen ein Backup wie in „Die Engine betreiben“ beschrieben.

Du brauchst `package:export` auf der Quell-Engine und `package:import` auf der Ziel-Engine. Beides sind Administrationsrechte.

1. Melde dich bei beiden Engines an, jeweils mit einem eigenen Profil:

   ```bash
   sk login --engine-url https://<engine-a> --profile a
   sk login --engine-url https://<engine-b> --profile b
   ```

2. Exportiere aus Engine A:

   ```bash
   sk packages export --out workspace.zip --profile a
   ```

   `--only <kinds>` exportiert nur einige Arten. `--json` gibt das Ergebnis als JSON aus.
3. Importiere in Engine B:

   ```bash
   sk packages import workspace.zip --profile b
   ```

   `sk` zeigt zuerst den Plan: Jeder Eintrag ist `create`, `update`, `unchanged` oder `conflict`. Bestätige ihn oder gib `--yes` mit.
   Hat sich Engine B nach dem Plan geändert, bricht der Import ab und ändert nichts. Starte ihn erneut.
4. Schließe auf Engine B ab. Bis dahin läuft und schreibt nichts:
   - Hinterlege die Zugangsdaten jedes Konnektors. Das Paket enthält keine.
   - Aktiviere die Skills. Sie kommen als Entwürfe an.
   - Bestätige das Wissen in der Prüfung im Cockpit. Es kommt als Vorschlag an und wird nie automatisch übernommen.
   - Prüfe die Workflows und erteile ihre Freigaben. Sie kommen als inaktive Entwürfe an.
   - Setze die Zeitpläne fort. Sie kommen pausiert an.
   - Starte einen Testlauf.

Importierst du dasselbe Paket erneut, ist jeder Eintrag `unchanged`.
Einen Eintrag, den du auf Engine B geändert hast, zeigt der Import als `conflict` und überschreibt ihn nie.
`sk packages installs` listet frühere Importe.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `sk: browser login failed` | Die Anmeldung im Browser ist nicht abgeschlossen. Versuche es erneut oder folge „Mit einem API-Schlüssel anmelden“. |
| `sk login` erreicht die Engine nicht | Prüfe die `--engine-url`. Gib die Adresse ohne Pfad an. |
| `scripts/install.sh` stoppt wegen einer fehlenden Lizenzdatei oder Signatur | Nutze ein veröffentlichtes öffentliches Release. Ein lokaler Build oder ein privates Repository funktioniert nicht. |
| `scripts/install.sh` stoppt wegen nicht unterstützter Kryptografie | Stelle OpenSSL mit Ed25519-Unterstützung, zum Beispiel OpenSSL 3, in den PATH. |
