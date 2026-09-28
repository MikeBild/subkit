# Kontoverbindungen und Freigaben

> Wie du SubKit mit einem anderen System verbindest, ohne einen Schlüssel einzutippen — und wie eine vorbereitete Änderung an dieser Installation auf deine Freigabe wartet.

Beides findest du im Cockpit unter **Installation**: die Kontoverbindungen im Abschnitt
**Kontoverbindungen** der Seite **Zugangsdaten**, die vorbereiteten Änderungen oben auf
**Einstellungen**.

**Zugangsdaten** ist die eine Seite für alles, was an dieser Installation Rechte hält oder
vergibt: **Kontoverbindungen** (Systeme, die SubKit in deinem Namen aufrufen darf),
**API-Schlüssel** (womit Skripte und Programme SubKit aufrufen) und **Verbundene
Anwendungen** (Programme, denen jemand Zugriff auf diese Installation freigegeben hat) — in
dieser Reihenfolge, mit einem Verzeichnis der drei Abschnitte ganz oben. Jede Zeile
zeigt ihren Zustand; **Erneuern** steht in der Zeile. Was dich braucht — etwa eine
abgelaufene Kontoverbindung oder eine vorbereitete Änderung, die auf Freigabe wartet —
steht nicht hier, sondern auf der Startseite **Heute**, der einen Liste dessen, was
jetzt zu tun ist.

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

Jede Zeile nennt den Namen, die Adresse, die gewährten Rechte, wann die Kontoverbindung
zuletzt verwendet wurde, welche Konnektoren sie nutzen (mit der Zahl ihrer Workflows) und ein
Zustandswort. Kann sich der Zugriff nicht selbst erneuern, sagt die Zeile auch, warum:
das andere System hat kein Erneuerungs-Token ausgestellt.

| Wort | Bedeutung | Was zu tun ist |
|---|---|---|
| **gültig** | Der Zugriff funktioniert und erneuert sich selbst. | Nichts. |
| **läuft ab am …** | Der Zugriff funktioniert, kann sich aber nicht selbst erneuern und endet an diesem Tag. | Vor dem Datum **Erneuern**. |
| **abgelaufen** | Die andere Seite hat die Erneuerung abgelehnt, oder der Zugriff ist zu Ende und kann sich nicht selbst erneuern. Die Zeile nennt, welcher der beiden Gründe gilt. | **Erneuern** — wiederholt die Freigabe. |
| **unlesbar** | Der gespeicherte Zugriff lässt sich mit dem Schlüssel dieser Installation nicht lesen. | **Erneuern**. |

**Erneuern** wiederholt den Weg von oben für dieselbe Kontoverbindung: gleicher Name,
gleiche Rechte, neue Freigabe. Eine abgelaufene oder unlesbare Kontoverbindung steht nur
dann auf **Heute**, wenn ein Konnektor sie nutzt; eine, die niemand nutzt („Von keinem
Konnektor genutzt"), bricht nichts und bleibt hier in der Liste. **Trennen** (im ⋯-Menü, mit Rückfrage) widerruft den
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
du über **Zugangsdaten → Kontoverbindungen**.

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
