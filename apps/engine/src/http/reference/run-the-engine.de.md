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

### Kurz und knapp

1. Installiere Docker mit Compose und OpenSSL auf deinem Server.
2. Lade die [`docker-compose.yml`](https://github.com/MikeBild/subkit/releases/latest/download/docker-compose.yml) des neuesten Releases in ein leeres Verzeichnis.
3. Erzeuge die `.env` mit `MASTER_KEY` und `SUBKIT_DB_PASSWORD`, mit dem Befehl weiter unten.
4. Starte alles mit `docker compose pull && docker compose up -d --wait`.
5. Leg das Admin-Konto an und verbinde deinen KI-Schlüssel mit `docker compose exec engine subkit init`, wie unter „Erstes Setup“ beschrieben.
6. Öffne `http://localhost:3000`. Du landest im Cockpit.

Die Details folgen.

Du brauchst Docker mit Compose, OpenSSL und eine POSIX-Shell.
Lade die `docker-compose.yml` in ein eigenes Verzeichnis. Sie kommt immer aus dem neuesten Release und startet das Engine-Image dieses Release:

```bash
mkdir subkit && cd subkit
curl -fsSLO https://github.com/MikeBild/subkit/releases/latest/download/docker-compose.yml
```

Jede Einstellung mit ihrem Standardwert steht in der [`subkit.config.example.json`](https://github.com/MikeBild/subkit/releases/latest/download/subkit.config.example.json). Du brauchst sie nur, wenn du eine Einstellung per Datei änderst, wie unter „Einstellungen“ beschrieben.
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

### Arbeitsbereiche in der Datenbank trennen

Die Engine nutzt Row Level Security von PostgreSQL als zusätzliche Wand zwischen Arbeitsbereichen. Bei Tabellen mit besonders schutzwürdigen Daten liefert dann die Datenbank selbst nur Zeilen des Arbeitsbereichs, der gerade arbeitet. Das betrifft gespeicherte Geheimnisse, Freigaben von Tools, eingehende Webhooks, Abonnements, Chat-Arbeitsbereiche, Push-Abonnements, den Laufzustand von Workflows und die Einstellungen der Anmelde-Anbieter.

Du musst dafür nichts einrichten. Die Migrationen der Engine schalten Row Level Security ein und erzwingen sie. Damit gilt sie auch für den Login, dem die Tabellen gehören. Eine zusätzliche Datenbankrolle ist nicht nötig:

- Jeder Zugriff auf diese Tabellen läuft entweder für einen Arbeitsbereich oder, bei Sweeps und Wartung, in einem ausdrücklichen System-Scope. Beides gilt jeweils für eine Transaktion.
- Code, der keinen Scope wählt, liest keine Zeilen und kann nicht schreiben. Ein vergessener Filter scheitert also sicher, statt Daten eines anderen Arbeitsbereichs zu zeigen.
- Das funktioniert mit jeder PostgreSQL-Datenbank, auch mit verwalteten Datenbanken, in denen du keine Rollen anlegen darfst.

Gut zu wissen:

- Superuser und Logins mit `BYPASSRLS` ignorieren Row Level Security, auch wenn sie erzwungen ist. Das mitgelieferte PostgreSQL der `docker-compose.yml` meldet sich als solcher Superuser an. Für diese Logins legt die Engine die Rolle `subkit_tenant` beim Start selbst an und wechselt in sie, solange sie für einen Arbeitsbereich arbeitet. `subkit_tenant` kann sich nicht anmelden.
- Ein Login mit `BYPASSRLS`, der kein Superuser ist, kann diese Rolle nicht anlegen. Das Log meldet dann „role subkit_tenant is not usable“ und nennt die Befehle. Nimm dem Login der Engine besser `BYPASSRLS` weg.
- Meldet das Log, dass die Rolle `subkit_tenant` Superuser ist oder `BYPASSRLS` hat, schränkt Row Level Security sie nicht ein. Behebe das mit `ALTER ROLE subkit_tenant NOSUPERUSER NOBYPASSRLS;`.
- Meldet das Log, dass Row Level Security nicht erzwungen ist, starte die Engine noch einmal. Die Migrationen der Engine legen die Policies erneut an und brauchen dafür keine Rolle.

### Browser-Crawling für die Connector-Discovery

Das mitgelieferte Image enthält keinen Browser und kein Node.js.
Die Connector-Discovery sucht die Dokumentation eines Dienstes deshalb über HTTP: OpenAPI, GraphQL, Swagger UI, `llms.txt` und HTML-Seiten.
Findet keiner dieser Wege die Dokumentation, nennt das Ergebnis den fehlenden Baustein: „browser discovery is not available“.
Braucht die Dokumentation JavaScript zum Anzeigen, stelle eine erreichbare OpenAPI-Spezifikation bereit oder trage die Endpunkte des Connectors selbst ein.

Browser-Crawling läuft nur, wenn beide Bedingungen gelten:

- `SUBKIT_PLAYWRIGHT_ENTRY` nennt ein installiertes Playwright-Modul mit seinem Chromium-Build,
  lesbar für den Container-Nutzer (uid 1001), zum Beispiel in einem eigenen, vom
  SubKit-Image abgeleiteten Image.
- Der Schutz für ausgehende Verbindungen ist nicht strikt. Der Container startet mit
  `NODE_ENV=production` und damit strikt; er lehnt Browser-Discovery ab. Die Einstellung
  `egress.mode: permissive` erlaubt zusätzlich private und Loopback-Adressen für alle
  Connectors. Wähle sie nur hinter einer Netzgrenze, die du geprüft hast. Lokale Dienste
  auf `localhost` oder `host.docker.internal` brauchen sie nicht, denn sie sind standardmäßig
  erlaubt, siehe „Lokale Dienste aus dem Container“ weiter unten.

Ein abgeleitetes Image pflegst du selbst: Halte Playwright und den Browser aktuell, scanne
es und liefere die Browser-Lizenzen mit. Dieser Weg ist nicht Teil der Release-Prüfungen.

### Lokale Dienste aus dem Container

Im Container ist `localhost` die Engine selbst. Einen Dienst auf deinem Server, etwa einen
lokalen MCP-Server, erreichst du über `http://host.docker.internal:8931`. Die
`docker-compose.yml` leitet `host.docker.internal` über `extra_hosts` auf deinen Server.
Unter Linux muss der Dienst dafür an `0.0.0.0` oder an der Docker-Bridge lauschen, nicht nur
an `127.0.0.1`.

Diese lokalen Adressen sind über `connectors.local_servers` standardmäßig erlaubt;
`egress.mode: permissive` brauchst du dafür nicht. MCP-Server per Befehl (stdio) laufen nicht
im Container. Nutze für sie SubKit Desktop oder eine Engine auf dem Host.
Alles Weitere steht unter „Lokale Dienste verbinden“.

### Backup und Wiederherstellung

Ein Backup kopiert die ganze Installation und stellt sie mit demselben Image wieder her.
Um nur die eigenen Workflows, Connectors, Skills und das Wissen eines Arbeitsbereichs auf eine andere Engine zu bringen, exportiere stattdessen ein Paket wie in „Die subkit-CLI auf deinem Rechner verwenden“ beschrieben.

Plane für ein konsistentes Backup ein Wartungsfenster ein.
Die Schritte gelten für die mitgelieferte PostgreSQL und den mitgelieferten Objektspeicher; externe Dienste brauchen ein eigenes Verfahren.
Führe die Befehle im Installationsverzeichnis mit dem ursprünglichen Compose-Projektnamen aus.
Lege ein neues Backup-Verzeichnis außerhalb des Installationsverzeichnisses an, nur für den Eigentümer lesbar, setze `umask 077` und halte es verschlüsselt.
Dump, Objektarchiv und `.env` enthalten sensible Daten.

1. Erfasse die Identität des laufenden Engine-Images mit `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Bewahre dieses Image in einer erreichbaren Registry oder mit `docker image save` auf, zusammen
   mit `docker-compose.yml` und `.env`. Verlass dich für die Wiederherstellung nicht auf einen veränderlichen Tag.
2. Stoppe schreibende Dienste mit `docker compose stop engine`. Sichere PostgreSQL mit
   `docker compose exec -T -e PGOPTIONS='-c subkit.rls_scope=system' postgres pg_dump --enable-row-security -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Prüfe den Exit-Status, bevor du weitermachst. Lass die Engine gestoppt, bis beide Datenspeicher gesichert sind.
   Bei einer eigenen PostgreSQL-Datenbank sicherst du genauso: Ein Login, der kein Superuser ist, bricht sonst
   mit „query would be affected by row-level security policy“ ab. Übergib deshalb `--enable-row-security` und den
   System-Scope über `PGOPTIONS`. Mit so einem Login gilt dasselbe `PGOPTIONS` auch für `pg_restore`.
3. Stoppe den Objektspeicher mit `docker compose stop object-store`. Ermittle sein genaues Volume
   mit `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archiviere es schreibgeschützt mit `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:@@BUN_VERSION@@-debian -C /data -cf - . > /path/to/backup/objects.tar`.
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
Lass sie aktiv, bis du wiederhergestellte Zeitpläne, Trigger und Connector-Rechte geprüft hast. Löse über dieses Projekt keine echten externen Wirkungen aus.

```yaml
networks:
  default:
    internal: true
```

1. Lege neuen Speicher mit `docker compose -p subkit-recovery create postgres object-store` an.
   Ermittle das `/data`-Volume des neuen Objektspeicher-Containers wie oben, mit dem Wiederherstellungsprojekt.
   Stelle nur in dieses neue Volume wieder her:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:@@BUN_VERSION@@-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Starte die neue Datenbank mit `docker compose -p subkit-recovery up -d --wait postgres`.
   Stelle die Datenbank mit `docker compose -p subkit-recovery exec -T -e PGOPTIONS='-c subkit.rls_scope=system' postgres pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges -U subkit -d subkit < /path/to/backup/postgres.dump` wieder her.
   Eine Datenbankrolle musst du vorher nicht anlegen. Die Policies für Row Level Security gehören zum Dump und nennen keine Rolle, gespeicherte Geheimnisse bleiben also lesbar. Braucht die Engine die Rolle `subkit_tenant`, legt sie sie beim Start selbst an.
   Dieser Befehl ersetzt Datenbankinhalte. Verwende ihn nur gegen das neue Wiederherstellungsprojekt.
3. Starte die wiederhergestellten Dienste mit `docker compose -p subkit-recovery up -d --wait`.
   Docker veröffentlicht `SUBKIT_HOST_PORT` nicht, solange das Netz `internal` ist. Prüfe deshalb im Engine-Container:
   `docker compose -p subkit-recovery exec engine curl -fsS http://127.0.0.1:3000/health` und
   `docker compose -p subkit-recovery exec engine curl -fsS http://127.0.0.1:3000/ready`.
   Lies Datensätze mit der CLI im selben Container zurück: Stelle einen Schlüssel mit
   `docker compose -p subkit-recovery exec engine engine --issue-admin-key --tenant <tenant>` aus, dann führe
   `docker compose -p subkit-recovery exec engine subkit login --engine-url http://127.0.0.1:3000 --api-key <key>` und
   `docker compose -p subkit-recovery exec engine subkit workflows list` aus.
   Entferne `internal: true` nicht nur für die Prüfung. Melde dich erst im Cockpit an, wenn du Zeitpläne, Trigger und Connector-Rechte geprüft und die Trennung aufgehoben hast.
   Vergleiche Workflow-Datensätze und Prüfsummen heruntergeladener Dateien, und prüfe ein verschlüsseltes Zugangsdatum mit einem kontrollierten Test.
   Ein erfolgreicher Health-Check allein belegt nicht, dass Datenbank, Objektdateien und Schlüssel zusammenpassen.

So stellst du dasselbe Image und ein konsistentes Backup wieder her. Ein Upgrade oder ein Schema-Downgrade ist damit nicht getestet.
Daten, die nach dem Backup geschrieben wurden, fehlen.
Behalte die ursprüngliche Installation, bis die Wiederherstellung abgenommen ist.
