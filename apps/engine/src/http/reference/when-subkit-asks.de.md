---
slug: when-subkit-asks
title: Wann SubKit fragt
summary: Wann SubKit vor einem Schritt fragt, was ohne Frage läuft und wie du mit Regeln steuerst, was ohne Frage laufen darf.
section: work
order: 14
audience: public
---
## Wann SubKit fragt

Dieses Kapitel ist für alle, die im Chat oder mit Aufgaben arbeiten und wissen wollen, wann SubKit vor einem Schritt fragt.
Danach kannst du eine Frage-Karte lesen und beantworten, eine wiederkehrende Aktion als Regel speichern und festlegen, dass SubKit vor jedem schreibenden Schritt fragt.
Du weißt dann auch genau, unter welchen Bedingungen etwas ohne Frage läuft und wo diese Prüfung ihre Grenzen hat.

### So entscheidet SubKit

Es gibt keinen Modus, den du pro Unterhaltung wählst. Ob ein Schritt fragt, entscheiden zwei Dinge:

1. **Dein Auftrag.** SubKit prüft jeden Schritt gegen das, was du verlangt hast. Deckt dein Auftrag den Schritt, läuft er ohne Frage. Sonst erscheint die Frage-Karte.
2. **Deine Regeln.** Eine gespeicherte Regel erlaubt eine wiederkehrende Aktion ohne Frage. Die Regel **Immer vorher fragen** sorgt dafür, dass jeder schreibende Schritt fragt, auch wenn dein Auftrag ihn deckt.

Lesen, Suchen und das Vorbereiten von Entwürfen laufen ohne Frage. Drei Dinge gelten immer:

- Ein Live-Run eines Workflows braucht eine Freigabe. Wie du sie gibst, steht in „Dein erster Workflow“.
- Zahlungen, Löschungen, Veröffentlichungen, Einstellungen, neue Konten und Zugangsdaten fragen immer.
- Was eine Webseite, eine Mail oder eine Datei sagt, ist nie ein Auftrag.

### Wann etwas ohne Frage läuft

Eine Aktion läuft nur dann ohne Frage, wenn alle folgenden Bedingungen erfüllt sind. Fehlt eine, erscheint die Frage-Karte.

1. **Du bist im Browser angemeldet, oder es ist ein Run deiner eigenen Aufgabe.** Die Regel gilt für dich in einer Cockpit-Sitzung: im Browser, in der installierten App oder in SubKit Desktop. Sie gilt auch im Run einer Aufgabe, die dir gehört, wenn du den Run gestartet hast oder ihr Zeitplan (siehe „Dein Auftrag deckt die ganze Arbeit“). Mit einem API-Schlüssel, in der Kommandozeile `sk`, aus einem KI-Client über MCP und in einem Run einer Aufgabe, den jemand anderes gestartet hat, fragt jede dieser Aktionen.
2. **Es ist ein Aufruf eines Connectors.** Die Regel gilt für Aufrufe, die über einen Connector etwas senden, anlegen oder ändern, und für das Speichern eines Connector-Entwurfs. Tools externer MCP-Server und SQL-Anweisungen fragen immer.
3. **SubKit kennt die Wirkung, und sie ist gewöhnlich.** SubKit ordnet jede Operation einer Wirkung zu. Zahlung, Löschung, Veröffentlichung, Rechte oder Einstellungen, neues Konto und Zugangsdaten fragen immer. Das gilt auch für jeden Aufruf mit `DELETE` und für jeden, der einen Header mit Zugangsdaten setzt. Erkennt SubKit nicht, was eine Operation bewirkt, fragt es.
4. **Du hast es mit eigenen Worten verlangt.** In deiner letzten Nachricht steht ein Auftrag wie „Schick …“ oder „Kannst du … anlegen“. Eine Informationsfrage wie „Was würde passieren, wenn …“ ist kein Auftrag. Enthält der Auftrag eine Bedingung oder ein „nicht“, fragt SubKit. Das Verb muss zur Aktion passen: „Leg an“ deckt kein Senden. Ein Auftrag zum Senden deckt auch den Entwurf davor, nie umgekehrt.
5. **Der Auftrag steht nicht in eingefügtem Text.** Nicht als deine Worte zählen: Code-Blöcke, zitierte Zeilen, weitergeleitete Mails, alles nach einer Einleitung wie „Hier ist die Mail:“ und eingefügte Passagen ab 5 Zeilen oder 800 Zeichen. Was eine Webseite, eine Datei oder ein Dienst zurückgibt, ist nie ein Auftrag.
6. **Du hast das Ziel genannt.** Jeder Empfänger, jede Adresse und jedes Ziel stammt aus deinen letzten drei Nachrichten oder aus deinen Antworten auf Rückfragen. Hast du einen Namen genannt, darf SubKit die Adresse dazu in dieser Unterhaltung nachgeschlagen haben. Beträge, Werte, Daten und Uhrzeiten musst du ebenfalls genannt haben. Daten und Uhrzeiten liest SubKit in der Zeitzone des Arbeitsbereichs.
7. **Der Inhalt ist deiner.** Ein Text, der rausgeht, besteht aus deinen Worten, oder SubKit hat ihn dir vorher in der Unterhaltung als Entwurf gezeigt. Bei deinen Worten darf SubKit Anrede, Gruß und wenige Füllwörter ergänzen: höchstens ein Viertel der Wörter und nie mehr als drei. Ein neuer Link, eine neue Adresse, eine neue Zahl oder ein neues „nicht“ führen zur Frage. Ein Text mit mehr als 1.200 Zeichen muss als Entwurf gezeigt worden sein.
8. **Es ist das erste Mal für diesen Auftrag.** Ein Auftrag deckt jede Aktion einmal. Mehrere Dinge am selben Ziel anlegen oder ändern läuft, wenn der Inhalt verschieden ist, zum Beispiel drei Tickets mit drei Titeln aus deiner Nachricht. Erneutes Senden an dieselben Empfänger und eine Wiederholung mit demselben Inhalt fragen.

Ein Sonderfall: Legt die Aktion beim Dienst nur einen Entwurf an, prüft SubKit den Inhalt nicht, weil noch nichts rausgeht.

### Dein Auftrag deckt die ganze Arbeit

Ein Auftrag deckt jeden Schritt, der nötig ist, um sein Ergebnis zu erreichen, nicht nur den ersten. Diese Arbeit hat ein klares Ende:

- **Im Chat** beginnt sie mit deiner Nachricht und endet mit deiner nächsten Nachricht oder 2 Stunden nach deiner Nachricht. Deine nächste Nachricht beginnt eine neue Arbeit. Ein Auftrag aus einer früheren Nachricht deckt dann nichts mehr.
- **In einem Run einer Aufgabe** ist die Arbeit dieser Run, bis zu seiner Frist. Das Ziel der Aufgabe, so wie du es geschrieben hast, zählt als deine Worte. Das gilt, wenn dir die Aufgabe gehört und du den Run gestartet hast oder ihr Zeitplan. Deine gespeicherten Regeln gelten dort auch. Wurde die Aufgabe nach dem Start des Runs geändert, deckt das Ziel nichts mehr. Hat zuletzt jemand anderes das Ziel oder „Fertig, wenn“ geändert, zum Beispiel ein Admin, sind das nicht deine Worte und decken nichts, bis du sie selbst änderst. Die gebundenen Connectors und Workflows der Aufgabe bleiben ihre äußere Grenze. Ein Run, den jemand anderes gestartet hat, behält nur die Dauererlaubnis der Aufgabe, und jeder schreibende Schritt fragt wie bisher.

Auch innerhalb der Arbeit fragen die festen Klassen immer: Zahlungen, Löschungen, Veröffentlichungen und Senden an Empfänger, die du nicht genannt hast, Einstellungen, neue Konten und Zugangsdaten. Was eine Webseite, eine Mail oder eine Datei sagt, erweitert die Arbeit nie.

Läuft eine Aktion ohne Frage, steht darunter in der Unterhaltung eine Zeile wie „Senden an anna@example.com, weil du es verlangt hast“. **Deine Worte anzeigen** zeigt den Satz, auf den sich SubKit stützt. Der Audit-Trail hält jede dieser Aktionen fest, mit dem Grund „Die Person hat es mit eigenen Worten verlangt“ oder „Eine gespeicherte Regel der Person deckt es“.

### Die Frage-Karte

Fragt SubKit, zeigt es eine Karte mit dem Titel **Deine Entscheidung**.

| Feld | Bedeutung |
| --- | --- |
| **Aktion** | Was passiert: Senden, Anlegen, Ändern, Ausführen oder Speichern. |
| **Ziel** | Die Operation beim Dienst, zum Beispiel `POST /v1/messages`. |
| **Konto** | Der Connector, über den die Aktion läuft. |
| **Empfänger** | Alle Adressen, Links und Namen, die die Aktion erreicht. |
| **Inhalt** | Der vollständige Text, so wie er rausgehen würde. |

Unter den Feldern steht, warum SubKit fragt, zum Beispiel „Du hast diesen Empfänger nicht genannt.“ Die letzte Zeile nennt die Frist und ergänzt: „Anderer Empfänger oder Inhalt fragt neu“. **Einmal erlauben** gilt genau für diese Aktion.

1. Lies die Felder, vor allem **Empfänger** und **Inhalt**.
2. Wähle **Einmal erlauben**, wenn genau das passieren soll. Die Aktion läuft einmal.
3. Wähle **Ablehnen**, wenn nicht. Nichts läuft.

Zwei Dinge schützen dich vor einem Versehen:

- **Getippter Text gibt nie eine Freigabe.** Schreibst du „ja“ ins Nachrichtenfeld, während eine Karte offen ist, fragt SubKit „Meintest du: Einmal erlauben?“. Ausgeführt wurde nichts. Bestätige mit der Schaltfläche oder wähle **Nein, Karte offen lassen**.
- **Eine Antwort, die die Aktion ändert, führt nichts aus.** Du liest dann „Deine Antwort ändert die Aktion, deshalb lief nichts“. Erlaube genau das Gezeigte, oder wähle **Ablehnen und neu formulieren** und schick deinen geänderten Auftrag.

### Eine Aktion als Regel speichern

Eine Regel erlaubt genau eine wiederkehrende Aktion ohne Frage. Du legst sie nicht von Hand an: SubKit bietet sie an, wenn du dieselbe Aktion zum zweiten Mal mit **Einmal erlauben** bestätigt hast.

1. Bestätige die Aktion wie gewohnt. Unter der Karte erscheint „Soll das künftig ohne Frage laufen?“ mit dem **Umfang** der Regel.
2. Prüfe den Umfang: Aktion, Ziel, Konto und Empfänger.
3. Wähle **Als Regel speichern**. Oder wähle **Nein, weiter fragen**, dann bietet SubKit diese Regel nicht noch einmal an.

Eine Regel gilt so:

| Eigenschaft | Was gilt |
| --- | --- |
| Umfang | Genau diese Aktion über genau diesen Connector an genau diese Operation. Mit Empfängern: nur an die genannten Empfänger. Ohne Empfänger: nur Aktionen ohne Empfänger. Höchstens 20 Empfänger. |
| Inhalt | War der Text bei beiden Bestätigungen gleich, deckt die Regel nur genau diesen Text. War er verschieden, deckt sie nur Text, den du selbst geschrieben oder als Entwurf gesehen hast. Trug die Aktion keinen Text, deckt sie nur Aktionen ohne Text. |
| Dauer | 90 Tage ab dem Speichern. Danach fragt die Aktion wieder. |
| Tageslimit | 20 Ausführungen pro Tag, gezählt nach UTC. Danach fragt die Aktion bis zum nächsten Tag. |
| Immer vorher fragen | Eine gespeicherte Regel gilt auch, wenn du **Immer vorher fragen** eingeschaltet hast. |
| Person | Gilt nur für dich: im Browser angemeldet oder in einem Run deiner eigenen Aufgabe, den du oder ihr Zeitplan gestartet hat. Andere Personen im Arbeitsbereich haben eigene Regeln. |

Zahlungen, Löschungen, Veröffentlichungen, Einstellungen, neue Konten und Zugangsdaten lassen sich nie als Regel speichern.

Läuft eine Aktion wegen einer Regel, steht in der Unterhaltung „…, laut deiner Regel“ mit dem Verweis **Regeln öffnen**.

### Immer vorher fragen

Möchtest du jeden schreibenden Schritt selbst bestätigen, schalte die Regel **Immer vorher fragen** ein.

1. Öffne **Einstellungen** und darin **Regeln**.
2. Schalte **Immer vorher fragen** ein.

Ab dann fragt SubKit vor jedem Schritt, der etwas speichert, sendet, anlegt oder ändert, auch wenn dein Auftrag ihn deckt. Lesen läuft weiter ohne Frage. Deine gespeicherten Regeln gelten weiter, ebenso eine Freigabe für Live-Runs. Die Einstellung gilt nur für dich: in jeder Unterhaltung, für Tools, die ein KI-Client über MCP in deinem Namen aufruft, und für direkte Tool-Aufrufe, auch mit deinem eigenen API-Schlüssel. Für ein Systemkonto und seine Schlüssel gilt sie nicht, weil dahinter keine Person steht. Aufgaben-Runs, die ihr Zeitplan startet, richten sich nach ihrem Auftrag und ihrer Dauererlaubnis.

### Regeln ansehen und widerrufen

1. Öffne **Einstellungen** und darin **Regeln**.
2. Unter **Aktiv** stehen deine Regeln. Chips zeigen Connector, Empfänger, Inhalt, Gültigkeit und die Nutzung heute, zum Beispiel „bis …“ und „heute 3/20“; darunter steht „Zuletzt genutzt …“. Unter **Angeboten** stehen Regeln, über die du noch nicht entschieden hast.
3. Wähle bei einer Regel **Widerrufen** und bestätige.

Nach dem Widerruf fragt SubKit wieder, bevor es diese Aktion ausführt. Bereits Gesendetes bleibt gesendet.

Fragt eine Aktion trotz Regel, nennt die Karte den Grund:

| Was du liest | Bedeutung |
| --- | --- |
| „Deine Regel für diese Aktion ist abgelaufen. Verlängere sie unter Regeln.“ | Die 90 Tage sind vorbei. |
| „Deine Regel für diese Aktion hat ihr Tageslimit erreicht.“ | Heute lief die Aktion schon 20-mal über diese Regel. |
| „Deine Regel deckt einen anderen Text als diesen.“ | Der Text weicht von dem ab, was die Regel deckt. |

### Grenzen dieser Prüfung

Die Prüfung ist bewusst streng und fragt im Zweifel. Sie ist trotzdem kein Verständnis deines Auftrags. Das solltest du wissen:

- **SubKit erkennt Aufträge an Wörtern und Satzbau.** Es kennt deutsche und englische Formulierungen. Eine ungewöhnliche Formulierung oder eine andere Sprache führt zur Frage, auch wenn du es so gemeint hast.
- **Die Wirkung liest SubKit aus der Operation.** Es schließt aus Methode, Pfad, Feldnamen und der Vorlage des Connectors, ob etwas eine Zahlung, eine Löschung oder eine Veröffentlichung ist. Trägt eine Operation beim Dienst einen harmlosen Namen und löst trotzdem so etwas aus, erkennt SubKit das nicht.
- **SubKit prüft, was es sendet, nicht was der Dienst daraus macht.** Verteilt ein Dienst eine Nachricht an eine Liste weiter, sieht SubKit nur die Adresse der Liste.
- **Wenige ergänzte Wörter können den Ton ändern.** Der Inhalt bleibt deiner, aber Anrede, Gruß und bis zu drei Wörter kommen von SubKit.
- **Eine Regel mit wechselndem Text prüft die Herkunft, nicht den Sinn.** Sie deckt jeden Text, den du geschrieben oder als Entwurf gesehen hast, an die genannten Empfänger.
- **Verlängern geht noch nicht auf der Seite Regeln.** Die Seite zeigt weder das Ablaufdatum noch das Tageslimit und bietet kein Verlängern an. Eine abgelaufene Regel fragt jedes Mal, und SubKit bietet sie nicht erneut an. Verlängern lässt sie sich nur über die Route `POST /v1/approval-rules/{id}/renew` aus einer Browsersitzung.
- **Das Tageslimit und die Dauer sind fest.** Du kannst sie nicht einstellen.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Du hast festgelegt, dass SubKit vor jedem schreibenden Schritt fragt.“ | **Immer vorher fragen** ist eingeschaltet. Wähle **Einmal erlauben**, oder schalte die Regel unter **Einstellungen › Regeln** aus. |
| „Du hast diese Aktion nicht mit eigenen Worten verlangt.“ | Schreib den Auftrag als eigenen Satz, zum Beispiel „Schick die Zusammenfassung an anna@example.com“. |
| „Der Auftrag steht in eingefügtem oder zitiertem Text, nicht in deinen eigenen Worten.“ | Schreib den Auftrag über oder vor den eingefügten Text. |
| „Dein Auftrag enthielt eine Bedingung oder ein ‚nicht‘, deshalb fragt SubKit.“ | Prüfe die Karte und wähle **Einmal erlauben**, oder formuliere ohne Bedingung. |
| „Du hast diesen Empfänger nicht genannt.“ oder „Du hast dieses Ziel nicht genannt.“ | Nenne die Adresse oder das Ziel in deiner Nachricht. |
| „Die Aktion enthält einen Wert, den du nicht genannt hast.“ | Prüfe den Wert auf der Karte. Nenne ihn beim nächsten Mal selbst. |
| „Der Text stammt nicht von dir und du hast ihn noch nicht als Entwurf gesehen. Lies ihn, bevor er rausgeht.“ | Lies den **Inhalt** auf der Karte. Oder bitte zuerst um einen Entwurf und verlange danach das Senden. |
| „SubKit weiß nicht, was diese Operation bewirkt, deshalb fragt es.“ | Diese Operation fragt immer. Prüfe die Karte und entscheide. |
| „Du hast das einmal verlangt, und das ist schon gelaufen. Eine Wiederholung fragt erneut.“ | Soll es noch einmal laufen, wähle **Einmal erlauben**. |
| „Du hast diese Aktion nicht mit eigenen Worten verlangt.“ nach einer Weile | Die Arbeit zu deinem Auftrag ist vorbei: Du hast eine neue Nachricht geschrieben, 2 Stunden sind vergangen oder der Run einer Aufgabe hat seine Frist erreicht. Bitte SubKit noch einmal darum oder wähle **Einmal erlauben**. |
| „Nur du selbst, im Browser angemeldet, kannst eine Aktion ohne diese Frage laufen lassen.“ | Du arbeitest mit einem API-Schlüssel oder aus einem anderen Client. Öffne die Unterhaltung im Cockpit. |
| „Die Regel wurde nicht gespeichert. Geändert wurde nichts; SubKit fragt weiterhin.“ | Wähle **Als Regel speichern** noch einmal. Bleibt es dabei, prüfe, ob du im Browser angemeldet bist. |

### Das Gleiche über die HTTP-API

Regeln gehören einer Person. Ein Systemkonto hat keine, und die Routen antworten ihm mit `403 person_required`. **Immer vorher fragen** setzt du mit `PUT /v1/identity/me/setup` und dem Feld `ask_before_writing`.

| Route | Bewirkt |
| --- | --- |
| `GET /v1/approval-rules` | Listet deine angebotenen und aktiven Regeln. `?state=` filtert nach `offered`, `active`, `dismissed` oder `revoked`. |
| `POST /v1/approval-rules/{id}/accept` | Speichert eine angebotene Regel. Geht nur aus einer Browsersitzung. |
| `POST /v1/approval-rules/{id}/dismiss` | Lehnt eine angebotene Regel ab. Sie wird nicht erneut angeboten. |
| `POST /v1/approval-rules/{id}/renew` | Verlängert eine aktive Regel um 90 Tage ab jetzt, auch wenn sie schon abgelaufen ist. Geht nur aus einer Browsersitzung. |
| `DELETE /v1/approval-rules/{id}` | Widerruft eine aktive Regel. |

Passt der Zustand der Regel nicht zur Route, antwortet die Engine mit `409 approval_rule_wrong_state`. Alle Felder einer Regel stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
