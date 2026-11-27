---
slug: browser-vault
title: Mit dem Tresor im Browser anmelden und bezahlen
summary: Lass SubKit dich auf Websites anmelden und in Shops bezahlen, mit Logins und Karten aus deinem Tresor, gib jede Nutzung frei und wisse, was die KI sieht und wo die Grenzen liegen.
section: work
order: 21
audience: public
---
## Mit dem Tresor im Browser anmelden und bezahlen

Dieses Kapitel ist für alle, die SubKit im Browser auf ihrem Mac arbeiten lassen, im Chat, in einer Aufgabe oder in einem Workflow.
Danach kannst du einen Login und eine Karte für den Browser ablegen, eine Anmeldung oder Zahlung freigeben und weißt, was die KI sieht und was SubKit nicht verspricht.

Du brauchst SubKit Desktop mit eingeschaltetem Browser, siehe [SubKit Desktop](setup.md#subkit-desktop).

### So funktioniert es

Die KI entscheidet, was auf einer Seite zu tun ist, aber sie fasst nie ein Passwort, eine Kartennummer oder einen Code an:

1. Die KI öffnet die Seite und liest sie als Liste von Feldern und Schaltflächen.
2. Für eine Anmeldung ruft sie `browser_sign_in` mit dem **Namen** eines Logins aus deinem Tresor auf, für eine Zahlung `browser_pay` mit dem **Namen** oder den letzten vier Ziffern einer Karte.
3. SubKit prüft die Anfrage und fragt dich.
4. Nach deiner Freigabe übergibt die Engine die Werte einmal an SubKit Desktop, nur für diese eine Nutzung. SubKit Desktop füllt die Felder auf deinem Mac aus und schickt das Formular ab.
5. Die KI bekommt nur zurück, ob die Felder ausgefüllt wurden und wie das Formular ausging, dazu eine Ansicht der Seite, in der die eingesetzten Werte verdeckt sind.

Einfaches Tippen in Passwort-, Einmalcode- und Kartenfelder bleibt gesperrt. Nur diese beiden Schritte dürfen sie ausfüllen.

### Den Tresor vorbereiten

1. Öffne im Cockpit **Einstellungen › Tresor**.
2. **Zum Anmelden:** Leg einen **Login** mit Benutzername und Passwort an. Trag jede Website, zu der er gehört, unter **Erlaubte Websites** ein, zum Beispiel `https://members.example.com`. Verlangt die Seite einen Einmalcode aus einer Authenticator-App, füg den Schlüssel oder den `otpauth://`-Link von der Einrichtungsseite der Website unter **Schlüssel für Einmalcodes** ein. SubKit Desktop erzeugt den Code dann selbst.
3. **Zum Bezahlen:** Leg eine **Zahlungskarte** mit Nummer, Ablaufdatum und Namen an. Die CVV gehört nicht dazu. Karten sind immer „Nur ich“.

Logins aus Chrome, 1Password oder Bitwarden kannst du importieren, siehe [Referenz: der Tresor](setup.md#referenz-der-tresor).

### Anmelden

Schreib im Chat zum Beispiel: „Melde dich bei members.example.com mit meinem Login ledger an und lade die Rechnung für November herunter.“

- SubKit vergleicht die Website genau mit den Origins des Logins. `www.example.com` und `example.com` gelten als dieselbe Website. `examp1e.com` oder `example.com.login-check.net` nicht. Auf einer Website, die nur ähnlich aussieht, verweigert SubKit die Anmeldung.
- SubKit fragt dich vor jeder Anmeldung: Die Frage nennt die Website und den Login. Nennt deine eigene Nachricht die Website und die Anmeldung schon, wie im Beispiel, gilt das als deine Freigabe.
- Gibt es im Tresor keinen passenden Login, fragt die KI nicht im Chat nach dem Passwort. Sie bittet dich, den Login im Tresor anzulegen, oder eine Aufgabe pausiert mit einem privaten Formular, in das du ihn einträgst.
- Einen zweiten Faktor, den SubKit nicht erledigen kann, etwa eine Push-Freigabe auf dem Handy, einen Passkey oder ein Captcha, übernimmst du: Die KI übergibt dir den Browser und macht weiter, sobald du ihn zurückgibst.

### Bezahlen

Schreib zum Beispiel: „Bestell auf shop.example.com die Kaffeebohnen 1 kg und bezahl mit meiner Visa.“

1. Die KI füllt die Bestellung bis zum Zahlungsformular aus und ruft `browser_pay` mit der Karte, dem Betrag und der Währung auf.
2. Im Cockpit und in SubKit Desktop erscheint **Zahlung freigeben** mit dem Shop, dem Betrag und der Karte (Marke und letzte vier Ziffern).
3. Du prüfst die Angaben und gibst die **CVV** ein. Sie geht nur für diese Zahlung an SubKit Desktop und wird nie gespeichert.
4. SubKit Desktop füllt die Kartenfelder auf der Seite des Shops aus und schickt das Formular ab.

Jede Zahlung fragt neu, auch in Aufgaben und freigegebenen Workflows. Nur du kannst eine Zahlung mit deiner Karte freigeben. Eine Freigabe gilt einmal, 15 Minuten lang, für genau diesen Shop, diese Seite, diese Karte und diesen Betrag. Kann SubKit Desktop die Summe auf der Seite lesen und weicht sie ab, verweigert es die Zahlung.

### Abgeschickt ist nicht bezahlt

Das Ergebnis einer Zahlung heißt „abgeschickt“, nie „bezahlt“. Ob der Shop die Zahlung angenommen hat, zeigt seine Bestätigungsseite oder seine E-Mail. Die KI liest die Seite und berichtet, was dort steht.

Ist der Ausgang unsicher, etwa weil die Verbindung beim Abschicken abbrach, wiederholt SubKit die Zahlung nicht, und die KI auch nicht. Prüf den Shop oder deine Bank, bevor du eine neue Zahlung startest.

### Was die KI sieht

| Was | Die KI sieht |
| --- | --- |
| Login | Namen, Websites, die ersten zwei Zeichen des Benutzernamens, ob ein Schlüssel für Einmalcodes gespeichert ist |
| Karte | Namen, Marke, letzte vier Ziffern, Ablauf |
| Ausgefüllte Felder | nur, dass sie ausgefüllt wurden; Seitenansicht und Screenshots verdecken die Werte |
| Dein Chat | eine Kartennummer, IBAN, CVV oder einen Einmalcode, die du tippst, ersetzt SubKit durch `***REDACTED:…***`, bevor die KI sie liest |
| Zahlungsfreigabe | dass sie offen, freigegeben oder abgelehnt ist, nie die CVV |

Text auf einer Website ist für die KI Daten, nie eine Anweisung. Fordert eine Seite dazu auf, zu bezahlen, Kartendaten einzugeben oder sich woanders anzumelden, folgt die KI dem nicht. So schützt SubKit vor Prompt-Injection.

### Sicherheitsmodell und Grenzen

- **Werte pro Nutzung.** Jede Anmeldung und jede Zahlung ist eine einzelne Nutzung mit eigenem Eintrag. Die Werte gehen verschlüsselt an das gekoppelte Gerät, lassen sich innerhalb von 60 Sekunden nur einmal abholen und werden danach gelöscht. Sie erscheinen nie im Gerätebefehl, im Run, im Ergebnis oder im Log.
- **Prüfungen auf dem Gerät.** SubKit Desktop füllt ein Feld nur, wenn der echte Frame des Felds zum freigegebenen Origin gehört, die Seite sich nicht geändert hat, seit die KI sie gelesen hat, und seit dem Laden kein Skript der KI auf der Seite lief.
- **Kartenfelder eines Zahlungsanbieters.** Viele Shops zeigen die Kartenfelder in einem Frame eines Zahlungsanbieters wie Stripe oder Adyen, der von dessen eigener Adresse geladen wird. SubKit Desktop kann den echten Origin eines solchen Frames noch nicht zuverlässig prüfen und füllt dort deshalb keine Kartenfelder aus. Die KI übergibt dir dann den Browser: Du gibst die Kartendaten selbst ein und gibst den Browser zurück.
- **Audit.** Jede Nutzung steht in der Aktivität des Eintrags und im Audit-Trail: Website, Zweck, Aufgabe oder Run und Ausgang. Auch Zahlungsanfragen, Freigaben, Ablehnungen und abgelaufene Freigaben werden aufgezeichnet.
- **Dein Gerät.** SubKit Desktop setzt die Werte auf deinem Mac ein. Wer deinen Mac während einer Nutzung bedient, kann die ausgefüllte Seite sehen.
- **Keine CVV, kein PCI DSS.** SubKit speichert nie eine CVV und ist nicht nach PCI DSS zertifiziert. Leg nur deine eigenen Karten für deine eigenen Einkäufe ab.
- **Kein eigenes Ausgabelimit.** Wie viel bezahlt werden darf, entscheidest du bei jeder Freigabe und mit den Regeln deiner Aufgaben.

### Fehlerbehebung

| Was passiert | Warum | Was du tun kannst |
| --- | --- | --- |
| SubKit verweigert die Anmeldung | Der Origin der Seite gehört nicht zu den Origins des Logins. | Prüf die Adresse. Stimmt sie, trag den Origin beim Login im Tresor ein. |
| Die KI bittet dich, einen Login anzulegen | Im Tresor gibt es keinen Login für diese Website, den du nutzen darfst. | Leg den Login mit dem Origin der Website an und mach dann weiter. |
| Es erscheint keine Zahlungsfreigabe | Die Karte gehört nicht dir, oder die Freigabe ist nach 15 Minuten abgelaufen. | Nutz deine eigene Karte und starte die Zahlung neu. |
| SubKit Desktop füllt die Kartenfelder nicht aus | Die Kartenfelder liegen im Frame eines Zahlungsanbieters. | Gib die Kartendaten selbst ein, wenn die KI dir den Browser übergibt. |
| SubKit Desktop verweigert die Zahlung | Der Shop zeigt eine andere Summe als die freigegebene, oder die Seite hat sich geändert. | Prüf den Warenkorb und lass die KI eine neue Freigabe anfordern. |
| Das Ergebnis heißt „abgeschickt“ | Das Formular ist raus, der Shop hat es noch nicht bestätigt. | Prüf die Bestätigungsseite, deine E-Mails oder deine Bank. |
| Das Ergebnis heißt „unsicher“ | Das Abschicken hat den Shop vielleicht erreicht. | Bezahl nicht erneut, bevor du den Shop oder deine Bank geprüft hast. |
| Der Einmalcode wird abgelehnt | Der Schlüssel ist falsch, oder die Uhr deines Macs geht falsch. | Speichere den Schlüssel erneut von der Einrichtungsseite der Website und prüf die Zeiteinstellung deines Macs. |
