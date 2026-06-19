# sk CLI ANSI frame snapshots

Captured against the live binary at `dist/sk` and a local engine at
`http://localhost:3000`. These are the visual reference points for a
before/after ANSI-frame diff of the key screens.

## How to refresh

```sh
docker compose up -d                # postgres only — see docker-compose.yml
bun run dev                          # engine on host (different terminal)
bun run build:sk                     # rebuild sk binary
SUBKIT_ENGINE_URL=http://localhost:3000 ./dist/sk --help > tests/e2e/frames/sk-help.txt 2>&1
SUBKIT_ENGINE_URL=http://localhost:3000 ./dist/sk health > tests/e2e/frames/sk-health.txt 2>&1
SUBKIT_ENGINE_URL=http://localhost:3000 ./dist/sk doctor > tests/e2e/frames/sk-doctor.txt 2>&1
```

## What's here

- `sk-help.txt` — top-level usage help.
- `sk-health.txt` — engine reachability check.
- `sk-doctor.txt` — diagnostics output (✔/✘/⚠ structured rows).

## What's NOT here

The interactive REPL chrome (welcome banner, slash autocomplete
panel, ErrorPanel toast, IntegrationPicker rows) needs a TTY +
expect script to capture deterministically. Those flows are exercised
by `tests/e2e/sk-overhaul-cold-start.e2e.test.ts` and
`tests/e2e/sk-overhaul-matrix.e2e.test.ts` rather than snapshotted —
their ANSI output is timing-sensitive and would churn on every run.
