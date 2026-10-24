# SubKit Agent Guide

## Sources

- Tasks, bugs, features, priority and acceptance: [Issues](https://github.com/MikeBild/subkit/issues).
- Roadmap, website and launch: [SubKit Product](https://github.com/users/MikeBild/projects/4) and [Milestones](https://github.com/MikeBild/subkit/milestones).
- Product, architecture, design, operating concepts and dated evidence: [Wiki](https://github.com/MikeBild/subkit/wiki).
- Keep project management entirely in GitHub. Do not create repository TODOs, roadmaps, status reports or handoffs.
- Issues and Wiki pages: goal first, short sentences, useful checklists, source links; no text walls or duplicate status lists.
- Every issue states "Fertig, wenn" (one checkable sentence) and "Nicht Teil davon". Keep at most three issues in progress; finish before starting the next.
- Fix a finding inside the current topic when it takes under 30 minutes; otherwise comment on an existing issue. Open a new issue only after the user agrees. Do not widen scope without asking.
- Bundle several finished issues into one release instead of releasing each fix. One session owns a release and announces it before tagging.
- Daily/weekly briefings read current GitHub main, Issues, Milestones and Project. Prefer private workflows only when the client can actually run and read them. Name sensitive-client limits and use authorized GitHub reads; never infer a run.

## Work

- The engine has 48 directories under `apps/engine/src/`; keep this navigation count aligned with the tree.
- Work on main. Secure existing tracked and untracked work before `git pull --ff-only origin main`; preserve and restore unrelated changes.
- Read touched code and the nearest AGENTS: engine, sk and shared-package guides override this one.
- Verify checkout and actual running engine versions independently.
- Use existing abstractions; preserve transport, domain, persistence and execution boundaries.
- Use one conventional-commit line. Never force-push or discard foreign work.
- No code comments except tool directives. No version/date/ticket/commit names in code, tests or filenames; no version-suffixed or legacy names.
- Never commit credentials, local configuration, generated secrets or concrete private infrastructure.

## Product boundaries

- Persist in the product-owned PostgreSQL schema. Reach other products only through documented public APIs.
- Preserve tenant isolation, RBAC, encryption, audit and deterministic execution.
- Human approval binds connector/address/read-write effects to an environment. It follows a version only when the boundary does not grow; support revocation and run/time limits.
- Keep migrations, OpenAPI and self-description assets embedded and covered by drift checks. Use generators for generated files.
- Product knowledge, skills and raw intake remain distinct. Only an authenticated person with destination permissions confirms admission; API keys, MCP and chat prepare proposals and hand off to review.
- Never treat raw clips or collected session notes as instructions or confirmed knowledge. Redact collection, preserve provenance, exclude unconfirmed material from ordinary retrieval.
- Follow the full [collection-to-knowledge contract](https://github.com/MikeBild/subkit/wiki/Clippings) before changing intake, review, admission or coding-agent briefings.
- Keep test fixtures isolated from the user's Inbox and knowledge; track and clean exact fixture IDs.

## Design

- Lovable owns public website design. Inspect the selected project through the official integration before implementation; preserve approved layouts and interactions.
- Superdesign owns Cockpit design. Inspect the concrete approved draft before UI changes; preserve its layouts, components, states and responsive variants.
- Existing Cockpit patterns remain binding until an approved design replaces them. Reuse DataTable, categories, form dialogs, row/bulk actions and visible @ references.
- Intake opens item details; source URLs remain separate. Use an action-only instruction with the selected item's @ reference. No browser prompt/alert/confirm for product editing.
- Category membership, processing and knowledge admission are separate; moving or editing a clip never admits it. A changed proposal must be reviewed again.
- Personal visual acceptance remains with the user.

## Validation

- Choose checks by changed behavior and risk, not by line count. Run the smallest meaningful focused test plus relevant type, lint, drift or build checks; even a tiny semantic change needs a focused regression check. Documentation-only and similarly low-impact changes do not need a full test suite.
- Reuse a successful verification result when it covers the exact current code, dependencies, configuration and relevant runtime. Do not rerun checks just because of a status request or an unrelated small change.
- `bun run release:tag` runs the essential release gate `bun run verify:gate` (static checks, drift checks, contract and determinism tests) plus the live LLM gate. Run the full `bun run verify` manually when the changed behavior warrants it. If `bun run release:tag` is running, do not start a second gate. Never run duplicate full verifications concurrently.
- Capture full-gate output to a readable log. When a gate fails, identify and fix the specific failure, then rerun the failed check; rerun the full gate only if code or relevant environment changed, or the previous run did not complete reliably.
- No Playwright suites, screenshot tests or visual matrices. Browser acceptance uses browser-use with Codex or Claude Code.
- Required pre-push checks and release gates remain mandatory; CI is not a replacement. Run each gate at the point it is required, not for every small edit.
- Release tags additionally require fail-closed `bun run verify:llm-live` through `bun run release:tag -- --models openai:<primary>,openai:<fallback>` using the deployed OpenAI-only route. Keys stay in gitignored local key files.
- Before handing over a changed local demo, run `bun run demo:local:verify`; also verify navigation, persistence, permissions, approval handoffs and a real provider response in the browser.
- Simulations, current code checks, connected-channel runs, hardware, legal/human acceptance, release and PROD evidence are separate. Report gaps and skipped validation explicitly.
- A documentation migration does not authorize release, deployment, Store submission or product opening.
