# SubKit Agent Guide

Canonical repo-wide instructions for the SubKit engine and CLI. Closer AGENTS.md files override this guide.

## Product planning and documentation ownership

- Read [docs/PRODUCT-ROADMAP.md](docs/PRODUCT-ROADMAP.md) for the accepted hosted
  self-service direction, assumptions, opening criteria and source boundaries.
- [GitHub Issues](https://github.com/MikeBild/subkit/issues) and the private
  [SubKit Product Project](https://github.com/users/MikeBild/projects/4) own the
  operational task queue, priority and current issue state. Keep their stable
  links in [docs/roadmap-issues.json](docs/roadmap-issues.json) and run
  `node scripts/check-roadmap-links.mjs` after changing task IDs or links.
  [docs/TODO.md](docs/TODO.md) holds hosted acceptance details and evidence;
  LAUNCH_STATUS.md holds L-task evidence snapshots; WEBSITE-TODO.md holds website
  handoff details. Root TODO.md points to these sources and may contain separate
  operator reminders. Reconcile significant status changes across the issue and
  its source file; do not duplicate full status lists or transfer self-hosting
  dates to cloud.
- Daily and weekly ChatGPT briefings must read current GitHub main, Issues,
  Milestones and the SubKit Project before using repository evidence snapshots.
  The active private GitHub briefing workflows are preferred when their sensitive
  results are actually available to that client. If ChatGPT cannot dispatch a
  sensitive workflow, use authorized read-only GitHub access and name that limit;
  never infer a workflow run from a task prompt or an older snapshot.
- [docs/lovable-website-briefing.md](docs/lovable-website-briefing.md) owns current
  product/design copy; [docs/lovable-setup.md](docs/lovable-setup.md) owns access and
  handoff. Keep concrete private project/deployment metadata outside the repository.
- [docs/browserstack.md](docs/browserstack.md) and its linked test strategy describe
  planned supplementary cloud-browser checks, not an installed or verified service.
  Existing browser-use and manual visual-acceptance rules remain binding.
- Planning documents under docs/ are intentionally hand-maintained. API, CLI,
  settings and llms technical references remain generated from code and README.

## Design ownership: Lovable

- For public website work, read [WEBSITE-TODO.md](WEBSITE-TODO.md) first for
  current user decisions, verified scope, remaining release work and handoff location.
- Lovable exclusively creates and changes the design. Coding agents implement,
  integrate, and test the concrete Lovable design; they do not design independently
  or use another design generator as a substitute.
- Use the official Lovable integration to inspect the selected project and its
  current design before UI implementation. If the project or required state is
  missing, request it or have Lovable produce it rather than inventing a design.
- Preserve Lovable layouts, components, typography, colors, spacing, icons,
  interactions, and responsive states exactly. Any required deviation needs
  explicit user agreement before implementation.
- Existing Cockpit patterns remain binding until a concrete Lovable design
  replaces them. Visual acceptance remains manual under the validation rules below.

## Product boundaries

- Preserve the engine, CLI, shared-package, approval, and deployment boundaries.
- Keep the repository independent of the private deployment implementation.
- Keep all persisted data in the product-owned PostgreSQL schema. Other products
  are reachable only through their documented public APIs, never through their
  database objects, files, queues, or runtime internals.
- Keep migrations, `llms*.txt`, OpenAPI, and comparable self-description assets
  embedded in every shipped binary/image and covered by drift tests. `llms*.txt`
  is generated from code and README.md (`bun run gen:llms-txt`). Hand-written
  docs/ files cover product planning and handoff, not duplicate technical references.
- Do not record concrete production hosts, credentials, deployment identifiers,
  or private infrastructure anywhere in the repository. Examples use placeholders.
- Preserve human approval semantics and deterministic execution. A person
  approves an effect boundary (connectors, addresses, read vs. write) for an
  environment. The approval follows a newly activated version whose boundary
  does not grow and is asked for again when it grows. It may stand until
  revoked or be limited by runs and time; revoking it is always possible.

## Clippings: collection to knowledge

Accepted product direction for the clipper, knowledge domain, Cockpit, and chat.
This is a target contract, not a claim that the current implementation already
supports the process. Describe it as available only after the complete flow is
implemented and verified.

- Preserve the user journey: Sammeln → Inbox → im Chat prüfen und aufbereiten →
  Übernahme bestätigen → Wissen oder Skill.
- Inbox is the initial default category, not a reserved name or a permission
  boundary. Reuse shared categories without a separate intake collection level.
  Each authenticated identity may choose its default, including an empty category.
- Keep category membership, processing state, and knowledge admission separate.
  Collecting, renaming, or moving a clip never admits it to regular knowledge
  retrieval. Intake content is available for explicit review and preparation;
  normal knowledge retrieval excludes it until a person confirms the proposal.
- Chat proposes what to retain, with source references and a reviewable result.
  A person explicitly confirms the content and destination of the admission.
  Facts and reference material go to knowledge in their domain; a repeatable
  practice or convention goes to a skill. Admitting a skill activates guidance
  that chat and coding-agent briefings apply. A proposal that changes or
  replaces skills is bound to the skill versions the person reviewed. Both are
  content decisions; do not confuse them with an environment's standing
  connector or execution approval.
- Only a person in an authenticated browser session who holds the
  destination's permissions confirms an admission. API keys, MCP OAuth, token
  exchange, and chat channels prepare proposals and hand off to the review page;
  they never confirm.
- Learnings from coding-agent sessions and `save_learning` are collected
  material with origin `session`, not skill candidates. Redact them before
  storage, file them in the category of the repository's domain (otherwise the
  collector's default), append evidence to an existing item with the same title
  instead of duplicating it, and send them through the same review and
  confirmation. Do not collect status events or secret-adjacent notes.
- Preserve the original clip and provenance, linked to the resulting knowledge.
  Keep source author/publication time separate from collector/capture time.
  A credential label must never stand in for the original author's identity.
- Explain the same process in onboarding, intake empty states, the clipper, and
  chat review. Use the user's actual category name in contextual text. Show
  where an item is in the process and its next available action.
- Suggested user explanation: "Sammle Seiten, Ideen und Hinweise in deiner
  Kategorie. Im Chat prüfst du, was davon nützlich ist, und lässt es aufbereiten.
  Erst wenn du die Übernahme bestätigst, wird daraus Wissen oder ein Skill.
  Die ursprüngliche Quelle bleibt erhalten."
- Suggested chat starter: "Schau meine neuen Inbox-Einträge durch. Welche davon
  helfen uns? Schlage vor, was wir übernehmen sollten, als Wissen oder als
  Skill." Substitute the chosen category name for Inbox.
- Before shipping, cover category rename/move without admission, exclusion
  before confirmation, explicit intake review, proposal confirmation, and
  preserved provenance with acceptance tests. Keep README and generated
  self-description aligned with delivered behavior through existing generators.
- Completion also requires the whole user journey across Cockpit chat, sk CLI,
  MCP, HTTP, and supported chat channels. Reuse the same domain operations and
  human confirmation boundary. A surface may link to an authenticated review
  page when it cannot present the exact proposal safely; describe and verify
  that handoff instead of claiming native confirmation support.
- Coding-agent briefings must distinguish collected material from confirmed
  knowledge. Show a bounded, permission-scoped intake reminder and a useful
  next action; never preload clip bodies as instructions or accepted facts.
  Confirmed material must be discoverable in its intended knowledge domain.
  Hook status messages must tell the person what is available and what to do.
- Offer contextual review prompts using the actual category name. Measure
  discovery, review, confirmation, provenance, and retrieval separately, with
  explicit acceptance criteria and reproducible evidence. Prompt suggestions
  must never imply that a clip has already been accepted as knowledge.
- Keep setup guidance, README, generated llms assets, API contracts, and client
  capabilities aligned. Match Clipper controls, typography, colors, spacing,
  focus, and feedback to the existing SubKit design system.
- Provide a short public-API smoke verification suitable for an explicitly
  selected production test scope. Keep credentials and hosts outside the
  repository, require explicit opt-in for writes, and report timing, assertions,
  created resources, cleanup, and failures. The verifier stops at the review
  handoff; a person confirms in the browser, and a second run checks the
  admission, provenance, and retrieval. Do not infer permission to deploy
  or modify ordinary production content from a request for this verifier.
- During development run focused checks for the changed behavior. Run the
  broad completion gate after architecture, implementation, review, and test
  agents have checked the complete agreed acceptance scope.
- The active intake implementation goal includes a complete parity recheck after
  the shared-category cutover: Clipper, sk CLI, MCP, HTTP, Cockpit chat, and
  Google Chat. Check collection, category selection, discovery, review,
  discard/restore, proposal, authenticated confirmation handoff, provenance,
  and retrieval. Unsupported native actions must expose a working continuation,
  not claim success. Report simulated and live evidence separately; a missing
  connected-channel run remains an explicit verification gap.
- Recheck Codex and Claude Code briefings, session hooks, human-facing output,
  and contextual prompt suggestions. Confirmed sources must appear in the
  intended domain; raw clips must remain excluded and only produce a bounded
  permission-scoped review reminder. Cover updated generated llms assets,
  setup instructions, and shipped binaries in the same acceptance scope.
- Required cross-surface evidence: zero ordinary knowledge-search hits from an
  unconfirmed clip; every proposed source remains traceable; repeated identical
  confirmation produces exactly one admission; both coding-agent hooks can
  discover the confirmed source in the intended domain; briefing output never
  contains raw clip bodies. Verify restricted permissions and stale proposals
  as negative cases. A mock-only browser run is not production evidence.
- Reuse persisted conversations for review across clients, and keep clients
  thin. Present one primary category-aware review suggestion, with optional
  comparison and preparation prompts. Human-facing results explain what is
  useful, why, its sources, the proposed text and destination, and the next
  action. Derive effectiveness measures from existing audit events; separate
  deterministic contract checks from a bounded real-model evaluation.

## Cockpit consistency

Before changing a Cockpit view, inspect the matching existing view and reuse its
established design templates and shared components. Lists, category navigation
and editing, filters, row actions, and bulk actions must follow the existing
Cockpit patterns. Do not invent a new card layout, selector, checkbox interaction,
or category-management variant when the established pattern already serves the
user flow. Introduce a new pattern only when an existing one cannot support the
required behavior, and explain that gap first.
Use the existing form dialogs for editing product records. Do not use browser
`prompt`, `alert`, or `confirm` dialogs as product editing or approval surfaces.

For Intake, use the same DataTable and shared category-management drawer as
Knowledge Sources. Clicking an item opens its internal detail view; the source
address is a separate link in those details. Category management means editing
categories and assigning items, not starting a category review chat. Keep chat
review as an action on the collected item.
An item's chat action uses the existing visible @ reference mechanism, bound to
that item's ID, with a short review instruction. Never use a category-wide or
plural review prompt after the user selects a single item. Intake references
remain unreviewed source material and never become ordinary knowledge implicitly.
For every chat action with an @ reference, keep the accompanying instruction
action-only: do not repeat the referenced record's title or name in the prompt.
The item editor exposes title, content, and category in the existing form dialog.
Do not add a separate notes field. Preserve existing stored notes and the original
source snapshot; editing the working copy requires reviewing affected proposals again.
Show a proposal and its confirmation in the associated item's details
only when a proposal exists. Chat links open those details directly. Do not add
an empty global review section to the intake list. Chat preparation and explicit
human admission remain separate decisions.

Keep synthetic verification data in a separate test tenant or isolated fixture.
Do not populate the user's manual acceptance Inbox with generated test clips or
knowledge. Track created fixture IDs and clean those exact fixtures after checks;
never remove unrelated user content.

## Sources and workflow

For launch work, read [LAUNCH.md](LAUNCH.md), [LAUNCH_STATUS.md](LAUNCH_STATUS.md),
and [LAUNCH_SYNC.md](LAUNCH_SYNC.md). Record verified progress and preserve the
approval and validation rules in this guide.

Read touched code and the nearest AGENTS.md:
- apps/engine/AGENTS.md for engine work
- apps/sk/AGENTS.md for CLI work
- packages/shared/AGENTS.md for shared contracts

The engine currently contains 48 directories under `apps/engine/src/`; the
subsystem-count contract keeps this navigation summary aligned with the tree.

Work directly on `main`. Prefer focused changes, existing abstractions, and generated-source workflows. Never discard unrelated dirty-worktree state.
Before starting implementation, synchronize with `git pull --ff-only origin main`.
Secure existing tracked and untracked work first and restore it afterward without
dropping unrelated changes. Verify both checkout and running engine versions;
do not infer the deployed or local runtime version from the checkout alone.

## Non-negotiable rules

- Maintain strict boundaries between transport, domain, persistence, and execution.
- Preserve approval gates and interaction-mode behavior.
- Never commit credentials, local configuration, or generated secrets.
- Do not hand-edit generated artifacts when a generator exists.
- Keep shared guidance in AGENTS.md or closer directory guides, not Claude-only memory.
- No comments in code except tool directives (`biome-ignore`, `@ts-expect-error`,
  `tenant-filter:exempt`, …). Names and tests carry the meaning; a comment is a
  claim, only a test is evidence.
- No versions, dates, ticket, PR or commit references in code, tests or file names.
- No version-suffixed names (`*V2`, `_v2`, `legacy*`); replace the old path and migrate every caller in the same change.
- Commit messages are one conventional-commit line.

## Validation

Browser acceptance uses browser-use with Codex or Claude Code. Do not create,
restore, or run Playwright test suites, screenshot tests, or visual matrices.
Keep API, security, domain, contract, invariant, drift, and build checks automated.
Visual acceptance remains with the user.

There is no CI. The pre-push hook (lint, typecheck, invariants, drift, commit
messages, gitleaks, build) and `bun run verify` before every release tag are the
gate. `bun run release:tag` also runs `bun run verify:llm-live`, a fail-closed live
call of the release models that has no bypass: pass the deployed route as
`bun run release:tag -- --models anthropic:<primary>,openai:<fallback>`; keys come from
`./claude-key.txt` (Anthropic) and `./openai-key.txt` (OpenAI), both gitignored. Run the narrowest relevant checks while iterating.
Report any skipped validation.

Before handing a changed local demo installation to the user, verify affected
API journeys against the actual local services with `bun run demo:local:verify`.
This command covers APIs only. Verify browser actions, navigation, persistence,
permissions, approval handoffs, and a real provider chat response with browser-use
and Codex or Claude Code. Mocked fixtures or configuration readback alone do not
prove that local chat works. Reuse valid evidence, retain explicit verification gaps,
and keep user data intact. The user performs visual acceptance manually.
