# SubKit Website: Aufgaben und Session-Übergabe

## Einstieg für die nächste Session

Diese Datei vor weiterer Website-Arbeit lesen. Sie hält Nutzerentscheidungen,
Umsetzungsstand und offene Aufgaben fest; sie ist keine Release-Freigabe.
Zusätzlich AGENTS.md, LAUNCH.md, LAUNCH_STATUS.md und LAUNCH_SYNC.md beachten.
Ältere Framer-Aufträge und widersprechende Schreibregeln sind durch die hier
festgehaltenen Entscheidungen ersetzt.

Die Website liegt in Mike’s Lovable. Ausschließlich die offizielle
Lovable-Integration für Designänderungen verwenden. Aktuellen Projektstand und
laufende Nachrichten zuerst prüfen, keine zweite Website anlegen.
Projektlinks, bestätigte Betreiber-/Domainangaben und die zuletzt bearbeiteten
Nachrichten stehen außerhalb des Repositorys in
`/Users/mikebild/Documents/SubKit-Lovable/WEBSITE-HANDOFF.md`.
Diese Angaben nicht erneut vom Nutzer erfragen.

Die Website ist unveröffentlicht. Weder vollständige Releasefähigkeit noch
tatsächliche Formularzustellung oder öffentliche Installierbarkeit behaupten.

## Verbindliche Entscheidungen

### Produkt und Sprache

- Ein KI-Assistent hilft im Gespräch und in natürlicher Sprache, Workflows und
  Konnektoren zu erstellen. Nutzer müssen sich dafür nicht selbst durch die
  API-Dokumentationen der angebundenen Systeme arbeiten.
- Nach Prüfung und Freigabe führt SubKit die festgelegten Schritte wiederholbar
  aus und protokolliert jeden Lauf. Wiederholbarkeit betrifft den Prozess;
  wechselnde Daten und ausdrücklich vorgesehene KI-Schritte können andere
  Ergebnisse liefern. Keine pauschale Garantie identischer Ergebnisse.
- Keine erneute KI-Planung bei jedem Lauf. Zusätzliche Modellkosten entstehen,
  wenn der Workflow selbst KI nutzt. Infrastruktur und externe Dienste können
  eigene Kosten verursachen; nicht pauschal kostenlosen Betrieb versprechen.
- Konnektoren werden mit festgelegten Berechtigungen wiederverwendet.
  Fachliche Skills sind keine technisch erzwungenen Zugriffsrechte.
- Zielgruppe: Solounternehmer und kleine professionelle Teams, einschließlich
  spezialisierter Abteilungen größerer Unternehmen. Gemeinsames Wissen,
  wiederverwendbare Regeln und gemeinsam nutzbare Workflows sind Kernnutzen.
- Kurze, konkrete, praxisnahe Texte. Nutzen anhand echter Tätigkeiten erklären,
  Interesse am Ausprobieren wecken. Keine Textwände, Angstrhetorik, Belehrungen
  oder pauschale Abwertung anderer Werkzeuge.
- Keine fremde Firma, fremden Kundenreferenzen, Zertifikate, Partnerlogos,
  Erfolgszahlen oder ERP-Migrationsversprechen aus den Textbeispielen übernehmen.
  Insbesondere keine Zuordnung zu index commerce GmbH.
- Das alte zentrale Briefing enthält noch widersprechende Aussagen. Aktuelle
  Nutzerentscheidungen haben Vorrang; zentrale Schreibregeln separat korrigieren.

### Verworfene Formulierungen

Nicht wiederverwenden:

- „Dein/Der Assistent probiert. SubKit betreibt.“
- „Jede Organisation hat Arbeit, die jedes Mal gleich abläuft.“
- „Du beschreibst, was passieren soll. In normalen Sätzen.“
- „Ein Werkzeug, das in deine echten Systeme greift, ist kein Spielzeug.“
- „Die KI hilft beim Bauen. Beim Ausführen gilt der freigegebene Ablauf.“
- „Aus einer Aufgabe wird ein Ablauf.“

Aktuell verwendete Erklärungen:

- „Aus deiner Aufgabe wird ein wiederholbarer Workflow. Jeder Lauf folgt den
  festgelegten Schritten und wird protokolliert.“
- „Mit dem KI-Assistenten erstellst du deinen Workflow im Gespräch. Nach deiner
  Prüfung und Freigabe führt SubKit die festgelegten Schritte bei jedem Lauf aus.“
- „Du bestimmst, was dein Workflow darf.“ Berechtigungen und Protokollierung
  konkret erklären, statt Vertrauen durch Warnungen zu untergraben.

### Design und Umfang

- Bestehende, vom Nutzer bevorzugte Hero-Gestaltung erhalten:
  „ENTWERFEN. PRÜFEN. FREIGEBEN. LÄUFT.“ plus konkrete wechselnde Aufgaben.
  Eine zwischenzeitliche umfassende Umgestaltung wurde auf Wunsch zurückgesetzt.
- TE-Kit als gestalterische Referenz, eigenständige SubKit-Interpretation,
  ausdrücklich keine 1:1-Kopie. Maßgeblich ist der aktuelle Lovable-Entwurf.
- Scharfkantige Formensprache, keine runden Pills, keine verspielten Schatten.
  Barlow Condensed für prägende Überschriften, Share Tech Mono sparsam für Labels,
  gut lesbarer Fließtext. Blau als Akzent, kein Grün.
- Acht Seiten: Start, Anwendungsfälle, Loslegen, Vergleiche, Beta-Anfrage,
  Kontakt, Impressum, Datenschutz; zusätzlich passende Fehler-/404-Zustände.
- Beide primären Einstiege: „Beta-Einladung anfragen“ und „Self-Hosting starten“.
  Einladung bedeutet Anfrage, kein versprochener sofortiger Zugang.
- Keine erneute Komplettgestaltung. Weitere Maßnahmen als gezielte Änderungen
  im vorhandenen Layout durch Lovable ausführen.

### Sprache, Theme, Analytics und Social

- Vollständiges Deutsch und Englisch einschließlich Formulare, Fehler,
  Installationsassistent, Datenschutzdialoge und Metadaten.
- KEINE manuellen Sprach- oder Theme-Schalter, KEINE gespeicherten Overrides.
- Theme ausschließlich aus prefers-color-scheme, inklusive Live-Systemwechsel.
- Sprache aus priorisierten Browserpräferenzen/Accept-Language. Erste unterstützte
  Sprache Deutsch oder Englisch, sonst Englisch. Keine IP-basierte Erkennung.
- Umgesetzt: unpräfixierte Einstiegsadressen verhandeln per temporärer Weiterleitung
  die Sprache; explizite /de- und /en-Adressen bleiben in ihrer Sprache.
  Keine Redirect-Schleifen, korrekte Cache-/Vary-Regeln, Anker erhalten.
- Cookie-Einwilligung bleibt manuell: gleichwertiges Akzeptieren/Ablehnen,
  Einstellungen und jederzeitiger Widerruf im Footer. Ohne verfügbare Analytics
  keinen unnötigen Pflichtbanner anzeigen; Einstellungen bleiben erreichbar.
- GA4 vorbereitet, Kennung liefert Nutzer später. Ohne Kennung, in der Vorschau
  und vor Einwilligung keine Google-Scripts, Pings oder Messungen.
- Basic Consent Mode, keine Werbefunktionen, keine Formularinhalte, E-Mails,
  Namen, Tokens, vertraulichen Referrer oder vollständigen Querystrings senden.
  Formularerfolg erst nach tatsächlicher Serverannahme messen. Self-Hosting-Klick
  nicht als erfolgreiche Installation erfassen.
- Statische Social-Linkvorschauen auf Deutsch/Englisch in 1200 × 630 sowie
  Open-Graph-/Twitter-Metadaten, Canonical, hreflang und vorbereitete Sitemap.
  Keine Social-Profile, Beiträge oder fremden Tracking-Pixel beauftragt/angelegt.
- Vorschau bleibt noindex/disallow. Veröffentlichung, DNS-Änderungen und
  Aktivierung der Produktionskonfiguration benötigen separate Freigabe.

## Umgesetzt und überprüft

- [x] Bevorzugte Hero-Gestaltung wiederhergestellt, beanstandete Texte ersetzt.
- [x] Abstände/Alignments und mobile Umbrüche durch Lovable geprüft/korrigiert.
- [x] Mobile Menü-CTA lesbar; Formularbestätigungen unter sticky Header sichtbar.
- [x] Bestätigte Betreiber-, Kontakt- und Ziel-Domainangaben übernommen.
- [x] DE/EN-Seiten und automatische Sprach-/Theme-Erkennung ohne Schalter.
- [x] Social-Bilder, Sprachmetadaten und vorbereitete Sitemap.
- [x] Consent und deaktivierte GA4-Vorbereitung, inklusive Widerruf.
- [x] Übersetzungsfragmente bei Inline-Auszeichnung korrigiert.
- [x] Unbekannte Links werden nicht mehr auf Startseite umgeschrieben.
- [x] Spät ladende Analytics-Scripts können nach Widerruf keine vorgemerkten
  Ereignisse mehr senden; Warteschlange wird verworfen.

Nachweisgrenze: Lovable meldet erfolgreichen Build und 41 fokussierte Tests.
Geprüft wurden acht vollständige englische Seiten, 16 direkte Sprachseiten,
275 Links/Anker, zwölf simulierte Formularzustände, Systemwechsel und Consent
einschließlich Reload, Cross-tab, Widerruf während Scriptladung und erneuter
Einwilligung. Browsernachweise stammen aus Chromium auf localhost.
Google-Scripts wurden lokal abgefangen, Formularantworten simuliert.
Keine echten E-Mails, keine reale GA-Messung, keine Veröffentlichung.
Ausgewählte Codeänderungen wurden zusätzlich über die offizielle Integration
nachgelesen. Kein eigener vollständiger Produktionsnachweis durch den Hauptagenten.

Im Lovable-Projekt enthalten RELEASE.md und VERIFICATION.md die Aktivierungsregeln,
Reproduktionsbefehle und offenen Prüfgrenzen. Diese vor neuen Tests lesen und
bestandene Ergebnisse wiederverwenden. Keine automatische visuelle Matrix erneut
starten; manuelle Sichtabnahme bleibt beim Nutzer. Safari/Firefox und tatsächliche
öffentliche Hosting-Ausführung wurden noch nicht nachgewiesen.

## Offene Aufgaben, priorisiert

### 1. Inhalt und echter Produkteinblick

- [ ] Verbliebene Textprobleme in DE und EN korrigieren: „Eure KI-Experimente
  werden prüfbar“, „Fremdcode nur im Käfig“, pauschale Vergleichsaussagen wie
  „Nicht vorgesehen“, „Alles, was du darfst“ und Abwertung wiederverwendbarer Skripte.
- [ ] Unbelegte Absolutheiten überprüfen/präzisieren: Test-Umgebung allein
  garantiere keinen Produktionszugriff; automatische Datenmaskierung;
  zuverlässige Erkennung jeder API-Änderung. Rechte, Konfiguration und tatsächlich
  ausgelieferten Funktionsumfang unterscheiden.
- [ ] Produktbild-Platzhalter durch freigegebene echte Aufnahmen mit isolierten
  Beispieldaten ersetzen. Keine privaten laufenden Installationen oder erfundenen
  Cockpit-Screenshots verwenden.
- [ ] Vorschlag, noch nicht umgesetzt/abgenommen: einen nachvollziehbaren
  Beispielworkflow zeigen — Aufgabe beschreiben → Konnektor erstellen → prüfen
  und freigeben → Lauf mit Protokoll. Bestehenden Hero erhalten.
- [ ] Vorschlag, noch nicht umgesetzt/abgenommen: Wiederholungen kürzen und kurze
  FAQ zu Kosten, Kenntnissen, Konnektoren, Berechtigungen und Fehlerbehandlung.
- [ ] Zentrales SubKit-Briefing/Schreibregeln an Nutzerkorrekturen angleichen.
  Eine Korrektur wurde als Lernvorschlag gesammelt, nicht als aktive Regel bestätigt.
  Wissens-/Skill-Übernahme nur über den vorgesehenen menschlichen Prüfprozess.

### 2. Einstiege vollständig funktionsfähig machen

- [ ] Formular-Versanddienst und serverseitigen Endpoint anschließen. Empfänger
  beider Formulare ist bereits bestätigt; nicht erneut erfragen.
- [ ] Tatsächliche Zustellung, Fehlerfälle und Schutz vor Massenanfragen prüfen.
  Keine Simulation als echten Zustellnachweis ausgeben. Reale Tests gesondert
  abstimmen, bisher wurden keine E-Mails versendet.
- [ ] Beta-Anfrage erklärt konkret, was nach Absenden passiert; keine erfundene
  Reaktionszeit, automatische Aufnahme oder Newsletter-Anmeldung.
- [ ] Öffentlich freigegebenes Self-Hosting-Paket mit exakter Version,
  Release-Compose, Prüfsumme und passenden Start-/Setup-Befehlen eintragen.
- [ ] Installation ohne privaten Zugang bis zum ersten erfolgreichen Workflow
  durchtesten. Neustart, Datenerhalt und Sicherung mit Release-Anleitung abstimmen.
- [ ] Dokumentation, Downloads, Release Notes, Quellcode und Supportziele wirklich
  öffentlich erreichbar machen/prüfen; keine Platzhalter oder erfundenen Links.

### 3. Veröffentlichung abschließen

- [ ] Tatsächliches Hosting, Versanddienst, Aufbewahrungsfristen und Datenflüsse
  klären; Datenschutzhinweise DE/EN vervollständigen und rechtlich prüfen lassen.
  Vorhandene Betreiberangaben allein sind keine vollständige Rechtsfreigabe.
- [ ] Ziel-Domain technisch anbinden, DNS/TLS prüfen; zuvor Freigabe beachten.
- [ ] Finale manuelle Inhalts-/Sichtabnahme und gezielter Browser-/Tastaturcheck.
- [ ] Nach Veröffentlichungsfreigabe Produktions-SEO aktivieren: robots,
  Indexierbarkeit, Sitemap, Canonical/hreflang und öffentliche Fehlerseiten prüfen.
- [ ] Echte Social-Linkvorschauen auf der öffentlichen Domain testen.
- [ ] GA-Kennung später ergänzen; kein Blocker für einen Start ohne Analytics.
  Enhanced Measurement/Google Signals/Werbefunktionen nach RELEASE.md deaktivieren;
  echte Messung und Einwilligung erst nach Freigabe mit dem realen Konto prüfen.
- [ ] Website-Publikation und Produkt-/Beta-Go getrennt behandeln. Öffentliche
  Pakete, Repository-Öffnung oder Engine-Deployment sind nicht durch Website-Arbeit
  automatisch autorisiert.

## Arbeitsstand der Übergabe

Die Session-Dokumentation wird auf ausdrücklichen Nutzerwunsch in main committed
und gepusht. Der zuerst gescheiterte Fast-forward-Abgleich ist aufgelöst: Der
patchgleiche lokale Release-Commit wurde beim Rebase auf origin/main übersprungen.
Neuere Remote-Produktnachweise sind erhalten; lokale Website-Nachweise wurden mit
separaten IDs ergänzt, statt neuere Launch-Ergebnisse zurückzusetzen.

Der Nutzer hat ausdrücklich angewiesen, die lokalen Push-Hooks für diesen
Dokumentationsabschluss zu überspringen. Kein Release-Tag, Engine-Deployment oder
Website-Publishing. Historische Sicherungs-Stashes bleiben als Sicherungen bestehen;
sie sind nicht automatisch erneut anzuwenden. Den tatsächlichen Push-/Arbeitsbaumstand
vor neuer Arbeit mit git status prüfen.


## Clipper-Store: bestätigter Session-Abschluss

- Der Nutzer hat SubKit Clipper im Chrome Web Store eingereicht. Die offizielle
  Status-API bestätigt `PENDING_REVIEW` für Version `9.15.2`. Das ist eine
  eingereichte, auf Google-Prüfung wartende Version, keine öffentliche Freigabe.
- Store-Beschreibung auf Englisch und Deutsch im gemeinsamen Feld gespeichert;
  Symbol, echter Screenshot und kleine Werbekachel hochgeladen. Zweck,
  Berechtigungsbegründungen, Angabe ohne Remote-Code und Datenarten gespeichert.
- Der Nutzer hat eine bestehende persönliche Datenschutzseite als Übergang
  freigegeben. Ihre deutsche Fassung ist erreichbar, die vorgeschlagene englische
  Fassung lieferte 404. Der geprüfte Inhalt beschreibt die Website, noch nicht
  die Clipper-Datenverarbeitung. Dies bleibt ein inhaltlicher Release-Punkt;
  ein erfolgreicher Einreichungsstatus bestätigt keine Datenschutzvollständigkeit.
- Lovable hat separate Seiten `/de/clipper-datenschutz`, `/en/clipper-privacy`
  und den automatischen Einstieg `/clipper-privacy` implementiert. Laut Lovable
  28 fokussierte Tests bestanden; keine Website-Analytics oder Formulare auf
  diesen Seiten. Inhalt und Hosting-Grenzen stehen im Lovable-Projekt in
  `CLIPPER-PRIVACY.md`, `RELEASE.md` und `VERIFICATION.md`.
- Diese Seiten sind noch unveröffentlicht. Lovable veröffentlicht projektweit,
  nicht einzelne Routen. Nicht deshalb die unfertige Marketing-Website starten.
  Nächster Schritt: Clipper-Hinweise separat öffentlich bereitstellen oder in
  die bestehende öffentliche Datenschutzseite aufnehmen, dann den Store-Link
  kontrollieren/aktualisieren. Anschließend Googles Prüfentscheidung abfragen.
- Konkrete Projekt-/Store-Adressen, IDs, Auftrags- und Commitstand sowie die
  operative Übergabe liegen außerhalb des Repositorys in
  `/Users/mikebild/Documents/SubKit-Lovable/WEBSITE-HANDOFF.md` und
  `/Users/mikebild/Documents/SubKit-Lovable/Chrome-Web-Store/status.txt`.
- Kein erneutes Einreichen, Zurückziehen, Website-Publishing, DNS-Wechsel oder
  Engine-Deployment aus diesem Status ableiten. Kein öffentlicher Store-Erfolg
  behaupten, bevor er tatsächlich bestätigt ist.

### Validierungsgrenze beim Git-Abschluss

Alle zu diesem Zeitpunkt vorhandenen Änderungen auf main wurden auf ausdrücklichen
Nutzerwunsch mit `--no-verify` committed und gepusht, einschließlich vorhandener
Hook-Hinweis- und HTTP-400-Korrekturen. `git diff --check` bestand. Der gezielte
Test `apps/engine/src/http/tests/request-media-type.test.ts` brach beim Aufbau
der Testdatenbank während der Migrationen mit einem PostgreSQL-Verbindungsfehler
ab (0 bestandene Tests); die HTTP-Assertions wurden nicht verifiziert.
Vollständige Hooks und Release-Gate wurden nicht ausgeführt. Vor einem Release
diese Prüflücke schließen. Der separate Tenant-Authority-Worktree enthält
weiterhin uncommittete Entwicklungsarbeit und wurde weder gemergt noch entfernt.
