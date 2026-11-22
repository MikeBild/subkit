---
slug: set-subkit-up-for-yourself
title: SubKit auf dich einstellen
summary: Beantworte fünf Fragen und lege fest, wie SubKit für dich arbeitet.
section: work
order: 13
audience: public
---
## SubKit auf dich einstellen

Dieses Kapitel ist für alle, die zum ersten Mal ins Cockpit kommen oder ihre Voreinstellungen ändern wollen.
Danach hast du den Schritt „So arbeitet SubKit für dich“ beantwortet und weißt, was jede der fünf Antworten einstellt und wo du sie später änderst.

### Was du brauchst

- Ein Konto in einem Arbeitsbereich mit der Rolle Administrator oder Mitglied. Der Schritt erscheint nur mit dem Recht `settings:write`. Anwender sehen ihn nie.
- Zwei Minuten Zeit. Jede Frage hat eine empfohlene Antwort.

### Den Schritt „So arbeitet SubKit für dich“ beantworten

Der Schritt erscheint einmal, nach deiner ersten Anmeldung in einem Arbeitsbereich.

1. Lies die Frage und wähle eine Antwort. Was jede Antwort bewirkt, steht unter **Einstellungen** › **Einrichtung** in der Zeile „Stellt ein: …“. Die empfohlene Antwort trägt den Zusatz **empfohlen**.
2. Wähle **Weiter**, bis alle fünf Fragen beantwortet sind.
3. Prüfe die Zusammenfassung „Das stelle ich für dich ein“. Mit **Ändern** korrigierst du eine einzelne Antwort.
4. Wähle **So übernehmen**.

Mit **Jetzt nicht** überspringst du den Schritt. SubKit übernimmt dann die empfohlenen Einstellungen und fragt nicht noch einmal.

### Die fünf Antworten und was sie einstellen

| Frage | Auswahl | Stellt ein |
| --- | --- | --- |
| „Was soll SubKit als Erstes für dich erledigen?“ | **Rechnungen ablegen**, **Tageszahlen per Mail**, **Woche zusammenfassen**, **Offene Tickets auflisten**, **Preisseite beobachten**, **Nach Zahlung Zugang freischalten** oder **Etwas anderes** mit eigenem Text | Den ersten Vorschlag im Chat und den ersten Punkt der „Ersten Schritte“. |
| „Welche Dienste nutzt du dafür?“ | Gmail, Google Drive, Google Sheets, Slack, Jira, GitHub, Notion, HubSpot, Stripe oder **Anderer Dienst** | Welche Connectors die „Ersten Schritte“ zuerst anbieten. |
| „Wer gibt frei, was SubKit tun darf?“ | **Ich selbst** (empfohlen), **Jemand anderes im Team** oder **Wir zu zweit: einer baut, einer gibt frei**, jeweils mit E-Mail-Adresse | Wer Freigabe-Hinweise bekommt, ob eine Einladung vorbereitet wird und, bei „Wir zu zweit“, ob jede Workflow-Freigabe zwei Personen braucht. |
| „Wo soll Neues zuerst laufen?“ | **Erst im Test** (empfohlen) oder **Direkt im Echtbetrieb** | Die Standardumgebung für neue Workflows und Aufgaben. |
| „Wann darf SubKit dich benachrichtigen?“ | **Sofort** (empfohlen), **Nur zu meinen Arbeitszeiten** oder **Einmal täglich als Zusammenfassung** | Benachrichtigungen und Ruhezeiten. |
| „Wie viel darf SubKit im Monat für KI ausgeben?“ (nur Administratoren) | **20 $**, **50 $** (empfohlen), **200 $** oder **Ohne Grenze** | Das monatliche KI-Budget des Arbeitsbereichs. |

Als Administratorin oder Administrator bekommst du diese sechste Frage. Das KI-Budget gilt für den ganzen Arbeitsbereich; was bei 80 % und 100 % passiert, steht in „Nutzung und Kosten im Blick“. Unter **Einstellungen** › **Einrichtung** führt diese Zeile zu **Einstellungen** › **Budget**, der einen Stelle, an der das Budget geändert wird.

Die ersten beiden Antworten ändern nur, was dir das Cockpit zuerst vorschlägt. Sie verbinden keinen Dienst und legen keinen Workflow an. Die anderen drei ändern, wie SubKit arbeitet:

- **Standardumgebung.** Eine neue Aufgabe und die Prüfung eines neuen Workflows starten in dieser Umgebung. Die Umgebung eines einzelnen Workflows oder einer Aufgabe wählst du weiterhin selbst.
- **Freigaben und Benachrichtigungen.** Beides ist in „Benachrichtigungen und Ruhezeiten“ beschrieben.

### Wir zu zweit: einer baut, einer gibt frei

Mit dieser Antwort braucht jede Workflow-Freigabe im Arbeitsbereich zwei verschiedene Personen. Die erste Person gibt frei, die Freigabe wartet, und erst die Freigabe einer zweiten Person, die freigeben darf, lässt den Workflow laufen. Niemand gibt allein frei, auch nicht im Chat oder über eine Aufgabe.

- Einschalten darf das nur eine Administratorin oder ein Administrator. Bist du keine bzw. keiner, liest du, dass jemand mit diesen Rechten es einschalten muss.
- Es braucht mindestens zwei Personen, die freigeben dürfen. Ist die genannte Person noch nicht beigetreten, startet die Freigabe zu zweit von selbst, sobald sie beigetreten ist.
- Eine wartende Freigabe endet nach 72 Stunden. Sie endet auch, wenn sich der Workflow vor der zweiten Freigabe ändert.
- Wählst du später **Ich selbst**, bleibt die Freigabe zu zweit eingeschaltet. Ausschalten kann sie nur eine Administratorin oder ein Administrator, und das Audit-Log hält es fest.

„Referenz: Freigabe zu zweit, Einladungen, Offline-Berichte und Benachrichtigungspause“ listet Routen und Zustände.

### Antworten später ändern

1. Öffne **Einstellungen** und darin **Einrichtung**.
2. Wähle bei der Antwort, die du ändern willst, **Ändern**.
3. Wähle die neue Antwort und dann **Übernehmen**. Du liest „Einstellung übernommen“.

Jede Änderung wirkt sofort auf die genannte Einstellung.

Wann SubKit vor einem Schritt fragt, ist keine Antwort der Einrichtung. Das entscheiden dein Auftrag und deine Regeln; wie, steht in „Wann SubKit fragt“, auch die Regel **Immer vorher fragen**.

Die Übersicht der **Einstellungen** zeigt deine Wahl in einer Zeile, zum Beispiel „Erst im Test · Sofort“.

### Gut zu wissen

- Die Antworten gehören dir, nicht dem Arbeitsbereich. Jede Person stellt SubKit für sich ein.
- Der Audit-Trail hält jede Änderung als „Einrichtung geändert“ fest.
- Die empfohlenen Werte sind: **Erst im Test**, **Ich selbst** und **Sofort**, für Administratoren außerdem **50 $** als monatliches KI-Budget.
- Nennst du als Administrator eine Adresse, die noch nicht im Arbeitsbereich ist, bereitet SubKit eine Einladung vor und verschickt keine E-Mail. Die eingeladene Person kommt als Mitglied in den Arbeitsbereich; neben dem Feld steht deshalb „Rolle: Mitglied“. Diese Rolle darf freigeben.
- Nennst du eine Person, deren Rolle nicht freigeben darf, speichert SubKit die Wahl und warnt unter **Einstellungen** › **Einrichtung**: „… darf mit der aktuellen Rolle nichts freigeben. Freigabe-Mitteilungen bleiben bei dir, bis ein Administrator die Rolle ändert.“
- Nennst du ohne Administrator-Rolle eine unbekannte Adresse, wird sie gespeichert, aber niemand eingeladen. Sobald ein Administrator die Adresse einlädt oder anlegt, verknüpft SubKit deine Wahl von selbst; die Hinweise gehen an die Person, sobald sie beigetreten ist.
- Wählst du **Nur zu meinen Arbeitszeiten**, gibst du neben **Von** und **Bis** deine **Arbeitstage** an. Vorbelegt sind Montag bis Freitag.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Die empfohlenen Einstellungen wurden nicht gespeichert“ | Geändert wurde nichts. Mit **Ohne Speichern weiter** arbeitest du mit den empfohlenen Einstellungen weiter. Dieser Browser merkt sich deine Wahl; in einem anderen Browser erscheint der Schritt noch einmal. |
| „Die Einstellung wurde nicht übernommen“ | Deine bisherige Wahl gilt weiter. Versuch es erneut. |
| „Deine Einrichtung konnte nicht geladen werden“ | Wähle **Erneut versuchen**. |
| „Gib eine gültige E-Mail-Adresse ein, zum Beispiel anna@example.com.“ | Prüfe die Adresse der Person, die freigeben soll. |
| „Wähl mindestens einen Dienst.“ | Wähle einen Dienst oder **Anderer Dienst**. |
| Der Schritt erscheint nicht | Du hast ihn schon beantwortet oder mit **Jetzt nicht** übersprungen, oder dir fehlt `settings:write`. Deine Antworten stehen unter **Einstellungen › Einrichtung**. |

### Das Gleiche über die HTTP-API

`GET /v1/identity/me/setup` liest deine Antworten. Das Feld `unset` nennt, was du noch nicht gewählt hast, und `recommended` die empfohlenen Werte.
`PUT /v1/identity/me/setup` speichert Antworten. Felder, die du weglässt, behalten ihren Wert.

```bash
curl -s -X PUT "$SUBKIT_URL/v1/identity/me/setup" \
  -H "Authorization: Bearer $SUBKIT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ask_before_writing":true,"default_environment":"dev"}'
```

Alle Felder stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
