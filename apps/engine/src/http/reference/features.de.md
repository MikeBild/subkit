---
slug: features
title: SubKit-Funktionen im Überblick
summary: Finde jede Funktion von SubKit in einer Liste, mit ihrer Verfügbarkeit und dem Kapitel, das sie erklärt.
section: reference
order: 8
audience: public
---
## SubKit-Funktionen im Überblick

Diese Seite listet jede Funktion von SubKit an einer Stelle, nach Bereichen geordnet, damit du auch selten genutzte schnell wiederfindest.
Jede Zeile sagt, was du bekommst, und verlinkt das Kapitel, das sie erklärt.

### Legende

| Kennzeichen | Bedeutung |
| --- | --- |
| **Überall** | In SubKit Cloud und auf deiner eigenen Engine verfügbar. |
| **Selbst betrieben** | Nur, wenn du die Engine selbst betreibst. |
| **Cloud** | Nur in SubKit Cloud. |
| **Admin** | Nur Personen mit der Rolle Admin oder der Engine-Betreiber nutzen oder ändern es. |
| **Optional** | Standardmäßig aus. Du oder ein Admin schaltet es ein. |

### Workflows und Runs

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Workflow aus einem Satz | Du beschreibst die Aufgabe im Chat, die KI entwirft einen Workflow, du prüfst und speicherst ihn. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Feste Schritte | Ein Workflow läuft mit Request-, Transform-, Call-, Wait-, Wait-for-Event-, Branch-, Parallel- und Loop-Schritten jedes Mal gleich. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Versionen | Jede Änderung ist eine neue Version; die freigegebene Version läuft weiter, bis eine neue freigegeben ist. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Test und Produktion | Jeder Run und jede Freigabe gehört zu einer Umgebung, das Cockpit zeigt dir, in welcher du bist. | Überall | [Im Cockpit zurechtfinden](setup.md#im-cockpit-zurechtfinden) |
| Probe-Run | Ohne Freigabe ist ein Run ein Probe-Run: Schreibende Schritte werden zurückgehalten, nichts wird gesendet. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |
| Run-Ergebnis | Jeder Run zeigt Zustand, Schritte, Version und warum er erlaubt war, mit Link zum Audit-Trail. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Markdown-Ergebnis | Ein Run kann ein schriftliches Ergebnis in Markdown übergeben, das das Cockpit anzeigt. | Überall | [Referenz: Dateien vom Desktop, Run-Ergebnisse und Anmeldesignale](setup.md#referenz-dateien-vom-desktop-run-ergebnisse-und-anmeldesignale) |
| Im Chat reparieren | Scheitert ein Schritt oder blockiert er eine Freigabe, schlägt SubKit im Chat eine Korrektur vor, die du erneut prüfst. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Automatisierungs-Check | Beim Speichern eines Workflows oder Zeitplans erfährst du, ob er allein laufen kann oder welcher Schritt eine Änderung braucht. | Überall | [Die HTTP-API nutzen](setup.md#die-http-api-nutzen) |
| Sandbox-Datenwerkzeuge | Transform-Schritte rechnen, parsen und prüfen Daten mit eingebauten Helfern in einer abgeschotteten Sandbox. | Überall | [Sandbox-Datenwerkzeuge](setup.md#sandbox-datenwerkzeuge) |
| Pakete | Exportiere Workflows, Connectors, Skills, Zeitpläne, Quellen und Dateien und importiere sie in eine andere Engine. | Überall | [Die subkit-CLI auf deinem Rechner verwenden](setup.md#die-subkit-cli-auf-deinem-rechner-verwenden) |

### Freigaben und Rechte

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Freigeben, worauf er zugreifen darf | Eine Person gibt Umgebung, Gültigkeit sowie Lese- und Schreibzugriffe und Dienste vor dem ersten echten Run frei. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Freigabe bis auf Widerruf | Eine Freigabe gilt bis auf Widerruf oder endet an einem Datum oder nach einer Zahl von Runs. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Freigabe folgt neuer Version | Eine neue Version braucht keine neue Freigabe, solange sie nicht weiter reicht; sonst nennt SubKit den Unterschied. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |
| Vor dem Ende verlängern | SubKit meldet eine Freigabe drei Tage vor ihrem Ende, und du verlängerst sie. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Freigabe zu zweit („gemeinsam freigeben“) | Jede Workflow-Freigabe braucht zwei verschiedene Personen, für Teams, in denen niemand sensible Workflows allein freigeben darf. Standardmäßig aus; die Einstellung erscheint erst, wenn mindestens zwei Personen im Arbeitsbereich freigeben dürfen, und nur Admins ändern sie. | Admin · Optional | [Referenz: Freigabe zu zweit, Einladungen, Offline-Berichte und Benachrichtigungspause](setup.md#referenz-freigabe-zu-zweit-einladungen-offline-berichte-und-benachrichtigungspause) |
| Einmal erlauben | Ein schreibendes Tool aus einem KI-Client wartet, bis eine Person **Einmal erlauben** oder **Ablehnen** wählt. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |
| Rollen, Gruppen und Berechtigungen | Rollen, Berechtigungen und eingeschränkte API-Keys gelten gleich für Cockpit, `subkit`, API und MCP. | Admin | [Ausführungsidentität und Berechtigung](setup.md#ausführungsidentität-und-berechtigung) |
| Wer einen Run gestartet hat | Jeder Run nennt seinen Aufrufer, und du verfolgst ihn über alle Kanäle. | Überall | [Ausführungsidentität und Berechtigung](setup.md#ausführungsidentität-und-berechtigung) |

### Aufgaben

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Ziel als Aufgabe | Du übergibst ein Ziel mit Grenzen; SubKit plant den Weg, arbeitet ihn ab und fragt, wenn es dich braucht. | Überall | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |
| Dauererlaubnis | Eine Aufgabe startet nur mit einer Dauererlaubnis von selbst; sie endet, wenn sich die Aufgabe ändert. | Überall | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |
| Verfolgen und eingreifen | Du verfolgst einen Run, beantwortest seine Fragen und bestätigst oder verwirfst sein schriftliches Ergebnis. | Überall | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |
| Aus der Aufgabe ein Workflow | Mach aus einem bewährten Aufgabenlauf einen Workflow. | Überall | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |
| Admins greifen ein | Admins verwalten jede Aufgabe und geben zurückgehaltene Schreibzugriffe eines Runs frei oder lehnen sie ab. | Admin | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |

### Zeitpläne, Webhooks und Ereignisse

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Zeitpläne | Ein Workflow oder eine Aufgabe läuft zu festen Zeiten. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Fehlergründe | Ein gescheiterter oder wartender geplanter Run sagt, warum, und was zu tun ist. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Pause nach wiederholten Fehlern | Ein Zeitplan, der fünfmal hintereinander aus demselben Grund scheitert, pausiert und sagt es einmal. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Zeitplan-Verlauf | Du siehst, was aus jedem geplanten Zeitpunkt geworden ist. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Run stoppen | Du stoppst einen Run, der noch läuft. | Überall | [Zeitpläne im Blick behalten](setup.md#zeitpläne-im-blick-behalten) |
| Eingehende Webhooks | Ein Webhook aus einem anderen System startet einen Workflow. | Überall | [Ausführungsidentität und Berechtigung](setup.md#ausführungsidentität-und-berechtigung) |
| Abonnements | Programme erhalten Ereignisse von SubKit über Abonnements und Webhooks. | Überall | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |

### Chat und KI-Assistent

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Chat im Cockpit | Du entwirfst Workflows, stellst Fragen und startest freigegebene Workflows im Gespräch. | Überall | [Dein erster Workflow](setup.md#dein-erster-workflow) |
| Wann SubKit fragt | Dein Auftrag entscheidet, was ohne Frage läuft; **Immer vorher fragen** lässt jeden schreibenden Schritt fragen. | Überall | [Wann SubKit fragt](setup.md#wann-subkit-fragt) |
| Immer vorher fragen | Eine Regel nur für dich: Jeder Schritt, der schreibt, fragt dich vorher, im Chat, in Aufgaben und auf deinem Mac. | Überall | [Wann SubKit fragt](setup.md#wann-subkit-fragt) |
| Regeln | Nach dem zweiten **Einmal erlauben** für dieselbe Aktion speicherst du sie für 90 Tage als Regel. | Überall | [Wann SubKit fragt](setup.md#wann-subkit-fragt) |
| Dateien im Chat | Du hängst Dateien an eine Nachricht, auch aus SubKit Desktop. | Überall | [Referenz: Dateien vom Desktop, Run-Ergebnisse und Anmeldesignale](setup.md#referenz-dateien-vom-desktop-run-ergebnisse-und-anmeldesignale) |
| Slack und Google Chat | Du stellst Fragen und startest freigegebene Workflows dort, wo dein Team arbeitet; in SubKit Cloud erst, wenn die Inhaberschaft des Chat-Workspace geprüft ist. | Überall | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |
| Dein eigenes Modell | Anthropic, OpenAI, Google Gemini, Azure, Amazon Bedrock oder Vertex AI mit deinem eigenen Key, dazu ein Fallback-Provider. | Überall | [Einstellungen](settings.md) |
| Websuche | Mit einem Anthropic-Modell nutzt der Assistent die eingebaute Websuche des Modells, pro Suche über deinen Key abgerechnet; an, bis sie jemand ausschaltet. | Überall | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |

### Wissen, Eingang und Skills

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Eingang | Notizen, Funde aus dem Chat und aus Coding-Agents, Dateien und gesammelte Webseiten landen in einer Liste. | Überall | [Ideen sammeln und in Wissen oder Skills verwandeln](setup.md#ideen-sammeln-und-in-wissen-oder-skills-verwandeln) |
| Prüfen und bestätigen | Du entscheidest, ob ein Eintrag eine Wissensquelle oder ein Skill wird; nichts wird von selbst übernommen. | Überall | [Ideen sammeln und in Wissen oder Skills verwandeln](setup.md#ideen-sammeln-und-in-wissen-oder-skills-verwandeln) |
| Wissensquellen | Notizen, Runbooks und Regeln deines Teams, durchsuchbar innerhalb der Engine. | Überall | [Quellen, Skills und Dateien pflegen](setup.md#quellen-skills-und-dateien-pflegen) |
| Skills | Wiederverwendbare Anleitungen für Chat und Workflow-Entwurf; Vorschläge warten auf deine Entscheidung. | Überall | [Quellen, Skills und Dateien pflegen](setup.md#quellen-skills-und-dateien-pflegen) |
| Versionen und Wiederherstellen | Vergleiche Versionen einer Quelle oder eines Skills und stell eine frühere wieder her. | Überall | [Quellen, Skills und Dateien pflegen](setup.md#quellen-skills-und-dateien-pflegen) |
| Dateien | Lade Dateien hoch, ersetze sie und stell frühere Versionen wieder her. | Überall | [Quellen, Skills und Dateien pflegen](setup.md#quellen-skills-und-dateien-pflegen) |
| Web Clipper | Speichere Seiten, Markierungen und YouTube-Transkripte aus Chrome in deinem Eingang. | Überall | [Webseiten mit dem Web Clipper sammeln](setup.md#webseiten-mit-dem-web-clipper-sammeln) |
| Briefings für Coding-Agents | Claude Code, Codex und Hermes bekommen das Wissen deines Teams als Briefing und sammeln Funde. | Überall | [SubKit aus einem Coding-Agenten verwenden](coding-agents.md#subkit-aus-einem-coding-agenten-verwenden) |

### Connectors und Integrationen

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Connector-Katalog | 61 Connector-Vorlagen und 248 fertige Rezepte, von GitHub bis Stripe. | Überall | [Connector- und Rezeptkatalog](connectors.md) |
| MCP-Server als Connector | Workflows und Chat rufen die Tools eines MCP-Servers auf, den dein Team schon nutzt. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |
| Externe MCP-Server per OAuth | Binde externe MCP-Server per OAuth an, ohne dass Secrets umgeleitet werden. | Überall | [OAuth-Zugangsdaten für externe MCP-Server](setup.md#oauth-zugangsdaten-für-externe-mcp-server) |
| Signierte JWT-Zugangsdaten | Binde APIs wie App Store Connect an, die ein signiertes JWT direkt annehmen. | Überall | [Direkte signierte JWT-Connector-Zugangsdaten](setup.md#direkte-signierte-jwt-connector-zugangsdaten) |
| Antworten per E-Mail | Bestätige eine signierte Formularanfrage mit genau einer E-Mail an die Absenderin oder den Absender. | Überall | [Per E-Mail auf eine signierte Anfrage antworten](transactional-email.md#per-e-mail-auf-eine-signierte-anfrage-antworten) |
| Deine eigene App | Eine App mit eigener Anmeldung startet Workflows für ihre Nutzerinnen und Nutzer. | Admin | [Eine App anbinden](setup.md#eine-app-anbinden) |
| Produkt-Anmeldung und Budgets | App-Nutzende rufen SubKit mit dem Token der App auf, begrenzt durch ein Tageskontingent pro Aufrufer. | Admin | [Produkt-Bearer-Tokens und Aufruferbudgets](setup.md#produkt-bearer-tokens-und-aufruferbudgets) |
| Identitätsbindung | Verknüpfe die Nutzenden einer App mit einem SubKit-Konto mit minimalen Rechten. | Admin | [Produkt-Identitätsbindung](setup.md#produkt-identitätsbindung) |
| Supabase-Daten | Nutze die Daten deines Supabase-Projekts in Produkt-Workflows, ohne Keys offenzulegen. | Admin | [Produkt-Workflows mit Supabase](setup.md#produkt-workflows-mit-supabase) |
| Adressen im privaten Netz | Connectors erreichen Dienste wie `localhost` oder interne Firmenserver. | Selbst betrieben | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |

### Cockpit und installierte App

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Übersicht und „Braucht dich“ | Du siehst, was lief, was scheiterte und was auf deine Entscheidung wartet. | Überall | [Was ist SubKit?](setup.md#was-ist-subkit) |
| Zurechtfinden | Navigation, Seitenleiste, Fehlerhinweise mit Abhilfe und eine Markdown-Ansicht. | Überall | [Im Cockpit zurechtfinden](setup.md#im-cockpit-zurechtfinden) |
| Einrichtung in fünf Fragen | Deine Antworten setzen Standardumgebung, freigebende Person und Benachrichtigungen. | Überall | [SubKit auf dich einstellen](setup.md#subkit-auf-dich-einstellen) |
| Deutsch und Englisch | Das Cockpit und diese Dokumentation gibt es in beiden Sprachen. | Überall | [Was ist SubKit?](setup.md#was-ist-subkit) |
| Branding | Gib dem Cockpit Namen, Logo und Farben deiner Firma. | Admin | [Cockpit-Branding](setup.md#cockpit-branding) |
| Cockpit als App | Installiere das Cockpit eines Arbeitsbereichs als eigene App auf Computer und Smartphone, mit Push und Teilen aus anderen Apps. | Überall | [Cockpit als App](setup.md#cockpit-als-app) |

### SubKit Desktop

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| SubKit Desktop | Das Cockpit deines Servers als App für Macs mit Apple Silicon (ab macOS 13) und für Windows 10 und 11 (x64), mit Symbol in der Menüleiste oder im Infobereich, Benachrichtigungen und Start bei der Anmeldung. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Willkommen und Einladungslink | Der erste Start erklärt, was SubKit tut, und öffnet den Einladungslink aus deiner E-Mail, sodass du in wenigen Schritten einem Arbeitsbereich beitrittst. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Anmeldung über den Browser | Die App meldet sich über deinen Browser an; jeder Computer ist ein eigenes Gerät, das du widerrufen kannst. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Mehrere Server | SubKit Desktop merkt sich ein Profil pro Server. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Menüleiste | Die Zahl der Einträge, die dich brauchen, Ruhezeiten, Pause, Schnellnotiz, Live-Ansicht, Updates und „Fehler melden“ in einem Menü. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Schnellnotiz | ⌥ Leertaste öffnet von überall eine Notiz; sie landet in deinem Eingang. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Ablage „Wohin damit?“ | Zieh Dateien auf das Fenster, das Dock-Symbol oder das Symbol in der Menüleiste und wähle: als Datei ablegen, als Quelle einlesen, im Chat anhängen oder in den Eingang. | Überall | [Referenz: Dateien vom Desktop, Run-Ergebnisse und Anmeldesignale](setup.md#referenz-dateien-vom-desktop-run-ergebnisse-und-anmeldesignale) |
| Pause | Halte Benachrichtigungen eine Stunde lang oder bis zum Fortsetzen zurück, direkt aus der Menüleiste. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Fehler melden | Schick einen Fehlerbericht oder eine Idee in den Eingang deines Arbeitsbereichs, mit Screenshot und auf Wunsch mit Diagnosedaten. Ein offline geschriebener Bericht wartet in einer Warteschlange und geht raus, sobald du wieder online bist. | Überall | [Einen Fehler melden](setup.md#einen-fehler-melden) |
| Desktop-Versionen und Geräte | Leg fest, welche App-Version dein Server annimmt, und widerrufe Geräte. | Admin · Selbst betrieben | [Desktop-Anmeldung betreiben](setup.md#desktop-anmeldung-betreiben) |

### SubKit auf deinem Mac

Diese Funktionen brauchen SubKit Desktop auf einem Mac mit Apple Silicon; unter Windows gibt es sie vorerst nicht. Auf deinem Mac läuft nichts, bevor du es unter **Lokale Fähigkeiten** einschaltest.

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Lokale Dateien | Chat, Aufgaben und Workflows lesen und schreiben Dateien in Ordnern, die du erlaubt hast, pro Ordner mit Lese- oder Lese- und Schreibzugriff. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Browser | SubKit arbeitet in Websites, die du erlaubt hast, in einem eigenen Browser auf deinem Mac. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Computer-Use | SubKit bedient Knöpfe und Felder in Apps, die du erlaubt hast. Passwort-Manager, Banking, Terminal, Systemeinstellungen und andere heikle Apps bleiben gesperrt. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Lokale Erlaubnisse | Ordner, Websites und Apps, die du erlaubst, dazu eine Liste dessen, was tabu bleibt, gespeichert auf dem Mac selbst. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Live-Ansicht | Sieh, was SubKit auf deinem Mac tut, mit dem letzten geschwärzten Bildschirmfoto und jedem Schritt; stopp es jederzeit mit ⌘⇧⎋. | Überall | [SubKit Desktop](setup.md#subkit-desktop) |
| Bestätigungen auf dem Mac | Ein Schritt, der schreibt und den deine Bitte nicht abdeckt, fragt mit **Einmal erlauben** oder **Ablehnen**; eine Anmeldung übergibt SubKit an dich, und du gibst sie zurück. | Überall | [Wann SubKit fragt](setup.md#wann-subkit-fragt) |
| Lokale Workflow-Schritte | Workflows mit festen Schritten für Dateien, Browser und Apps; die Freigabe nennt Gerät, Ordner, Websites und Apps. | Überall | [Referenz: Workflow-Schritte auf deinem Gerät](setup.md#referenz-workflow-schritte-auf-deinem-gerät) |
| Vollständig lokaler Arbeitsbereich | Betreib einen Arbeitsbereich nur auf deinem Mac, mit eigener Datenbank, Sicherungen und deinem eigenen KI-Key oder einem lokalen Modell-Server; zieh ihn später auf einen Server um. | Selbst betrieben | [SubKit Desktop](setup.md#subkit-desktop) |

### subkit-CLI, HTTP-API und MCP

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| subkit-CLI | Du entwirfst, änderst und startest Workflows als Dateien im Terminal, auch mit mehreren Engines. | Überall | [Die subkit-CLI auf deinem Rechner verwenden](setup.md#die-subkit-cli-auf-deinem-rechner-verwenden) |
| Befehlsreferenz | Jeder `subkit`-Befehl mit seinen Argumenten. | Überall | [subkit-CLI-Referenz](cli.md) |
| HTTP-API | Du startest Workflows aus deinem eigenen Code und liest ihre Ergebnisse; beschrieben in OpenAPI unter `/openapi.json`. | Überall | [Die HTTP-API nutzen](setup.md#die-http-api-nutzen) |
| MCP-Server | Jeder freigegebene Workflow ist ein Tool in Claude Code, Codex und anderen MCP-Clients, mit Anmeldung im Browser oder API-Key. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |
| Aufgaben aus einem KI-Client | Du legst Aufgaben aus einem MCP-Client an und verfolgst sie. | Überall | [KI-Clients per MCP anbinden](setup.md#ki-clients-per-mcp-anbinden) |

### Benachrichtigungen

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Push-Benachrichtigungen | Eine Benachrichtigung pro Eintrag, der dich braucht, im Browser, in der installierten App oder in SubKit Desktop. | Überall | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |
| Ruhezeiten | Leg fest, wann SubKit dich benachrichtigen darf. | Überall | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |
| Benachrichtigungen pausieren | Halte Benachrichtigungen eine Zeit lang zurück oder bis du sie fortsetzt. | Überall | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |
| Dringendes trotz Ruhezeit | Kritische Einträge kommen auch in Ruhezeiten und Pausen durch. | Optional | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |
| Freigaben weiterleiten | Schick Benachrichtigungen zu Freigaben an eine andere Person im Team. | Überall | [Benachrichtigungen und Ruhezeiten](setup.md#benachrichtigungen-und-ruhezeiten) |
| Einladungen | Ein Admin erzeugt einen Einladungslink und gibt ihn weiter. | Admin | [Referenz: Freigabe zu zweit, Einladungen, Offline-Berichte und Benachrichtigungspause](setup.md#referenz-freigabe-zu-zweit-einladungen-offline-berichte-und-benachrichtigungspause) |

### Nutzung und Kosten

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Nutzung | KI-Kosten pro Run, Workflow, Person und Modell in einem Zeitraum deiner Wahl. | Überall | [Nutzung und Kosten im Blick](setup.md#nutzung-und-kosten-im-blick) |
| Monatliches KI-Budget | Eine Grenze für KI-Kosten in US-Dollar, 50 $ für einen neuen Arbeitsbereich. Bei 100 % pausieren Chat, Aufgaben und Modellschritte; Workflows ohne Modellschritt laufen weiter. | Admin | [Nutzung und Kosten im Blick](setup.md#nutzung-und-kosten-im-blick) |
| Preise | Eingebaute Modellpreise, pro Modell überschreibbar. | Admin | [Nutzung und Kosten im Blick](setup.md#nutzung-und-kosten-im-blick) |
| Export | Exportiere die Nutzungszahlen. | Überall | [Nutzung und Kosten im Blick](setup.md#nutzung-und-kosten-im-blick) |
| Kosten von Aufgaben | Sieh, was die Runs jeder Aufgabe kosten. | Überall | [Ein Ziel als Aufgabe übergeben](setup.md#ein-ziel-als-aufgabe-übergeben) |

### SubKit Cloud und Selbstbetrieb

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| SubKit Cloud | SubKit läuft für dich, du meldest dich im Browser an. Preview mit offener Registrierung. | Cloud | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |
| Eigener KI-Key pro Arbeitsbereich | Jeder Cloud-Arbeitsbereich bringt eigenen Provider und Key mit; der KI-Zugang des Betreibers wird nie genutzt. | Cloud | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |
| Mehrere Arbeitsbereiche | Du wechselst Konten und Arbeitsbereiche und löschst einen Arbeitsbereich. | Cloud | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |
| Grenzen des Arbeitsbereichs | Grenzen für Anfragen, Speicher und Ressourcen, vom Betreiber gesetzt, mit klaren Meldungen. | Cloud | [SubKit Cloud nutzen](setup.md#subkit-cloud-nutzen) |
| Eigene Engine | Betreib SubKit mit Docker Compose auf deinem eigenen Server. | Selbst betrieben | [Die Engine betreiben](setup.md#die-engine-betreiben) |
| Erstes Setup | Leg nach dem ersten Start Admin-Konto, Arbeitsbereich und KI-Provider an. | Selbst betrieben | [Erstes Setup](setup.md#erstes-setup) |
| Backup und Wiederherstellung | Sichere die ganze Installation und stell sie mit demselben Image wieder her. | Selbst betrieben | [Die Engine betreiben](setup.md#die-engine-betreiben) |
| Browser-Crawling | Durchsuche Seiten für die Connector-Erkennung mit einem abgeleiteten Image. | Selbst betrieben · Optional | [Die Engine betreiben](setup.md#die-engine-betreiben) |
| Engine-Betreiber | Ein Arbeitsbereich verwaltet die ganze Engine. | Admin · Selbst betrieben | [Engine-Betreiber](setup.md#engine-betreiber) |
| Laufzeiteinstellungen | Jede Einstellung der Engine mit Beschreibung und Standardwert, änderbar mit `subkit settings`, über die API oder in der Konfigurationsdatei. | Admin | [Einstellungen](settings.md) |

### Sicherheit und Audit

| Funktion | Was du bekommst | Gilt | Mehr |
| --- | --- | --- | --- |
| Audit-Trail | Jeder Run, jede Freigabe und jede Änderung wird mit der handelnden Person aufgezeichnet, jedes Objekt zeigt seinen eigenen Verlauf. | Überall | [Im Cockpit zurechtfinden](setup.md#im-cockpit-zurechtfinden) |
| Tresor | API-Keys, Logins und Connector-Zugänge an einem Ort, verschlüsselt, für den Workspace oder nur für dich. Workflows nennen sie per Handle, die KI sieht nie einen Wert, und jede Nutzung, jedes Aufdecken und jede Rotation steht im Audit-Trail. | Überall | [Referenz: der Tresor](setup.md#referenz-der-tresor) |
| Anmeldesitzungen | Installierte Apps halten eine Sitzung und melden sich sauber ab. | Überall | [Sitzungen installierter Cockpits](setup.md#sitzungen-installierter-cockpits) |
| Schwärzung | Secrets werden aus gesammelten Seiten und Fehlerberichten entfernt, bevor sie gespeichert werden. | Überall | [Einen Fehler melden](setup.md#einen-fehler-melden) |
| Lizenz | Open Source unter der Apache License 2.0. | Überall | [Lizenz](setup.md#lizenz) |
