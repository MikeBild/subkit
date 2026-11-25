---
slug: who-can-read-a-conversation
title: Wer eine Unterhaltung lesen kann
summary: Unterhaltungen gehören der Person, die sie begonnen hat. Gib eine fürs Team frei, wenn andere sie lesen sollen.
section: work
order: 20
audience: public
---
## Wer eine Unterhaltung lesen kann

Dieses Kapitel ist für alle, die mit SubKit im Cockpit, über einen MCP-Client oder in Slack und Google Chat schreiben.
Danach weißt du, wer eine Unterhaltung lesen kann, wie du sie mit dem Team teilst und wie du sie wieder privat machst.

### Privat ist der Standard

Jede Unterhaltung gehört der Person, die sie begonnen hat. Niemand sonst kann sie lesen, auch keine Administratorin und kein Administrator.

| Wer | Private Unterhaltung | Fürs Team freigegebene Unterhaltung |
| --- | --- | --- |
| Du als Besitzerin oder Besitzer | Lesen und schreiben | Lesen und schreiben |
| Andere im Arbeitsbereich mit `conversation:read` | Nicht sichtbar | Lesen und forken, nicht schreiben |
| Administratorinnen und Administratoren | Sehen, dass es sie gibt, wem sie gehört und wann sie entstand, und dürfen sie über die HTTP-API löschen (`DELETE /v1/conversations/{id}`) | Lesen und forken, löschen |

Für eine Unterhaltung, die du nicht lesen darfst, antwortet SubKit so, als gäbe es sie nicht. So verrät nichts, dass sie existiert. In der Liste der Unterhaltungen sehen Administratorinnen und Administratoren die private Unterhaltung einer anderen Person als **Private Unterhaltung**, ohne Titel und Inhalt. Die Suche in der Liste findet nie Text aus Unterhaltungen, die du nicht lesen darfst.

Für Unterhaltungen eines Task-Runs gilt weiter ihre eigene Regel: Lesen dürfen die Person, der der Task gehört, und Administratorinnen und Administratoren.

### Eine Unterhaltung mit dem Team teilen

1. Öffne die Unterhaltung im **Chat**.
2. Öffne das Menü in ihrem Kopf und wähle **Mit dem Team teilen**.
3. Die Rückfrage nennt die Unterhaltung und was sich ändert. Bestätige sie mit **Teilen**.

Das Badge im Kopf wechselt von **Privat** zu **Fürs Team freigegeben**. Die Unterhaltung wird nicht kopiert, es ändert sich nur, wer sie lesen kann. Du schreibst weiter darin. Andere können sie lesen und einen Fork anlegen, um allein weiterzumachen.

Nur du selbst kannst deine Unterhaltung teilen, angemeldet im Cockpit. Ein API-Key oder ein MCP-Client kann das nicht für dich tun.

### Wieder privat machen

Öffne das Menü noch einmal, wähle **Wieder privat machen** und bestätige mit **Privat machen**. Ab dann kannst nur du die Unterhaltung lesen. Forks, die andere schon angelegt haben, bleiben bei ihnen.

### Slack und Google Chat

Ein Thread in einem Kanal von Slack oder Google Chat ist von Anfang an fürs Team freigegeben, denn alle im Kanal sehen ihn ohnehin. Alle im Thread können weiter antworten. Eine Direktnachricht an SubKit bleibt privat.

Kanal-Threads, die vor dieser Änderung begonnen wurden, werden mit ihrer nächsten Nachricht fürs Team freigegeben.

### Wenn etwas nicht klappt

| Was du siehst | Was es bedeutet | Was du tun kannst |
| --- | --- | --- |
| Ein Link zu einer Unterhaltung meldet „nicht gefunden“ | Die Unterhaltung ist privat und gehört jemand anderem, oder sie wurde gelöscht. | Bitte die Besitzerin oder den Besitzer, sie zu teilen. |
| Eine Meldung, dass nur die Besitzerin oder der Besitzer schreiben darf | Die Unterhaltung ist freigegeben, gehört aber nicht dir. | Leg einen Fork an, um allein weiterzumachen. |
| **Mit dem Team teilen** fehlt im Menü | Die Unterhaltung gehört nicht dir oder zu einem Task-Run. | Frag die Besitzerin oder den Besitzer, oder leg einen Fork an. |
