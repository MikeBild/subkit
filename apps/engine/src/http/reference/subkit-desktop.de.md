---
slug: subkit-desktop
title: SubKit Desktop
summary: Installier SubKit Desktop auf deinem Mac, melde dich an und lass SubKit mit deinen Dateien, einem Browser und deinen Apps arbeiten, während du in der Live-Ansicht zusiehst.
section: work
order: 18
audience: public
---
## SubKit Desktop

Dieses Kapitel ist für alle, die SubKit auf ihrem Mac haben wollen: um es den ganzen Tag im Blick zu behalten und um es mit Dateien, Websites und Apps auf diesem Mac arbeiten zu lassen.
Danach hast du SubKit Desktop installiert, dich angemeldet und erlaubt, was SubKit auf deinem Mac nutzen darf. Du weißt, wie du es in der Live-Ansicht verfolgst und stoppst.
Außerdem kannst du einen Arbeitsbereich nur auf deinem Mac betreiben und ihn später auf einen Server umziehen.

### Was SubKit Desktop ist

SubKit Desktop ist das Cockpit deines Servers als Mac-App, dazu kommen drei Dinge, die ein Browser-Tab nicht kann:

- **Es bleibt bei dir.** Ein Symbol in der Menüleiste zeigt, was dich braucht, Benachrichtigungen kommen auch bei geschlossenem Fenster, und die App startet beim Anmelden.
- **Es arbeitet auf deinem Mac, wenn du es erlaubst.** Chat, Aufgaben und Workflows können Dateien in erlaubten Ordnern lesen und schreiben, in erlaubten Websites arbeiten und erlaubte Apps bedienen. Nichts davon ist an, bevor du es einschaltest.
- **Es kann einen eigenen Arbeitsbereich betreiben.** Mit **Nur auf diesem Mac** laufen Datenbank und Engine auf deinem Mac, ohne Server.

| SubKit Desktop | SubKit Desktop nicht |
| --- | --- |
| Zeigt das Cockpit deines Servers, mit denselben Rechten wie im Browser. | Berührt keinen Ordner, keine Website und keine App, die du nicht erlaubt hast. |
| Meldet, was dich braucht, auch wenn das Fenster geschlossen ist. | Speichert dein Passwort nicht. Die Anmeldung ist eine Sitzung wie im Browser. |
| Fragt, bevor ein Schritt auf deinem Mac schreibt, außer deine Bitte deckt ihn ab. | Folgt keinen Anweisungen, die in einer Webseite oder Datei stehen. |
| Zeigt jeden Schritt auf deinem Mac in der Live-Ansicht, mit einem Stopp-Knopf. | Arbeitet weiter, nachdem du es gestoppt hast. Spätere Schritte laufen nicht. |

Den Unterschied zur installierten Web-App zeigt die Tabelle in „Cockpit als App“.

### Was du brauchst

- Einen Mac mit Apple Silicon ab macOS 13. Macs mit Intel-Prozessor und Linux werden nicht unterstützt. Die App für Windows folgt.
- Für einen Server: einen SubKit-Server ab Version @@DESKTOP_MIN_SERVER_VERSION@@. Seine Adresse muss über `https://` erreichbar sein; nur `localhost` darf `http://` nutzen.
- Ein Konto, mit dem du dich im Browser am Cockpit anmelden kannst, einen Einladungslink aus deiner Einladungs-Mail oder ein neues Konto für einen eigenen Arbeitsbereich.
- Für einen Arbeitsbereich nur auf deinem Mac: keinen Server, aber einen API-Schlüssel von Anthropic, OpenAI oder Google Gemini oder einen Modell-Server auf deinem Mac.

### Installieren

SubKit Desktop ist eine signierte DMG-Datei für Macs mit Apple Silicon.

1. Lade [SubKit für Mac](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-mac-arm64.dmg) herunter.
2. Öffne die DMG-Datei.
3. Zieh **SubKit** in **Programme**.
4. Starte SubKit aus **Programme**. Beim ersten Start fragt macOS, ob du eine App aus dem Internet öffnen willst. Wähle **Öffnen**.
5. Wähle **Loslegen** und verbinde dich mit SubKit Cloud unter `https://subkit-cloud.mikebild.dev` oder mit deinem eigenen Server, wie unter „Mit einem Server verbinden“ beschrieben.
6. Melde dich im Browser an. Erlaube danach die Ordner und Apps, die SubKit nutzen darf, wie unter „SubKit auf deinem Mac arbeiten lassen“ beschrieben.

Die App aktualisiert sich selbst. Du lädst sie also nur einmal herunter.

Die App für Windows folgt.

### Willkommen und Einladungslink

Beim ersten Start siehst du „Willkommen bei SubKit Desktop“. Dort stehen vier Dinge: sehen, was deine Freigabe braucht, chatten und Workflows entwerfen, Aufgaben Schritt für Schritt erledigen lassen und „Du behältst die Kontrolle“.

- **Loslegen** führt zu „Server verbinden“.
- **Neuen Arbeitsbereich anlegen** führt ebenfalls zu „Server verbinden“. Bei der Anmeldung im Browser fragt SubKit dann nach deinem Namen, dem Namen des Arbeitsbereichs, der Zeitzone und dem Schlüssel deines KI-Anbieters. Danach meldest du das Gerät wie gewohnt an. Das geht mit einem Konto, das noch zu keinem Arbeitsbereich gehört, und nur, wenn der Server neue Arbeitsbereiche erlaubt. Sonst sagt der Browser es dir.
- **Einladungslink verwenden** ist für eine Einladungs-Mail. Füg den ganzen Link unter **Einladungslink** ein und wähle **Einladung öffnen**. Du liest zum Beispiel „Anna hat dich in den Arbeitsbereich ‚Brennwerk‘ eingeladen.“ mit Adresse und Gültigkeit. **Beitreten und anmelden** öffnet die Einladung in deinem Browser, und die App wartet auf die Bestätigung. Tritt im Browser bei. Gleich danach zeigt der Browser „Bei SubKit Desktop anmelden“ (siehe „Im Browser anmelden“, ab Schritt 3). Nach **Anmelden** bist du in der App angemeldet, ohne einen zweiten Schritt in der App.

Ist eine Einladung abgelaufen, zurückgezogen oder schon verwendet, sagt die App das. Bitte die Person, die dich eingeladen hat, um eine neue.

### Mit einem Server verbinden

1. Lass in „Server verbinden“ **Mit einem Server verbinden** gewählt. **Nur auf diesem Mac** startet stattdessen einen lokalen Arbeitsbereich (siehe „Ein Arbeitsbereich nur auf diesem Mac“).
2. Gib unter **Serveradresse** die Adresse deines Servers ein und wähle **Verbindung prüfen**. Unter **Beispiele** stehen die Server, die die App schon kennt, und `localhost:3000`.
3. Lies das Ergebnis. Bei „Verbunden“ passt alles, und **Weiter** führt zur Anmeldung.

Die App prüft, ob unter der Adresse ein SubKit-Server antwortet und ob die Versionen zusammenpassen. Ist der Server zu alt, kopiert **Administrator fragen** eine Nachricht für die Person, die ihn betreibt.

### Im Browser anmelden

Die Anmeldung läuft in deinem Browser, nicht in der App. So nutzt du die Anmeldung, die du schon kennst, und die App sieht dein Passwort nie.

1. Wähle im Schritt „Anmelden im Browser“ **Browser öffnen**. Dein Browser öffnet sich, und die App zeigt „Warte auf Bestätigung im Browser …“.
2. Melde dich im Browser am Cockpit an, falls du es dort noch nicht bist.
3. Lies die Seite „Bei SubKit Desktop anmelden“. Sie nennt den Namen deines Macs, den Arbeitsbereich und das Konto, zum Beispiel „SubKit Desktop auf MacBook-Anna möchte sich bei Brennwerk anmelden.“ und „Angemeldet als anna@example.com“.
4. Wähle **Anmelden**. Fahre nur fort, wenn du diese Anmeldung gerade selbst in der App auf diesem Gerät gestartet hast.
5. Der Browser gibt an die App zurück. Du liest „Gerät registriert“ mit Gerätename, Server und Status. **SubKit öffnen** öffnet das Cockpit.

Mit **Abbrechen** auf der Seite im Browser oder **Abbrechen** in der App passiert nichts: Es entsteht kein Profil und kein Gerät.
Die Seite im Browser gilt 10 Minuten. Danach startest du die Anmeldung in der App neu.

### Der erste Start nach der Anmeldung

Die App stellt einmal bis zu drei Fragen:

1. **Arbeitsbereich.** Hast du Zugriff auf mehrere Arbeitsbereiche, wähle einen. Du kannst später jederzeit wechseln.
2. **Benachrichtigungen erlauben.** **Erlauben** lässt macOS die Benachrichtigungen von SubKit zeigen. Eine Testbenachrichtigung bestätigt es: „Benachrichtigungen sind an“.
3. **Diagnosedaten.** „Sollen deine Fehlerberichte Diagnosedaten enthalten?“ **Diagnosedaten anhängen** fügt jedem Fehlerbericht, den du sendest, einen bereinigten Diagnosebericht bei. Ohne diese Wahl bleiben Diagnosedaten aus.

**Jetzt nicht** überspringt eine Frage. Alle drei änderst du später unter **Einstellungen** im Cockpit.

### Menüleiste, Benachrichtigungen und Ruhezeiten

Schließt du das Fenster, läuft SubKit Desktop weiter. Das Symbol in der Menüleiste zeigt die Zahl der offenen Punkte.

| Eintrag im Menü des Symbols | Was er tut |
| --- | --- |
| **SubKit öffnen** | Holt das Fenster nach vorn. |
| **Braucht dich (3)** | Öffnet die Liste der offenen Punkte. Ist nichts offen, steht dort „Nichts braucht dich gerade“. |
| **Live-Ansicht öffnen** | Zeigt, was SubKit gerade auf deinem Mac tut. Erscheint, solange SubKit auf deinem Mac arbeitet. |
| **Benachrichtigungen 1 Stunde pausieren** | Hält Benachrichtigungen eine Stunde zurück. Darunter steht, bis wann, zum Beispiel „Pausiert bis 15:05 Uhr“. **Benachrichtigungen fortsetzen** beendet die Pause. |
| **Beim Anmelden starten** | Startet SubKit Desktop mit deinem Mac, ohne ein Fenster zu öffnen. |
| **Nach Updates suchen** | Sucht nach einer neuen Version der App. |
| **Schnellnotiz …** | Öffnet eine Notiz für deinen Eingang (⌥ Leertaste). |
| **Einstellungen …** | Öffnet die Einstellungen der App. |
| **Fehler melden …** | Öffnet den Dialog aus „Einen Fehler melden“. |
| **SubKit beenden** | Beendet die App. Danach kommen keine Benachrichtigungen mehr. |

Eine Benachrichtigung sagt, was passiert ist und was zu tun ist, zum Beispiel „‚Tagesbericht‘ wartet auf deine Entscheidung“ und „Prüf die Änderung und entscheide.“ Ein Klick öffnet genau diesen Punkt im Fenster.

- Ein neuer Punkt wird innerhalb etwa einer Sekunde gemeldet, spätestens nach einer Minute.
- Kommen mehrere Punkte zugleich, zeigt die App höchstens drei Benachrichtigungen. Die übrigen siehst du an der Zahl am Symbol.
- Was beim Start der App schon offen ist, wird nicht noch einmal gemeldet.

Ruhezeiten stellst du in der App ein:

1. Öffne **Einstellungen …** im Menü der App oder drücke ⌘,.
2. Schalte **Ruhezeiten** ein und gib **Von** und **Bis** an. Vorbelegt sind 22:00 und 07:00 Uhr.
3. Schalte bei Bedarf **Beim Anmelden am Computer starten** ein und wähle unter **Sprache** Deutsch, Englisch oder **Wie das System**.

In den Ruhezeiten und während einer Pause zählt SubKit weiter, zeigt aber keine Benachrichtigungen. Im Menü steht dann zum Beispiel „Ruhezeit bis 07:00 Uhr“. Die Ruhezeiten gelten nach der Uhr deines Macs.

### Schnellnotiz

Drück irgendwo ⌥ Leertaste oder wähle **Schnellnotiz …** in der Menüleiste. Ein kleines Fenster fragt „Was willst du festhalten?“.

1. Schreib deine Notiz.
2. Drück ⌘ ↩ oder wähle **In den Eingang**. Esc schließt das Fenster, ohne zu senden.

Du liest „Notiz im Eingang“. Dort wartet die Notiz auf deine Prüfung, wie in „Ideen sammeln und in Wissen oder Skills verwandeln“ beschrieben.

### Dateien ablegen: „Wohin damit?“

Zieh Dateien auf das Fenster, das Dock-Symbol oder das Symbol in der Menüleiste. SubKit fragt „Wohin damit?“ und bietet vier Wege an:

| Wahl | Was passiert | Grenze |
| --- | --- | --- |
| **Als Datei ablegen** | Die Datei landet unter **Dateien**, mit einem `@attachment:`-Verweis. | 5 MB pro Datei |
| **Als Quelle einlesen** | SubKit teilt sie in Abschnitte und hält sie als Wissensquelle. | 50 MB pro Datei |
| **Im Chat anhängen** | Die Dateien warten auf deine nächste Nachricht im Chat. | 10 Dateien |
| **In den Eingang** | SubKit prüft sie und schlägt vor, was daraus wird. | 1 MB bei Textdateien |

Du kannst bis zu 20 Dateien auf einmal ablegen. Passt eine Wahl nicht, steht dort der Grund, zum Beispiel „Größer als 5 MB“ oder „Dateityp nicht unterstützt“. Ist die App offline, wird nichts abgelegt.

### SubKit auf deinem Mac arbeiten lassen

SubKit kann auf deinem Mac drei Dinge tun. Alle drei sind aus, bis du sie einschaltest, und jedes nutzt nur, was du erlaubst.

| Fähigkeit | Was SubKit tut | Was du erlaubst |
| --- | --- | --- |
| **Dateien** | Liest Dateien, speichert, legt Ordner an, verschiebt Dateien und legt sie in den Papierkorb. | Ordner, jeweils mit **Lesen** oder **Lesen und schreiben** |
| **Browser** | Öffnet Seiten, liest sie, füllt Felder aus, drückt Knöpfe und lädt Dateien herunter, in einem eigenen Browser. | Websites, als Origin wie `https://shop.example.com` |
| **Apps** | Liest und bedient Knöpfe und Felder in einem App-Fenster, tippt und macht geschwärzte Bildschirmfotos. | Apps, einzeln ausgewählt |

So schaltest du sie ein:

1. Öffne in der App **Einstellungen …** und dort **Lokale Fähigkeiten**. Wähle **Verwalten**.
2. Schalte **Chat und Aufgaben dürfen diesen Mac nutzen** ein.
3. Füg unter **Lokale Erlaubnisse** hinzu, was SubKit nutzen darf:
   - **Ordner**: **Ordner auswählen …**, dann unter **Zugriff** **Lesen** oder **Lesen und schreiben**.
   - **Websites**: Gib eine Origin ein, zum Beispiel `https://shop.example.com:8443` oder eine Adresse im lokalen Netz, ohne Pfad, und wähle **Hinzufügen**.
   - **Apps**: **App auswählen …**.
4. Füg unter **Tabu für SubKit** hinzu, was SubKit nie nutzen darf.

Manches ist immer gesperrt und lässt sich nicht erlauben: SubKit selbst, Sicherheitsabfragen und Anmeldefenster, Passwort-Manager, Krypto-Wallets, Banking und Zahlungen, Terminal und Shells, Skripte und Automatisierung, Systemeinstellungen und Installationsprogramme, Fernwartung und der Finder. SubKit lehnt außerdem ganze Laufwerke, System- oder versteckte Ordner und deinen ganzen Benutzerordner ab. Wähl stattdessen einen Unterordner.

Die Erlaubnisse liegen auf deinem Mac. Der Server erfährt, welche Ordner, Websites und Apps der Mac anbietet, damit eine Freigabe sie nennen kann. Im Cockpit zeigt **Einstellungen** › **Geräte** › „Welche Geräte führen lokale Schritte aus?“ jeden Mac mit dem, was er anbietet, zum Beispiel „3 Ordner“.

Sobald du eine Fähigkeit einschaltest, legt SubKit dafür einen Connector an, zum Beispiel „MacBook Pro (Anna): Dateien“, benannt in der Sprache der App. Chat und Aufgaben nutzen ihn von da an. Wie ein Workflow ihn mit festen Schritten nutzt, steht in „Referenz: Workflow-Schritte auf deinem Gerät“.

**Entfernen** an einem Eintrag nimmt die Erlaubnis zurück. Workflows, Aufgaben und Chat können ihn danach nicht mehr nutzen.

### macOS-Berechtigungen

Für **Apps** muss macOS SubKit zwei Dinge erlauben. **Berechtigungen prüfen** unter **Lokale Fähigkeiten** zeigt beide mit **Erteilt** oder **Fehlt**.

| Berechtigung | Wofür SubKit sie braucht |
| --- | --- |
| **Bedienungshilfen** | SubKit liest und bedient Knöpfe und Felder in den Apps, die du erlaubt hast. |
| **Bildschirmaufnahme** | SubKit macht Bildschirmfotos des App-Fensters, auf denen Passwortfelder geschwärzt sind. |

1. Wähle neben einer fehlenden Berechtigung **Systemeinstellungen öffnen**.
2. Schalte SubKit unter **Datenschutz & Sicherheit** ein.
3. Wähle zurück in SubKit **Erneut prüfen**. Verlangt macOS es, wähle **SubKit neu starten**.

Dateien und Browser brauchen keine zusätzliche Berechtigung. Fragt macOS, ob SubKit auf deinen Schreibtisch, deine Dokumente oder deine Downloads zugreifen darf, liegt das an einem Ordner, den du dort erlaubt hast.

### Wann SubKit auf deinem Mac fragt

Auf deinem Mac gilt dieselbe Regel wie überall: Deine Bitte entscheidet, was ohne Frage läuft.

- **Lesen und Vorbereiten laufen ohne Frage.** Eine Seite öffnen, eine Datei lesen, ein Bildschirmfoto machen, scrollen und auswählen.
- **Ein Schritt, der schreibt, läuft nur ohne Frage, wenn deine Bitte ihn abdeckt.** Eine Datei speichern, einen Knopf drücken, der etwas absendet, ein Feld ausfüllen, tippen. Sonst fragt SubKit mit **Einmal erlauben** oder **Ablehnen**, im Chat und in der Live-Ansicht.
- **Manche Schritte fragen immer.** Eine Datei in den Papierkorb legen, Zahlungen, Veröffentlichungen und das Senden an Empfänger, die du nicht genannt hast.
- **Immer vorher fragen** lässt jeden Schritt, der etwas ändert, vorher fragen, auch auf deinem Mac. Du schaltest es im Cockpit unter **Einstellungen** › **Regeln** ein.
- **Was eine Seite sagt, ist keine Bitte von dir.** Steht in einer Seite eine Anweisung, zeigt die Live-Ansicht „Die Seite enthält eine Anweisung. SubKit folgt ihr nicht.“

„Wann SubKit fragt“ erklärt die Regel vollständig.

Verlangt eine Seite eine Anmeldung, übergibt SubKit an dich. Die Live-Ansicht zeigt „Du bist dran – melde dich an, dann ‚Zurück an SubKit‘“. Melde dich selbst an und wähle dann **Zurück an SubKit**. Solange du dran bist, handelt SubKit nicht im Fenster.

Ein Workflow-Schritt auf deinem Mac braucht wie jeder Workflow-Schritt seine Freigabe. Die Freigabe nennt den Mac, die Ordner, Websites und Apps.

### Live-Ansicht

Solange SubKit auf deinem Mac arbeitet, zeigt eine kleine Leiste oben am Bildschirm „SubKit bedient ‚Safari‘“ mit **Stoppen**. **Live-Ansicht öffnen** in der Menüleiste zeigt mehr:

- Woher die Arbeit kommt: „Von dir im Chat gestartet“, „Aus deiner Aufgabe“ oder „Aus deinem Zeitplan“.
- Das **Letzte geschwärzte Bildschirmfoto**. Passwortfelder und als vertraulich markierte Felder werden auf deinem Mac geschwärzt, bevor etwas ihn verlässt.
- **Schritte**, jeder mit seinem Ergebnis, zum Beispiel **Erledigt**, **Wartet auf dich**, **Abgelehnt** oder **Nicht ausgeführt**.
- Eine Frage, wenn ein Schritt auf dich wartet, mit **Einmal erlauben** und **Ablehnen**.

Der Status sagt, was los ist:

| Status | Bedeutung |
| --- | --- |
| **Läuft** | SubKit arbeitet. |
| **Wartet auf dich** | Ein Schritt braucht deine Entscheidung. |
| **Wartet, bis du nicht mehr tippst** | Du tippst gerade auf deinem Mac. SubKit wartet, damit es nicht in deinen Text tippt. |
| **Du bist dran – melde dich an, dann „Zurück an SubKit“** | Eine Anmeldung ist an dich übergeben. |
| **Gestoppt. Spätere Schritte laufen nicht.** | Du hast es gestoppt. |
| **Gerät nicht erreichbar** | Der Mac hat die Verbindung zum Server verloren. |
| **Fertig** | Alles ist erledigt. |

**Stoppen** oder ⌘⇧⎋ stoppt SubKit sofort, aus jeder App heraus. Der laufende Schritt endet, spätere Schritte laufen nicht. Der Run zeigt, welche Schritte erledigt sind.

Bildschirmfotos eines Runs werden 30 Tage verschlüsselt aufbewahrt und dann gelöscht. Im Cockpit sieht die Person des Geräts das geschwärzte Bildschirmfoto an den Schritten eines Runs.

### Ein Arbeitsbereich nur auf diesem Mac

Mit **Nur auf diesem Mac** betreibt SubKit Datenbank und Engine auf deinem Mac, ohne Server. Außer deinem KI-Anbieter und den Diensten, die deine Workflows aufrufen, verlässt nichts den Mac. Das passt, um SubKit auszuprobieren oder allein zu arbeiten.

1. Wähle in „Server verbinden“ **Nur auf diesem Mac**.
2. **Datenordner**: Behalte den vorgeschlagenen Ordner oder wähle **Anderen Ordner wählen …**. Der Ordner muss auf diesem Mac liegen und darf nicht synchronisiert werden, also zum Beispiel nicht in iCloud Drive.
3. **Du**: Gib **Dein Name** ein.
4. **KI-Zugang**: Wähle einen **Anbieter** (Anthropic, OpenAI oder Google Gemini) und gib seinen **API-Schlüssel** ein, oder wähle **Lokaler Modell-Server** und gib seine Adresse ein, zum Beispiel `http://localhost:11434`. Der Schlüssel wird verschlüsselt in deinem lokalen Arbeitsbereich gespeichert. **Später einrichten** überspringt den Schritt; Workflows ohne KI laufen trotzdem.
5. **Einrichten**: SubKit startet Datenbank, Engine und Arbeitsbereich. Dann öffnet sich das Cockpit.

Der lokale Arbeitsbereich läuft, solange die App offen und der Mac wach ist.

Unter **Einstellungen …** › **Lokaler Arbeitsbereich** findest du:

- **Läuft** oder **Gestoppt** und die Größe der Daten.
- **Sicherungen**: SubKit legt vor jedem Update und vor jedem Wiederherstellen automatisch eine an. **Sicherung erstellen** legt eine von Hand an. **Wiederherstellen** ersetzt den Arbeitsbereich durch eine Sicherung. Neuere Änderungen gehen verloren; erlaubte Ordner bleiben erhalten.
- **Bei der Anmeldung öffnen**: Startet den lokalen Arbeitsbereich, wenn du dich anmeldest.
- **Auf einen Server umziehen**: Exportiert den Arbeitsbereich als Bundle und importiert ihn in deinen Server-Arbeitsbereich (siehe unten).
- **Alle lokalen Daten entfernen**: Stoppt die Engine, legt die Daten in den Papierkorb und vergisst die Schlüssel. Workflows, Runs und Sicherungen auf diesem Mac sind danach weg.

Ein Modell auf einem lokalen Modell-Server muss Werkzeuge aufrufen können. Kann es das nicht, liest du „Modell kann keine Werkzeuge aufrufen“: Chat und Aufgaben funktionieren damit nicht, Workflows laufen weiter. Wähle im Cockpit unter **Einstellungen** › **KI-Assistent** ein anderes Modell oder einen Anbieter-Schlüssel.

#### Auf einen Server umziehen

1. Wähle unter **Lokaler Arbeitsbereich** **Auf einen Server umziehen**.
2. Gib die Serveradresse mit `https://` ein und wähle **Jetzt umziehen**. SubKit exportiert den Arbeitsbereich für den Server und stoppt ihn auf diesem Mac.
3. Melde dich beim Server an. Der Arbeitsbereich läuft jetzt dort.

Dieser Mac bleibt als Gerät mit seinen erlaubten Ordnern verbunden. Die Freigaben deiner Workflows erneuerst du auf dem Server. Die lokalen Daten bleiben auf dem Mac, bis du sie entfernst. **Bundle exportieren** speichert das Bundle, ohne umzuziehen, zum Beispiel um es selbst zu importieren.

### Geräte und Abmelden

Jeder Mac, auf dem du dich mit SubKit Desktop anmeldest, ist ein eigenes Gerät mit eigener Sitzung. Der Server führt es unter dem Namen des Macs. Meldest du dich auf demselben Mac erneut an, bleibt es dasselbe Gerät.

- **Abmelden** im Kontomenü des Cockpits beendet die Sitzung dieses Geräts. Deine Sitzung im Browser und andere Geräte bleiben angemeldet.
- **Entfernen** in der Liste **Deine Server** löscht die lokale Sitzung und das Profil. Auf dem Server ändert sich nichts.
- **Ein Gerät widerrufen** meldet es von außen ab, zum Beispiel nach einem Verlust. Die App zeigt dann innerhalb weniger Sekunden „Abgemeldet von …“ mit **Neu anmelden**.

Deine Geräte siehst du im Cockpit unter **Einstellungen** › **Geräte**. Die Liste zeigt die installierte Web-App und jedes Desktop-Gerät mit Art, Namen, dem Tag der Anmeldung und der letzten Nutzung. Das Gerät, an dem du gerade sitzt, trägt die Marke **Dieses Gerät**.

1. Öffne das Cockpit im Browser und dort **Einstellungen** › **Geräte**.
2. Wähle am Gerät **Widerrufen**.
3. Bestätige. Der Dialog nennt das Gerät und sagt, was passiert: Es wird sofort abgemeldet und erhält keine Benachrichtigungen mehr; andere Geräte bleiben angemeldet.

In der App selbst siehst du dieselbe Liste, kannst dort aber nur **Dieses Gerät** mit **Abmelden** abmelden. Ein anderes Gerät widerrufst du im Browser.

Wird ein Mac widerrufen, der lokale Schritte ausführt, laufen auf ihm keine lokalen Schritte mehr, und Freigaben, die ihn nennen, können nicht mehr laufen.

### Wie lange du angemeldet bleibst

| Regel | Wert |
| --- | --- |
| Ohne Nutzung | 30 Tage. Jede Nutzung der App, auch im Hintergrund am Symbol in der Menüleiste, beginnt die Frist neu. |
| Höchstens | 90 Tage seit der Anmeldung, auch bei täglicher Nutzung. Danach meldest du dich im Browser neu an. |
| Nach einem Widerruf oder **Abmelden** | Sofort beendet. |

Läuft die Sitzung ab, liest du „Sitzung abgelaufen“ und „Melde dich neu an, deine Einstellungen bleiben.“ Für den Browser und die installierte Web-App gelten kürzere Fristen: 8 Stunden ohne Nutzung, höchstens 24 Stunden.

### Mehrere Server

Arbeitest du mit mehreren SubKit-Servern, bekommt jeder ein eigenes Profil mit eigener Sitzung.

1. Wähle im Menü **Server** den Eintrag **Server hinzufügen …** oder drücke ⌘N.
2. Verbinde und melde dich an wie oben.
3. Wechsle über das Menü **Server** oder die Liste **Deine Server** mit **Öffnen** zwischen den Profilen.

### Updates

Die App sucht beim Start und danach alle sechs Stunden nach Updates. Steht unter **Einstellungen** „Automatische Updates sind in diesem Build nicht aktiv.“, wurde dein Build ohne Updates gebaut. Lade SubKit neu herunter, wie unter „Installieren“ beschrieben.

| Was du liest | Was passiert |
| --- | --- |
| „Du nutzt die aktuelle Version ….“ | Nichts zu tun. |
| „Version … ist verfügbar. Der Download beginnt gleich.“ | Die App lädt das Update im Hintergrund. |
| „Version … ist geladen. Starte SubKit neu, um sie zu installieren.“ | Wähle **Jetzt neu starten**. Mit **Später** wird das Update beim nächsten Beenden installiert. |
| „Das Update ließ sich nicht prüfen und wurde nicht installiert. …“ | Deine Version bleibt unverändert. Versuch es später noch einmal. |
| „Noch aktive Runs im lokalen Arbeitsbereich: …. Ein Neustart bricht sie ab.“ | Warte, bis die Runs fertig sind, oder wähle **Trotzdem neu starten**. |

Verlangt der Server eine neuere App, liest du das beim Verbinden. Aktualisiere dann SubKit Desktop.

### Grenzen

- **Benachrichtigungen kommen nur, solange die App läuft.** Nach **SubKit beenden** meldet sie nichts mehr. Für Benachrichtigungen ohne laufende App nutze den Push der Web-App.
- **Was in Ruhezeiten oder einer Pause neu war, wird später nicht nachgemeldet.** Du siehst es an der Zahl am Symbol und in der Liste **Braucht dich**.
- **Die Ruhezeiten der App sind eigene.** Die Wahl unter **Einstellungen › Einrichtung** im Cockpit gilt für Push im Browser, nicht für die App.
- **Die App meldet die Punkte des geöffneten Profils.** Andere Server melden sich erst, wenn du zu ihnen wechselst.
- **Lokale Schritte laufen nur, solange die App offen und der Mac wach ist.** Ein Run, der den Mac braucht, wartet auf ihn und sagt „Ein Run wartet, bis sein Gerät online ist.“
- **Browser- und App-Schritte laufen nur für die Person des Macs.** Aus ihrem Chat oder ihrer Aufgabe, aus einem Run, den sie startet, oder aus einem Zeitplan, den sie eingerichtet hat.
- **Geschwärzt werden Passwortfelder und als vertraulich markierte Felder.** Ein Geheimnis, das eine Seite oder App als Klartext zeigt, bleibt im Bildschirmfoto.
- **SubKit Desktop läuft vorerst nur auf dem Mac.** Die App für Windows folgt.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Server nicht erreichbar“ | Prüfe die Adresse und ob du den Server im Browser erreichst. |
| „Kein SubKit-Server“ | Gib die Adresse des Servers ein, ohne `/cockpit` am Ende. |
| Die Adresse beginnt nicht mit `https` | Nutze die `https`-Adresse deines Servers. |
| „Version … wird nicht unterstützt“ | Der Server ist zu alt für die App. Wähle **Administrator fragen** und gib die Nachricht weiter. |
| „App zu alt“ | Aktualisiere SubKit Desktop. |
| „Anmeldung nicht unterstützt“ | Aktualisiere den Server oder SubKit Desktop. |
| „Das ist kein vollständiger Einladungslink.“ | Kopiere den ganzen Link aus der Einladungs-Mail. |
| „Diese Einladung ist abgelaufen“ oder „Diese Einladung wurde schon verwendet“ | Bitte die Person, die dich eingeladen hat, um eine neue Einladung. |
| „Anmeldung abgelaufen, starte sie neu“ | Zwischen **Anmelden** im Browser und der Rückkehr in die App darf höchstens eine Minute liegen. Starte die Anmeldung neu. |
| „Server hat abgelehnt“ | Starte neu. Bleibt es dabei, prüfe, ob dein Konto im Arbeitsbereich aktiv ist. |
| „Der Browser ließ sich nicht öffnen“ | Prüfe, ob auf deinem Mac ein Standardbrowser eingerichtet ist. |
| Nach **Anmelden** im Browser passiert in der App nichts | Erlaube dem Browser, SubKit zu öffnen, wenn er danach fragt. Läuft die App nicht mehr, starte sie und beginne neu. |
| „Server offline“ | SubKit versucht automatisch, die Verbindung wiederherzustellen. Das Symbol zeigt „Keine Verbindung zum Server“. |
| „Diesen Ordner kann SubKit nicht freigeben.“ | Wähle einen Unterordner, keine ganzen Laufwerke, keine System- oder versteckten Ordner und nicht deinen ganzen Benutzerordner. |
| „Ein freigegebener Ordner wurde ersetzt. Gib ihn neu frei.“ | Der Ordner wurde gelöscht und neu angelegt. Entferne ihn unter **Lokale Fähigkeiten**, wähle ihn neu und erneuere die Freigaben, die ihn nennen. |
| „Diesem Gerät fehlt eine Systemberechtigung.“ | Öffne **Berechtigungen prüfen** unter **Lokale Fähigkeiten** und erteile die fehlende Berechtigung. |
| Ein Schritt ist **Abgelehnt** | Ordner, Website oder App sind nicht erlaubt oder tabu. Erlaube sie unter **Lokale Fähigkeiten** oder bitte SubKit um etwas anderes. |
| „Modell kann keine Werkzeuge aufrufen“ | Wähle unter **Einstellungen** › **KI-Assistent** ein Modell mit Werkzeugaufrufen oder einen Anbieter-Schlüssel. |
| „Port ist belegt“ | Wähle **Anderen Port verwenden**. |
| „Hier kann die Datenbank nicht laufen.“ | Wähle einen Ordner auf diesem Mac, der nicht synchronisiert wird. |
| „Lokaler Arbeitsbereich startet nicht“ | Wähle **Erneut versuchen**. Bleibt es dabei, melde den Fehler mit Diagnosedaten. |
| Es kommen keine Benachrichtigungen | Prüfe, ob eine Pause oder Ruhezeiten aktiv sind und ob macOS Benachrichtigungen für SubKit erlaubt. |
