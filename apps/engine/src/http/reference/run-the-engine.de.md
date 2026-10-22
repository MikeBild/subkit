---
slug: run-the-engine
summary: Starte die Engine mit Docker Compose auf deinem eigenen Server.
section: start
path_choice: hosting
order: 3
audience: operator
---
## Die Engine betreiben

Erfordert Docker mit Compose, OpenSSL und eine POSIX-Shell. Verwende `docker-compose.yml`
aus demselben veröffentlichten Release wie das Engine-Image, in einem eigenen Verzeichnis.
Entwicklungs-Checkouts können auf ein Image verweisen, das noch nicht veröffentlicht ist;
ein fehlgeschlagener Image-Pull ist keine funktionierende Installation. Ersetze nicht
stillschweigend ein älteres Image durch eine neuere Compose-Datei.

Erzeuge die Installationsgeheimnisse einmalig vor dem ersten Start. Dieser Befehl weigert sich,
eine bestehende `.env` zu überschreiben, und beschränkt den Zugriff auf deren Eigentümer:

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

Bewahre ein verschlüsseltes Backup der `.env` außerhalb dieses Verzeichnisses auf. `MASTER_KEY`
verschlüsselt gespeicherte Geheimnisse; geht er verloren, sind diese Geheimnisse unlesbar. Erzeuge ihn
für eine bestehende Datenbank nie neu. Lass das Datenbankpasswort unverändert, wenn du dessen Volume
wiederverwendest; das Ändern der `.env` ändert nicht das Passwort in einer bereits initialisierten
PostgreSQL-Datenbank. Committe die `.env` nie und gib die Ausgabe von `docker compose config`,
die Geheimnisse enthält, nie weiter.

Der Offline-Befehl `--rewrap-master-key` deckt das Register der Einstellungsgeheimnisse ab.
Er lehnt behaltene Zugangsdaten, verschlüsselte Workflow- oder Konversationsdaten, Freigabenachweise
und andere verschlüsselte Speicher außerhalb dieses Umfangs ab. Bewahre den ursprünglichen
`MASTER_KEY`, wenn er ablehnt. Der Befehl erfordert die ausdrückliche Bestätigung, dass alle
Produzenten gestoppt sind, und eine separate Datei mit Stopp-Nachweis; abgelaufene Heartbeats allein
belegen das nicht. Die gehostete Wartung inaktiver Eigentümer erfordert zusätzlich eine
ausdrücklich bereitgestellte Wartungsfähigkeit. Wähle diesen Login über die bestehende
Datenbankkonfiguration und verwende `--maintenance`; er erhält nur die vorgesehenen
Wartungsfunktionen. Die Engine legt keine Datenbankbenutzer an.

Führe für spätere Starts `docker compose up -d --wait` im selben Verzeichnis aus.
`docker compose stop` stoppt Dienste, ohne Daten zu löschen. Datenbank und Objektspeicher
verwenden benannte Volumes; `docker compose down -v` löscht sie. Behalte beim Fortsetzen einer
Installation denselben Compose-Projektnamen bei. Ein Wiederherstellungs-Backup benötigt Datenbank,
Objektspeicherdaten, `.env` sowie die passende Compose-Datei und Image-Identität gemeinsam.
Teste die Wiederherstellung in einer separaten Installation, bevor du dich auf ein Backup
verlässt oder ein Upgrade durchführst.

Die Standard-Bindungen von API und Datenbank sind nur auf Loopback. Schließe das erste Setup
lokal ab, bevor du die API freigibst. Fernzugriff erfordert HTTPS und Zugriffskontrollen;
gib Datenbank oder Objektspeicher nicht öffentlich frei.

Die Konnektor-Discovery im mitgelieferten Container unterstützt HTTP-basierte Dokumentationsquellen.
Optionales Playwright-Crawling ist standardmäßig nicht verfügbar. Für Dokumentation, die
JavaScript-Rendering erfordert, stelle eine zugängliche OpenAPI-Spezifikation bereit oder
konfiguriere die Konnektor-Endpunkte ausdrücklich. Eine mitgelieferte Browser-Programmdatei allein
belegt nicht, dass die Discovery-Integration verfügbar ist.

### Backup und Wiederherstellung

Nutze ein Wartungsfenster für ein konsistentes Backup. Diese Schritte gelten für die
mitgelieferte PostgreSQL und den Objektspeicher; externe Dienste benötigen ein eigenes
Wiederherstellungsverfahren. Führe Befehle im Installationsverzeichnis mit dem ursprünglichen
Compose-Projektnamen aus. Verwende ein neues, nur dem Eigentümer zugängliches Backup-Verzeichnis
außerhalb des Checkouts, setze `umask 077` und halte es im Ruhezustand verschlüsselt.
Dump, Objektarchiv und `.env` enthalten sensible Daten.

1. Erfasse die Identität des laufenden Engine-Images mit `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Bewahre dieses Image in einer zugänglichen Registry oder mit `docker image save` auf, zusammen
   mit `docker-compose.yml` und `.env`. Verlass dich für die Wiederherstellung nicht auf einen veränderlichen Tag.
2. Stoppe Schreiber mit `docker compose stop engine`. Sichere PostgreSQL mit
   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Prüfe den Exit-Status, bevor du fortfährst. Lass die Engine gestoppt, bis beide Datenspeicher gesichert sind.
3. Stoppe den Objektspeicher mit `docker compose stop object-store`. Ermittle sein genaues Volume
   mit `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archiviere es schreibgeschützt mit `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.0-debian -C /data -cf - . > /path/to/backup/objects.tar`.
   Ersetze `<object-volume>` durch den ermittelten Namen, nicht durch einen geratenen Volume-Namen.
4. Prüfe, dass jeder Befehl erfolgreich war, beschränke alle Backup-Dateien auf den Modus `0600` und halte
   ihre SHA-256-Prüfsummen fest. Starte die ursprüngliche Installation mit `docker compose up -d --wait` neu.
   Schlägt ein Backup-Befehl fehl, behalte die ursprünglichen Volumes und untersuche die Ursache; ein unvollständiges Backup ist kein Wiederherstellungspunkt.

Teste die Wiederherstellung in einem separaten Verzeichnis mit `docker compose -p subkit-recovery` für
**jeden** Compose-Befehl unten. Bestätige zuerst, dass dieser Projektname keine bestehenden
Container oder Volumes hat; wähle andernfalls einen anderen unbenutzten Namen. Kopiere die gesicherte Compose-Datei
und `.env`, bewahre `MASTER_KEY` und das Datenbankpasswort, wähle das gesicherte
Engine-Image mit `SUBKIT_IMAGE` und setze unbenutzte Loopback-Ports über
`SUBKIT_HOST_PORT` und `SUBKIT_DB_PORT`. Verbinde die Wiederherstellungsinstallation nicht mit
externen Schreibern. Füge vor dem Start der Dienste im Wiederherstellungsverzeichnis eine
`docker-compose.override.yml` mit der folgenden Netzwerkisolation hinzu. Lass sie in Kraft, bis
wiederhergestellte Zeitpläne, Trigger und Konnektor-Berechtigungen geprüft wurden; der Start
der Engine startet auch ihren Scheduler. Verwende dieses Wiederherstellungsprojekt nicht, um
echte externe Wirkungen auszuführen.

```yaml
networks:
  default:
    internal: true
```

1. Lege neuen Speicher mit `docker compose -p subkit-recovery create postgres object-store` an.
   Ermittle das `/data`-Volume des neuen Objektspeicher-Containers wie oben, mit dem Wiederherstellungsprojekt.
   Stelle nur in dieses neue Volume wieder her:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.0-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Starte die neue Datenbank mit `docker compose -p subkit-recovery up -d --wait postgres`.
   Stelle sie mit `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump` wieder her.
   Dieser Befehl ersetzt Datenbankinhalte: Verwende ihn nur gegen das neue Wiederherstellungsprojekt.
3. Starte die wiederhergestellten Dienste mit `docker compose -p subkit-recovery up -d --wait`.
   Prüfe `/health` und `/ready` auf dem gewählten Port, melde dich mit einem bestehenden Konto an,
   vergleiche Workflow-Datensätze und Prüfsummen heruntergeladener Dateien und verifiziere ein verschlüsseltes
   Zugangsdatum über einen kontrollierten Test. Ein erfolgreicher HTTP-Health-Check allein
   belegt nicht, dass Datenbank, Objektdateien und Verschlüsselungsschlüssel zusammenpassen.

Das stellt dasselbe Anwendungs-Image und ein konsistentes Backup wieder her. Es belegt weder einen
Upgrade- noch einen Schema-Downgrade-Pfad. Nach dem Backup geschriebene Daten sind nicht
enthalten. Behalte die ursprüngliche Installation, bis die Wiederherstellung akzeptiert wurde.

