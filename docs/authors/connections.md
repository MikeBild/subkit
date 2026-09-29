# Zugriff in deinem Namen und Freigaben

> Wie du SubKit ein anderes System in deinem Namen nutzen lässt, ohne einen Schlüssel einzutippen — und wie eine vorbereitete Änderung an dieser Installation auf deine Freigabe wartet.

Beides findest du im Cockpit unter **Installation**: den Zugriff in deinem Namen im Bereich
**Zugriff in deinem Namen** der Seite **Zugangsdaten**, die vorbereiteten Änderungen oben auf
**Einstellungen**.

**Zugangsdaten** beantwortet eine Frage: Wer darf auf SubKit zugreifen — und worauf greift
SubKit in deinem Namen zu? Die Seite hat drei Bereiche, als Reiter (auf dem Telefon als
Auswahl), jeder mit eigener Adresse:

| Bereich | Wann brauchst du ihn? | Beispiel |
|---|---|---|
| **Apps mit Zugriff auf SubKit** | Claude, ChatGPT oder ein anderes Programm, dem du SubKit freigegeben hast. Hinzufügen startest du in der App selbst; hier siehst du, wer darf, und entziehst den Zugriff. | Claude Code nutzt SubKit — siehe [Use sk from a coding agent](coding-agents.md). |
| **Schlüssel für Skripte** | Ein eigenes Skript, ein Cronjob oder CI ruft SubKit auf. **Schlüssel erstellen** legt einen an. | Ein nächtlicher Export. |
| **Zugriff in deinem Namen** | SubKit darf ein anderes System in deinem Namen nutzen. Du meldest dich dort einmal an, kein Schlüssel nötig. **Verbinden** startet es. | Ein Workflow liest aus WikiKit. |

Jede Zeile in **Zugriff in deinem Namen** ist eine *Kontoverbindung*: ein System, bei dem
du SubKit einmal freigegeben hast. Jede Zeile zeigt ihren Zustand; **Erneuern** steht in
der Zeile. Ein Reiter trägt nur eine Zahl, wenn dort etwas zu tun ist („2 laufen ab",
„1 erneuern"); wie viele es insgesamt sind, steht im Bereich selbst. Was dich braucht —
etwa eine abgelaufene Kontoverbindung oder eine vorbereitete Änderung, die auf Freigabe
wartet — steht nicht hier, sondern auf der Startseite **Übersicht**, in der einen Liste
dessen, was jetzt zu tun ist.

Wie ein Skript seinen Schlüssel gegen ein kurzlebiges Token tauscht, steht nicht auf der
Seite, sondern in der Anleitung für Entwickler:
[Machine tokens](../developers/token-exchange.md). Die Seite verlinkt sie unten im Bereich
**Schlüssel für Skripte**.

Offen stehen nur die Schlüssel, die noch Rechte halten, und die Anwendungen, für die jemand
eine gültige Freigabe hält. Widerrufene Schlüssel und Anwendungen ohne gültige Freigabe sind
zugeklappt, mit ihrer Anzahl. Eine Anwendungs-Registrierung, die seit 7 Tagen niemand
freigegeben oder benutzt hat, legt SubKit still; sie kommt zurück, sobald jemand sie wieder
freigibt. Eine widerrufene Registrierung kommt nicht zurück. Registrierungen ohne verbliebene
Tokens entfernt SubKit 30 Tage nach der Registrierung ganz — stillgelegt oder nicht; danach
muss sich die Anwendung neu registrieren.

---

## Ein System verbinden

Ein System, das selbst Zugriff freigeben kann, brauchst du nicht mit einem Schlüssel zu
füttern. Der Weg hat drei Schritte, und der letzte passiert auf der anderen Seite.

1. **Adresse.** Klicke auf **Verbinden** und gib die Basis-Adresse des Systems ein
   (`https://…`). **Prüfen** liest, was das System über sich sagt: seinen Namen, wenn es
   einen veröffentlicht, und welche Rechte es kennt. Steht dort, dass das System den
   Zugriff nicht auf diesem Weg freigibt, sagt die Seite das in einem Satz — dann gehört
   der Schlüssel auf die Konnektor-Seite (siehe unten).
2. **Name und Rechte.** Die Kontoverbindung bekommt einen kurzen Namen (vorgeschlagen aus dem
   Namen des Systems) und du wählst die Rechte, die SubKit dort haben soll. Nur was du
   hier wählst, wird auf der anderen Seite erbeten. `offline_access` steht nicht zur
   Wahl: Es ist kein Recht, sondern die Bitte um ein Erneuerungs-Token. Nennt das System
   diesen Wert, erbittet SubKit ihn selbst — beim Verbinden und bei jedem **Erneuern**.
3. **Freigabe.** **Weiter zur Freigabe** schickt dich zum anderen System. Dort siehst du,
   wer anfragt (SubKit, mit seiner Adresse) und wofür, und klickst auf **Freigeben** —
   oder auf **Ablehnen**. Danach bist du wieder im Cockpit, und die Kontoverbindung steht in
   der Liste.

Was dabei im Hintergrund passiert, musst du nicht wissen; für die Neugierigen: SubKit
meldet sich beim anderen System als öffentlicher Client an (Dynamic Client Registration),
startet einen Authorization-Code-Ablauf mit PKCE und tauscht den Code gegen Zugriffs- und
Erneuerungs-Token. Ein OpenID-Connect-Server stellt das Erneuerungs-Token nur aus, wenn
`offline_access` erbeten wurde; ohne es endet der Zugriff nach der ersten Laufzeit des
Zugriffs-Tokens. Beide liegen als Versionen im Secret-Speicher dieser Installation —
verschlüsselt wie jedes andere Secret, und kein Schlüssel wurde je eingetippt.

## Was die Liste zeigt

Jede Zeile nennt den Namen, die Adresse, wie viele Rechte gewährt sind („2 Rechte"), wann
die Kontoverbindung zuletzt verwendet wurde, welche Konnektoren sie nutzen (mit der Zahl
ihrer Workflows) und ein Zustandswort. **Details anzeigen** zeigt die Rechte so, wie das
andere System sie nennt. Ein Risikowort („liest", „schreibt") steht dort bewusst nicht:
SubKit kennt die Rechte eines fremden Systems nicht und würde raten. Kann sich der Zugriff
nicht selbst erneuern, sagt die Zeile auch, warum: das andere System hat kein
Erneuerungs-Token ausgestellt.

| Wort | Bedeutung | Was zu tun ist |
|---|---|---|
| **gültig** | Der Zugriff funktioniert und erneuert sich selbst. | Nichts. |
| **läuft ab am …** | Der Zugriff funktioniert, kann sich aber nicht selbst erneuern und endet an diesem Tag. | Vor dem Datum **Erneuern**. |
| **abgelaufen** | Die andere Seite hat die Erneuerung abgelehnt, oder der Zugriff ist zu Ende und kann sich nicht selbst erneuern. Die Zeile nennt, welcher der beiden Gründe gilt. | **Erneuern** — wiederholt die Freigabe. |
| **unlesbar** | Der gespeicherte Zugriff lässt sich mit dem Schlüssel dieser Installation nicht lesen. | **Erneuern**. |

**Erneuern** wiederholt den Weg von oben für dieselbe Kontoverbindung: gleicher Name,
gleiche Rechte, neue Freigabe. Eine abgelaufene oder unlesbare Kontoverbindung steht nur
dann auf der **Übersicht**, wenn ein Konnektor sie nutzt; eine, die niemand nutzt („Von keinem
Konnektor genutzt"), bricht nichts und bleibt hier in der Liste. **Trennen** (in der Zeile, mit Rückfrage) widerruft den
gespeicherten Zugriff und vergisst die Kontoverbindung. Ein Konnektor, der sie benutzt hat, steht danach ohne
Zugangsdaten da und sagt das auf seiner Seite.

## Eine Kontoverbindung in einem Konnektor verwenden

Auf der Seite eines Konnektors gibt es die Karte **Anmeldung**. Dort wählst du unter
**Verbindung wählen** eine Kontoverbindung und klickst auf **Übernehmen**. Der Konnektor
sendet von da an den Zugriff der Kontoverbindung — und weil sich der Zugriff selbst
erneuert, ist damit auch dieses Thema erledigt.

Die Karte zeigt, wie es um die Anmeldung steht, und verlinkt auf die Kontoverbindung. Ist
die Anmeldung verloren — die Kontoverbindung abgelaufen, oder der Anbieter hat den Zugang
abgelehnt —, bietet sie **Neu anmelden** an: bei einer Kontoverbindung führt das zu ihr
(dort erneuert, gilt sie für jeden Konnektor, der sie nutzt), bei einem eigenen
OAuth-Zugang startet es die Anmeldung beim Anbieter, bei einem Schlüssel öffnet es das
Schlüsselfeld.

**Stattdessen einen Schlüssel eingeben** gibt es weiterhin, aber nur für den Fall, für den
es gemeint ist: einen externen Anbieter, der den Zugriff nicht selbst freigeben kann — ein
Modell-Schlüssel etwa. Das Feld sagt das dazu. Ein System, das Freigaben kennt, verbindest
du über **Zugangsdaten → Zugriff in deinem Namen**.

---

## Vorbereitete Änderungen

Manchmal legt jemand einen neuen Wert für diese Installation an, ohne ihn gleich zu
verwenden — ein Administrator von der Kommandozeile des Servers etwa, mit
`engine --vault-set <name> --value-file <pfad> --pending`. Dieser Wert ist dann gespeichert
und verschlüsselt, aber noch nicht in Gebrauch. Er erscheint oben auf **Einstellungen**
als **Vorbereitete Änderung**: mit dem Namen der Einstellung, der neuen Versionsnummer, wer
sie vorbereitet hat und seit wann.

- **Freigeben** macht die Version zur aktuellen und hängt die genannten Einstellungen auf
  sie um. Ab jetzt wird sie verwendet.
- **Ablehnen** widerruft die Version. Sie wird nie verwendet.

Den Wert selbst zeigt das Cockpit nirgends — auch nicht dem, der ihn freigibt. Bis zur
Freigabe zählt eine vorbereitete Version nicht als aktuelle Version: keine Einstellung
kann sie verwenden, und `engine --vault-check` sieht sie nicht.

Beide Entscheidungen brauchen das Recht, Einstellungen zu ändern (Administrator), und
beide stehen im Audit-Trail.
