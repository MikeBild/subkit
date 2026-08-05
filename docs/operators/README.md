# Operators

Keep it running without babysitting it. Connect the systems your team depends on, put work on a schedule or behind a webhook, route the outcome to the people who care — and when a vendor changes their API, get a ready-to-apply repair instead of a 3am page.

![Connecting a system in the sk terminal: pick the target, enter credentials, test the connection, save](../_tapes/out/operator-onboard.gif)

```mermaid
flowchart TD
    Q[quickstart] --> C[connectors-and-credentials]
    C --> S[scheduling-and-hooks]
    S --> N[notifications]
    S --> O[observability]
    O --> H[self-healing]
    N --> O
```

Start at the quickstart, attach a credential, then put workflows on a schedule or behind a webhook. Notifications and observability tell you when and how a run finished; drift-assisted repair turns an upstream break into a change you review and apply.

| Page | What it covers | Link |
|---|---|---|
| Quickstart — Operator | Engine up, admin key minted, first connector registered — three steps to a running engine. | [quickstart.md](quickstart.md) |
| Connectors & Credentials | Register a connector once, attach a credential, and let every workflow reuse it. | [connectors-and-credentials.md](connectors-and-credentials.md) |
| Scheduling & Hooks | Wire scheduled runs that survive restarts and inbound webhooks that trigger workflows. | [scheduling-and-hooks.md](scheduling-and-hooks.md) |
| Notifications | Route run outcomes — succeeded, failed, aborted — to the right people, with per-rule failures logged. | [notifications.md](notifications.md) |
| Chat Channels | Use sk read-only from Google Chat (Slack/Teams to follow): ask, look up, and run workflows from the space your team already lives in. | [chat.md](chat.md) |
| Observability & Resource Limits | Diagnose a run in minutes with metrics, logs, and traces, bounded so no single workflow runs away. | [observability.md](observability.md) |
| Drift-assisted repair | Detect upstream API breaks during real execution and apply a validated repair instead of a 3am page. | [self-healing.md](self-healing.md) |
| Runtime Dependencies | The one host dependency outside the single binary — Chromium + playwright for SPA-docs discovery — and how it is provisioned. | [runtime-dependencies.md](runtime-dependencies.md) |
| Deploy & Upgrade | Replace the single binary and restart — the checksum-verified published-asset scp, `engine --self-update` (and why a private repo needs a token), and rollback. | [deploy.md](deploy.md) |
