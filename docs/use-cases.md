# Use cases

What people actually run on sk — as cases, not features. Every row below is traceable:
**recipe** rows name a blueprint that ships in the box (clone it, bind your credentials,
run — the full list is the [catalog](catalog.md)); **our production** rows name a workflow
from the deployment we run sk's own company operations on. We dogfood sk daily; those are
our workflows, not customer references.

sk shows up in five shapes. Pick yours.

| Shape | In one line |
|---|---|
| [Personal AI assistant](#personal-ai-assistant) | One person, their own tools, running the same day |
| [Corporate LLM](#corporate-llm) | The company answers questions — with sources, or an honest "it's not in there" |
| [Agentic workflows](#agentic-workflows) | An agent builds it, an agent invokes it — the run itself never improvises |
| [Domain-specific AI](#domain-specific-ai) | sk learns a whole field of work, then every workflow in it arrives right |
| [Knowledge-base integration](#knowledge-base-integration) | Documents become searchable knowledge every AI client can ground on |

---

## Personal AI assistant

The smallest useful sk: one person pointing it at the tools they already use. No team
setup, no governance ceremony — that arrives later, when it matters.

| Situation | sk does | Systems | Runs on |
|---|---|---|---|
| A pricing page has no API and the price changes | Renders the page in headless Chrome, reads the price, mails you on change | Browserless + Gmail | our production |
| Receipts from one vendor are scattered across months of inbox | Filters messages with attachments into one list | Gmail | our production |
| "What's on my plate today?" | Pulls your open tickets with full details | Jira | our production |
| A long article, five minutes of time | Renders the page, summarizes it | Browserless + Anthropic | our production |
| Infrastructure cost creeps unnoticed | Mails a daily resource digest, grouped by project | DigitalOcean + Gmail | our production |
| A JS-heavy dashboard should land in your inbox every morning | Scrapes at 07:00, extracts, emails the digest | Browserless + SendGrid | recipe `browserless/scrape-then-email-digest` |

The pattern: **describe it once in a sentence, approve what sk built, and it runs from
then on** — on demand, on a schedule, or when an event fires.
Start: [Author quickstart](authors/quickstart.md).

---

## Corporate LLM

Your team asks questions where they already work — Slack, Teams, Google Chat, a browser AI
client — and the company answers from its own knowledge.

| Situation | sk does | See |
|---|---|---|
| "How do we normally do this here?" | Searches your knowledge sources and answers **with a Sources footer** naming what it read — or says plainly that the answer isn't in there, instead of inventing one | [Answer provenance & honest refusal](concepts/governance-and-audit.md#answer-provenance-and-honest-refusal) |
| The team lives in chat | The sk bot answers questions and runs saved workflows there. Deliberately: **a chat window runs things; it does not rewrite them** — changing a process goes through a surface a person can review | [Chat channels](operators/chat.md) |
| "Who saw what?" | The same RBAC and the same append-only audit trail as every other door — chat is not a side entrance | [Governance & audit](concepts/governance-and-audit.md) |

What makes this a *corporate* LLM rather than a chatbot: the knowledge is curated (a human
approves what gets remembered), the answers carry provenance, and every interaction is
permission-checked and recorded. Details:
[Ask your company's knowledge](authors/asking-your-knowledge.md).

---

## Agentic workflows

The term needs defining, because sk draws the line deliberately:

> **Agentic** here means: *an agent authors the workflow, and an agent can invoke it* —
> every saved workflow is a callable `wf_<slug>` tool on the MCP surface.
> It does **not** mean a model re-decides what to do on each run. Once approved, the
> control flow is fixed — that determinism is what makes the rest safe to leave running.

What the fixed control flow can still express:

| Situation | sk does | Runs on |
|---|---|---|
| A PR must merge only after human sign-off | Opens the PR, waits up to 24 h for an external approval signal, then merges — or abandons on timeout | recipe `github/merge-pr-after-approval` |
| A new customer should be enriched and announced | Stripe customer → HubSpot contact → Slack notification, one workflow across three systems | recipe `stripe/new-customer-enrich-notify` |
| Trial users need day-1/3/7/14 touchpoints | Daily sweep with persistent per-contact state driving the cadence | recipe `intercom/trial-nurture-day-1-3-7-14-via-state` |
| A booking must never half-commit | Debit and credit in one database transaction | recipe `postgres/atomic-debit-credit-double-entry` |
| A failed payment needs eyes now | Signature-verified webhook → redacted Slack alert | recipe `stripe/on-charge-failed-notify-slack` |
| Market signals should become published content | An eight-workflow chain: collect → normalize → analyze → generate → publish → **acceptance check** | our production (`radar-*`) |
| Metrics live in five systems and the report is manual | Daily/weekly/monthly/yearly rollups across analytics, search, repos, and infrastructure — plus retention of old artifacts | our production (`mission-control-*`) |

Which building block carries which shape:

| Building block | Carries |
|---|---|
| `request` — five drivers: HTTP, GraphQL, SQL, S3, MCP | Any system call, uniform retry/backoff/audit |
| `loop` + `transform` | Collect and normalize collections |
| `branch` | Deterministic gates — "if refund, else charge" |
| `parallel` | Fan out independent calls concurrently |
| `call` | Compose workflows into pipelines |
| `wait_for_event` | A human in the loop — the run pauses for a signed signal, with a timeout path |
| `output_schema` + validation expressions | Business invariants that fail the run instead of shipping bad data |
| `response_filters` | PII masking at the tenant boundary, whichever step produced the data |

The model behind the line: [Workflow execution](concepts/workflows.md) ·
[Reversibility & trust domains](concepts/reversibility-and-trust-domains.md).

---

## Domain-specific AI

A single workflow answers one question. A **domain** — your expense policy, your editorial
style, your compliance framework — is the shared context that makes *every* workflow in it
correct. You model one with three primitives: a **Connector** (the system of record),
**Skills** (rules the AI follows), and **Knowledge Sources** (documents the AI searches).

| Domain | Skill prescribes | Knowledge Source informs | Evidence |
|---|---|---|---|
| Expense approval | Two-approver rule over €1,000, receipt requirement | The expense policy PDF — thresholds, per-diem rates | worked end to end in [Model a domain](authors/model-a-domain.md) |
| Editorial house style | Punctuation and style conventions the AI must follow | The style corpus it can cite | locked as an eval fixture in the repo (`knowledge-retrieval-blogde-golden`) |
| Vendor quirks | "Stripe returns 200 with an error object for validation failures" — and 44 more `*-basics` Skills like it, shipped per connector template | vendor docs, ingested per connector | shipped in the box |

Honesty note: what ships at boot is **product knowledge** — sk's own reference plus
per-vendor API mechanics. Your business domain is what *you* bring, and the trio above is
how. The worked path: [Model a domain](authors/model-a-domain.md).

---

## Knowledge-base integration

Getting knowledge *in*, keeping it current, and letting every AI client ground on it.

| Situation | sk does | Runs on |
|---|---|---|
| The knowledge lives on a website | Crawls the sitemap, converts every article to clean Markdown for ingestion | recipe `web-scraper/crawl-sitemap-to-markdown` |
| A document exists only as rendered HTML | Converts it to Markdown for downstream extraction | recipe `jina-reader/sec-filing-to-markdown` |
| Every coding-agent session starts from zero | Claude Code / Codex sessions open with a briefing of your approved domain rules, and can look runbooks up instead of inventing them | [Use sk from a coding agent](authors/coding-agents.md) |
| What a session learned evaporates when it ends | Capture an observation → human review → approved, domain-tagged rule the next session carries | our production (`capture-dogfood-observation` → `promote-dogfood-learning`) |
| Nobody knows where the knowledge has gaps | A weekly coverage report over the knowledge base | our production (`wikikit-coverage-weekly`) |
| A model should read these docs itself | The engine serves `/llms.txt`, `/llms-full.txt`, and every page under `/llms/<path>` unauthenticated | [Docs index](README.md#pipe-these-docs-into-an-llm) |

The loop that compounds: knowledge grounds authoring, runs surface patterns, humans
promote what worked — see [Knowledge & skills](concepts/knowledge-and-skills.md).

---

## Where to go next

- **Try one of these today** → [Author quickstart](authors/quickstart.md)
- **Browse everything that ships** → [Connector & recipe catalog](catalog.md)
- **Understand why this holds up in production** → [Architecture overview](concepts/overview.md)
