---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Sammle Seiten und Ideen und prüfe, was davon zu Wissen oder Skills wird.
section: work
order: 5
audience: public
---
## Ideen sammeln und in Wissen oder Skills verwandeln

Sammle jetzt Seiten und Ideen und entscheide später, was zu Wissen oder zu einem Skill wird. Nutze die gemeinsamen Kategorien, um Clips zu ordnen; Inbox ist deine persönliche Standardkategorie zum Start.
Du kannst jederzeit eine andere Standardkategorie wählen.
Der Ablauf bleibt gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.
Erkenntnisse aus Sitzungen mit Coding-Agents gelangen als gesammelte Einträge mit Herkunft
`session` in denselben Ablauf; Intake zeigt die Herkunft als Filter und Badge.

Führe `sk clipper install` aus, um die in der CLI mitgelieferte Chrome-Erweiterung zu entpacken.
Öffne in Chrome `chrome://extensions`, aktiviere den Entwicklermodus, wähle **Load unpacked**
und wähle den Ordner, den der Befehl ausgibt. Der Installer füllt die Engine-URL
aus deinem aktiven Profil vor. Gib in den Einstellungen der Erweiterung einen separaten API-Schlüssel mit
`intake:read`- und `intake:write`-Zugriff ein und erlaube den Zugriff auf deinen Engine-Host.
Der Clipper braucht keine Berechtigung, um Wissen aufzunehmen. Du kannst die Engine-URL
in seinen Einstellungen ändern; in die Erweiterung ist keine Serveradresse eingebaut.

Nutze die Symbolleiste, das Kontextmenü der Seite oder ein unter `chrome://extensions/shortcuts`
konfiguriertes Tastenkürzel, um einen Artikel oder markierten Text zu sammeln. Die Quelladresse wird
automatisch erfasst. Prüfe die Vorschau, ergänze optional, warum es wichtig ist, und drücke **Collect**.
Deine Standardkategorie ist vorausgewählt, anfangs Inbox. Du kannst eine bestehende Kategorie wählen oder
eine neue eingeben. Kategorien werden mit dem Rest von SubKit geteilt; der Bearbeitungsstatus bleibt getrennt.
Die Standardkategorie gehört zur authentifizierten Identität; ein gemeinsam genutzter API-Schlüssel teilt diese Identität.
Die Sichtbarkeit in Intake folgt den Berechtigungen deines Mandanten, statt Kategorien privat zu machen.

Öffne im Cockpit **Intake**, um gesammelte Einträge mit derselben Tabelle und denselben
Kategoriesteuerungen wie bei den Knowledge Sources zu prüfen und zu ordnen. Öffne einen Eintrag, um seinen Inhalt
und die Originalquelle zu sehen, seinen Titel, Inhalt oder seine Kategorie zu bearbeiten oder einen Prüf-Chat zu starten.
Bearbeitungen erhalten das erfasste Original und erfordern eine erneute Prüfung jedes betroffenen Vorschlags.
Der Chat verlinkt
auf den Vorschlag des Eintrags zur Bestätigung; abgeschlossene Entscheidungen bleiben in seinem Verlauf.
In einem neuen Chat hilft der kategoriebezogene Prüfvorschlag, neue Einträge gemeinsam
zu prüfen. Die Chat-Aktion eines Eintrags prüft dagegen nur diesen ausgewählten Eintrag, mit einem sichtbaren
`@`-Verweis. Chat-Aktionen für bestehende Workflows, Konnektoren, Läufe, Quellen und Skills
tragen ebenfalls einen Verweis auf den ausgewählten Datensatz. Du kannst auch fragen:
„Sieh meine neuen Research-Einträge durch. Welche sind
für uns nützlich? Schlage vor, was wir behalten sollten, als Wissen oder als Skill.“ Der Chat bereitet einen Vorschlag
mit dem genauen Inhalt, den Originalquellen und dem Ziel vor. Du prüfst ihn und bestätigst ausdrücklich
**Confirm as knowledge** oder **Confirm as skill**. Erst dann kann die gewöhnliche Wissensabfrage
das Ergebnis nutzen oder können Agent-Briefings den Skill tragen. Ein Skill als Ziel legt einen aktiven Skill an oder
aktualisiert ihn und archiviert die Skills, die er ersetzt, im selben Schritt; der Vorschlag
zeigt jede Änderung. Das Bestätigen erfordert eine angemeldete Browsersitzung und die Rechte des
Ziels: `knowledge:write` für Wissen, `skill:write` und `skill:activate` für einen Skill,
dazu `skill:archive` für jeden ersetzten Skill. API-Schlüssel und MCP-Clients können nicht bestätigen.
Einen Skill aufzunehmen ist eine inhaltliche Entscheidung, getrennt von der Konnektor- oder
Ausführungsfreigabe einer Umgebung.
Du kannst einen nicht benötigten Clip während der Prüfung verwerfen und später wiederherstellen; das Verwerfen
erhält seine Originalquelle und macht ihn nie zu Wissen oder zu einem Skill.
Das Ändern des Vorschlags oder seiner Quellen erfordert eine weitere Prüfung. Der ursprüngliche Clip bleibt
mit dem entstandenen Wissen oder Skill verknüpft. Das Verschieben von Clips oder Umbenennen einer Kategorie nimmt ihre Clips nie auf. Kategorieänderungen, die
einen Vorschlag betreffen, erfordern dessen erneute Prüfung.

Der Clipper führt für jede Seite und jede Engine getrennte lokale Entwürfe, einschließlich ungesendeter Notizen.
Das Öffnen einer anderen Seite erfasst diese Seite; nutze die Entwurfsauswahl, um ungesendete Änderungen fortzusetzen.
Ein geöffneter Clipper folgt URL-Änderungen und Tab-Wechseln in seinem Quellfenster. Wenn Chrome
Zugriff auf eine neue Website verlangt, öffne den Clipper über das Symbolleistensymbol dieser Website. Fehlgeschlagene
Erfassungen bleiben lokal für einen erneuten Versuch; eine wiederholte Anfrage legt keinen weiteren Eintrag an.
Autor und Veröffentlichungszeit der Originalquelle bleiben getrennt davon, wer die Seite gesammelt hat
und wann. Nicht verfügbare Quellmetadaten bleiben unbekannt.

Auf YouTube extrahiert der Clipper Videometadaten, Beschreibung und ein verfügbares Original-Transkript.
Beschreibung und Transkript können unter Details getrennt einbezogen werden.
Die Verfügbarkeit hängt vom Video und vom Zugriff auf Untertitel ab. Die Extraktion entfernt Navigation
und Empfehlungen, ohne den Inhalt zusammenzufassen. Kann kein Hauptinhalt erkannt werden, meldet
der Clipper das, statt die gesamte Seite zu sammeln. Markdown ist bearbeitbar;
der ursprünglich erfasste Text bleibt erhalten. Bildlinks bleiben erhalten; Bilddateien
werden nicht hochgeladen.

Führe nach einem Update der CLI `sk clipper install` aus und lade die Erweiterung in Chrome neu.
Mit `sk clipper install --dir <directory> --no-open` wählst du ein Verzeichnis und verhinderst das
Öffnen von Chrome. Das Aktualisieren einer bestehenden Installation erhält ihre Verbindungseinstellungen.
Bei einer Neuinstallation überschreibt `--engine-url <url>` die Adresse des aktiven Profils.
Die Engine liefert dasselbe eingebettete Archiv unter `/install/clipper.zip` aus, mit seinem SHA-256
im Antwort-Header `x-subkit-sha256`. HTTPS-Engines und lokale HTTP-Engines auf
`localhost`, `127.0.0.1` oder `[::1]` werden unterstützt, einschließlich eines optionalen URL-Pfadpräfixes.
Das Ändern der Engine-Adresse erfordert die Eingabe des Schlüssels für diese Engine; ein bestehender
Entwurf bleibt seiner ursprünglichen Engine zugeordnet. Ältere Engines benötigen ein Update, um
Intake zu unterstützen; der Clipper schreibt nie ersatzweise direkt in das Wissen.
Bestehende Knowledge Sources bleiben unverändert, und alte lokale Entwürfe können ausdrücklich
in Intake gesammelt werden, ohne zu behaupten, dass bearbeitete Entwürfe Originalerfassungen der Seite sind.
