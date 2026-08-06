# sk

**Your AI experiments become something IT will sign off on.**

Every team has work that runs the same way every week — and a person doing it by hand.
With sk, you describe that work in ordinary sentences. sk builds it, shows you what it
built, and waits. If it is right, you approve it. From then on it runs by itself — and
every run is written down, so you can always show what happened.

[![ci](https://github.com/mikebild/subkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mikebild/subkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**New to this?** [Start here](docs/start-here.md) — no prior knowledge assumed, no code on
the page.

![Describing a workflow in plain language, previewing it, approving it, and running it in the sk terminal](docs/_tapes/out/repl-author.gif)

---

## What people use it for

Real cases — each one ships in the box or runs in our own production, none invented.
The full gallery: [Use cases](docs/use-cases.md).

| | For example |
|---|---|
| **[A personal assistant](docs/use-cases.md#personal-ai-assistant)** | A website shows a price but has no export — sk reads the page every day and mails you when the price changes |
| **[A company that answers questions](docs/use-cases.md#corporate-llm)** | "How do we normally do this here?" — answered from your own documents, naming its sources, or honestly saying "that's not written down" |
| **[Work that crosses several systems](docs/use-cases.md#agentic-workflows)** | A new customer pays — sk puts them in your customer list and tells the sales channel. Three systems, one process, no one copying by hand |
| **[Work that waits for a person](docs/use-cases.md#agentic-workflows)** | Something needs sign-off before it goes out — sk waits up to a day for the yes, then proceeds or backs off |
| **[A memory for your AI tools](docs/use-cases.md#knowledge-base-integration)** | Your team's know-how becomes something every AI assistant you use can look up — instead of guessing |

## What you end up with

1. **Your most expensive routines run by themselves.** You sign off by watching one real
   run and checking the result.
2. **Your AI experiments become something a reviewer can read.** Who may do what, what
   needs approval, what happened when — all in one place.
3. **Connections that stay healthy.** When the other side changes something, sk suggests
   the repair instead of quietly breaking.

## What sk does not do

It does not move your old data into a new system — that is a different job.

And it does not improvise. If nobody described it and nobody approved it, it does not run.

---

## Where to start

| You want to | Go to |
|---|---|
| See what people solve with it | [Use cases](docs/use-cases.md) |
| Understand it from scratch | [Start here](docs/start-here.md) |
| Try it yourself | [Self-host quickstart](docs/developers/self-host.md) |
| Someone already runs sk for you | [Author quickstart](docs/authors/quickstart.md) |
| Run sk for your team | [Operator quickstart](docs/operators/quickstart.md) |

Everything else lives in the [documentation](docs/README.md).

---

## Can you trust it?

Four rules hold, always:

- **The AI helps build; it never decides on its own while running.** What you approved is
  what runs — the same way, every time.
- **Every door is the same door.** However a request comes in, it passes the same
  permission check, and anything that changes the outside world needs a confirmation.
- **You see it before it happens.** A rehearsal shows exactly what *would* be sent —
  nothing goes out — and going live takes your approval.
- **Passwords and keys stay locked away.** They never appear in a process, a prompt, or a
  log.

The longer story: [why this holds up](docs/concepts/overview.md).

---

## Contributing

Bug reports, docs fixes, and features are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) and issues labeled
[`good first issue`](https://github.com/mikebild/subkit/labels/good%20first%20issue).
Security reports go through [`SECURITY.md`](SECURITY.md), never public issues.

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
