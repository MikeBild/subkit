---
slug: notifications-and-quiet-hours
title: Benachrichtigungen und Ruhezeiten
summary: Lege fest, wann SubKit dich benachrichtigt und wer Freigabe-Hinweise bekommt.
section: work
order: 16
audience: public
---
## Benachrichtigungen und Ruhezeiten

Dieses Kapitel ist für alle, die von SubKit erfahren wollen, wenn etwas auf sie wartet, aber nicht zu jeder Zeit.
Danach kannst du Benachrichtigungen auf einem Gerät einschalten, sie auf deine Arbeitszeiten oder eine tägliche Zustellung begrenzen und Freigabe-Hinweise an eine andere Person leiten.

### Was dich benachrichtigt

SubKit meldet nur, was eine Person braucht: Etwas wurde angehalten, etwas schlägt fehl oder eine Entscheidung wartet.

| Weg | Was du bekommst | Wird durch Ruhezeiten verzögert |
| --- | --- | --- |
| Liste **Braucht dich** in der **Übersicht** | Jeden offenen Punkt mit Ursache und Handlung. | Nie. Die Liste ist immer aktuell. |
| Push im Browser oder in der installierten Web-App | Je Punkt eine Benachrichtigung. Ein Klick öffnet den Punkt. | Ja, nach deiner Wahl in **Einrichtung**. |
| SubKit Desktop | Eine Benachrichtigung des Betriebssystems und die Zahl am Symbol. | Nach den Ruhezeiten, die du in der App einstellst. |
| Abonnements, Webhooks und der `sk`-Eingang | Ereignisse für Programme und für das Terminal. | Nie. |

Eine Benachrichtigung sagt, was passiert ist und was zu tun ist. Namen von Workflows oder Konnektoren, Inhalte und Freigabe-Schaltflächen stehen im Browser-Push nie darin.

### Benachrichtigungen auf einem Gerät einschalten

1. Öffne **Einstellungen** und darin **Dein Profil**.
2. Unter „Möchtest du auf diesem Gerät benachrichtigt werden?“ schaltest du **Auf diesem Gerät benachrichtigen** ein.
3. Erlaube die Benachrichtigungen im Dialog deines Browsers.

Die Einstellung gilt nur für diesen Browser. Wiederhole sie auf jedem Gerät, auf dem du Hinweise willst.
Darüber steht unter „Ist SubKit auf diesem Gerät installiert?“, ob die App installiert ist und ob Benachrichtigungen an sind. Wie du installierst, steht in „Cockpit als App“.

### Festlegen, wann SubKit dich benachrichtigt

1. Öffne **Einstellungen** und darin **Einrichtung**.
2. Wähle bei **Benachrichtigungen** **Ändern**.
3. Beantworte „Wann darf SubKit dich benachrichtigen?“ und wähle **Übernehmen**.

| Auswahl | Was passiert |
| --- | --- |
| **Sofort** | Push kommt, sobald ein Punkt neu ist oder sich ändert. Das ist die Voreinstellung. |
| **Nur zu meinen Arbeitszeiten** | Du gibst **Von** und **Bis** an, vorbelegt mit 08:00 und 18:00. Darunter wählst du deine **Arbeitstage**; vorbelegt sind Montag bis Freitag, mindestens ein Tag muss gewählt sein. Außerhalb dieser Zeit und an den anderen Tagen hält SubKit den Push bis zum nächsten Beginn zurück. Ein Zeitraum über Mitternacht ist möglich und gehört zu dem Tag, an dem er beginnt. |
| **Einmal täglich als Zusammenfassung** | Du gibst **Um** an, vorbelegt mit 08:00. SubKit stellt höchstens einmal am Tag zu, sobald diese Uhrzeit erreicht ist. |

Was beim Zurückhalten passiert:

- Nichts geht verloren, was noch offen ist. Zur nächsten Zustellung meldet SubKit jeden neuen Punkt, der dann noch offen ist.
- Was sich in der Zwischenzeit erledigt hat, meldet SubKit nicht mehr.
- Zur täglichen Uhrzeit und zu Beginn deiner Arbeitszeit kommt bei mehr als einem neuen Punkt eine einzige Zusammenfassung, etwa „5 Einträge brauchen dich“ mit „2 Fehler, 3 Entscheidungen“. Sie öffnet den neuesten Punkt. Ein einzelner neuer Punkt kommt als gewohnte Benachrichtigung.
- Ist zur täglichen Uhrzeit nichts Neues offen, kommt keine Nachricht.
- Die Liste **Braucht dich** zeigt alles sofort, unabhängig von dieser Wahl.

Unter **Einstellungen › Benachrichtigungen** steht deine Wahl als Zeile „Aus deiner Einrichtung: …“ mit **Einrichtung öffnen**.

### Welche Zeitzone gilt

Die Uhrzeiten gelten in der Zeitzone des Arbeitsbereichs. Sie steht unter **Einstellungen › Arbeitsbereich** bei „In welcher Zeitzone arbeitet ihr?“. Geplante Abläufe richten sich nach derselben Zeitzone.

Arbeitest du in einer anderen Zeitzone als dein Team, kannst du eine eigene hinterlegen. Dafür gibt es im Cockpit noch kein Feld. Es geht über die HTTP-API mit dem Feld `timezone`, siehe unten.

### Dringendes trotz Ruhezeit bekommen

Zwei Arten von Punkten gelten als kritisch:

- Ein Workflow im Echtbetrieb wurde angehalten.
- Ein gespeichertes Geheimnis lässt sich nicht mehr lesen.

In der Voreinstellung warten auch diese Punkte auf deine nächste Zustellung. Mit der Einstellung `critical_breakthrough` kommen sie sofort, auch außerhalb der Arbeitszeiten und vor der täglichen Zustellung. Im Cockpit schaltest du sie in derselben Frage mit **Kritisches darf Ruhezeiten durchbrechen** ein; über die HTTP-API geht es auch, siehe unten.

### Freigabe-Hinweise an eine andere Person leiten

Gibt in deinem Team eine andere Person frei, was SubKit tun darf, leitest du die Hinweise dazu an sie.

1. Öffne **Einstellungen › Einrichtung** und wähle bei **Freigaben** **Ändern**.
2. Beantworte „Wer gibt frei, was SubKit tun darf?“ mit **Jemand anderes im Team** und gib die **E-Mail-Adresse** ein.
3. Wähle **Übernehmen**. Darunter steht danach „Freigabe-Hinweise gehen an …“.

Was dann gilt:

- Betroffen sind die Punkte, die eine Freigabe brauchen: eine Version wartet auf Freigabe, ein Zeitplan wartet auf eine Freigabe, eine Freigabe oder eine Dauererlaubnis endet bald oder fehlt.
- Diese Punkte lösen bei dir keinen Push mehr aus. Die andere Person bekommt ihn, wenn sie aktives Mitglied des Arbeitsbereichs ist und die Freigabe selbst erteilen darf. Darf sie das nicht, bleibt der Push bei dir.
- Eine vorbereitete Einladung trägt die Rolle **Mitglied**. Diese Rolle darf freigeben.
- In deiner Liste **Braucht dich** stehen die Punkte weiterhin, mit „Wartet auf Freigabe von …“. Darf die Person die Freigabe nicht erteilen, fehlt dieser Satz, und der Punkt bleibt deine Entscheidung.
- Ist die Person noch nicht im Arbeitsbereich, bleibt alles bei dir, bis sie beigetreten ist.

Was du unter der Auswahl liest:

| Was du liest | Bedeutung |
| --- | --- |
| „… ist in diesem Arbeitsbereich.“ | Die Hinweise gehen an diese Person. |
| „Für … liegt eine Einladung bereit, die noch nicht angenommen wurde.“ | Die Hinweise bleiben bei dir, bis die Person die Einladung annimmt. |
| „… ist noch nicht in diesem Arbeitsbereich. Ein Administrator muss diese Adresse erst einladen.“ | Bitte einen Administrator um die Einladung oder wähle **Personen öffnen**, wenn du selbst einer bist. Sobald die Adresse eingeladen ist, gilt deine Wahl von selbst; du musst sie nicht noch einmal treffen. |
| „… darf mit der aktuellen Rolle nichts freigeben. Freigabe-Mitteilungen bleiben bei dir, bis ein Administrator die Rolle ändert.“ | Bitte einen Administrator, der Person die Rolle **Mitglied** oder **Administrator** zu geben, oder nenne jemand anderen. |
| „Einladung vorbereitet“ | Du bist Administrator und hast eine unbekannte Adresse genannt. SubKit hat eine Einladung vorbereitet und keine E-Mail verschickt. Gib den **Einladungslink** selbst weiter. Er wird nur einmal angezeigt. |

### Grenzen

- **Die Wahl gilt für Push, nicht für die Desktop-App.** SubKit Desktop liest die Liste direkt und richtet sich nach den Ruhezeiten, die du in der App einstellst. Mehr in „SubKit Desktop“.
- **Die Zusammenfassung nennt nur die Anzahl je Art.** Welche Punkte es sind, zeigt die Liste **Braucht dich**.
- **Für `critical_breakthrough` und die eigene Zeitzone fehlt die Oberfläche.** Beide lassen sich nur über die HTTP-API setzen.
- **Eine Person ohne das Recht freizugeben bekommt keine Hinweise.** Ist die genannte Person aktives Mitglied, darf aber die Freigabe nicht erteilen, bleibt der Push bei dir, und **Einstellungen** › **Einrichtung** warnt dich. Deine Liste **Braucht dich** nennt die Person dann nicht, und der Punkt bleibt deine Entscheidung. Nenne eine Person, die freigeben darf.
- **Das Cockpit zeigt nicht an, auf wen ein Punkt wartet.** Die API liefert dafür das Feld `waiting_on`.
- **Bereits versendete Nachrichten lassen sich nicht zurückholen.** Stellst du auf Arbeitszeiten um, gilt das ab der nächsten Prüfung.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Browser-Berechtigung verweigert. Bitte in den Einstellungen erlauben.“ | Erlaube Benachrichtigungen für die Cockpit-Adresse in den Einstellungen deines Browsers. |
| Es kommt kein Push, obwohl etwas offen ist | Prüfe unter **Einstellungen › Benachrichtigungen** die Zeile „Aus deiner Einrichtung“. Außerhalb der Arbeitszeiten und vor der täglichen Uhrzeit hält SubKit Push zurück. |
| Push kommt zur falschen Stunde | Prüfe die Zeitzone des Arbeitsbereichs unter **Einstellungen › Arbeitsbereich**. |
| „Gib eine Uhrzeit ein, zum Beispiel 08:00.“ | Schreib die Uhrzeit mit vier Ziffern und Doppelpunkt. |
| „Die Einstellung wurde nicht übernommen“ | Geändert wurde nichts. Deine bisherige Wahl gilt weiter. Versuch es erneut. |
| Die andere Person bekommt keine Freigabe-Hinweise | Prüfe, ob sie Mitglied ist, Push auf ihrem Gerät eingeschaltet hat und freigeben darf. |

### Das Gleiche über die HTTP-API

`GET /v1/identity/me/setup` liest deine Wahl, `PUT /v1/identity/me/setup` ändert sie. Felder, die du weglässt, behalten ihren Wert.

```bash
curl -s -X PUT "$SK_URL/v1/identity/me/setup" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"notifications":{"mode":"working_hours","from":"08:00","to":"18:00","days":[1,2,3,4,5]},"timezone":"Europe/Berlin","critical_breakthrough":true}'
```

Alle Felder stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
