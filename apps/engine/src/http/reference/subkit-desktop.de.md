---
slug: subkit-desktop
title: SubKit Desktop
summary: Nutze das Cockpit deines Servers als Programm mit Symbol in der Menüleiste und Benachrichtigungen.
section: work
order: 18
audience: public
---
## SubKit Desktop

Dieses Kapitel ist für alle, die SubKit den ganzen Tag im Blick behalten wollen, ohne einen Browser-Tab offen zu halten.
Danach hast du SubKit Desktop mit deinem Server verbunden, dich angemeldet und Benachrichtigungen, Ruhezeiten und den Start beim Anmelden eingestellt.

### Was SubKit Desktop ist und was nicht

SubKit Desktop ist ein Fenster auf das Cockpit deines Servers. Es bringt drei Dinge mit, die ein Browser-Tab nicht hat: ein Symbol in der Menüleiste oder im Infobereich mit der Zahl der offenen Punkte, Benachrichtigungen des Betriebssystems und den Start beim Anmelden am Computer.

| SubKit Desktop | SubKit Desktop nicht |
| --- | --- |
| Zeigt das Cockpit deines Servers, mit denselben Rechten wie im Browser. | Führt keine Workflows und keine Aufgaben auf deinem Rechner aus. Alles läuft auf dem Server. |
| Meldet, was dich braucht, auch wenn das Fenster geschlossen ist. | Arbeitet nicht ohne Verbindung zum Server. Es hält keine Daten lokal vor. |
| Merkt sich mehrere Server als Profile. | Speichert keinen API-Schlüssel und kein Passwort. Die Anmeldung ist eine Sitzung wie im Browser. |
| Öffnet fremde Links im Browser deines Systems. | Lädt keine anderen Webseiten in seinem Fenster. |

Den Unterschied zur installierten Web-App zeigt die Tabelle in „Cockpit als App“.

### Was du brauchst

- Einen SubKit-Server ab Version 11.2.0. Ältere Server bieten die Anmeldung der App nicht an.
- Die Adresse des Servers, zum Beispiel `subkit.example.com`. Sie muss über `https://` erreichbar sein; nur `localhost` darf `http://` nutzen.
- Ein Konto, mit dem du dich im Browser am Cockpit anmelden kannst.
- SubKit Desktop selbst. Eine Installationsdatei zum Herunterladen gibt es heute noch nicht: Die App für macOS, Windows und Linux ist mit der öffentlichen Version von SubKit verfügbar. Bis dahin nutzt du das Cockpit im Browser oder als installierte Web-App; die funktioniert schon jetzt („Installierte Cockpit-Sitzungen“).

### Mit einem Server verbinden

1. Starte SubKit Desktop. Du siehst „Mit SubKit verbinden“.
2. Gib unter **Server-Adresse** die Adresse deines Servers ein und wähle **Server prüfen**.
3. Lies das Ergebnis. Bei „SubKit … gefunden. Du kannst dich anmelden.“ passt alles.

Die App prüft dabei, ob unter der Adresse ein SubKit-Server antwortet und ob die Versionen zusammenpassen: Der Server muss neu genug für die App sein und die App neu genug für den Server.

### Im Browser anmelden

Die Anmeldung läuft in deinem Browser, nicht in der App. So nutzt du die Anmeldung, die du schon kennst, und die App sieht dein Passwort nie.

1. Wähle **Im Browser anmelden**. Dein Browser öffnet sich, und die App zeigt „Dein Browser ist geöffnet. Melde dich dort an, dann geht es hier automatisch weiter.“
2. Melde dich im Browser am Cockpit an, falls du es dort noch nicht bist.
3. Lies die Seite „Bei SubKit Desktop anmelden“. Sie nennt den Namen deines Rechners, den Arbeitsbereich und das Konto, zum Beispiel „SubKit Desktop auf MacBook-Anna möchte sich bei Brennwerk anmelden.“ und „Angemeldet als anna@example.com“.
4. Wähle **Anmelden**. Fahre nur fort, wenn du diese Anmeldung gerade selbst in der App auf diesem Gerät gestartet hast.
5. Der Browser gibt an die App zurück. Die App zeigt „Anmeldung wird abgeschlossen …“ und öffnet danach das Cockpit.

Mit **Abbrechen** auf der Seite im Browser oder **Anmeldung abbrechen** in der App passiert nichts: Es entsteht kein Profil und kein Gerät.
Die Seite im Browser gilt 10 Minuten. Danach startest du die Anmeldung in der App neu.

### Geräte und Abmelden

Jeder Rechner, auf dem du dich mit SubKit Desktop anmeldest, ist ein eigenes Gerät mit eigener Sitzung. Der Server führt es unter dem Namen des Rechners. Meldest du dich auf demselben Rechner erneut an, bleibt es dasselbe Gerät.

- **Abmelden** im **Benutzermenü** des Cockpits beendet die Sitzung dieses Geräts. Deine Sitzung im Browser und andere Geräte bleiben angemeldet.
- **Entfernen** in der Liste **Deine Server** löscht die lokale Sitzung und das Profil. Auf dem Server ändert sich nichts.
- **Ein Gerät widerrufen** meldet es von außen ab, zum Beispiel nach einem Verlust. Die App zeigt dann innerhalb weniger Sekunden „Dieses Gerät wurde in SubKit abgemeldet. Melde dich neu an, um es wieder zu verbinden.“

Deine Geräte siehst du im Cockpit unter **Einstellungen** › **Dein Profil** › **Wo bist du angemeldet?**. Die Liste zeigt die installierte Web-App und jedes Desktop-Gerät mit Art, Namen, dem Tag der Anmeldung und der letzten Nutzung. Das Gerät, an dem du gerade sitzt, trägt die Marke **Dieses Gerät**.

1. Öffne das Cockpit im Browser und dort **Einstellungen** › **Dein Profil**.
2. Wähle am Gerät **Widerrufen**.
3. Bestätige. Der Dialog nennt das Gerät und sagt, was passiert: Es wird sofort abgemeldet und erhält keine Benachrichtigungen mehr; andere Geräte bleiben angemeldet.

In der App selbst und in der installierten Web-App siehst du dieselbe Liste, kannst dort aber nur **Dieses Gerät** mit **Abmelden** abmelden. Ein anderes Gerät widerrufst du im Browser.

**Installation widerrufen** im Menü des Arbeitsbereichs betrifft nur die installierte Web-App. Der Dialog sagt das: Desktop-Geräte bleiben angemeldet.

### Wie lange du angemeldet bleibst

| Regel | Wert |
| --- | --- |
| Ohne Nutzung | 30 Tage. Jede Nutzung der App, auch im Hintergrund am Symbol, beginnt die Frist neu. |
| Höchstens | 90 Tage seit der Anmeldung, auch bei täglicher Nutzung. Danach meldest du dich im Browser neu an. |
| Nach einem Widerruf oder **Abmelden** | Sofort beendet. |

Läuft die Sitzung ab, liest du „Deine Sitzung ist abgelaufen. Melde dich neu an, deine Einstellungen bleiben erhalten.“ Für den Browser und die installierte Web-App gelten kürzere Fristen: 8 Stunden ohne Nutzung, höchstens 24 Stunden.

### Symbol, Benachrichtigungen und Ruhezeiten

Schließt du das Fenster, läuft SubKit Desktop weiter. Das Symbol in der Menüleiste oder im Infobereich zeigt die Zahl der offenen Punkte.

| Eintrag im Menü des Symbols | Was er tut |
| --- | --- |
| **SubKit öffnen** | Holt das Fenster nach vorn. |
| **Braucht dich (3)** | Öffnet die Liste der offenen Punkte. Ist nichts offen, steht dort „Nichts braucht dich gerade“. |
| **Benachrichtigungen 1 Stunde pausieren** | Hält Benachrichtigungen eine Stunde zurück. **Benachrichtigungen fortsetzen** beendet die Pause. |
| **Beim Anmelden starten** | Startet SubKit Desktop mit deinem Computer, ohne ein Fenster zu öffnen. |
| **Nach Updates suchen** | Sucht nach einer neuen Version der App. |
| **Fehler melden …** | Öffnet den Dialog aus „Einen Fehler melden“. |
| **SubKit beenden** | Beendet die App. Danach kommen keine Benachrichtigungen mehr. |

Eine Benachrichtigung sagt, was passiert ist und was zu tun ist, zum Beispiel „‚Tagesbericht‘ wartet auf deine Entscheidung“ und „Prüf die Änderung und entscheide.“ Anders als der Push im Browser nennt sie den Namen. Ein Klick öffnet genau diesen Punkt im Fenster.

- Ein neuer Punkt wird innerhalb etwa einer Sekunde gemeldet, spätestens nach einer Minute.
- Kommen mehrere Punkte zugleich, zeigt die App höchstens drei Benachrichtigungen. Die übrigen siehst du an der Zahl am Symbol.
- Was beim Start der App schon offen ist, wird nicht noch einmal gemeldet.

Ruhezeiten stellst du in der App ein:

1. Öffne **Einstellungen …** im Menü der App oder drücke ⌘, (unter Windows und Linux Strg+,).
2. Schalte **Ruhezeiten** ein und gib **Von** und **Bis** an. Vorbelegt sind 22:00 und 07:00.
3. Schalte bei Bedarf **Beim Anmelden am Computer starten** ein und wähle unter **Sprache** Deutsch, Englisch oder **Wie das System**.

In den Ruhezeiten und während einer Pause zählt SubKit weiter, zeigt aber keine Benachrichtigungen. Die Ruhezeiten gelten nach der Uhr deines Rechners.

### Mehrere Server

Arbeitest du mit mehreren SubKit-Servern, bekommt jeder ein eigenes Profil mit eigener Sitzung.

1. Wähle im Menü **Server** den Eintrag **Server hinzufügen …** oder drücke ⌘N.
2. Verbinde und melde dich an wie oben.
3. Wechsle über das Menü **Server** oder die Liste **Deine Server** mit **Öffnen** zwischen den Profilen.

### Updates

Ob sich deine App selbst aktualisiert, hängt davon ab, wie sie gebaut wurde. Steht unter **Einstellungen** „Automatische Updates sind in diesem Build nicht aktiv.“, gibt es neue Versionen erst mit der öffentlichen Version von SubKit; einen Download gibt es heute nicht.

Sind Updates aktiv, sucht die App beim Start und danach alle sechs Stunden.

| Was du liest | Was passiert |
| --- | --- |
| „Du nutzt die aktuelle Version ….“ | Nichts zu tun. |
| „Version … ist verfügbar. Der Download beginnt gleich.“ | Die App lädt das Update im Hintergrund. |
| „Version … ist geladen. Starte SubKit neu, um sie zu installieren.“ | Wähle **Jetzt neu starten**. Mit **Später** wird das Update beim nächsten Beenden installiert. |
| „Das Update ließ sich nicht prüfen und wurde nicht installiert. …“ | Deine Version bleibt unverändert. Versuch es später noch einmal. |

Verlangt der Server eine neuere App, liest du beim Verbinden „Der Server verlangt mindestens Version … der App, installiert ist …“. Aktualisiere dann SubKit Desktop.

### Grenzen

- **Benachrichtigungen kommen nur, solange die App läuft.** Nach **SubKit beenden** meldet sie nichts mehr. Für Benachrichtigungen ohne laufende App nutze den Push der Web-App.
- **Was in Ruhezeiten oder einer Pause neu war, wird später nicht nachgemeldet.** Du siehst es an der Zahl am Symbol und in der Liste **Braucht dich**.
- **Die Ruhezeiten der App sind eigene.** Die Wahl unter **Einstellungen › Einrichtung** im Cockpit gilt für Push im Browser, nicht für die App.
- **Die App meldet die Punkte des geöffneten Profils.** Andere Server melden sich erst, wenn du zu ihnen wechselst.
- **Erprobt ist bisher macOS.** Links, der Start beim Anmelden, das Symbol im Infobereich und die Zahl am Symbol sind für Windows und Linux gebaut, aber dort noch nicht durchgehend geprüft.
- **Ein Bildschirmfoto für einen Fehlerbericht kann offen angezeigte Geheimnisse enthalten.** Mehr in „Einen Fehler melden“.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Der Server ist nicht erreichbar. Prüf die Adresse und deine Internetverbindung.“ | Prüfe die Adresse und ob du den Server im Browser erreichst. |
| „Unter dieser Adresse antwortet kein SubKit-Server. Prüf die Adresse.“ | Gib die Adresse des Servers ein, ohne `/cockpit` am Ende. |
| „Die Adresse muss mit https:// beginnen. Nur localhost darf http:// nutzen.“ | Nutze die `https`-Adresse deines Servers. |
| „Dieser Server läuft mit SubKit …. Die App braucht mindestens …. Bitte deine Administration, den Server zu aktualisieren.“ | Der Server ist zu alt für die App. Gib die Meldung an die Person weiter, die ihn betreibt. |
| „Der Server verlangt mindestens Version … der App, installiert ist ….“ | Aktualisiere SubKit Desktop. |
| „Dieser Server bietet die Anmeldung, die diese App braucht, nicht an. …“ | Aktualisiere SubKit Desktop oder bitte die Person, die den Server betreibt, ihn zu prüfen. |
| Der Browser zeigt „Dieser Anmeldeversuch ist abgelaufen oder wurde schon verwendet. Melde dich erneut an.“ | Starte die Anmeldung in der App neu. |
| „Die Anmeldung ist abgelaufen. Starte sie noch einmal.“ | Zwischen **Anmelden** im Browser und der Rückkehr in die App darf höchstens eine Minute liegen. Starte die Anmeldung neu. |
| „Der Server hat die Anmeldung abgelehnt. Starte sie noch einmal.“ | Starte neu. Bleibt es dabei, prüfe, ob dein Konto im Arbeitsbereich aktiv ist. |
| „Der Browser ließ sich nicht öffnen. Versuch es noch einmal.“ | Prüfe, ob auf deinem System ein Standardbrowser eingerichtet ist. |
| Nach **Anmelden** im Browser passiert in der App nichts | Erlaube dem Browser, SubKit zu öffnen, wenn er danach fragt. Läuft die App nicht mehr, starte sie und beginne neu. |
| „Deine Sitzung ist abgelaufen. Melde dich neu an, deine Einstellungen bleiben erhalten.“ | Wähle **Anmelden**. Profil, Ruhezeiten und Sprache bleiben. |
| „SubKit ist gerade nicht erreichbar. Die App versucht es weiter, du kannst es auch selbst erneut versuchen.“ | Warte oder prüfe deine Verbindung. Das Symbol zeigt „Keine Verbindung zum Server“. |
| Es kommen keine Benachrichtigungen | Prüfe, ob eine Pause oder Ruhezeiten aktiv sind und ob dein Betriebssystem Benachrichtigungen für SubKit erlaubt. |
