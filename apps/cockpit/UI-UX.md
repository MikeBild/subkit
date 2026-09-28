# SubKit Cockpit UI/UX

SubKit implements the copied `cockpit-ui` family contract without importing runtime code from a
sibling product. The Cockpit is built, embedded and released with SubKit; it has its own routes,
session boundary, API facade and deployment lifecycle.

## Completion of a blocked automatic run

An answered question, a checked repair, a saved version and permission to run are distinct facts.
The engine supplies current schedule permission to the chat. A held-write preview cannot prove live
readiness. After preparation, the same bounded execution review opens inside the chat and working
context. Only a currently valid grant for the exact active version and environment resolves its
schedule hold; the transition is audited and the Übersicht's attention list is refreshed. An inactive version,
missing input or a changed, expired, revoked or exhausted boundary never fabricates completion.
Questions and human-review cards use a subtle accent-blue surface, with visible options and effects.
Raw runtime messages stay in collapsed technical details.

## Product adaptation

The home surface is a persistent, governed conversation rather than a dashboard. It combines the
family shell with the Reference Architecture's useful working pattern: a work surface that keeps the
page, a history panel that opens from the header, and an on-demand evidence drawer. Neither the panel
nor the drawer consumes the transcript's working width. Vercel
AI Elements render messages, tool calls, approval cards, suggestions and the prompt composer.

Navigation follows the work instead of the engine's directory tree:

- *(ungrouped)* — Übersicht (Overview), with the number of open entries as its badge
- **Arbeit** (Work) — Chat
- **Automatisierung** (Automation) — Workflows, Runs and Connectors
- **Wissen** (Knowledge) — Knowledge, Skills and Files
- **Installation** — Usage, Settings, Credentials, People & access, Notifications, Audit

The first block carries no heading and the last one carries the family's name for it. The
convention (v2.1, §1 and §6) names both: Übersicht stands ungrouped at the top, and the
administration block is called "Installation". There is no Decisions, System or Access entry any more:
their facts each have one home (see "One fact, one home" below), and their old addresses redirect.

`src/app/navigation.ts` is the one declaration of that table and the source of
this list; when the two disagree the code is right and this paragraph is stale.

Every entry declares its required effective permission and engine endpoint. Entries are omitted
when the browser session lacks that permission; the server remains the authorization authority.
State-changing requests use the browser-session CSRF proof returned by Cockpit bootstrap.

New authoring work starts in Chat. Resource pages provide search, inspection, refresh and direct
links into a contextual conversation; they do not create a second workflow-authoring state machine.
Approvals remain explicit and are resolved through the conversation's governed response endpoint.

## Saved preparation and automatic operation

A fresh saved-workflow checkpoint displays “Workflow saved” in the chat header and working context. It never means activation or execution authority. A held schedule remains an open operating decision after a chat answer or draft save. Show this distinction directly in the chat, including the remaining held-schedule count and a review link to the workflow’s execution-authority section. Pending questions take precedence; hide the operating handoff while a turn is running. Re-read the held schedules before claiming the block is resolved.

## Interaction and presentation rules

The Cockpit composes the checked-in shadcn components for navigation, menus, cards, tables, sheets,
empty states and forms. Pages use one hierarchy: page heading and primary action, a compact toolbar,
then the data state. Cards do not wrap unrelated controls, and a table row is opened through the
link in its name cell, never through a pointer-only row action.

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
the conversation list, transcript, context drawer and resource results own their respective scroll
areas. Resource tables fit their container at every width: narrow screens fall back to a card
carrying the first three cells, wide screens show up to seven columns, and the row sheet or detail
page retains all secondary details.

The desktop cap used to be four columns, and four was right for as long as every list rendered the
same generic key/value rows: with no list able to say which of its fields mattered, a fifth column
was a fifth guess. Explicit per-list column sets changed the arithmetic. Under the old cap the
fourth column went to a timestamp on all eight lists, so the relation the operator actually came
for — which connectors a workflow reaches, which workflow a run belongs to, which workflows use a
connector — never reached the screen at all. Seven is the number at which each list can carry its
identity, its state, its relation and its time without a scroll.

The cost is contained because the widening does not relax the layout rules that keep tables honest.
Every table stays `table-fixed` inside `overflow-x-clip` (`src/components/ui/table.tsx`), every
column declares its own width through `columnDef.meta.width`, and cells wrap instead of pushing the
page sideways. A column that cannot state a width does not belong in the set.

One page frame (`src/components/cockpit/page-frame.tsx`) and one table
(`src/components/cockpit/data-table.tsx`) render every list. The frame owns the heading, the single
primary action and which element scrolls; the table owns the toolbar strip, the column picker,
refresh, sorting, paging and all four load states. Refresh sits in the table's own action column
rather than in the page header, because it acts on the rows and not on the page. Cell shapes — text,
state, date, size, relation link and relation chips — come from
`src/components/cockpit/table-columns.tsx` so a date on Runs and a date on Files cannot drift apart.

The page description is opt-in: a visible sentence under the heading only where the title does not
already say what the page is for (Connectors, Skills, Notifications). A description that repeats
the title is removed.
A list's primary action heads the page only while the list has rows; an empty list carries it in its
empty state, so the same button never stands twice. A row opens by its name: the name cell is a real
`<a href>` to the record's own address (a button where the record opens in place and has none), so
the keyboard, a screen reader and "open in new tab" all reach it; the whole row stays clickable as a
pointer convenience that ignores clicks on controls inside it, and the row itself is no tab stop.
There is no "Open" button in a row. A mobile card is not a button: its title is the link, and its row
actions are shown on the card as well. The "⋯" glyph is reserved for a real menu of several further
actions; a single further act is a named button. The breadcrumb stands only on a record's page, as
"List › Record", and its list crumb is the way back.

Tasks live on one page only: the Übersicht, the start page. Under its operations bar it lists what
needs the reader — one sentence per subject with one primary action and at most one secondary link —
and says "Alles erledigt." with one status line when nothing is open and every source it may read
has answered. Object pages
show their state and at most link to the entry; every fact has exactly one home.

Every read has four states — loading, error, empty, ready — decided once by `queryView` in
`src/components/failure-state.tsx`. A failed read renders `LoadFailed` (what did not load, what to
do, retry), never the empty state it would otherwise fall through to. Addresses come from the
builders in `src/app/links.ts`, router-relative, with `absolute()` only for a raw `href`; each builder
is tested against the parser its page reads it back with.

### Übersicht — operations bar and attention list

The Übersicht (`/`, English "Overview") is the start page and the only place a task lives. Top to
bottom: the page header with the title and the window switch (24 Std · 7 Tage · 30 Tage, 24 hours by
default); the operations bar; "Braucht dich", the attention list; a notice naming the sources that
could not be read, only when one failed; and one link into the audit trail, "Was bereits entschieden
wurde".

The operations bar holds exactly four figures in one row (two by two on a phone), each about 72px
tall so the attention list stays on the first screen: Ausführungen, Erfolgsquote and Übernommene
Reparaturen over the chosen window, and Gesunde Konnektoren, marked "Stand jetzt" because it is a
state of now. Every figure links to the list that counts the same rows over the same bounds — the
runs by `started_from`/`started_to`, the failed runs of that window, the decided repairs by
`ts_from`/`ts_to`, the connectors unwell now. A figure with nothing to count says so in words and
has no link; there is no link beside "100 %" when nothing failed or every connector is healthy. A
figure whose read failed says "nicht lesbar" with its own retry. The bar is shown to readers with
`stats:read`; connector health reads connectors only with `connector:read`. The figures and their
reads live in `src/pages/operations-figures.ts` and `src/pages/operations-bar.tsx`.

The attention list reads one engine list, `GET /v1/attention`, which the digest, the MCP connect line
and the MCP tool `get_attention` render too; the page never assembles its own list from several
reads. Every entry is checked against the reader's permissions on its subject, and waiting questions
are always the reader's own.

One entry per subject: a failing scheduled workflow and the fixes waiting for it are one entry, not one
per run and one per fix, and all skill proposals are one entry. Entries are ordered by class —
stopped, then failing, then decide — and within a class by the next deadline, then by age. An entry
is one sentence (the subject by name, the reason, "seit …"), one primary action and at most one
secondary link. The primary action follows the cause: a waiting fix is reviewed first, a refused
sign-in leads to the connector, anything else opens the chat with the subject attached. Without the
permission to act the entry says so instead of offering a link. The engine's own wording is not on the
entry.

The navigation badge is the number of entries. List headers carry no count, and no figure reads a
bare zero.

When nothing is open and every source the reader may read has answered, the operations bar stays and
the list gives way to "Alles erledigt." and one status line — the health state and the next scheduled
run. When a source did not answer, the page names it and offers to read again; it never says "all
clear" over a gap. A source the reader may not read does not count as missing. A reader who may read
no source at all lands on the first navigation entry they can see.

Warnings, test and authoring failures and unused keys are not entries: they are the state of an
object and stay on that object's page.

The old addresses redirect through `legacyTarget()` in `src/app/route-table.ts`: `/decisions` and
`/operations` land on the Übersicht, `/decisions?workflow_id=<id>` opens that workflow's review
sheet, and `/access` lands on the roles section of Personen & Rechte.

### Review sheet

Deciding happens in a sheet over the list, addressed as `?review=<id>`, so a mail, an audit row or a
bookmark can point straight at it. The sheet renders the existing decision cards; after a decision the
entry leaves at once and a toast links the audit trail. The engine's wording, raw source data and
technical details live here and only here, collapsed.

A proposed fix is titled in the reader's language. The engine passes the repair model's own change
note through verbatim — "Field follows the rename: data.id → data.result.id" — and that note used
to be the card's title, so the queue read as a list of commit messages from another system. The
title is now composed from what the decision is about, the workflow it would repair and the kind of
change, and the engine's note keeps its place as the summary line beneath it: German on top, the
original one layer down.

Every card then names where it came from before it names what it is, and what it acts on as a
name: two of the three sources carry only an id for their target, so the client resolves those ids
against the workflow and connector catalogues. An id we hold is always a valid route and always
becomes a link; what degrades when the catalogue cannot name the thing is the LABEL, which falls
back to the word for its kind. A name or a kind, never an id.

Each card carries two context columns — where this came from, and what it affects. The first names
the cause in words, links the run that failed and names the endpoint that moved; the second links
the workflow or connector a decision would act on. A run is linked only for someone holding
`execution:read`, because that permission is evaluated per object and a link nobody may follow is
worse than no link.

Expanding a card shows the full reasoning and the raw source data: a proposed fix carries the
engine's own account of what drifted, the model's stated justification, the classifier's argument
and the attempts that were dropped. A proposed skill shows the text approval would promote, with its
examples, pitfalls and referenced documentation, and the observed cases it rests on. A waiting
conversation shows the question being asked.

A proposal is decided where it appears: the diff card carries the before/after lines, the dry-run
result beside them and the approve/reject actions, both in the conversation and in the review sheet.
Both paths call the same engine decision, so the audit trail does not depend on the route taken.
Inside either card the diff renders without a frame of its own — cards do not nest.

A proposed skill states the model's confidence as a word with its scale named and the number of
observed cases it rests on. Never a bar, never a percentage, and never the success colour for
"high": a model's confidence is a claim about itself, not a measurement of the world.

There is no "remind me later" action, as §8.4 allows where no deferred state exists. The engine
models a patch candidate as proposed, applied, rejected or superseded and has no deferred state;
inventing a cockpit-local snooze would show a position as parked that the engine still counts as
open. Rejecting with a note is the honest alternative.

A held schedule is an observed admission failure, not a prepared approval proposal. Its review opens
the existing workflow review surface, where execution boundaries and supported approval paths can
be inspected. It never grants authority or starts a run from the list. Different workflow versions
and effects must not be collapsed into a blanket approval merely because their reason codes match.

The workflow review continues the same task language: a held schedule keeps its “Review needed”
status, while lifecycle metadata explicitly says “Version active”. Authority history refreshes
automatically; a retry action appears only after a load failure. The grant dialog opens in the
held schedule's environment and separates unsupported workflow effects from invalid numeric input.
Unsupported effects lead to a contextual preparation task, not an impossible grant form. Valid
fields never inherit an unrelated review failure. Granting retains finite server defaults and
never starts a run. Names and version labels replace internal identifiers in the grant review.

### One fact, one home

There is no decisions page and no system page. Each fact they showed has one home now:

- The health state is the Übersicht's status line, shown only when nothing is open; every cause of an unwell
  installation is an entry. Health components and the score are available through the API, MCP and
  Prometheus only.
- Executions, success rate, connector health and repair rate are the Übersicht's operations bar.
  Nutzung (`/usage`) shows consumption, the cap and its breakdown, and a "Laufzeit" table with its
  own window — never these figures a second time. Every figure links to a list that counts the same
  thing — the same window, the same filter. A count of zero has nothing to open and gets no link; a ratio, a score or a duration at
  zero is the worst state its figure can be in and keeps its way to the cause.
- Stale data is an entry on the Übersicht, and only when it is stale.
- There is no drift-scan button: the scheduler scans, and the CLI and MCP keep the manual scan.

### Installation pages

**Zugangsdaten** (`/api-access`) is the one page for API keys, connected applications and account
connections, each section addressable as `?section=keys|clients|grants`. It carries no attention list
of its own — that would be a second task list. Keys and connections show their state as chips; renewing
stays a row action.

**Personen & Rechte** (`/people`) is the one page for people, roles, groups and grants, each section
addressable as `?section=people|roles|groups|grants`. The entry shows for `identity:read` or
`rbac:read`, and each section is behind its own read.

**Einstellungen** (`/settings`, `src/pages/settings.tsx`) lists every section of the engine's
configuration at once, grouped by what an operator comes to change (`SETTING_GROUPS` in
`settings-model.ts`; a section the engine has and no group places fails `settings-model.test.ts`).
There are no tabs and no counters, and nothing scrolls sideways: from 720px of content the list stands
left of the open section, below that the list is the start view and a section opens in its place with
"← Alle Bereiche". A search keeps the list whole, dims sections without a hit and shows the hits of all
sections. A line above the sections appears only when something waits — a setting saved but waiting
for a restart, a last change that did not activate — and nothing when all is well. A row is the
setting's name, the control, "Wirkt nach Neustart" where that holds and the source only when it is not
the installation's own value or the default; key, source, scope and the engine's English wording are in
the collapsed "Technische Angaben". `?leaf=`, `?section=` and `?q=` address a setting, a section and a
search.

### Error, cause, fix

A failure never ends at a red word. Wherever the cockpit shows one — a run sheet, an unhealthy
workflow — one block (`components/cockpit/cause-fix.tsx`) says the state, the cause in the
cockpit's own words, the engine's wording where it wrote some, and exactly one next step. The step
is chosen by `lib/remedy.ts` in a fixed order: an open repair proposal is reviewed first, a
rejected sign-in leads to the connector, and anything else opens the chat with the workflow and
the run attached. Without the permission to act there is no link at all.

The run sheet follows the Reference Architecture's run dialog: the title is the workflow and leads
there, with the status beside it; then the short facts; then one sentence composed from the
engine's structured `outcome` — the step that stopped the run, the classified cause, how many steps
completed — never from its English error text. A cause class this build has no word for stays the
engine's value, set as one. The stopping step's error appears once, not again inside its step
card. The payload comes last and closed; a failed run's newest output is named for the step that
produced it, because a failed run has no result. Running a run again states its consequence first
— same version, same input, real effects — and is offered only where the engine accepts it.

The runs list carries the cause class of each failure in words (§3); a run that did not fail has an
empty cause cell, not a dash that reads as "unknown". On the workflow list the health mark leads to
that workflow's failed runs and the last-run time to its runs; the block column shows a name
derived from the slug prefix, never the slug. A workflow page shows its health beside the title, the
cause block when unhealthy, and its five latest runs with the way to all of them.

Approval cards are headed by what a reader decides by — environment, validity end, run limit —
with the state beside it. Versions read `v{n}` where the page knows the number; any other
identifier is shortened with the whole value on its `title`. The visual sweep enforces this by
shape: any UUID-shaped text outside a fenced block fails the frame, not only the one value the
fixture happens to know.

### Conversation surface

Chat does not take the shared page frame, and that is a recorded decision rather than an oversight:
it is a work surface with its own scroll regions, not a heading above a scrolling body. It follows the
frame's alignment rule regardless: header, transcript and composer share one 1280 px column with the
horizontal padding outside it, so the title, the messages and the field the reader types in all begin
on the same line, and the scroll owner reserves its gutter on both edges so a growing conversation
cannot shift that line. Chat had drifted away from this and carried three different left edges — the
header at the page margin, the transcript centred inside its own padding, the composer centred
without any.

The history is a panel rather than a rail. A reader who is reading one conversation is not choosing
another, so the list opens from the header, lies over the conversation, and closes when one is
picked — at every width, so there is one layout rather than two.

A conversation carries a name. The engine derives one from the first request and a boot backfill
named the rows that predate it; where a conversation genuinely has none, the list borrows the last
message rather than falling through to a placeholder while an excerpt sits unused beside it.

A governed action carries its own name too. The transcript reads a tool name through an explicit
registry with a humanising fallback, so a card says which action ran instead of repeating one
generic phrase; a saved workflow keeps the speaking name whoever saved it chose, unhumanised. Reads
that changed nothing collapse to one shimmering line per action and group once they are finished,
because six lookups an agent made to orient itself are one fact, not six cards. How a call ended
comes from the engine's own persisted verdict — the human decision first, the machine result
second — and a call that has sat without a result for five minutes reads as unfinished rather than
as permanently running.

A running action shows its latest log line and its age from the live stream. Neither survives a
reload, and neither pretends to: no per-call duration is persisted anywhere, so a reloaded
transcript shows no timer rather than a fabricated one.

A submitted turn shows a spinner and a short localized activity label above the composer until
the request settles, including quiet periods between tool calls. The submitted message is visible
immediately. The transcript follows growing output at the live edge; scrolling back releases
following. Sending another message or jumping to the latest message resumes it. Streaming
assistant rows are not top-aligned turn anchors. Switching conversations opens at the latest message.

Text entered while an `ask_user_text` question is pending answers that exact question through
the elicitation response endpoint. A stale detail snapshot can recover once from the typed append
guard; ordinary failures are never replayed. Text answers are never converted into boolean
approvals. Pending questions receive an actionable hint, not a connection-failure message.

### Product-family evidence

The shared contract is copied into each repository; no Cockpit imports another product at runtime.

| Product | Pattern retained for SubKit | Product-specific boundary |
| --- | --- | --- |
| WorkKit | One scroll owner per pane, `min-h-0`/`min-w-0`, account submenu, context help | Mission and run semantics stay in WorkKit |
| WikiKit | Fixed responsive tables and stable table-view contracts | Sources, pages and decisions stay in WikiKit |
| ContentKit | Tooltip/context-help composition and compact page hierarchy | Publishing and moderation stay in ContentKit |
| WatchKit | Wrapped, fixed-layout tables with no horizontal page scroll | Drift and evidence semantics stay in WatchKit |
| CodeKit | Neutral selection and explicit action hierarchy | Projects, tasks and credentials stay in CodeKit |
| SubKit | Conversation-first work surface, governed tool and approval cards | Workflows, connectors and tenant governance stay in SubKit |

### Action hierarchy

- A page has at most one filled primary action. Secondary actions use `outline`; low-emphasis and
  compact actions use `ghost`. Destructive styling is reserved for irreversible actions.
- Selection uses neutral `muted` surfaces. Blue is reserved for focus, links and charts.
- An icon-only action contains exactly one functional icon and always has an accessible label, a
  hover/focus tooltip and a stable `data-testid` at the usage site.
- A labelled action may have one leading icon marked with `data-icon="inline-start"`.

### Explanations

- Tooltips explain icon-only controls and unfamiliar compact actions in one short sentence.
- Hover cards are only for richer previews containing information beyond a label.
- Inline descriptions remain for page purpose, empty states, errors, approvals and other context
  that must stay visible for a safe decision.
- Dense work surfaces do not repeat the same explanation in a heading, tooltip and paragraph.

### Layout and language

- Every flex or grid ancestor of a scroll region uses `min-h-0`; flex-owned scroll regions also use
  `h-0 flex-1` so their viewport has a measurable height.
- Shell controls use an 8 px gap. Page sections use 16 or 24 px padding. Related compact controls
  use a 4 or 8 px gap.
- All user-facing application copy comes from the English/German catalog, including tooltips and
  screen-reader labels. Both catalogs have identical keys.
- Engine statuses and known field names are translated before display. UUIDs, tenant ids,
  credential ids, tokens and hashes remain hidden.

`scripts/verify-cockpit-visual.mjs` exercises every Cockpit route with representative data in both
languages at desktop and mobile sizes. It rejects document overflow, transcript/composer overlap,
raw tool payload excerpts, visible UUIDs and resource error states. An identifier inside a fenced
block is the single exception: there it is the content of an answer rather than a label on it, and
masking it hands the reader a request body that cannot work. Monospace alone is not the exception —
a bare identifier in backticks mid-sentence is banned like any other, and reached production once
because the rule was read as "code is untouchable" rather than "a payload is untouchable". It also records Chat tool,
tooltip and user-menu states for visual comparison. The production deployment verifier repeats the
authenticated bilingual route sweep after SSO and publishes its screenshots as a workflow artifact.

### Chat decisions

A pending `ask_user_confirm` is one interactive card, available both in the transcript and at the top of Working Context. Match its explicit `tool_call_id`; submit the elicitation ID to the canonical response endpoint. Show the question, short effect and explicit approve/reject buttons. Saving a workflow draft says “Save inactive version” and explains that it does not start the workflow. Technical parameters stay out of the default view. Both surfaces share processing, error and expiry states; prevent duplicate submissions. On completion refresh the canonical state and continue streamed activity. A completed request must not remain “Waiting” after reload.

A pending `ask_user_choice` uses an explicit selection card in both places. Show every option and its one-line effect directly, including a grounded recommendation; do not hide the decision behind a dropdown. Selection has a visible checkmark and requires a separate submit action. Keep the answer bound to the original option value and request ID; choosing an option does not submit it. Disable the text composer with an actionable hint while a selection is required. After the server accepts the selection, show its readable label as the user response and the tool as “Answered”, including after reload. Refresh the conversation and the Übersicht's attention list after each completed response. A held workflow schedule stays open until its admission requirement is resolved; answering a question or saving an inactive draft is not a run authority. Show this remaining task with a link to the affected workflow in Working Context.

Editing a saved workflow invalidates its whole-workflow check and saved status. Do not label an edited version “saved” using evidence from its previous version. An interrupted preparation offers “Check change” through the normal chat turn; run authorization is the next task only after preparation is complete. Historical text remains historical; the header and action card reflect current server state.

Workflow preparation includes inspection, validation and the supported preview within the current request and permission mode. These are assistant tasks, not user choices. Explain the verified result, any untested effects, and the next action briefly in the user's language. Held publications and skipped dependent steps must not be presented as successfully tested or executed. Ask only for missing business input, access, an unresolved tradeoff or authority, and give an evidence-based recommendation. Human-facing labels must not expose internal tool names or bypass flags. Existing persisted technical questions may receive a narrowly matched presentation translation; request identity, option values, explicit submission and server authority remain unchanged.


## Attention grammar

What follows is a verbatim German copy of §8 of Cockpit Convention v2.1 (`COCKPIT-KONVENTION.md` in the repo root), kept in German and byte-identical on purpose: the standard has one source and no diverging copies (§13). The Übersicht's attention list and its review sheet are measured against it. SubKit offers no "remind me later" in the sheet because the engine has no deferred state, which §8.4 allows; the reason is recorded above under "Review sheet". The copy below is never adjusted to this product, or it would no longer be a copy.

### 8. Anliegen-Grammatik

Jedes Produkt, das menschliche Aufmerksamkeit braucht (Freigaben, Reviews, Budget-Gates, Proposals, Rückfragen, gestörte Anmeldungen, scheiternde Automatik), zeigt sie an **einem** Ort: der Anliegen-Liste auf der „Übersicht" (§1). Eine eigene Entscheidungs-Seite und eine System-Seite gibt es daneben nicht; die Betriebsleiste über der Liste zeigt Zahlen, keine Aufgaben. Die Liste beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? Jedes Produkt baut das Muster in eigenen Komponenten nach (kein Import).

**8.1 Eine Quelle.** Die Liste kommt von der Engine, nicht aus dem Browser: `GET /v1/attention` (`attention.v1`) liefert die Einträge, je Eintrag gegen die Rechte der lesenden Person geprüft, und je Quelle ihren Stand (`answered` · `failed` · `not_permitted`). Digest, MCP-Verbindungszeile und das MCP-Werkzeug `get_attention` rendern dieselbe Liste. Rückfragen sind immer die eigenen der lesenden Person. Der Navigationseintrag „Übersicht" trägt als Abzeichen die Zahl der Einträge.

**8.2 Ein Eintrag je Gegenstand, drei Klassen.** Was denselben Gegenstand betrifft, ist **ein** Eintrag: ein scheiternder Workflow samt seinen offenen Korrekturen ist ein Eintrag, nicht einer je Lauf und einer je Korrektur; mehrere Skill-Vorschläge sind ein Eintrag. Die Klassen und ihre feste Reihenfolge: **gestoppt** (etwas steht, bis jemand handelt — gehaltener Zeitplan, wartende Rückfrage, abgelaufene Anmeldung) → **scheitert** (etwas läuft und schlägt fehl) → **entscheiden** (ein Vorschlag wartet, nichts ist blockiert). Innerhalb einer Klasse: nächste Frist zuerst, dann älteste. Es gibt keine Art-Chips, keine Rubriken, keinen Gruppieren-Umschalter und keine Zahl im Listenkopf. Nicht aufgenommen werden Warnungen, Test- und Autoren-Fehlschläge und ungenutzte Schlüssel — sie sind Zustand eines Objekts, keine Aufgabe.

**8.3 Eintrag.** Ein Satz: Gegenstand (beim Namen, nie UUID) + Grund + „seit …", wo vorhanden mit Frist „Entscheiden bis …" samt Herkunft. Dazu **eine** Hauptaktion und **höchstens ein** Nebenlink. Die Hauptaktion benennt die Handlung („Prüfen", „Anmelden", „Antworten" — nie „OK", nie „Öffnen"); ihre Reihenfolge folgt der Ursache (eine bereitliegende Korrektur wird zuerst geprüft, eine abgelehnte Anmeldung führt zum Konnektor, alles andere in den Chat mit dem Gegenstand im Kontext). Wer die Handlung nicht darf, sieht den Grund statt eines Links. Der Wortlaut der Engine steht nicht am Eintrag.

**8.4 Prüf-Seitenblatt.** Entschieden wird im Seitenblatt, das sich über der Liste öffnet und eine eigene Adresse hat (`?review=<id>`), damit Mail, Audit-Zeile und Lesezeichen direkt darauf zeigen können. Das Seitenblatt trägt die Karten-Anatomie: Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile → Aktionen, die die Handlung benennen („Freigeben", „Ablehnen", „Änderung anfordern"). Ablehnung klappt ein Notizfeld auf. Mehr Kontext steht hinter einem benannten Toggle („Mehr anzeigen"), nie hinter einem nackten Chevron: volle Begründung, Rohdaten der Quelle, der Wortlaut der Engine, ggf. ein Formular für strukturierte Rückfragen. Technische Details sind zugeklappt. Nach der Entscheidung verschwindet der Eintrag sofort (Optimistic-Hide), ein Toast verlinkt den Audit-Trail; ein Fehler bringt den Eintrag zurück. Wo das Produkt einen zurückgestellten Zustand kennt, bietet das Seitenblatt „Später erinnern" (Presets + eigener Zeitpunkt); wo nicht, fehlt die Aktion, statt einen Zustand vorzutäuschen, den die Engine nicht führt. „Dauerhaft verwerfen" nur mit Bestätigung; wenn endgültig, sagt die UI das.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet das Seitenblatt: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt das Seitenblatt, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.5 Zustand und Geschichte sind getrennte Flächen.** Die Anliegen-Liste zeigt ausschließlich, was auf den Menschen wartet. Zurückgestellt, Verworfen und Entschieden sind Vergangenheit: Erledigtes verlässt die Liste — es wird nicht gedimmt, nicht durchgestrichen, nicht in eigene Sektionen unter der Liste gestellt und nicht über Zustands-Filter wieder hereingeholt. Die vollständige Geschichte wohnt im Audit-/Aktivitätsprotokoll (append, nie gekürzt) und ist von der Übersicht über **genau einen** Verweis erreichbar — „Was bereits entschieden wurde", ein Satz mit Link, keine Zähler-Kacheln. Ein Wert der Betriebsleiste, der auf die gefilterten Audit-Einträge seines Zeitfensters führt (§10.1), ist kein zweiter Verweis auf die Geschichte, sondern der Beleg seiner Zahl.

**8.5b Die Zahl selbst ist eine Design-Frage.** Eine Liste, die einem Menschen
Hunderte Positionen vorlegt, hat ihre Aufgabe verfehlt, egal wie gut sie gegliedert ist.
Gemessen am 21.08.2026: WatchKit legt **359 Positionen** vor, weil Doku- und Drift-Befunde als
Entscheidungen zählen; WorkKit zeigt **15 gleichartige Budget-Sperren einzeln**; SubKit lässt
**jede Korrektur-Karte einer Gruppe einzeln** entscheiden; bei SubKit trugen die wartenden
Unterhaltungen **weder Freigeben noch Ablehnen** — folgenlose Positionen in einer
Entscheidungs-Queue.

Das ist kein Darstellungs-, sondern ein Zuschnittsproblem: **was gleichartig ist, wird zu
einer Entscheidung zusammengefasst; was folgenlos ist, ist keine.** §8.2 („ein Eintrag je
Gegenstand") ist die Antwort darauf.

> **Korrektur, 21.08. 18:40.** Oben stand „bei SubKit sind 32 von 35 Positionen wartende
> Unterhaltungen". Die 32 stammen aus dem **Prüfstand-Mock**, der den Statusfilter ignorierte;
> auf PROD liefert derselbe Aufruf `total=1`. Gefunden vom SubKit-Verifier, nachdem der Satz
> bereits byte-gleich in sechs Repos stand. **Eine Zahl, die niemand nachmisst, wird durch
> Verteilung nicht wahrer.**
>
> **Zweite Korrektur, 21.08. 19:20.** Der erste Korrekturblock stand *vor* dem Regelsatz, und
> Markdowns lazy continuation zog ihn mit hinein — die Regel las sich in allen sechs Repos als
> Teil einer historischen Fußnote. Gefunden vom Verifier der Konventionsrunde, der die Datei
> durch einen Markdown-Renderer geschickt hat statt sie zu lesen. **Auch eine Korrektur kann
> beschädigen, was sie korrigiert.**

**8.6 Leere.** Nichts offen und jede lesbare Quelle hat geantwortet: „Alles erledigt." und eine Statuszeile (Gesundheitszustand · nächste geplante Ausführung); darüber bleibt die Betriebsleiste (§1) stehen — nichts sonst, keine Kachel mit 0. Eine Quelle hat nicht geantwortet: kein „Alles erledigt", sondern ein Hinweis, welche Quelle nicht lesbar war, mit „Erneut lesen"; die Einträge der übrigen Quellen stehen trotzdem da. Eine Quelle, die die Person nicht lesen darf, zählt nicht als fehlend. Die Statuszeile erscheint nur im leeren Zustand; ist etwas offen, sind die Ursachen eines schlechten Zustands selbst Einträge. Alle Fälle sind getrennt testbar (§4 gilt).

**8.7 Kein Incident-Banner.** Ein offenes Budget- oder Health-Gate und eine gerissene Frist sind Einträge der Klasse „gestoppt" oder „scheitert" und stehen damit oben in der Liste. Ein zusätzliches Banner wäre ein zweiter Ort für denselben Fakt (§0.1). Eine Startseite, die bei offenen Gates „Alles erledigt" meldet, bleibt ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Quellen und Arten (Kinds) und ihre Badges, die Resolver-Formulare im Seitenblatt, die Quell-Referenzen. Familienweit sind die eine Engine-Quelle, die drei Klassen und ihre Reihenfolge, die Eintrags-Anatomie, das Seitenblatt, die Sprache, die Trennung von Zustand und Geschichte und die Leere-Regel.
