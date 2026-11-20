---
slug: chat-modes-and-rules
title: Chat-Modi und Regeln
summary: Lege fest, wann SubKit im Chat fragt und was es ohne Frage ausführen darf.
section: work
order: 14
audience: public
---
## Chat-Modi und Regeln

Dieses Kapitel ist für alle, die im Chat arbeiten und wissen wollen, wann SubKit vor einer Aktion fragt.
Danach kannst du den Modus einer Unterhaltung wählen, eine Frage-Karte lesen und beantworten und eine wiederkehrende Aktion als Regel speichern.
Du weißt dann auch genau, unter welchen Bedingungen etwas ohne Frage läuft und wo diese Prüfung ihre Grenzen hat.

### Die drei Modi

Über dem Nachrichtenfeld wählst du unter **Modus**, wie viel SubKit in dieser Unterhaltung allein tut.

| Modus | Was er tut |
| --- | --- |
| **Fragen** | Fragt vor jedem Speichern, vor jeder Aktion mit Wirkung nach außen und vor einem Live-Lauf, den keine Freigabe deckt. |
| **Automatisch** | Bereitet Entwürfe vor und führt aus, was du ausdrücklich verlangst. Alles andere fragt. |
| **Nur planen** | Plant und schlägt vor; fragt wie „Fragen“ vor jedem Schritt. |

**Was heißt das?** neben der Auswahl zeigt für den gewählten Modus zwei Listen: **Fragt vorher** und **Ohne Rückfrage**.

Drei Dinge gelten in jedem Modus:

- Ein Live-Lauf eines Workflows braucht eine Freigabe. Wie du sie gibst, steht in „Dein erster Workflow“.
- Zahlungen, Löschungen, Veröffentlichungen, Einstellungen, neue Konten und Zugangsdaten fragen immer.
- **Nur planen** ist eine Anweisung an das Modell und keine eigene Schranke. Es gelten dieselben Schranken wie in **Fragen**.

Welcher Modus in einer neuen Unterhaltung vorgewählt ist, legst du unter **Einstellungen › Einrichtung** fest. In der Auswahl steht dieser Modus mit dem Zusatz **(dein Standard)**. Mehr dazu in „SubKit auf dich einstellen“.

### Wann etwas ohne Frage läuft

Im Modus **Automatisch** läuft eine Aktion nur dann ohne Frage, wenn alle folgenden Bedingungen erfüllt sind. Fehlt eine, erscheint die Frage-Karte.

1. **Du bist im Browser angemeldet.** Die Regel gilt nur für dich selbst in einer Cockpit-Sitzung: im Browser, in der installierten App oder in SubKit Desktop. Mit einem API-Schlüssel, in der Kommandozeile `sk`, aus einem KI-Client über MCP und in einem Lauf einer Aufgabe fragt jede dieser Aktionen.
2. **Es ist ein Aufruf eines Konnektors.** Die Regel gilt für Aufrufe, die über einen Konnektor etwas senden, anlegen oder ändern, und für das Speichern eines Konnektor-Entwurfs. Tools externer MCP-Server und SQL-Anweisungen fragen immer.
3. **SubKit kennt die Wirkung, und sie ist gewöhnlich.** SubKit ordnet jede Operation einer Wirkung zu. Zahlung, Löschung, Veröffentlichung, Rechte oder Einstellungen, neues Konto und Zugangsdaten fragen immer. Das gilt auch für jeden Aufruf mit `DELETE` und für jeden, der einen Header mit Zugangsdaten setzt. Erkennt SubKit nicht, was eine Operation bewirkt, fragt es.
4. **Du hast es mit eigenen Worten verlangt.** In deiner letzten Nachricht steht ein Auftrag wie „Schick …“ oder „Kannst du … anlegen“. Eine Informationsfrage wie „Was würde passieren, wenn …“ ist kein Auftrag. Enthält der Auftrag eine Bedingung oder ein „nicht“, fragt SubKit. Das Verb muss zur Aktion passen: „Leg an“ deckt kein Senden.
5. **Der Auftrag steht nicht in eingefügtem Text.** Nicht als deine Worte zählen: Code-Blöcke, zitierte Zeilen, weitergeleitete Mails, alles nach einer Einleitung wie „Hier ist die Mail:“ und eingefügte Passagen ab 5 Zeilen oder 800 Zeichen. Was eine Webseite, eine Datei oder ein Dienst zurückgibt, ist nie ein Auftrag.
6. **Du hast das Ziel genannt.** Jeder Empfänger, jede Adresse und jedes Ziel stammt aus deinen letzten drei Nachrichten oder aus deinen Antworten auf Rückfragen. Hast du einen Namen genannt, darf SubKit die Adresse dazu in dieser Unterhaltung nachgeschlagen haben. Beträge, Werte, Daten und Uhrzeiten musst du ebenfalls genannt haben. Daten und Uhrzeiten liest SubKit in der Zeitzone des Arbeitsbereichs.
7. **Der Inhalt ist deiner.** Ein Text, der rausgeht, besteht aus deinen Worten, oder SubKit hat ihn dir vorher in der Unterhaltung als Entwurf gezeigt. Bei deinen Worten darf SubKit Anrede, Gruß und wenige Füllwörter ergänzen: höchstens ein Viertel der Wörter und nie mehr als drei. Ein neuer Link, eine neue Adresse, eine neue Zahl oder ein neues „nicht“ führen zur Frage. Ein Text mit mehr als 1.200 Zeichen muss als Entwurf gezeigt worden sein.
8. **Es ist das erste Mal für diesen Auftrag.** Ein Auftrag deckt eine Aktion genau einmal. Eine Wiederholung derselben Aktion fragt.

Ein Sonderfall: Legt die Aktion beim Dienst nur einen Entwurf an, prüft SubKit den Inhalt nicht, weil noch nichts rausgeht.

Läuft eine Aktion ohne Frage, steht darunter in der Unterhaltung eine Zeile wie „Senden an anna@example.com, weil du es verlangt hast“. **Deine Worte anzeigen** zeigt den Satz, auf den sich SubKit stützt. Der Audit-Trail hält jede dieser Aktionen fest, mit dem Grund „Die Person hat es mit eigenen Worten verlangt“ oder „Eine gespeicherte Regel der Person deckt es“.

### Die Frage-Karte

Fragt SubKit, zeigt es eine Karte mit dem Titel **Möchte das ausführen**.

| Feld | Bedeutung |
| --- | --- |
| **Aktion** | Was passiert: Senden, Anlegen, Ändern, Ausführen oder Speichern. |
| **Ziel** | Die Operation beim Dienst, zum Beispiel `POST /v1/messages`. |
| **Konto** | Der Konnektor, über den die Aktion läuft. |
| **Empfänger** | Alle Adressen, Links und Namen, die die Aktion erreicht. |
| **Inhalt** | Der vollständige Text, so wie er rausgehen würde. |

Unter den Feldern steht, warum SubKit fragt, zum Beispiel „Du hast diesen Empfänger nicht genannt.“ Darunter steht: „Gilt genau für diese Aktion, einmal. Ein anderer Empfänger oder Inhalt braucht eine neue Frage.“

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
| Umfang | Genau diese Aktion über genau diesen Konnektor an genau diese Operation. Mit Empfängern: nur an die genannten Empfänger. Ohne Empfänger: nur Aktionen ohne Empfänger. Höchstens 20 Empfänger. |
| Inhalt | War der Text bei beiden Bestätigungen gleich, deckt die Regel nur genau diesen Text. War er verschieden, deckt sie nur Text, den du selbst geschrieben oder als Entwurf gesehen hast. Trug die Aktion keinen Text, deckt sie nur Aktionen ohne Text. |
| Dauer | 90 Tage ab dem Speichern. Danach fragt die Aktion wieder. |
| Tageslimit | 20 Ausführungen pro Tag, gezählt nach UTC. Danach fragt die Aktion bis zum nächsten Tag. |
| Modus | Gilt in **Fragen** und **Automatisch**, nicht in **Nur planen**. |
| Person | Gilt nur für dich, im Browser angemeldet. Andere Personen im Arbeitsbereich haben eigene Regeln. |

Zahlungen, Löschungen, Veröffentlichungen, Einstellungen, neue Konten und Zugangsdaten lassen sich nie als Regel speichern.

Läuft eine Aktion wegen einer Regel, steht in der Unterhaltung „…, laut deiner Regel“ mit dem Verweis **Regeln öffnen**.

### Regeln ansehen und widerrufen

1. Öffne **Einstellungen** und darin **Regeln**.
2. Unter **Aktiv** stehen deine Regeln mit Umfang, Datum und Nutzung, zum Beispiel „Zuletzt genutzt …“ und „Davor 2-mal von Hand erlaubt“. Unter **Angeboten** stehen Regeln, über die du noch nicht entschieden hast.
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
- **Die Wirkung liest SubKit aus der Operation.** Es schließt aus Methode, Pfad, Feldnamen und der Vorlage des Konnektors, ob etwas eine Zahlung, eine Löschung oder eine Veröffentlichung ist. Trägt eine Operation beim Dienst einen harmlosen Namen und löst trotzdem so etwas aus, erkennt SubKit das nicht.
- **SubKit prüft, was es sendet, nicht was der Dienst daraus macht.** Verteilt ein Dienst eine Nachricht an eine Liste weiter, sieht SubKit nur die Adresse der Liste.
- **Wenige ergänzte Wörter können den Ton ändern.** Der Inhalt bleibt deiner, aber Anrede, Gruß und bis zu drei Wörter kommen von SubKit.
- **Eine Regel mit wechselndem Text prüft die Herkunft, nicht den Sinn.** Sie deckt jeden Text, den du geschrieben oder als Entwurf gesehen hast, an die genannten Empfänger.
- **Verlängern geht noch nicht auf der Seite Regeln.** Die Seite zeigt weder das Ablaufdatum noch das Tageslimit und bietet kein Verlängern an. Eine abgelaufene Regel fragt jedes Mal, und SubKit bietet sie nicht erneut an. Verlängern lässt sie sich nur über die Route `POST /v1/approval-rules/{id}/renew` aus einer Browsersitzung.
- **Das Tageslimit und die Dauer sind fest.** Du kannst sie nicht einstellen.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Dieser Chat fragt vor jeder Aktion mit Wirkung nach außen.“ | Die Unterhaltung läuft im Modus **Fragen** oder **Nur planen**. Wähle **Einmal erlauben** oder stell den Modus auf **Automatisch**. |
| „Du hast diese Aktion nicht mit eigenen Worten verlangt.“ | Schreib den Auftrag als eigenen Satz, zum Beispiel „Schick die Zusammenfassung an anna@example.com“. |
| „Der Auftrag steht in eingefügtem oder zitiertem Text, nicht in deinen eigenen Worten.“ | Schreib den Auftrag über oder vor den eingefügten Text. |
| „Dein Auftrag enthielt eine Bedingung oder ein ‚nicht‘, deshalb fragt SubKit.“ | Prüfe die Karte und wähle **Einmal erlauben**, oder formuliere ohne Bedingung. |
| „Du hast diesen Empfänger nicht genannt.“ oder „Du hast dieses Ziel nicht genannt.“ | Nenne die Adresse oder das Ziel in deiner Nachricht. |
| „Die Aktion enthält einen Wert, den du nicht genannt hast.“ | Prüfe den Wert auf der Karte. Nenne ihn beim nächsten Mal selbst. |
| „Der Text stammt nicht von dir und du hast ihn noch nicht als Entwurf gesehen. Lies ihn, bevor er rausgeht.“ | Lies den **Inhalt** auf der Karte. Oder bitte zuerst um einen Entwurf und verlange danach das Senden. |
| „SubKit weiß nicht, was diese Operation bewirkt, deshalb fragt es.“ | Diese Operation fragt immer. Prüfe die Karte und entscheide. |
| „Du hast das einmal verlangt, und das ist schon gelaufen. Eine Wiederholung fragt erneut.“ | Soll es noch einmal laufen, wähle **Einmal erlauben**. |
| „Nur du selbst, im Browser angemeldet, kannst eine Aktion ohne diese Frage laufen lassen.“ | Du arbeitest mit einem API-Schlüssel oder aus einem anderen Client. Öffne die Unterhaltung im Cockpit. |
| „Die Regel wurde nicht gespeichert. Geändert wurde nichts; SubKit fragt weiterhin.“ | Wähle **Als Regel speichern** noch einmal. Bleibt es dabei, prüfe, ob du im Browser angemeldet bist. |

### Das Gleiche über die HTTP-API

Regeln gehören einer Person. Ein Systemkonto hat keine, und die Routen antworten ihm mit `403 person_required`.

| Route | Bewirkt |
| --- | --- |
| `GET /v1/approval-rules` | Listet deine angebotenen und aktiven Regeln. `?state=` filtert nach `offered`, `active`, `dismissed` oder `revoked`. |
| `POST /v1/approval-rules/{id}/accept` | Speichert eine angebotene Regel. Geht nur aus einer Browsersitzung. |
| `POST /v1/approval-rules/{id}/dismiss` | Lehnt eine angebotene Regel ab. Sie wird nicht erneut angeboten. |
| `POST /v1/approval-rules/{id}/renew` | Verlängert eine aktive Regel um 90 Tage ab jetzt, auch wenn sie schon abgelaufen ist. Geht nur aus einer Browsersitzung. |
| `DELETE /v1/approval-rules/{id}` | Widerruft eine aktive Regel. |

Passt der Zustand der Regel nicht zur Route, antwortet die Engine mit `409 approval_rule_wrong_state`. Alle Felder einer Regel stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
