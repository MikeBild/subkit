---
slug: send-feedback
title: Einen Fehler melden
summary: Schick einen Fehlerbericht, eine Idee oder anderes Feedback in den Eingang deines Arbeitsbereichs.
section: work
order: 19
audience: public
---
## Einen Fehler melden

Dieses Kapitel ist für alle, denen im Cockpit oder in SubKit Desktop etwas auffällt.
Danach kannst du einen Fehlerbericht mit Diagnosedaten senden und weißt, was dabei verschickt wird, was vorher entfernt wird und wer den Bericht lesen kann.

### Wohin ein Bericht geht

Ein Bericht verlässt deinen SubKit-Server nicht. Er landet als Eintrag im **Eingang** deines Arbeitsbereichs, in der Kategorie `feedback`. Niemand außerhalb bekommt ihn automatisch, auch nicht der Hersteller von SubKit.

Lesen kann ihn jede Person in deinem Arbeitsbereich, die den **Eingang** sehen darf (`intake:read`). Das sind Administratoren und Mitglieder, nicht Anwender.

### Einen Bericht senden

1. Wähle **Fehler melden** im Seitenkopf, neben dem Schalter der Seitenleiste. Denselben Dialog öffnen **Fehler melden …** im **Benutzermenü** und **Fehler melden** in den **Technischen Angaben** eines Fehlerhinweises.
2. Wähle unter **Art des Feedbacks** **Fehler**, **Idee** oder **Sonstiges**.
3. Beschreib, was du tun wolltest und was stattdessen passiert ist.
4. Hänge bei Bedarf mit **Datei anhängen** bis zu 3 Dateien mit je 2 MB an: PNG, JPG, PDF, TXT oder JSON.
5. Lass **Diagnosebericht anhängen** eingeschaltet oder schalte es aus. **Ansehen** zeigt genau, was mitgeht.
6. Prüfe Text und Dateien auf private Angaben und wähle **Feedback senden**.

Der Dialog sagt dir vor dem Senden zwei Dinge: Neben **Datei anhängen** steht, dass Bilder und PDFs unverändert gesendet werden. Über **Feedback senden** steht, dass der Bericht im **Eingang** deines Arbeitsbereichs landet, wer ihn dort liest und dass dein Text bis auf Geheimnisse und Dateipfade so gesendet wird, wie du ihn schreibst.

Du liest danach „Danke für dein Feedback!“. Öffnest du den Dialog aus einem Fehlerhinweis, sind Fehler, Ursache, Code, Anfrage-ID und Zeit schon eingetragen.

Schlägt das Senden fehl, bleibt dein Entwurf erhalten: die Art, der Text und die Wahl zum Diagnosebericht. Dateien und das Bildschirmfoto wählst du neu.

### Was mitgeschickt wird

| Teil | Inhalt |
| --- | --- |
| Deine Angaben | Die Art des Feedbacks und dein Text. |
| Dateien | Was du selbst anhängst. |
| Diagnosebericht, wenn eingeschaltet | **App** (Browser, Desktop-App oder Installierte Web-App), **App-Version**, **Betriebssystem**, **Server-Version**, **Verbindungsstatus**, **Seite** und die **Letzten 10 Fehlermeldungen** mit Code und Zeit. |
| Bildschirmfoto, nur in SubKit Desktop und nur wenn du es anhakst | Ein Bild des Cockpit-Fensters. |

Von der **Seite** geht nur der Pfad mit, ohne Parameter. Inhalte deiner Workflows, Runs oder Unterhaltungen gehen nicht mit, außer du schreibst sie in den Text oder hängst sie an.

### Was vor dem Speichern entfernt wird

Das Cockpit bereinigt den Diagnosebericht vor dem Senden, und der Server bereinigt den ganzen Bericht noch einmal, bevor er ihn speichert.

| Was | Wo | Wird ersetzt durch |
| --- | --- | --- |
| Zugangsdaten in Headern wie `Authorization` und `Cookie`, Tokens nach `Bearer`, `Basic` oder `Token`, benannte Geheimnisse wie `password`, `api_key`, `client_secret` und Zeichenfolgen, die wie ein Geheimnis aussehen | Text, Diagnosebericht, Textdateien, Dateinamen | `[removed]` |
| Parameter, Fragment und Benutzerangaben in Adressen | Text, Diagnosebericht, Textdateien, Dateinamen | Die Adresse bleibt ohne diese Teile. |
| Absolute Dateipfade | Text, Diagnosebericht, Textdateien, Dateinamen | `[path]` |
| E-Mail-Adressen | Diagnosebericht, Textdateien, Dateinamen | `[email]` |

Der gespeicherte Eintrag nennt unter „Removed before storing“, wie viele Stellen entfernt wurden.

### Das Bildschirmfoto in SubKit Desktop

In SubKit Desktop bietet der Dialog zusätzlich ein **Bildschirmfoto des Fensters** an. Im Browser und in der installierten Web-App gibt es das nicht.

1. Wähle **Fehler melden …** im Menü der App, im Menü **Hilfe** oder am Symbol in der Menüleiste. Die App nimmt das Bild auf, bevor der Dialog erscheint, damit der Dialog nicht darauf ist.
2. Sieh dir das Bild im Dialog an.
3. Hake **Dieses Bild des Fensters anhängen** nur an, wenn nichts Vertrauliches zu sehen ist. Das Häkchen ist nie vorbelegt.

Passwortfelder und Felder für Geheimnisse sind im Bild ausgeblendet. Was offen im Fenster steht, zum Beispiel ein gerade erstellter API-Key, bleibt sichtbar.

Ist die App nicht angemeldet, öffnet **Fehler melden …** stattdessen den Dialog **Diagnosedaten**. Die Daten enthalten App-Version, Betriebssystem, Server-Version und die letzten 10 Fehler.

- Nimmt dein Server Meldungen ohne Anmeldung an, bietet der Dialog **An den Server senden**. Die App schickt die Diagnosedaten dann mit ihrer Geräte-ID, und du liest „Danke, deine Meldung ist angekommen.“
- Sonst, etwa bei einem älteren Server, bietet er nur **Diagnose kopieren** und **Als Datei speichern …**. Füg die Daten deiner Meldung an die Person bei, die deinen Server betreibt.

### Einen Bericht offline schreiben

Erreicht SubKit den Server nicht, schreib den Bericht trotzdem und wähle **In Warteschlange**. SubKit sendet ihn, sobald die Verbindung wieder steht, einen Bericht nach dem anderen, und behält den Zeitpunkt, zu dem du ihn geschrieben hast. Wurdest du zwischendurch abgemeldet, wartet er bis zur nächsten Anmeldung. Jeder Bericht kommt nur einmal an, auch wenn ein Versand wiederholt wird. Ein Bericht, der sich in 14 Tagen nicht senden ließ, verfällt.

### Grenzen

- **E-Mail-Adressen in deinem Text bleiben stehen.** Das ist Absicht: Dein Text gehört dir und wird gesendet, wie du ihn schreibst. Der Server entfernt daraus nur Geheimnisse und Dateipfade. E-Mail-Adressen entfernt er aus dem Diagnosebericht, aus Textdateien und aus Dateinamen.
- **Bilder und PDFs werden nicht bereinigt.** Das gilt auch für das Bildschirmfoto. Der Dialog sagt das neben **Datei anhängen**. Sieh sie dir an, bevor du sendest.
- **Kein eigener Leserkreis für Feedback.** Die Kategorie `feedback` hat dieselben Leser wie der übrige **Eingang**: Administratoren und Mitglieder. Ein Bericht nur für Administratoren ist nicht vorgesehen.
- **Die Überschrift des Eintrags ist englisch.** Sie beginnt mit „Bug report:“, „Idea:“ oder „Feedback:“, gefolgt von der ersten Zeile deines Textes.
- **Zwei verschiedene Marken.** Das Cockpit schreibt im deutschen Diagnosebericht `[entfernt]`, der Server `[removed]`, `[email]` und `[path]`.
- **Fünf Berichte in zehn Minuten.** Danach bittet dich der Dialog, ein paar Minuten zu warten.
- **Kein API-Schlüssel.** Mit einem API-Schlüssel oder aus der Kommandozeile `subkit` lässt sich kein Bericht senden.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Feedback nicht gesendet“ mit „Dein Entwurf ist gespeichert und wurde nicht verworfen. …“ | Versuch es gleich noch einmal. |
| „Du hast in kurzer Zeit mehrere Meldungen gesendet. …“ | Warte ein paar Minuten und sende dann. |
| „Der Server hat eine angehängte Datei nicht angenommen. …“ | Entferne die Datei. Erlaubt sind PNG, JPG, PDF, TXT und JSON mit höchstens 2 MB. |
| „Höchstens 3 Dateien.“ oder „Höchstens 2 MB pro Datei.“ | Wähle weniger oder kleinere Dateien. |
| „Diese Datei ließ sich nicht lesen. …“ | Wähle die Datei noch einmal oder nimm eine andere. |
| In SubKit Desktop fehlt das Bildschirmfoto | Das Fenster war verdeckt, oder das Bild war zu groß. Sende ohne Bild oder hänge ein eigenes an. |

### Das Gleiche über die HTTP-API

`POST /v1/feedback` nimmt einen Bericht an. Die Route arbeitet nur mit einer Browsersitzung und braucht kein eigenes Recht. Sie antwortet mit `201` und den Feldern `id`, `intake_item_id` und `replayed`. `replayed` ist `true`, wenn dieselbe `client_request_id` schon abgelegt wurde.

Alle Felder, Grenzen und Fehlercodes stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.

### Ohne Anmeldung

Auf der Anmeldeseite öffnet **Fehler melden** ein kurzes Formular: was passiert ist, eine E-Mail-Adresse für Rückfragen (optional) und ein Bildschirmfoto (optional, PNG oder JPG mit höchstens 2 MB). **Meldung senden** legt es ohne Anmeldung ab.

Hinter dem Formular und dem Button in SubKit Desktop steht `POST /v1/feedback/anonymous`. Die Route braucht keine Sitzung und keinen Schlüssel. Sie nimmt dieselben Felder an, dazu `device_id` aus SubKit Desktop und eine optionale `contact_email`.

- **Wohin:** in den **Eingang** des Betreiber-Arbeitsbereichs, in die Kategorie `feedback`. Als Sammler nennt der Eintrag `anonymous`. Ohne Betreiber-Arbeitsbereich antwortet der Server mit `503 feedback_unavailable`.
- **Was entfernt wird:** dasselbe wie bei einem Bericht aus dem Cockpit.
- **Wie viele:** 3 Berichte in 10 Minuten je Adresse, 3 je Desktop-Gerät und 60 für den ganzen Server. Danach antwortet der Server mit `429` und `Retry-After`.
- **Wie groß:** höchstens 6 MB für die ganze Anfrage. Die Grenzen je Datei bleiben gleich; eine größere Anfrage lehnt der Server mit `413` ab.
- **Von einer fremden Seite:** Eine Browser-Anfrage von einer fremden Seite lehnt der Server mit `403 csrf_rejected` ab.
- **Wiederholen:** Eine wiederholte `client_request_id` liefert den gespeicherten Bericht, zählt aber trotzdem gegen die Grenzen.

Der Service-Descriptor nennt die Route als `clients.desktop.anonymous_feedback_path`.
