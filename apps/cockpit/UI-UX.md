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
- **Admin** — People, Access, API access, Operations and Settings

Every entry declares its required effective permission and engine endpoint. Entries are omitted
when the browser session lacks that permission; the server remains the authorization authority.
State-changing requests use the browser-session CSRF proof returned by Cockpit bootstrap.

New authoring work starts in Chat. Resource pages provide search, inspection, refresh and direct
links into a contextual conversation; they do not create a second workflow-authoring state machine.
Approvals remain explicit and are resolved through the conversation's governed response endpoint.

