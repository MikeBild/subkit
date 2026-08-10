# Subkit Cockpit UI/UX

Subkit implements the copied `cockpit-ui` family contract without importing runtime code from a
sibling product. The Cockpit is built, embedded and released with Subkit; it has its own routes,
session boundary, API facade and deployment lifecycle.

## Product adaptation

The home surface is a persistent, governed conversation rather than a dashboard. It combines the
family shell with Superglue's useful working pattern: a narrow history rail, a focused work surface
and an optional evidence/context panel. Vercel AI Elements render messages, tool calls, approval
cards, suggestions and the prompt composer.

Navigation follows the work instead of the engine's directory tree:

- **Work** — Chat and Inbox
- **Build** — Workflows and Runs
- **Resources** — Connectors, Knowledge, Skills and Files
- **Govern** — Approvals, Audit log and Usage
- **Admin** — People, Access, API access, Operations and Engine settings

Every entry declares its required effective permission and engine endpoint. Entries are omitted
when the browser session lacks that permission; the server remains the authorization authority.
State-changing requests use the browser-session CSRF proof returned by Cockpit bootstrap.

New authoring work starts in Chat. Resource pages provide search, inspection, refresh and direct
links into a contextual conversation; they do not create a second workflow-authoring state machine.
Approvals remain explicit and are resolved through the conversation's governed response endpoint.

## Interaction and presentation rules

The Cockpit composes the checked-in shadcn components for navigation, menus, cards, tables, sheets,
empty states and forms. Pages use one hierarchy: page heading and primary action, a compact toolbar,
then the data state. Cards do not wrap unrelated controls, and table rows use a named open button
instead of a pointer-only row action.

The signed-in user menu is the single home for profile information, language, theme and sign-out.
Language defaults to browser detection and can be pinned to English or German. Theme defaults to
the operating system and can be pinned to light or dark. The behavior is covered by
`src/app/i18n.test.ts` and `src/app/theme.test.ts`.

Database identifiers remain internal routing keys. Lists, detail titles, workflow steps and
structured tool output present names, labels or neutral positional fallbacks instead of UUIDs.
Interactive Cockpit elements carry stable, semantic `data-testid` selectors; repeated data uses
row or message positions rather than database identifiers. `src/app/testids.test.ts` enforces both
contracts.

The application shell is exactly one viewport high. The shell never grows with a long transcript;
the conversation list, transcript, context panel and resource results own their respective scroll
areas. On narrow screens, resource tables keep the two primary columns and move secondary details
to the row sheet.

`scripts/verify-cockpit-visual.mjs` exercises every Cockpit route with representative data at
desktop and mobile sizes. It rejects document overflow, transcript/composer overlap, raw tool
payload excerpts, visible UUIDs and resource error states, and records screenshots for visual
comparison. The production deployment verifier repeats the authenticated route sweep after SSO and
publishes its screenshots as a workflow artifact.
