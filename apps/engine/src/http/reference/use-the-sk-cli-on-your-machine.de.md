---
slug: use-the-sk-cli-on-your-machine
summary: Installiere die sk-CLI von deiner Engine und arbeite damit im Terminal.
section: work
order: 1
audience: public
---
## Die sk-CLI auf deinem Rechner verwenden

Die Engine liefert die CLI selbst aus. Es gibt kein npm-Paket.

```bash
curl -fsSL http://localhost:3000/install | bash
docker compose exec engine engine --issue-admin-key --tenant my-org   # prints an `sk login` line
sk login --engine-url http://localhost:3000 --api-key <key>
sk
```

`sk --help` listet jeden Befehl auf. Die Engine beschreibt sich selbst unter `/openapi.json` und `/llms.txt`.

Für ein veröffentlichtes öffentliches GitHub-Release installiert `bash scripts/install.sh` aus
einem geprüften Checkout die passende CLI für Linux oder macOS und legt den lokalen
`subkit`-Kompatibilitätslink an. Es erfordert Bash, curl und OpenSSL mit Ed25519-Unterstützung
(zum Beispiel OpenSSL 3 im PATH). Es verifiziert das signierte Prüfsummen-Manifest gegen den
festgelegten öffentlichen Release-Schlüssel und anschließend die gewählte Binärdatei und beide
Lizenzdateien, bevor es eine bestehende Installation ersetzt. Es installiert `subkit.LICENSE`
und `subkit.THIRD_PARTY_NOTICES.txt` neben der CLI. Fehlende Lizenzdateien, fehlende Signaturen
oder nicht unterstützte Kryptografie stoppen die Installation. Dieser Weg erfordert öffentlich
herunterladbare Release-Dateien; ein lokaler Build oder ein privates Repository genügt nicht. Der
oben genannte von der Engine ausgelieferte Installer ist ein eigener Download-Weg, getrennt von
deiner eigenen Installation. Er erfordert die Binärdatei, `LICENSE` und
`THIRD_PARTY_NOTICES.txt` aus demselben Engine-Bundle oder einem ausdrücklichen Mirror und
verifiziert jede gegen das Prüfsummen-Manifest dieser Quelle. Seine Vertrauensgrenze ist deine
gewählte Engine bzw. dein gewählter Mirror; er impliziert keine Verifikation der
GitHub-Release-Signatur.

Der GitHub-Updater erfordert ebenfalls beide signierten Lizenzdateien. Er aktualisiert die Hinweise
neben der Binärdatei und behält bestehende Hinweise mit ihren Prüfsummen für den Rollback. Ältere
behaltene Versionen ohne Hinweis-Metadaten können fehlende historische Lizenzdateien nicht
rekonstruieren; ihr bestehendes Rollback-Verhalten bleibt verfügbar.
