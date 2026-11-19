---
slug: run-the-engine
summary: Betreibe SubKit selbst mit Docker Compose auf deinem eigenen Server.
section: start
path_choice: hosting
order: 3
audience: operator
---
## Die Engine betreiben

Danach läuft SubKit auf deinem eigenen Server: die Engine mit Cockpit, eine PostgreSQL-Datenbank und ein Objektspeicher, gestartet mit Docker Compose.
Datenbank, Dateien und Schlüssel bleiben auf deinem Server.

Du brauchst Docker mit Compose, OpenSSL und eine POSIX-Shell.
Lege die `docker-compose.yml` in ein eigenes Verzeichnis. Nimm sie aus demselben veröffentlichten Release wie das Engine-Image.
Nutze nur veröffentlichte Release-Images. Schlägt das Laden des Images fehl, ist die Installation nicht fertig, auch wenn andere Dienste starten.
Kombiniere kein älteres Image mit einer neueren Compose-Datei.

Erzeuge die Installationsgeheimnisse einmalig vor dem ersten Start. Der Befehl überschreibt keine bestehende `.env` und macht sie nur für ihren Eigentümer lesbar:

```bash
(
  set -eu
  umask 077
  set -C
  install_master_key=$(openssl rand -hex 32)
  install_database_password=$(openssl rand -hex 32)
  printf 'MASTER_KEY=%s\nSUBKIT_DB_PASSWORD=%s\n' \
    "$install_master_key" "$install_database_password" > .env
)
```

Starte die Installation, nachdem der Befehl erfolgreich war:

```bash
docker compose pull && docker compose up -d --wait
curl -fsS http://localhost:3000/health
```

Danach richtest du Admin-Konto und KI-Anbieter ein, wie in „Erstes Setup“ beschrieben.

### Schlüssel und Passwörter schützen

`MASTER_KEY` verschlüsselt alle gespeicherten Geheimnisse. Geht er verloren, sind diese Geheimnisse nicht mehr lesbar.
Bewahre deshalb ein verschlüsseltes Backup der `.env` außerhalb des Installationsverzeichnisses auf.
Erzeuge den `MASTER_KEY` für eine bestehende Datenbank nie neu.

Lass auch das Datenbankpasswort unverändert, wenn du das Datenbank-Volume weiterverwendest.
Eine geänderte `.env` ändert das Passwort in einer bereits eingerichteten PostgreSQL-Datenbank nicht.
Committe die `.env` nie. Gib auch die Ausgabe von `docker compose config` nicht weiter, denn sie enthält die Geheimnisse.

Musst du den `MASTER_KEY` wechseln, verschlüsselt der Offline-Befehl `--rewrap-master-key` die gespeicherten Einstellungsgeheimnisse mit dem neuen Schlüssel neu.
Er deckt nur diese Einstellungsgeheimnisse ab. Gibt es weitere verschlüsselte Daten, etwa gespeicherte Zugangsdaten, verschlüsselte Workflow- oder Chat-Inhalte oder Freigabenachweise, lehnt er ab.
Behalte in diesem Fall den bisherigen `MASTER_KEY`.

Der Befehl läuft nur, wenn alle schreibenden Dienste gestoppt sind.
Das bestätigst du ausdrücklich mit `--all-producers-stopped` und belegst es mit einer separaten Datei über `--stop-evidence-file`. Dass keine Lebenszeichen mehr kommen, reicht als Beleg nicht.
Betreibst du die Datenbank mit einem eigens eingerichteten Wartungs-Login, wählst du ihn über die bestehende Datenbankkonfiguration und gibst `--maintenance` an. Dieser Login bekommt nur die vorgesehenen Wartungsfunktionen.
Die Engine legt keine Datenbankbenutzer an.

### Starten, stoppen, erreichbar machen

Für spätere Starts führst du `docker compose up -d --wait` im selben Verzeichnis aus.
`docker compose stop` stoppt die Dienste, ohne Daten zu löschen.
Datenbank und Objektspeicher liegen in benannten Volumes; `docker compose down -v` löscht sie.
Behalte beim Weiterführen einer Installation denselben Compose-Projektnamen.

API und Datenbank sind anfangs nur über Loopback erreichbar, also nur vom Server selbst.
Schließe das erste Setup lokal ab, bevor du die API freigibst.
Für Zugriff von außen brauchst du HTTPS und eine Zugriffskontrolle. Gib Datenbank und Objektspeicher nie öffentlich frei.

Für eine Wiederherstellung brauchst du Datenbank, Objektspeicherdaten, `.env`, die passende Compose-Datei und die Image-Identität zusammen.
Teste die Wiederherstellung in einer separaten Installation, bevor du dich auf ein Backup verlässt oder ein Upgrade machst. Die Schritte stehen unter „Backup und Wiederherstellung“.

### Browser-Crawling für die Konnektor-Discovery

Das mitgelieferte Image enthält keinen Browser und kein Node.js.
Die Konnektor-Discovery sucht die Dokumentation eines Dienstes deshalb über HTTP: OpenAPI, GraphQL, Swagger UI, `llms.txt` und HTML-Seiten.
Findet keiner dieser Wege die Dokumentation, nennt das Ergebnis den fehlenden Baustein: „browser discovery is not available“.
Braucht die Dokumentation JavaScript zum Anzeigen, stelle eine erreichbare OpenAPI-Spezifikation bereit oder trage die Endpunkte des Konnektors selbst ein.

Browser-Crawling läuft nur, wenn beide Bedingungen gelten:

- `SK_PLAYWRIGHT_ENTRY` nennt ein installiertes Playwright-Modul mit seinem Chromium-Build,
  lesbar für den Container-Nutzer (uid 1001), zum Beispiel in einem eigenen, vom
  SubKit-Image abgeleiteten Image.
- Der Schutz für ausgehende Verbindungen ist nicht strikt. Der Container startet mit
  `NODE_ENV=production` und damit strikt; er lehnt Browser-Discovery ab. Die Einstellung
  `egress.mode: permissive` erlaubt zusätzlich private und Loopback-Adressen für alle
  Konnektoren. Wähle sie nur hinter einer Netzgrenze, die du geprüft hast.

Ein abgeleitetes Image pflegst du selbst: Halte Playwright und den Browser aktuell, scanne
es und liefere die Browser-Lizenzen mit. Dieser Weg ist nicht Teil der Release-Prüfungen.

### Backup und Wiederherstellung

Ein Backup kopiert die ganze Installation und stellt sie mit demselben Image wieder her.
Um nur die eigenen Workflows, Konnektoren, Skills und das Wissen eines Arbeitsbereichs auf eine andere Engine zu bringen, exportiere stattdessen ein Paket wie in „Die sk-CLI auf deinem Rechner verwenden“ beschrieben.

Plane für ein konsistentes Backup ein Wartungsfenster ein.
Die Schritte gelten für die mitgelieferte PostgreSQL und den mitgelieferten Objektspeicher; externe Dienste brauchen ein eigenes Verfahren.
Führe die Befehle im Installationsverzeichnis mit dem ursprünglichen Compose-Projektnamen aus.
Lege ein neues Backup-Verzeichnis außerhalb des Installationsverzeichnisses an, nur für den Eigentümer lesbar, setze `umask 077` und halte es verschlüsselt.
Dump, Objektarchiv und `.env` enthalten sensible Daten.

1. Erfasse die Identität des laufenden Engine-Images mit `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Bewahre dieses Image in einer erreichbaren Registry oder mit `docker image save` auf, zusammen
   mit `docker-compose.yml` und `.env`. Verlass dich für die Wiederherstellung nicht auf einen veränderlichen Tag.
2. Stoppe schreibende Dienste mit `docker compose stop engine`. Sichere PostgreSQL mit
   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Prüfe den Exit-Status, bevor du weitermachst. Lass die Engine gestoppt, bis beide Datenspeicher gesichert sind.
3. Stoppe den Objektspeicher mit `docker compose stop object-store`. Ermittle sein genaues Volume
   mit `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archiviere es schreibgeschützt mit `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.5-debian -C /data -cf - . > /path/to/backup/objects.tar`.
   Ersetze `<object-volume>` durch den ermittelten Namen, nicht durch einen geratenen.
4. Prüfe, dass jeder Befehl erfolgreich war. Setze alle Backup-Dateien auf den Modus `0600` und halte
   ihre SHA-256-Prüfsummen fest. Starte die ursprüngliche Installation mit `docker compose up -d --wait` neu.
   Schlägt ein Backup-Befehl fehl, behalte die ursprünglichen Volumes und such die Ursache. Ein unvollständiges Backup ist kein Wiederherstellungspunkt.

Teste die Wiederherstellung in einem separaten Verzeichnis. Nutze dort für **jeden** Compose-Befehl unten `docker compose -p subkit-recovery`.
Prüfe vorher, dass es unter diesem Projektnamen noch keine Container oder Volumes gibt; sonst wähle einen anderen, unbenutzten Namen.

Kopiere die gesicherte Compose-Datei und die `.env` hinein und behalte `MASTER_KEY` und Datenbankpasswort bei.
Wähle das gesicherte Engine-Image mit `SUBKIT_IMAGE` und setze freie Loopback-Ports über `SUBKIT_HOST_PORT` und `SUBKIT_DB_PORT`.
Verbinde die Testinstallation nicht mit externen Diensten, die Daten schreiben.

Mit dem Start der Engine startet auch ihr Zeitplaner. Lege deshalb vor dem Start eine `docker-compose.override.yml` mit dieser Netzwerktrennung ins Wiederherstellungsverzeichnis.
Lass sie aktiv, bis du wiederhergestellte Zeitpläne, Trigger und Konnektor-Rechte geprüft hast. Löse über dieses Projekt keine echten externen Wirkungen aus.

```yaml
networks:
  default:
    internal: true
```

1. Lege neuen Speicher mit `docker compose -p subkit-recovery create postgres object-store` an.
   Ermittle das `/data`-Volume des neuen Objektspeicher-Containers wie oben, mit dem Wiederherstellungsprojekt.
   Stelle nur in dieses neue Volume wieder her:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.5-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Starte die neue Datenbank mit `docker compose -p subkit-recovery up -d --wait postgres`.
   Stelle sie mit `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump` wieder her.
   Dieser Befehl ersetzt Datenbankinhalte. Verwende ihn nur gegen das neue Wiederherstellungsprojekt.
3. Starte die wiederhergestellten Dienste mit `docker compose -p subkit-recovery up -d --wait`.
   Prüfe `/health` und `/ready` auf dem gewählten Port und melde dich mit einem bestehenden Konto an.
   Vergleiche Workflow-Datensätze und Prüfsummen heruntergeladener Dateien, und prüfe ein verschlüsseltes Zugangsdatum mit einem kontrollierten Test.
   Ein erfolgreicher Health-Check allein belegt nicht, dass Datenbank, Objektdateien und Schlüssel zusammenpassen.

So stellst du dasselbe Image und ein konsistentes Backup wieder her. Ein Upgrade oder ein Schema-Downgrade ist damit nicht getestet.
Daten, die nach dem Backup geschrieben wurden, fehlen.
Behalte die ursprüngliche Installation, bis die Wiederherstellung abgenommen ist.
