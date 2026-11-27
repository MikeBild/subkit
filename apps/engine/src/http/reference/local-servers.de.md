---
slug: local-servers
summary: Verbinde Dienste, die auf deinem eigenen Rechner laufen, etwa einen lokalen MCP-Server, eine API oder eine Datenbank.
section: operate
order: 12
audience: operator
---
## Lokale Dienste verbinden

Manche Dienste laufen direkt neben SubKit: ein MCP-Server auf deinem Laptop, eine API in einem Entwicklungscontainer, eine PostgreSQL-Datenbank auf deinem Rechner. Du brauchst dieses Kapitel, wenn du einen solchen lokalen Dienst als Connector anbinden willst. Danach erreicht SubKit ihn über `localhost` oder `host.docker.internal`, mit oder ohne Anmeldung, über `http` oder `https`.

Ein lokaler Dienst ist einer, dessen Adresse auf deinen eigenen Rechner zeigt. Jeder Connector-Typ kann einen nutzen: HTTP, GraphQL, S3, SFTP, PostgreSQL und MCP. MCP-Server können zusätzlich als Befehl laufen (stdio), den SubKit selbst startet.

### Wo lokale Dienste funktionieren

SubKit erreicht einen lokalen Dienst nur, wenn die Engine auf demselben Rechner läuft.

| Wo SubKit läuft | Lokale Dienste |
| --- | --- |
| SubKit Desktop unter macOS, lokaler Arbeitsbereich | Ja, auch stdio-MCP-Server |
| Engine direkt auf deinem Rechner gestartet (`bun`) | Ja; stdio-MCP-Server, nachdem du sie eingeschaltet hast |
| Engine in Docker auf deinem Rechner | Ja, über `http://host.docker.internal:8931`; keine stdio-MCP-Server |
| SubKit Cloud | Nein |
| SubKit Desktop, verbunden mit SubKit Cloud | Nein, weil die Engine in der Cloud läuft |
| SubKit Desktop unter Windows | Nein, den lokalen Arbeitsbereich gibt es unter Windows noch nicht |

### Welche Adressen als lokal gelten

Ein Connector gilt als lokal, wenn seine eigene Adresse einen dieser Hosts nutzt:

- `localhost` und Namen, die auf `.localhost` enden
- `127.0.0.1` und jede andere Adresse, die mit `127.` beginnt
- `[::1]`
- `host.docker.internal`, die Adresse deines Rechners aus Sicht eines Docker-Containers

`http://` und `https://` funktionieren beide, mit jedem Port, zum Beispiel `http://localhost:8931/mcp` oder `https://127.0.0.1:8443`. `0.0.0.0` ist kein gültiges Ziel.

Der Connector erreicht nur seine eigene Adresse. Ein entfernter Connector erreicht nie eine lokale Adresse, auch nicht über eine Umleitung oder eine Anmeldeadresse, die er ankündigt. Ein lokaler Connector kann auch nicht auf einen anderen lokalen Port wechseln. Die einzige Ausnahme ist der lokale Autorisierungsserver, den ein lokaler MCP-Server für seine OAuth-Anmeldung nennt. Andere private Netzadressen wie `192.168.x.x` bleiben gesperrt.

### Beispiel: ein lokaler MCP-Server ohne Anmeldung

Angenommen, du startest den Playwright-MCP-Server auf deinem Rechner:

```bash
npx @playwright/mcp@latest --port 8931
```

1. Öffne im Cockpit „Connectors“ und wähle „Connector hinzufügen“.
2. Wähle MCP und trag `http://localhost:8931/mcp` als Adresse ein.
3. Lass die Anmeldung auf „Keine“. Das ist für lokale Adressen voreingestellt.
4. Speichere. SubKit prüft die Verbindung und listet die Tools des Servers auf.

Du kannst auch im Chat fragen: „Verbinde meinen MCP-Server auf localhost:8931.“ SubKit legt denselben Connector an.

Läuft die Engine in Docker, trägst du stattdessen `http://host.docker.internal:8931/mcp` ein.

### Anmeldung

Lokale Dienste starten ohne Anmeldung. Erwartet dein Dienst eine, wählst du sie im Connector:

- **API-Key:** SubKit schickt den Key als `Authorization: Bearer <key>` oder in einem Header, den du nennst, zum Beispiel `X-API-Key`.
- **OAuth (MCP):** Der MCP-Server nennt seinen eigenen Autorisierungsserver. Der darf ebenfalls lokal laufen, zum Beispiel auf `http://localhost:9000`. Melde dich einmal im Browser an. Danach erneuert SubKit die Anmeldung selbst, auch wenn `server.public_base_url` nicht gesetzt ist.

HTTPS ist nur für entfernte Autorisierungsserver nötig. Ein lokaler auf `localhost` funktioniert über `http`.

### HTTPS mit einem lokalen Zertifikat

Viele lokale Dienste nutzen ein Zertifikat einer lokalen Zertifizierungsstelle (CA), zum Beispiel eines, das mit `mkcert` erstellt wurde. Einer solchen CA vertraut SubKit nicht von selbst. Du hast zwei Möglichkeiten:

1. **CA hinzufügen (empfohlen):** Füge das CA-Zertifikat im PEM-Format in den Connector ein. Bei `mkcert` zeigt `mkcert -CAROOT` den Ordner; die Datei heißt `rootCA.pem`. In der Konfiguration liegt es bei HTTP- und GraphQL-Connectors unter `config.tls`, bei MCP-Connectors unter `config.mcp.tls`. SubKit Desktop vertraut außerdem den CAs im macOS-Schlüsselbund. Dort legt `mkcert -install` seine CA ab.
2. **„Zertifikat nicht prüfen (nur lokal)“:** SubKit akzeptiert dann jedes Zertifikat dieser Adresse. Nutze das nur für Tests auf deinem eigenen Rechner. Das Cockpit zeigt eine Warnung.

Beide Möglichkeiten gelten nur für lokale Adressen. Bei entfernten Adressen prüft SubKit das Zertifikat immer.

### MCP-Server per Befehl (stdio)

Manche MCP-Server lauschen an keinem Port. Sie laufen als Programm, das SubKit startet und über dessen Ein- und Ausgabe es mit ihm spricht. Das heißt stdio. Beispiele:

```bash
docker mcp gateway run
npx @playwright/mcp@latest
```

Im Connector trägst du den Befehl, seine Argumente, Umgebungsvariablen und auf Wunsch einen Arbeitsordner ein. Markiere geheime Werte als geheim; SubKit speichert sie verschlüsselt.

stdio läuft nur dort, wo die Engine direkt auf deinem Rechner läuft: in SubKit Desktop und in einer Engine, die du mit `bun` startest. Eine Engine im Docker-Container lehnt stdio ab. Nutze dort stattdessen eine `http`-Adresse über `host.docker.internal`.

#### Vor dem ersten Start bestätigen

SubKit startet einen Befehl erst, nachdem eine Person ihn bestätigt hat. Chat und Cockpit dürfen einen Befehl eintragen, starten ihn aber nicht.

- Für die Bestätigung brauchst du die Berechtigung `connectors:confirm_local_command`. Standardmäßig haben sie nur die Rollen Owner und Admin.
- Wer den Befehl eingetragen oder geändert hat, kann ihn nicht selbst bestätigen. Ausnahme ist der lokale Arbeitsbereich in SubKit Desktop, in dem du die einzige Person bist.
- Der Bestätigungsdialog zeigt den vollständigen Befehl: Programm, Argumente, Namen der Umgebungsvariablen und Arbeitsordner.
- Eine Antwort des KI-Modells zählt nie als Bestätigung.
- Jede Änderung an Befehl, Argumenten, Umgebung oder Arbeitsordner hebt die Bestätigung auf. SubKit fragt dann erneut.

#### Was das gestartete Programm sieht

Das Programm erbt die Umgebung der Engine nicht. Geheimnisse der Engine wie `MASTER_KEY` oder `DATABASE_URL` bleiben ihm verborgen. Es bekommt nur:

- `PATH` und `HOME`
- `DOCKER_HOST`, `DOCKER_CONFIG` und `DOCKER_CONTEXT`, wenn sie gesetzt sind
- die Umgebungsvariablen, die du im Connector eingetragen hast, auch die geheimen

SubKit Desktop liest `PATH` aus deiner Login-Shell. So findet es `docker`, `npx` und andere Tools aus Homebrew, auch wenn du SubKit aus dem Finder startest.

SubKit startet ein Programm bei der ersten Nutzung und beendet es nach einer Zeit ohne Anfragen. Stürzt es ab, startet SubKit es mit wachsender Wartezeit neu. Seine Fehlerausgabe erscheint geschwärzt in den Logs und in der Verbindungsprüfung.

### Einstellungen

| Einstellung | Werte | Standard | Wirkung |
| --- | --- | --- | --- |
| `connectors.local_servers` | `allow`, `deny` | `allow` | Erlaubt oder sperrt lokale Adressen für alle Connectors. Wirkt sofort, ohne Neustart. |
| `connectors.mcp.stdio` | `auto`, `on`, `off` | `auto` | `auto` schaltet stdio im lokalen Arbeitsbereich von Desktop ein und sonst aus. `on` schaltet es für eine Engine auf deinem Rechner ein und wird im Container abgelehnt. |
| `connectors.mcp.stdio_limits` | siehe „Einstellungen“ | | Startzeit, Leerlaufzeit, Höchstzahl der Prozesse und Größe der aufbewahrten Fehlerausgabe. |

Für lokale Dienste brauchst du `egress.mode: permissive` nicht. Diese Einstellung öffnet alle privaten Adressen für alle Connectors; lokale Dienste sind auch ohne sie erlaubt.

### Fehlerbehebung

| Was du siehst | Ursache | Was du tust |
| --- | --- | --- |
| „Connection refused“ bei `localhost`, während die Engine in Docker läuft | Im Container ist `localhost` die Engine selbst. | Nutze `http://host.docker.internal:8931`. Unter Linux muss der Dienst an `0.0.0.0` oder an der Docker-Bridge lauschen, nicht nur an `127.0.0.1`. |
| TLS- oder Zertifikatsfehler bei `https://localhost` | SubKit kennt die lokale CA nicht. | Füge die CA als PEM in den Connector ein (bei `mkcert`: `rootCA.pem`). |
| `mcp_local_command_unconfirmed` | Noch niemand hat den Befehl bestätigt, oder er wurde nach der Bestätigung geändert. | Bitte eine Person mit `connectors:confirm_local_command`, ihn zu bestätigen. |
| `mcp_stdio_unavailable_in_container` | Die Engine läuft in einem Docker-Container. | Betreibe den Server über `http` und verbinde ihn über `host.docker.internal`, oder nutze SubKit Desktop oder eine Engine auf deinem Rechner. |
| `docker` oder `npx` in SubKit Desktop nicht gefunden | Das Programm liegt nicht im `PATH` deiner Login-Shell. | Ergänze seinen Ordner in deinem Shell-Profil im `PATH`, zum Beispiel in `~/.zprofile`, und starte SubKit Desktop neu. |
| `local_target_from_remote_origin` | Ein entfernter Dienst wollte SubKit auf eine lokale Adresse umleiten. | Das ist absichtlich gesperrt. Binde den lokalen Dienst mit einem eigenen Connector an. |
| Lokale Adresse auf einer selbst betriebenen Engine gesperrt | `connectors.local_servers` steht auf `deny`. | Stell die Einstellung auf `allow`. |
