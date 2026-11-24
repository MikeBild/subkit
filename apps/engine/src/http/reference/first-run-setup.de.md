---
slug: first-run-setup
summary: Lege nach dem ersten Start Admin-Konto, Arbeitsbereich und KI-Anbieter an.
section: start
order: 4
audience: operator
---
## Erstes Setup

Nach diesem Schritt hat deine Engine ein Admin-Konto, einen ersten Arbeitsbereich und einen geprüften KI-Anbieter, und du kannst dich im Cockpit anmelden.
Den einmaligen Einrichtungs-Token schreibt die Engine beim ersten Start in ihr Log; der Befehl liest ihn dort aus.

```bash
docker compose exec engine subkit init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'subkit init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

Ersetze die E-Mail-Adresse, den Namen und den Schlüssel durch deine Werte.
`subkit init` prüft den Schlüssel mit einem kleinen Testaufruf, bevor es etwas speichert.
Lehnt der Anbieter ihn ab, stoppt das Setup ohne gespeicherte Daten. Derselbe Token funktioniert beim nächsten Versuch.

Öffne `http://localhost:3000` im Browser. Die Adresse führt direkt ins Cockpit unter `/cockpit`.
Die Übersicht der Engine mit allen Adressen für Werkzeuge und KI-Clients findest du unter `/engine`.
Ist kein Anmeldeanbieter eingerichtet, meldest du dich mit einem persönlichen API-Schlüssel an.
Der Schlüssel, den `subkit init` ausgibt, gehört einem Systemkonto. Er funktioniert für die API und die CLI, aber nicht für die Anmeldung im Cockpit.
Stelle dir stattdessen einen persönlichen Admin-Schlüssel aus:

```bash
docker compose exec engine engine --issue-admin-key --tenant my-org
```

Der Tenant-Slug ist dein Workspace-Name in Kleinbuchstaben mit Bindestrichen, aus „My Org“ wird also `my-org`.
Füge den ausgegebenen `wf_live_…`-Schlüssel bei der API-Schlüssel-Anmeldung im Cockpit ein.
Danach baust du mit „Dein erster Workflow“ deinen ersten Workflow.

