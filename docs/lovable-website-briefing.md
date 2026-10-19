# SubKit: Produkt- und Website-Briefing für Lovable

## Geltung und Quellen

Maßgebliche Produktentscheidungen für die bestehende Website. Operative Aufgaben:
[WEBSITE-TODO](../WEBSITE-TODO.md); Projektzugang und Prüfgrenzen:
[Lovable-Setup](lovable-setup.md); Cloud-Zielbild:
[Produktroadmap](PRODUCT-ROADMAP.md). Dieses Briefing beauftragt keine erneute
Gestaltung oder Veröffentlichung. Das konkrete aktuelle Lovable-Projekt bleibt
Designreferenz; Tokens und TE-Kit dienen nicht als Ersatz.

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

## Ergänzung: Cloud-Self-Service

Die neue Zielrichtung ergänzt Self-Hosting um eine begrenzte kostenlose Cloud-Beta.
Noch keine offene Registrierung oder öffentliche Verfügbarkeit behaupten. Die
bestehenden Einstiege „Beta-Einladung anfragen“ und „Self-Hosting starten“ bleiben
bis zur geprüften Cloud-Öffnung sachlich richtig. Erst dann einen von Lovable
konkret ausgearbeiteten Registrierungsweg integrieren. Keine Preise, unbegrenzte
Nutzung, zugesicherte Region, Reaktionszeit oder Cloud-Starttermine erfinden.

Künftig benötigte Zustände als gezielte Ergänzung des bestehenden Entwurfs:

| Schritt | Benötigte Zustände und Information |
| --- | --- |
| Cloud-Einstieg | Beta-Umfang, Kosten-/Nutzungsgrenzen und Verfügbarkeit; getrennte Self-Hosting-Option |
| Registrierung | Versand ausstehend, E-Mail bestätigt, Link abgelaufen/ungültig, Wiederholung gedrosselt, bestehendes Konto |
| Bereitstellung | Mandant wird erstellt, wiederholbarer Fehler ohne Duplikat, bereit; keine Abfrage interner Kennungen |
| Erststart | Konnektor verbinden, Workflow im Gespräch vorbereiten, Wirkung prüfen und menschlich freigeben, ersten Lauf nachvollziehen |
| Verbrauch | Verfügbares Budget, ausgeschöpftes Budget, fehlgeschlagener Modellaufruf und nächste erlaubte Aktion; keine überraschende Abrechnung |
| Lebenszyklus | Sperrung, Wiederaufnahme soweit erlaubt, Datenexport, Löschantrag und nachvollziehbare Folgen |
| Kanalfortsetzung | CLI/MCP/Clipper/Chat anbinden; menschliche Inhaltsbestätigung im authentifizierten Cockpit öffnen |

Diese Tabelle spezifiziert Bedarf, keine vorhandenen Bildschirmdesigns. Vor jeder
UI-Umsetzung konkrete Komponenten, Interaktionen und responsive Zustände durch
Lovable ausarbeiten lassen und über die offizielle Integration prüfen. Bestehende
Cockpit-Ansichten und Formdialoge bis dahin verbindlich wiederverwenden.

## Clipper und Datenschutz

Vorhandene separate Clipper-Hinweise erhalten. Die bisherige Beschreibung einer
gewählten selbst gehosteten Instanz muss für die Cloud-Beta ergänzt werden:
Betreiberverantwortung, tatsächliche Empfänger, Provider, Speicherregion,
Aufbewahrung und Löschung anhand des realen Angebots erklären. Lokales Löschen
der Erweiterung löscht keine bereits gespeicherten Engine-Daten. Keine
Verschlüsselungszusage für chrome.storage.local hinzufügen.

Erweiterung, Website und Cloud-Dienst haben unterschiedliche Datenflüsse und
Verantwortlichkeiten. Website-Analytics bleibt auf den Clipper-Datenschutzseiten
deaktiviert. Die BrowserStack-Prüfung darf keine echten Kundendaten oder produktiven
Zugangsschlüssel in Anbieteraufzeichnungen bringen. Rechtliche Inhalte brauchen
menschliche Prüfung; technische Checks sind keine Rechtsfreigabe.

## Übergabe an Lovable

Vor Änderungen [Setup](lovable-setup.md) und aktuellen Projektstand lesen. Einen
gezielten Auftrag mit betroffenen bestehenden Ansichten, benötigten Zuständen und
Abnahmekriterien vorbereiten. Keine zweite Website, keine parallele Produktdatenbank
und keine unabhängige Workflow-/Freigabelogik anlegen. SubKit-Domänenoperationen
bleiben in der Engine und werden ausschließlich über öffentliche APIs genutzt.
Cloud-Texte DE/EN, Metadaten und Rechtsinformationen gemeinsam angleichen.
