---
slug: find-your-way-in-the-cockpit
title: Im Cockpit zurechtfinden
summary: Nutze Navigation, Seitenleiste, Fehlerhinweise und Umgebungs-Kennzeichen im Cockpit.
section: work
order: 15
audience: public
---
## Im Cockpit zurechtfinden

Dieses Kapitel ist für alle, die täglich im Cockpit arbeiten.
Danach kannst du die Navigation und die Seitenleiste mit der Tastatur ein- und ausblenden, einen Fehlerhinweis lesen und erkennen, ob etwas im Test oder im Echtbetrieb läuft.

### Die zwei Leisten

Das Cockpit hat links die Navigation und rechts die Seitenleiste. Dazwischen liegt die Seite, an der du arbeitest.

| Leiste | Inhalt | Tastenkürzel |
| --- | --- | --- |
| Navigation, links | Die Bereiche des Cockpits, zum Beispiel **Chat**, **Eingang** und **Workflows**. | ⌘B, unter Windows und Linux Strg+B |
| **Seitenleiste**, rechts | **Chat**, **Details** und **Verlauf** zu dem, was du gerade ansiehst. | ⌘J, unter Windows und Linux Strg+J |

1. Drücke ⌘B, um die Navigation auf eine schmale Symbolleiste zu verkleinern. Drücke es noch einmal, um sie wieder zu öffnen.
2. Drücke ⌘J oder wähle im Seitenkopf **Seitenleiste öffnen**.
3. Zieh den Rand der Seitenleiste, um ihre Breite zu ändern. Mit der Tastatur geht es über die Pfeiltasten, sobald der Rand den Fokus hat.
4. Drücke in der Seitenleiste Esc, um sie zu schließen.

Das Cockpit merkt sich in diesem Browser, ob die Seitenleiste offen ist, wie breit sie ist und welcher Reiter gewählt war. In einem schmalen Fenster legt sich die Seitenleiste über die Seite, statt neben ihr zu stehen.

### Die drei Reiter der Seitenleiste

| Reiter | Was er zeigt |
| --- | --- |
| **Chat** | Eine Unterhaltung neben der Seite. Auf einer geöffneten Seite steht „Der Chat weiß, was du hier gerade ansiehst.“, sonst „Frag zu allem in diesem Arbeitsbereich.“ Auf den Chat-Seiten selbst fehlt dieser Reiter. |
| **Details** | Die Abschnitte **Status** und **Technisch** zu dem, was du geöffnet hast: IDs, Versionen, Zeitpunkte und Umgebung. |
| **Verlauf** | Die Einträge des Audit-Logs zu diesem einen Objekt. **Alles im Audit-Log anzeigen** öffnet die ganze Liste. |

Gut zu wissen:

- Technische Angaben stehen im Reiter **Details** und nicht mehr auf der Seite. So bleibt die Seite bei dem, was du entscheiden musst.
- Öffnest du einen Lauf neben einer Seite, zeigt **Details** den Status und die Angaben dieses Laufs.
- Für **Verlauf** brauchst du `audit:read`. Ohne das Recht liest du „Deine Rolle umfasst das Audit-Log nicht.“
- Ist nichts geöffnet, steht dort „Hier gibt es keine Details“. Öffne einen Workflow, eine Aufgabe oder einen Konnektor.

### Einen Fehlerhinweis lesen

Geht etwas schief, erscheint der Hinweis dort, wo es passiert ist: in der Karte, im Dialog oder über der Liste. Jeder Hinweis hat denselben Aufbau.

| Teil | Was er sagt |
| --- | --- |
| Titel | Was passiert ist. |
| Text | Was das für dich heißt. Steht dort nichts Eigenes, liest du „Es wurde nichts geändert.“ |
| Eine Schaltfläche | Die eine Handlung, die weiterhilft, zum Beispiel **Erneut versuchen**, **Neu anmelden**, **Freigabe prüfen**, **Im Chat beheben** oder **Administrator fragen**. |
| **Technische Angaben** | Zugeklappt. Darin stehen **Code**, **HTTP-Status**, **Anfrage-ID** und **Zeit**. |

1. Lies Titel und Text.
2. Wähle die angebotene Handlung.
3. Hilft sie nicht, klappe **Technische Angaben** auf und wähle **Einzelheiten kopieren** oder **Fehler melden**.

Kann eine Liste oder eine Seite nicht geladen werden, bietet sie **Erneut versuchen** an. Wie du einen Fehler meldest, steht in „Einen Fehler melden“.

### Test und Echtbetrieb erkennen

SubKit trennt zwei Umgebungen: **Test** und **Echtbetrieb**. Ein Kennzeichen mit einem dieser beiden Wörter steht überall dort, wo die Umgebung über die Wirkung entscheidet:

- an den Punkten unter **Braucht dich** in der **Übersicht**,
- an den Konnektoren eines Workflows und im Katalog der Konnektoren,
- im Freigabe-Dialog und am Hinweis auf eine endende Freigabe,
- in den technischen Angaben einer Aufgabe.

Lies das Kennzeichen, bevor du etwas freigibst oder erneuerst. Eine Freigabe gilt immer nur für die genannte Umgebung.

### Markdown-Dokumente ansehen

Skills, Wissensquellen, Einträge im **Eingang** und Dateien, die Markdown enthalten, öffnen sich in derselben Dokument-Ansicht.

1. Öffne das Dokument.
2. Wähle unter **Ansicht** zwischen **Darstellung** und **Markdown**. **Darstellung** zeigt den formatierten Text, **Markdown** den Quelltext zum Lesen und Kopieren.
3. Bei längeren Dokumenten springst du über **Inhalt** zu einer Überschrift. Das Inhaltsverzeichnis erscheint ab drei Überschriften, wenn die Spalte breit genug ist.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| ⌘J öffnet die Seitenleiste nicht | Unter Windows und Linux gilt Strg+J, ohne Umschalt- und Alt-Taste. Sonst wähle **Seitenleiste öffnen** im Seitenkopf. |
| Der Hinweis an der Schaltfläche nennt nur ⌘J | Der Hinweis zeigt immer das Mac-Kürzel. Unter Windows und Linux funktioniert Strg+J. |
| „Der Verlauf konnte nicht geladen werden. Es wurde nichts geändert.“ | Öffne den Reiter erneut. Bleibt es dabei, wähle **Alles im Audit-Log anzeigen**. |
| Der Reiter **Chat** fehlt | Du bist auf einer Chat-Seite. Dort ist die Unterhaltung schon die Seite. |
| „Das konnte nicht geladen werden“ | Wähle **Erneut versuchen**. |
