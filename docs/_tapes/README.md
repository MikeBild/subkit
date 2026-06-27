# `sk` REPL demo tapes

Animated GIFs of the `sk` REPL for the docs, recorded with
[charmbracelet/vhs](https://github.com/charmbracelet/vhs). The `.tape` files
here are the source of truth; the rendered GIFs live in `out/` and are embedded
from the audience docs (`authors/repl-tour.md`, `authors/slash-commands.md`,
`authors/settings.md`, `authors/quickstart.md`, `operators/quickstart.md`).

| Tape | Shows | Output |
|---|---|---|
| `repl-author.tape` | Natural-language authoring → spinner + token count → `/preview` → `/approve` → run → `/cost` | `out/repl-author.gif` |
| `repl-slash.tape` | Slash fuzzy footer (`/`) → `/draft`, `/connectors`, `/context`, `/settings` | `out/repl-slash.gif` |
| `operator-onboard.tape` | The `/install` connector onboarding wizard (template → credentials → probe → save) | `out/operator-onboard.gif` |

## Regenerate

```sh
brew install vhs           # or: go install github.com/charmbracelet/vhs@latest
cd docs/_tapes
vhs *.tape                 # writes out/*.gif
```

Render one at a time with `vhs repl-author.tape`. VHS resolves the relative
`Output out/…` and `bash scenes/…` paths from the `docs/_tapes` directory, so
always run it from here.

## How these are built

The tapes do **not** drive a live engine. Each tape runs a small scripted
"scene" under `scenes/` that replays the real REPL frames so the GIFs render
deterministically and offline — no engine, no auth, no secrets:

- `scenes/_lib.sh` — shared renderers (welcome banner, braille thinking spinner
  with rotating verb + elapsed + token count, status line). The palette and
  layout mirror the real components:
  - `apps/sk/src/repl/welcome-banner.tsx` (round-border orientation banner)
  - `apps/sk/src/repl/spinner.tsx` (`running <tool>… 12s · 8420t`, `processing N tool results`)
  - `apps/sk/src/repl/status-line/render.ts` (authoring chip, mode, tenant)
  - `apps/sk/src/repl/slash/SlashSuggest.tsx` (the `›` fuzzy footer)
  - `apps/sk/src/slash.ts` (the command catalog + help strings)
- `scenes/repl-author.sh`, `scenes/repl-slash.sh`, `scenes/operator-onboard.sh`
  — one scene per tape.

All data is **fake and redacted on purpose**: the tenant is `acme-prod`, the
user is `admin@acme-prod`, credentials render as `***redacted***`, API keys are
masked (`sk_live_••••`), and ids are truncated (`ch_3Pk•••`, `acct_1Pa•••`,
`exec_9a2f41c8`). Nothing here is a real secret or a real tenant id.

### Refreshing against a live REPL

To re-record from the real binary instead of the scenes, point a tape at `sk`
and type the prompt with VHS directives, e.g.:

```tape
Output out/repl-author.gif
Set Shell bash
Set Theme "Catppuccin Mocha"
Type "sk"
Enter
Sleep 2s
Type "Create a workflow that fetches yesterday's Stripe charges and emails me a summary"
Enter
Sleep 30s
```

This needs a reachable engine, a signed-in profile, and connectors in the
tenant. Keep the scene-based tapes as the offline-reproducible default and only
swap in a live recording when you want real engine output — scrub any real
tenant ids / secrets before committing the GIF.

## Tunables

Each tape sets a legible frame: `Width 1280`, `Height 820–900`, `FontSize 18`,
`Padding 24`, `Framerate 24`, theme `Catppuccin Mocha`. Bump `FontSize` for a
larger embed or trim `Width`/`Height` to crop. The trailing `Sleep` in each tape
must stay ≥ the scene's runtime or the GIF cuts off early.
