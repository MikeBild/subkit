---
slug: web-clipper
summary: Speichere Webseiten und Auswahlen mit der Browser-Erweiterung in deiner SubKit-Inbox.
section: work
order: 4
audience: public
---
## Web Clipper

Der SubKit Clipper ist eine Browser-Erweiterung. Er schickt eine Webseite, einen markierten
Text oder ein YouTube-Transkript an deine SubKit-Engine. Dort wartet der Eintrag im Cockpit
unter **Eingang**, bis du ihn prüfst. Durch das Sammeln allein wird nichts zu Wissen oder
zu einem Skill.

Der Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.

### Was der Clipper erfasst

- **Eine Seite.** Der Clipper holt den Haupttext des Artikels heraus und wandelt ihn in
  Markdown um. Links werden zu vollständigen Adressen. Navigation und Empfehlungen bleiben weg.
- **Einen markierten Text.** Markiere zuerst Text auf der Seite. Der Clipper übernimmt
  dann nur diesen Text.
- **Ein YouTube-Video.** Auf einer Videoseite übernimmt der Clipper Titel, Autor,
  Veröffentlichungsdatum, Beschreibung und das Transkript in der Originalsprache des Tons.
  Beschreibung und Transkript kannst du unter **Details und Inhalt bearbeiten** einzeln
  ein- oder ausschließen.

Neben dem Text behält der Clipper Titel, Quelladresse, Autor der Quelle und
Veröffentlichungsdatum, sofern die Seite sie angibt. Bildlinks bleiben im Text.
Bilddateien werden nicht hochgeladen. Der Clipper macht keine Screenshots.

Wenn du über die Symbolleiste oder das Tastenkürzel sammelst, nimmt der Clipper deine
Markierung, falls es eine gibt. Sonst nimmt er den ganzen Artikel.

### Bevor du beginnst

Du brauchst:

- **Google Chrome.** Der Clipper ist für Chrome gebaut. Andere Browser sind nicht getestet.
- **Die `sk`-CLI**, angemeldet an deiner Engine. Siehe „Die sk-CLI auf deinem Rechner verwenden“.
- **Eine Engine-Adresse** mit HTTPS. Einfaches HTTP funktioniert nur mit `localhost`,
  `127.0.0.1` oder `[::1]`.
- **Ein Konto mit `intake:read` und `intake:write`.** Fehlen deinem Konto diese Rechte,
  frag eine Admin-Person.

Den Clipper gibt es nicht im Chrome Web Store. Du installierst ihn über die CLI.

### Die Erweiterung installieren

1. Starte den Installer:

   ```bash
   sk clipper install
   ```

   Er entpackt die Erweiterung nach `~/.sk/clipper` und meldet:

   ```text
   sk: clipping extension installed to /Users/you/.sk/clipper
   ```

   Außerdem versucht er, die Erweiterungsseite von Chrome für dich zu öffnen.

2. Öffne in Chrome `chrome://extensions`.
3. Schalte oben rechts den **Entwicklermodus** ein.
4. Klicke auf **Entpackte Erweiterung laden** (in englischem Chrome: **Load unpacked**)
   und wähle den Ordner, den der Befehl ausgegeben hat.
5. Hefte den SubKit Clipper an die Symbolleiste, damit du ihn schnell erreichst.

Der Installer übernimmt die Engine-Adresse deines aktiven Profils in die Erweiterung.
Du musst nur noch einen API-Schlüssel eintragen.

Nützliche Optionen:

| Option | Wirkung |
| --- | --- |
| `--dir <directory>` | Installiert in einen anderen Ordner. |
| `--engine-url <url>` | Nutzt diese Engine-Adresse statt der des aktiven Profils. |
| `--no-open` | Öffnet Chrome nicht. |

**Aktualisieren:** Führe nach einem Update der CLI erneut `sk clipper install` aus.
Klicke dann auf `chrome://extensions` beim SubKit Clipper auf das Symbol zum Neuladen.
Deine Verbindungseinstellungen bleiben erhalten.

### Mit deiner Engine verbinden

Der Clipper meldet sich mit einem API-Schlüssel an. Lege dafür einen eigenen Schlüssel an.

1. Öffne im Cockpit **API-Zugang**, erstelle einen neuen Schlüssel und wähle die Vorlage
   **Web Clipper**. Sie vergibt genau `intake:read` und `intake:write`.
   Fehlt deinem Konto eines davon, nennt die Seite das fehlende Recht.
2. Kopiere den Schlüssel.
3. Öffne den Clipper und klicke auf das Zahnrad (⚙). Die Einstellungen öffnen
   sich in einem neuen Tab.
4. Prüfe die **Engine-Adresse**, zum Beispiel `https://engine.example.com`.
5. Füge den Schlüssel unter **API-Schlüssel** ein.
6. Wähle deine Sprache.
7. Klicke auf **Verbindung speichern**. Chrome fragt nach Zugriff auf die Adresse
   deiner Engine. Erlaube ihn.

Danach prüft der Clipper die Verbindung. Er lädt deine Kategorien und bestätigt, dass der
Schlüssel Clips speichern darf.

Wenn du die Engine-Adresse später änderst, gib auch den API-Schlüssel für die neue
Engine ein. **API-Schlüssel löschen** entfernt den gespeicherten Schlüssel aus der Erweiterung.

### Eine Seite sammeln

Du kannst eine Erfassung auf drei Wegen starten:

- **Symbolleiste:** Klicke auf das Symbol des SubKit Clippers.
- **Kontextmenü:** Klicke mit der rechten Maustaste auf die Seite und wähle
  **Seite in SubKit sichern** oder **Auswahl in SubKit sichern**.
- **Tastenkürzel:** Drücke **Alt+Shift+K**. Du kannst es unter
  `chrome://extensions/shortcuts` ändern.

Das Popup zeigt dann, was es senden wird:

1. Prüfe den **Titel**. Du kannst ihn ändern.
2. Fülle bei Bedarf **Warum ist das interessant?** aus. Diese Notiz hilft dir bei der Prüfung.
3. Wähle eine **Kategorie**. Deine Standardkategorie ist vorausgewählt, anfangs `inbox`.
   Mit **Neue Kategorie** legst du eine an. Kategorienamen bestehen aus Kleinbuchstaben,
   Ziffern und Bindestrichen, zum Beispiel `research` oder `ai-tools`, mit höchstens 40 Zeichen.
4. Prüfe die Vorschau. Sie zeigt die Anzahl der Wörter und Zeichen.
   Unter **Details und Inhalt bearbeiten** siehst du Autor und Datum und kannst das Markdown ändern.
5. Klicke auf **Sammeln**.

Bei Erfolg meldet das Popup zum Beispiel
„Gesammelt: research. Noch nicht als Wissen oder Skill übernommen.“
Klicke auf **Im Chat prüfen**, um die Prüfung sofort zu starten.

Der Clipper hält für jede Seite und Engine einen lokalen Entwurf, einschließlich deiner Notiz.
Schlägt das Speichern fehl, bleibt der Entwurf erhalten, und du kannst es erneut versuchen.
Wenn derselbe Clip zweimal gesendet wird, entsteht kein zweiter Eintrag.

### Wie es weitergeht

1. **Der Clip landet im Eingang.** Öffne im Cockpit **Eingang**. Dort kannst du den
   Eintrag öffnen, Inhalt und Quelle lesen, ihn bearbeiten, in eine andere Kategorie
   verschieben oder verwerfen.
2. **Du prüfst ihn im Chat.** Nutze **Im Chat prüfen** im Clipper oder die Chat-Aktion
   des Eintrags im Eingang. Der Chat bewertet den Clip und bereitet einen Vorschlag vor:
   den genauen Inhalt, seine Quellen und das Ziel, Wissen oder Skill.
3. **Ein Mensch bestätigt ihn.** Nur eine Person, die im Browser am Cockpit angemeldet ist,
   kann einen Vorschlag als **Wissen** oder als **Skill** bestätigen. Sie braucht das Recht
   `intake:confirm` und das Recht des Ziels: `knowledge:write` für Wissen oder
   `skill:write` und `skill:activate` für einen Skill. API-Schlüssel,
   MCP-Clients und der Clipper selbst können nicht bestätigen.

Solange niemand bestätigt, ist ein Clip kein Wissen. Die normale Wissenssuche findet ihn
nicht. Auch Verschieben oder Bearbeiten übernimmt einen Clip nicht. Ändert sich der
Vorschlag, muss er erneut geprüft werden.

### Datenschutz

- **Wohin Clips gehen:** Der Clipper schickt Clips nur an die Engine, die du eingestellt
  hast. Auf YouTube lädt er für das Transkript eventuell auch die Seite und die Untertitel
  direkt von YouTube.
- **Originale bleiben:** Die Engine bewahrt den ursprünglich erfassten Stand auf. Spätere
  Änderungen überschreiben ihn nicht. Der Clip bleibt mit dem Wissen oder Skill verknüpft,
  das daraus entsteht.
- **Geheimnisse werden ersetzt:** Bevor ein Clip gespeichert wird, ersetzt SubKit darin
  erkennbare Geheimnisse (API-Schlüssel, Tokens, private Schlüssel, Signaturen
  signierter Links) durch eine Markierung und hält nur fest, wie viele ersetzt wurden.
  Die entfernten Werte werden nie gespeichert; Quelle, Autor und Zeitangaben bleiben
  wie erfasst. Personenbezogene Daten werden nicht entfernt. Sammle trotzdem keine Seiten,
  die Passwörter, Schlüssel, Tokens oder andere Geheimnisse zeigen.
- **Dein API-Schlüssel** liegt in der Browser-Erweiterung auf diesem Gerät. Nutze für den
  Clipper einen eigenen Schlüssel und widerrufe ihn im Cockpit, wenn du ihn nicht mehr brauchst.
- **Sichtbarkeit:** Gesammelte Einträge folgen den Berechtigungen deines Mandanten.
  Kategorien sind gemeinsam, nicht privat.

### Fehlerbehebung

Der Clipper zeigt seine Meldungen in der eingestellten Sprache. Über **Hilfe** im Popup und
in den Einstellungen öffnest du dieses Kapitel auf deiner Engine.

**Verbindung und Schlüssel**

| Meldung | Was zu tun ist |
| --- | --- |
| „Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest.“ | Öffne die Einstellungen über das Zahnrad, trage beides ein und speichere. |
| „Lege vor dem Erfassen eine Engine-Adresse fest.“ | Die Einstellungen öffnen sich von selbst. Trage die Engine-Adresse ein und speichere. |
| „Der API-Schlüssel ist ungültig oder abgelaufen. …“ | Erstelle unter **API-Zugang** einen neuen Schlüssel mit der Vorlage **Web Clipper** und speichere ihn in den Einstellungen. |
| „Dem API-Schlüssel fehlt intake:read. …“ | Erstelle unter **API-Zugang** einen Schlüssel mit der Vorlage **Web Clipper**. |
| „Die Verbindung steht, aber dem API-Schlüssel fehlt intake:write. …“ | Erstelle unter **API-Zugang** einen Schlüssel mit der Vorlage **Web Clipper**. Dein Entwurf bleibt erhalten. |
| „Die SubKit-API ist nicht erreichbar. …“ | Prüfe Engine-Adresse und Internetverbindung. Stelle sicher, dass Chrome auf die Adresse der Engine zugreifen darf. |
| „Nutze HTTPS oder HTTP auf localhost.“ | Nutze `https://` oder `http://` nur mit `localhost`, `127.0.0.1` oder `[::1]`. Die Adresse darf keinen Benutzernamen, kein Passwort, keine `?query` und kein `#fragment` enthalten. |
| „Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.“ | Speichere erneut und erlaube den Zugriff, wenn Chrome fragt. |
| „Gib einen API-Schlüssel für die neue Engine ein.“ | Du hast die Engine-Adresse geändert. Füge den Schlüssel der neuen Engine ein. |
| „Kategorien gerade nicht verfügbar“ | Klicke auf **Verbindung prüfen**. |

**Sammeln**

| Meldung | Was zu tun ist |
| --- | --- |
| „Die Speicherung ist noch nicht bestätigt. …“ | Das Netzwerk ist ausgefallen oder die Engine hatte einen Fehler. Klicke auf **Erneut versuchen**. |
| „SubKit hat den Clip abgelehnt. …“ | Prüfe Kategorie und Inhalt und versuche es erneut. |
| „Dieser Clip existiert bereits.“ | Dieser Clip wurde schon gesammelt. |
| „Wähle eine gültige Kategorie, bevor du sammelst.“ oder „Gib eine gültige Kategorie ein.“ | Nutze Kleinbuchstaben, Ziffern und Bindestriche, höchstens 40 Zeichen. |
| „Die gespeicherte Kategorie ist nicht verfügbar. …“ | Wähle eine andere Kategorie. |
| „Dieser Entwurf gehört zu einer anderen Engine.“ | Der Entwurf entstand für eine andere Engine-Adresse. Wechsle zu dieser Engine zurück, um ihn zu senden. |

**Erfassen**

| Meldung | Was zu tun ist |
| --- | --- |
| „Der Hauptinhalt konnte nicht zuverlässig erfasst werden. …“ | Markiere den relevanten Text auf der Seite und wähle dann **Neu erfassen**. |
| „Der Inhalt wurde vereinfacht als Text erfasst. …“ | Prüfe die Vorschau auf Vollständigkeit. |
| „Es wurde kein Text erfasst. …“ | Klicke auf **Neu erfassen**. Für einen Ausschnitt markierst du vorher den Text. |
| „Kein Transkript verfügbar.“ | Der Clipper konnte für dieses Video kein Transkript lesen. |
| „Öffne den Clipper über die Symbolleiste auf dieser Seite erneut.“ | Chrome braucht Zugriff auf diese Seite. Klicke auf dieser Seite auf das Symbol in der Symbolleiste. |
| „Die Seite hat sich während der Erfassung geändert. …“ | Die Adresse der Seite hat sich während der Erfassung geändert. Erfasse erneut. |
| „Die Seite konnte nicht erfasst werden.“ | Lade die Seite neu und versuche es erneut. |

Schlägt eine Erfassung über das Kontextmenü oder das Tastenkürzel fehl, öffnet der Clipper
sein Popup in einem Tab und zeigt dort den Fehler.
