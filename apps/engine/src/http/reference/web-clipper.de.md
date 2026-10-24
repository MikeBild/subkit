---
slug: web-clipper
summary: Speichere Webseiten und Auswahlen mit der Browser-Erweiterung in deinem Eingang.
section: work
order: 4
audience: public
---
## Webseiten mit dem Web Clipper sammeln

Der Web Clipper schickt eine Webseite, einen markierten Text oder ein YouTube-Transkript an deine Engine.
Der Eintrag wartet im Cockpit unter **Eingang**, bis du ihn prüfst.
Durch das Sammeln allein wird nichts zu Wissen oder zu einem Skill.

Der Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.

### Was du brauchst

- **Google Chrome.** Microsoft Edge und andere Chromium-Browser sind nicht getestet. Firefox wird nicht unterstützt: Die Erweiterung nutzt einen Hintergrund-Service-Worker von Chrome.
- **Die `sk`-CLI**, angemeldet an deiner Engine. Siehe „Die sk-CLI auf deinem Rechner verwenden“.
- **Eine Engine-Adresse** mit HTTPS. Einfaches HTTP funktioniert nur mit `localhost`, `127.0.0.1` oder `[::1]`. In SubKit Cloud ist es `https://subkit-cloud.mikebild.info`, ohne `/cockpit`.
- **Ein Konto mit `intake:read` und `intake:write`.** Fehlen sie, bitte eine Administratorin oder einen Administrator darum.

Den Web Clipper gibt es nicht im Chrome Web Store. Du installierst ihn über die CLI oder als ZIP-Datei deiner Engine.

### Die Erweiterung installieren

Der Installer übernimmt die Engine-Adresse deines aktiven Profils. Später trägst du nur noch einen API-Schlüssel ein.

1. Führe `sk clipper install` aus. Der Befehl entpackt die Erweiterung nach `~/.sk/clipper` und versucht, die Erweiterungsseite von Chrome zu öffnen.

   ```text
   sk: clipping extension installed to /Users/you/.sk/clipper
   sk: in Chrome, enable Developer mode, select Load unpacked, and choose the directory above. Reload the extension there after a future install.
   ```

   Die Ausgabe nennt den Installationsordner und die nächsten Schritte in Chrome.

2. Öffne in Chrome `chrome://extensions`.
3. Schalte oben rechts den **Entwicklermodus** ein.
4. Wähle **Entpackte Erweiterung laden** (in englischem Chrome: **Load unpacked**) und den Ordner, den der Befehl ausgegeben hat.
5. Hefte die Erweiterung „SubKit Clipper“ an die Symbolleiste.

Öffnet sich Chrome nicht, meldet der Befehl `sk: could not open Chrome automatically`. Öffne dann `chrome://extensions` selbst.

### Ohne CLI installieren

Deine Engine bietet die Erweiterung auch als ZIP-Datei an. Sie enthält keine Engine-Adresse; die trägst du selbst ein.

1. Lade `<Engine-Adresse>/install/clipper.zip` herunter, zum Beispiel `https://subkit-cloud.mikebild.info/install/clipper.zip`.
2. Entpacke die Datei in einen Ordner, den du behältst. Chrome lädt die Erweiterung aus diesem Ordner.
3. Öffne in Chrome `chrome://extensions`, schalte den **Entwicklermodus** ein und wähle **Entpackte Erweiterung laden** mit dem entpackten Ordner.
4. Trage beim Verbinden die **Engine-Adresse** selbst ein.

Zum Aktualisieren entpackst du die neue ZIP-Datei in denselben Ordner und lädst die Erweiterung neu.

### Die Erweiterung aktualisieren

Installiere den Web Clipper nach einem Update der `sk`-CLI erneut. Engine-Adresse und Sprache bleiben erhalten. Den API-Schlüssel trägst du nach dem Neuladen erneut ein.

1. Führe `sk clipper install` aus.
2. Lade die Erweiterung „SubKit Clipper“ auf `chrome://extensions` neu.

### Mit deiner Engine verbinden

Der Web Clipper meldet sich mit einem eigenen API-Schlüssel an.

1. Öffne im Cockpit **API-Zugang**.
2. Wähle **Schlüssel erstellen** und die Vorlage **Web Clipper**. Die Vorlage gewährt genau `intake:read` und `intake:write`.

   ![Dialog „Schlüssel erstellen“ mit der Vorlage Web Clipper, die nur Anzeigen und Bearbeiten für gesammelte Einträge erlaubt](images/web-clipper-api-key.de.webp)

3. Kopiere den Schlüssel.
4. Wähle im Web Clipper das Zahnrad (⚙). Die Einstellungen öffnen sich in einem neuen Tab.
5. Prüfe die **Engine-Adresse** und füge den Schlüssel unter **API-Schlüssel** ein.
6. Wähle **Verbindung speichern**.
7. Erlaube den Zugriff, wenn Chrome danach fragt.

Der Web Clipper prüft die Verbindung, lädt deine Kategorien und bestätigt, dass der Schlüssel Einträge speichern darf.

Ändert sich die Engine-Adresse, brauchst du auch den Schlüssel der neuen Engine. **API-Schlüssel löschen** entfernt den gespeicherten Schlüssel aus der Erweiterung.

Der Web Clipper hält den API-Schlüssel nur im Sitzungsspeicher des Browsers und schreibt ihn nie auf dieses Gerät. Nach einem Neustart des Browsers oder einem Neuladen der Erweiterung fügst du den Schlüssel erneut ein. Bewahre ihn in einem Passwortmanager auf oder erstelle einen neuen Schlüssel mit der Vorlage **Web Clipper**.

### Eine Seite sammeln

1. Wähle in der Symbolleiste das Symbol des Web Clippers („SubKit Clipper“).
2. Prüfe den **Titel**.
3. Optional: Fülle **Warum ist das interessant?** aus.
4. Wähle eine **Kategorie** oder **Neue Kategorie**. Namen bestehen aus Kleinbuchstaben, Ziffern und Bindestrichen, höchstens 40 Zeichen.
5. Prüfe die Vorschau.
6. Optional: Öffne **Details und Inhalt bearbeiten**, um Autor und Datum zu sehen und das Markdown zu ändern.
7. Wähle **Sammeln**.

Alternativ: Rechtsklick > **Seite in SubKit sichern** oder **Auswahl in SubKit sichern**, oder **Alt+Shift+K**.

Bei Erfolg meldet das Popup zum Beispiel „Gesammelt: research. Noch nicht als Wissen oder Skill übernommen.“ Wähle **Im Chat prüfen**, um die Prüfung sofort zu starten.

Gut zu wissen:

- Schlägt das Speichern fehl, bleibt dein Entwurf im Web Clipper.
- Dieselbe Seite wird nie doppelt gesammelt.
- Das Tastenkürzel änderst du unter `chrome://extensions/shortcuts`.

### Wie es weitergeht

1. **Eingang:** Öffne im Cockpit **Eingang** und klicke auf den Eintrag. Auf seiner Seite liest, bearbeitest oder verwirfst du ihn.
2. **Prüfen:** Wähle **Im Chat prüfen** im Web Clipper oder im Menü des Eintrags. Der Chat bereitet einen Vorschlag vor: genauer Inhalt, Quellen und Ziel (Wissen oder Skill).
3. **Bestätigen:** Nur eine Person, die im Browser am Cockpit angemeldet ist, bestätigt den Vorschlag im Tab **Prüfen** des Eintrags als Quelle oder Skill.

Zum Bestätigen braucht diese Person `intake:confirm` und das Recht des Ziels:

| Ziel | Nötige Rechte |
| --- | --- |
| Wissen | `knowledge:write` |
| Skill | `skill:write` und `skill:activate` |
| Skill, der andere ersetzt | zusätzlich `skill:archive` für jeden ersetzten Skill |

API-Schlüssel, MCP-Clients und der Web Clipper können nicht bestätigen.

Solange niemand bestätigt, ist ein Eintrag kein Wissen, und die normale Wissenssuche findet ihn nicht.
Auch Verschieben oder Bearbeiten übernimmt ihn nicht.
Ändert sich der Vorschlag, prüfst du ihn erneut.
Prüfen und Bestätigen beschreibt das Kapitel „Ideen sammeln und in Wissen oder Skills verwandeln“.

### Was der Web Clipper erfasst

- **Eine Seite:** Haupttext des Artikels als Markdown, Links als vollständige Adressen, ohne Navigation und Empfehlungen.
- **Einen markierten Text:** nur die Markierung. Über Symbolleiste oder Tastenkürzel nimmt der Web Clipper die Markierung, sonst den ganzen Artikel.
- **Ein YouTube-Video:** Titel, Autor, Veröffentlichungsdatum, Beschreibung und Transkript in der Originalsprache. Beschreibung und Transkript schaltest du unter **Details und Inhalt bearbeiten** einzeln ein oder aus.

Dazu kommen Quelladresse, Autor und Veröffentlichungsdatum, sofern die Seite sie angibt. Bildlinks bleiben im Text. Bilddateien und Screenshots werden nicht hochgeladen.

### Datenschutz

- **Ziel:** Einträge gehen nur an die Engine, die du eingestellt hast. Für das Transkript lädt der Web Clipper eventuell Seite und Untertitel direkt von YouTube.
- **Originale bleiben:** Die Engine bewahrt den ursprünglich erfassten Stand. Spätere Änderungen überschreiben ihn nicht, und der Eintrag bleibt mit dem daraus entstandenen Wissen oder Skill verknüpft.
- **Zugangsdaten werden ersetzt:** Vor dem Speichern ersetzt SubKit erkennbare Zugangsdaten (API-Schlüssel, Tokens, private Schlüssel, Signaturen signierter Links) durch eine Markierung. Die Werte werden nie gespeichert. Personenbezogene Daten bleiben erhalten. Sammle keine Seiten, die Passwörter oder Schlüssel zeigen.
- **Dein API-Schlüssel** bleibt nur bis zum Schließen des Browsers in der Erweiterung und wird nicht auf diesem Gerät gespeichert. Ein Schlüssel mit der Vorlage **Web Clipper** erlaubt nur das Sammeln. Widerrufe ihn im Cockpit, wenn du ihn nicht mehr brauchst.
- **Sichtbarkeit:** Einträge folgen den Rechten deines Arbeitsbereichs. Kategorien sind gemeinsam, nicht privat.

### Installationsoptionen

| Option | Wirkung |
| --- | --- |
| `--dir <directory>` | Installiert in einen anderen Ordner. |
| `--engine-url <url>` | Nutzt diese Engine-Adresse statt der des aktiven Profils. |
| `--no-open` | Öffnet Chrome nicht. |

### Wenn etwas nicht klappt

Der Web Clipper zeigt Meldungen in der eingestellten Sprache. **Hilfe** im Popup und in den Einstellungen öffnet dieses Kapitel auf deiner Engine. Schlägt eine Erfassung per Kontextmenü oder Tastenkürzel fehl, öffnet der Web Clipper sein Popup in einem Tab und zeigt den Fehler dort.

#### Verbindung und Schlüssel

| Was du siehst | Was du tust |
| --- | --- |
| „Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest. …“ oder „Lege vor dem Erfassen eine Engine-Adresse fest.“ | Trage beides in den Einstellungen (⚙) ein und speichere. Nach einem Neustart des Browsers fügst du den Schlüssel erneut ein. |
| „Der API-Schlüssel ist ungültig oder abgelaufen. …“ | Erstelle unter **API-Zugang** einen neuen Schlüssel mit der Vorlage **Web Clipper** und speichere ihn in den Einstellungen. |
| „Dem API-Schlüssel fehlt intake:read. …“ oder „… fehlt intake:write. …“ | Erstelle unter **API-Zugang** einen Schlüssel mit der Vorlage **Web Clipper**. Dein Entwurf bleibt erhalten. |
| „Die SubKit-API ist nicht erreichbar. …“ | Prüfe Engine-Adresse und Internetverbindung und ob Chrome auf die Adresse zugreifen darf. |
| „Nutze HTTPS oder HTTP auf localhost.“ | Nutze `https://`, oder `http://` nur mit `localhost`, `127.0.0.1` oder `[::1]`. Die Adresse darf keinen Benutzernamen, kein Passwort, keine `?query` und kein `#fragment` enthalten. |
| „Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.“ | Speichere erneut und erlaube den Zugriff, wenn Chrome fragt. |
| „Gib einen API-Schlüssel für die neue Engine ein.“ | Du hast die Engine-Adresse geändert. Füge den Schlüssel der neuen Engine ein. |
| „Kategorien gerade nicht verfügbar“ | Wähle **Verbindung prüfen**. |

#### Erfassen

| Was du siehst | Was du tust |
| --- | --- |
| „Der Hauptinhalt konnte nicht zuverlässig erfasst werden. …“ | Markiere den relevanten Text und wähle **Neu erfassen**. |
| „Der Inhalt wurde vereinfacht als Text erfasst. …“ | Prüfe die Vorschau auf Vollständigkeit. |
| „Es wurde kein Text erfasst. …“ | Wähle **Neu erfassen**. Für einen Ausschnitt markierst du vorher den Text. |
| „Kein Transkript verfügbar.“ | Der Web Clipper konnte für dieses Video kein Transkript lesen. |
| „Öffne den Clipper über die Symbolleiste auf dieser Seite erneut.“ | Chrome braucht Zugriff auf diese Seite. Wähle dort das Symbol in der Symbolleiste. |
| „Die Seite hat sich während der Erfassung geändert. Erfasse sie erneut.“ | Erfasse erneut. |
| „Die Seite konnte nicht erfasst werden.“ | Lade die Seite neu und versuche es erneut. |

#### Sammeln

| Was du siehst | Was du tust |
| --- | --- |
| „Die Speicherung ist noch nicht bestätigt. Versuche es erneut; dein Entwurf bleibt erhalten.“ | Netzwerk oder Engine hatten einen Fehler. Wähle **Erneut versuchen**. |
| „SubKit hat den Clip abgelehnt. …“ | Prüfe Kategorie und Inhalt und versuche es erneut. |
| „Dieser Clip existiert bereits.“ | Er wurde schon gesammelt. |
| „Wähle eine gültige Kategorie, bevor du sammelst.“ oder „Gib eine gültige Kategorie ein.“ | Nutze Kleinbuchstaben, Ziffern und Bindestriche, höchstens 40 Zeichen. |
| „Die gespeicherte Kategorie ist nicht verfügbar. Wähle eine andere Kategorie.“ | Wähle eine andere Kategorie. |
| „Dieser Entwurf gehört zu einer anderen Engine.“ | Wechsle zu der Engine zurück, für die er entstand, um ihn zu senden. |
