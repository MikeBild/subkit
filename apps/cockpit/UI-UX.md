# SubKit Cockpit UI/UX

SubKit implements the copied `cockpit-ui` family contract without importing runtime code from a
sibling product. The Cockpit is built, embedded and released with SubKit; it has its own routes,
session boundary, API facade and deployment lifecycle.

## Completion of a blocked automatic run

An answered question, a checked repair, a saved version and permission to run are distinct facts.
The engine supplies current schedule permission to the chat. A held-write preview cannot prove live
readiness. After preparation, the same bounded execution review opens inside the chat and working
context. Only a currently valid grant for the exact active version and environment resolves its
schedule hold; the transition is audited and the decision queue is refreshed. An inactive version,
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

- *(ungrouped)* — Overview and Decisions
- **Work** — Chat and Inbox
- **Build** — Workflows, Runs and Connectors
- **Knowledge** — Knowledge, Skills and Files
- **Installation** — System, Settings, Credentials, Notifications, Audit, then People, Access and
  Usage

The first block carries no heading and the last one carries the family's name for it. The
convention names both: the decisions entry stands ungrouped directly under the overview, and the
administration block is called "Installation" in all six products and owns the same five entries —
System, Settings, Credentials, Notifications, Audit — before anything SubKit adds to it. Audit and
Usage used to sit in a "Govern" block of their own; a section that has to contain Audit cannot also
leave it somewhere else.

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
already say what the page is for (Connectors beside Connections, Skills, Access, System,
Notifications, Decisions, the Overview). A list's primary action heads the page only while the list
has rows; an empty list carries it in its empty state, so the same button never stands twice. A row
opens by its own click and by one named "Open" button — the "⋯" glyph is reserved for a real menu of
further actions — and a name cell is text, not a third way to the same record. The breadcrumb stands
only on a record's page, as "List › Record", and its list crumb is the way back.

Every read has four states — loading, error, empty, ready — decided once by `queryView` in
`src/components/failure-state.tsx`. A failed read renders `LoadFailed` (what did not load, what to
do, retry), never the empty state it would otherwise fall through to. Addresses come from the
builders in `src/app/links.ts`, router-relative, with `absolute()` only for a raw `href`; each builder
is tested against the parser its page reads it back with.

### Decisions surface

Every proposal that needs a person lives on one page (`/decisions`): proposed fixes, skill
candidates and the scheduled workflows that are held or keep failing; the conversations waiting for
an answer have a tab of their own there. The navigation entry sits directly under the overview and
carries the exact open count, taken from the engine totals — when a count cannot be read it is
omitted rather than guessed.

The open count is said in exactly two places: the navigation badge and the kind chips. One rule
holds them together (`openDecisionQueue` and `chipCounts` in `decisions-model.ts`): the badge counts
what the chips count — fixes, skills, and held or failing schedules — so the chips always sum to the
badge. The waiting conversations are not in it: they carry no approve and no reject here (§8.5b) and
are counted on their own "Rückfragen" tab. There is no summary sentence and no per-rubric count
badge; each extra copy of the number was one more the reader had to reconcile. "Alle" and "Alle
anzeigen" are one reset, which clears both the chips and the bucket a tile brought.
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

Expanding a card shows the full reasoning and the raw source data, and this is not decoration: a
proposed fix carries the engine's own account of what drifted, the model's stated justification,
the classifier's argument and the attempts that were dropped — all of which arrive with the list
and were previously read and discarded. A proposed skill shows the text approval would promote,
with its examples, pitfalls and referenced documentation, and the observed cases it rests on. A
waiting conversation shows the question being asked. Before this, a person was asked to approve a
skill body they had never seen and a repair whose cause was never stated.

Deviation from the family convention, deliberate: the queue is not a 780px column. §8.2 asks for
one, and one was right while a card held a badge, a title and two buttons. A card that has to
carry the evidence for a decision does not fit in it, and the space beside it was empty. The page
uses the same full-width frame as every other surface; long prose inside a card is capped at a
reading measure instead, because the typographic limit belongs to the text and not to the page.

The queue's first division is what a position is doing to you, not how old it is. A conversation
waiting for an answer is stopped — an elicitation is pending and the agent loop is suspended
mid-turn — while a proposed fix blocks nothing and instead lets its workflow keep running and keep
failing. Age still divides the second pile, because that is the honest measure there, but it can no
longer put the position nobody is waiting on above the one that is stopped dead. That second pile
is two rubrics side by side and not one nested in the other: "Blocking nothing", and beneath it the
family's name for what has sat longer than three days. It used to be nested under a heading that
read "Can wait" — a verdict the product has no way to reach on the reader's behalf, and one that
buried the rubric the convention actually names. Where the engine
supplies a deadline the queue sorts by it and says how long is left; a lapsed position moves into
its own muted rubric rather than sitting in the working queue as if it were still decidable.

A proposal is decided where it appears: the diff card carries the before/after lines, the dry-run
result beside them and the approve/reject actions, both in the conversation and in the queue.
Both paths call the same engine decision, so the audit trail does not depend on the route taken.
Inside either card the diff renders without a frame of its own — cards do not nest, and a bordered
diff inside a bordered card inside a bordered `pre` was three frames for one thing.

A proposed skill states the model's confidence as a word with its scale named and the number of
observed cases it rests on. Never a bar, never a percentage, and never the success colour for
"high": a model's confidence is a claim about itself, not a measurement of the world.

Deviation from the family convention, deliberate: there is no "remind me later" action. §8.3 lists
one in the ⋯ menu, but the engine models a patch candidate as proposed, applied, rejected or
superseded and has no deferred state; inventing a cockpit-local snooze would show a position as
parked that the engine still counts as open. Rejecting with a note is the honest alternative.
What is settled does not come back onto this page at all: §8.5 keeps state and history apart, so
the decided and rejected positions live in the audit trail, reached by the single link the queue
carries.

Scheduled workflows held at admission appear in a named blocking group after the section controls
and kind filters. They use compact neutral cards with a status badge, workflow name,
short reason and an explicit review action. The cron expression and full explanation are behind a
keyboard-accessible disclosure. Holds obey the same kind filtering, loading and error states as the
rest of the queue; no repeated destructive alerts may precede its controls.

A hold is an observed admission failure, not a prepared approval proposal. Its review action opens
the existing workflow review surface, where execution boundaries and supported approval paths can
be inspected. It never grants authority or starts a run from the queue. Different workflow versions
and effects must not be collapsed into a blanket approval merely because their reason codes match.

The workflow review continues the same task language: a held schedule keeps its “Review needed”
status, while lifecycle metadata explicitly says “Version active”. Authority history refreshes
automatically; a retry action appears only after a load failure. The grant dialog opens in the
held schedule's environment and separates unsupported workflow effects from invalid numeric input.
Unsupported effects lead to a contextual preparation task, not an impossible grant form. Valid
fields never inherit an unrelated review failure. Granting retains finite server defaults and
never starts a run. Names and version labels replace internal identifiers in the grant review.

### Overview surface

The overview is the family's operational dashboard and nothing else. Its tiles are fixed by the
family contract (`FAMILY-UI.json`, checked by `checkOperationalDashboard` in
`scripts/konvention-check.mjs`): four decision counts — blocked, failing, waiting a while, other —
then the health state and the data freshness, then the product sections. It carries no incident
banner, no failure groups, no lists and no recent runs; adding, removing or reordering a tile is a
contract change, not a page change.

Every tile is a number and, where the number counted something, the way to it. The engine owns the
way (contract 2.3): each metric carries a drilldown aimed at what it counted, the health score at its
worst component, the data freshness at its stalest source, and the repair rate at the decided
repairs in the audit trail. The page adds one rule of its own, `metricOffersDrilldown`: a COUNT of
zero has nothing to open and gets no link — a link under "production incidents: 0" once opened nine
hundred rows. The rule is about counts only. A ratio, a score or a duration at zero is the worst state
its tile can be in (execution success 0 %, connector health 0 %, a health score of 0), so it links
whenever the engine names a way in; the tile carries its kind as `data-family-kpi-kind`, and the
convention check holds every card, core and product section, to that rule. A value that could not be
read gets no link either, unless the tile is red: the health
state turns critical on blocked work alone, with no score when nothing ran, and a red tile always
keeps its way to the cause.

The causes behind a red tile are not on the overview; they live where they can be acted on. The
failing and blocked workflows are on the decisions page, each tile linking to its own bucket there.
The health components, the concrete causes the engine names and the stale sources are on the system
page. The waiting count uses the same labels as the queue it links to: the fourth tile says
"Liegt schon länger", the words of the decisions page's own rubric for that bucket.

There is no "next scheduled run" tile. The engine exposes a cron expression, a timezone and a
paused flag, and computes no next-fire instant anywhere; a time this page derived itself would be a
guess presented as a fact.

### System surface

The system page answers "is this installation healthy, and if not, why". It reads the same snapshot
as the overview (one query key, one read) and shows the problems first: an attention block with one
line per cause the engine names, per stale or never-run source, and — when the score is not healthy
and the engine named no cause — per weak component, each with its way to where it is fixed. When
nothing is wrong the block is absent, not an "all good" card the reader learns to skip; an
incomplete report or an undetermined state is a problem of its own, never an all-clear. Below it,
every health component with its value and link, and every freshness source with when it last ran.

A cause line is the cockpit's own sentence, composed from the cause's `subject` (the workflow or
connector, by name) and its `reason`; its link is built by the same `links.ts` builders as every
other link. The engine's `label` is English prose kept for the family contract and is never shown.
What the engine wrote that nobody can translate — a failing group's cause, a connector's health
reason — arrives as `detail` and stands on its own line behind "Wortlaut der Engine", the same
marking the catalogue's health reason carries.

It used to hold only the drift scan and a sentence saying its findings were on the overview, while
the overview's red health tile linked here: a loop with a cause at neither end.

Checking and repairing stay two acts in one order: the drift scan reads and reports, and every
repair it proposes becomes a decision a person makes. The scan's toast says how many repairs it
proposed and, when there are any, leads to the decisions page. There is no button that does both.

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

A pending `ask_user_choice` uses an explicit selection card in both places. Show every option and its one-line effect directly, including a grounded recommendation; do not hide the decision behind a dropdown. Selection has a visible checkmark and requires a separate submit action. Keep the answer bound to the original option value and request ID; choosing an option does not submit it. Disable the text composer with an actionable hint while a selection is required. After the server accepts the selection, show its readable label as the user response and the tool as “Answered”, including after reload. Refresh conversation, decision queue and operational overview after each completed response. A held workflow schedule stays open until its admission requirement is resolved; answering a question or saving an inactive draft is not a run authority. Show this remaining task with a link to the affected workflow in Working Context.

Editing a saved workflow invalidates its whole-workflow check and saved status. Do not label an edited version “saved” using evidence from its previous version. An interrupted preparation offers “Check change” through the normal chat turn; run authorization is the next task only after preparation is complete. Historical text remains historical; the header and action card reflect current server state.

Workflow preparation includes inspection, validation and the supported preview within the current request and permission mode. These are assistant tasks, not user choices. Explain the verified result, any untested effects, and the next action briefly in the user's language. Held publications and skipped dependent steps must not be presented as successfully tested or executed. Ask only for missing business input, access, an unresolved tradeoff or authority, and give an evidence-based recommendation. Human-facing labels must not expose internal tool names or bypass flags. Existing persisted technical questions may receive a narrowly matched presentation translation; request identity, option values, explicit submission and server authority remain unchanged.


## Decision grammar

What follows is a verbatim German copy of §8 of Cockpit Convention v1.7 (`COCKPIT-KONVENTION.md` in the repo root), kept in German and byte-identical on purpose: the standard has one source and no diverging copies (§13). This product's decisions page is measured against it. Deliberate deviations are justified above under "Decisions surface" — the queue is not a 780 px column (§8.2), and there is no "remind me later" entry in the ⋯ menu (§8.3) because the engine has no deferred state. Both stand; the copy below is not adjusted to them, or it would no longer be a copy.

### 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? WorkKit ist die Referenz-Implementierung; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Die Sortierung ist fest: ablaufend zuerst, dann älteste. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Art-Chips mit Zählern sind das einzige Ordnungswerkzeug; der gewählte Chip bleibt lokal erhalten. Ein zusätzlicher Gruppieren-Umschalter ist Überfluss und damit ein Konventionsbruch.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet die Zeile: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt die Zeile, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Zustand und Geschichte sind getrennte Flächen.** Die Entscheidungs-Seite zeigt ausschließlich, was auf den Menschen wartet. Zurückgestellt, Verworfen und Entschieden sind Vergangenheit: Erledigtes verlässt die Queue — es wird nicht gedimmt, nicht durchgestrichen, nicht in eigene Sektionen unter der Queue gestellt und nicht über Zustands-Chips wieder hereingeholt. Ein Umschalter, der die Queue auf einen vergangenen Zustand stellt, ist ein Konventionsbruch; Filter auf der Queue filtern die **Art**, nie den Zustand. Die vollständige Geschichte wohnt im Audit-/Aktivitätsprotokoll (append, nie gekürzt) und ist von der Entscheidungs-Seite über **genau einen** Verweis erreichbar — ein Satz mit Link, keine Zähler-Kacheln. Wo die Vergangenheit dort nur als Maschinenwert ankommt, gehören Benennung und Filter ins Protokoll, nicht die Sektionen zurück in die Queue.

**8.5a Zähler-Kacheln.** Für **Offenes** erwünscht — wenn sie Entscheidungen nach **Kategorie**
aufschlüsseln und dadurch Übersicht schaffen, statt eine Summe zu wiederholen. Jede Kachel führt
auf die gefilterte Liste. Für **Erledigtes** gibt es keine. *(Mike, 21.08.2026.)*

**8.5b Die Zahl selbst ist eine Design-Frage.** Eine Entscheidungs-Seite, die einem Menschen
Hunderte Positionen vorlegt, hat ihre Aufgabe verfehlt, egal wie gut sie gegliedert ist.
Gemessen am 21.08.2026: WatchKit legt **359 Positionen** vor, weil Doku- und Drift-Befunde als
Entscheidungen zählen; WorkKit zeigt **15 gleichartige Budget-Sperren einzeln**; SubKit lässt
**jede Korrektur-Karte einer Gruppe einzeln** entscheiden; bei SubKit trugen die wartenden
Unterhaltungen **weder Freigeben noch Ablehnen** — folgenlose Positionen in einer
Entscheidungs-Queue.

Das ist kein Darstellungs-, sondern ein Zuschnittsproblem: **was gleichartig ist, wird zu
einer Entscheidung zusammengefasst; was folgenlos ist, ist keine.**

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

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, die Trennung von Zustand und Geschichte, Leere-Zustände und der Banner-Vertrag.
