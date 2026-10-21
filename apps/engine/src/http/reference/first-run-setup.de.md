---
slug: first-run-setup
summary: Richte Anbieter, Admin-Zugang und Cockpit nach dem ersten Start ein.
section: start
order: 4
audience: operator
---
## Erstes Setup

```bash
docker compose exec engine sk init \
  --token "$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)" \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key <your-provider-key>
```

Verwende `--llm-provider mock --llm-api-key mock`, um es ohne LLM-Konto auszuprobieren.
`sk init` prüft den Schlüssel mit einem minimalen Aufruf, bevor es etwas speichert; ein abgelehnter
Schlüssel stoppt das Setup, nichts wird gespeichert, und derselbe Token funktioniert beim nächsten
Versuch.

Öffne das Cockpit unter `http://localhost:3000/cockpit`.
Ohne eingerichteten Anmeldeanbieter meldest du dich mit einem API-Schlüssel an. Das gilt nur für
selbst betriebene Installationen ohne Anmeldeanbieter; in SubKit Cloud meldest du dich über Upraft Auth an.

