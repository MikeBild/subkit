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
convention (v2.2, §1 and §6) names both: Übersicht stands ungrouped at the top, and the
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

A fresh saved-workflow checkpoint displays “Workflow saved” in the chat header and working context. It never means activation or execution authority. A held schedule remains an open operating decision after a chat answer or draft save. Show this distinction directly in the chat, including the remaining held-schedule count and a review link to the workflow’s automation panel. Pending questions take precedence; hide the operating handoff while a turn is running. Re-read the held schedules before claiming the block is resolved.

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

The operations bar holds exactly six figures in a grid that never scrolls sideways — six in a row
on a wide screen, three by two on a desktop, two columns on a phone — each about 72px tall so the
attention list stays on the first screen: Ausführungen, Erfolgsquote, Übernommene Reparaturen and
Kosten over the chosen window, Gesunde Konnektoren, marked "Stand jetzt" because it is a state of
now, and Kontingent, marked "Monat" because the cap is spent against the calendar month. Every
figure links to the list that counts the same rows over the same bounds — the runs by
`started_from`/`started_to`, the failed runs of that window, the decided repairs by
`ts_from`/`ts_to`, the connectors unwell now, Nutzung over the same window for Kosten
(`/usage?window=…`), Nutzung for Kontingent. Kosten is the window's amount in the prices' currency
from `GET /v1/stats/llm` (built-in price catalog plus `tokens.prices` overrides); when some calls
had no price it reads "mind. …" with the number of unpriced calls, and when none had a price it
says "Modelle ohne Preis" and leads to Nutzung, never "0,00". Kontingent is the month's share of
`tokens.monthly_budget` from `GET /v1/status` — "27 % von 150 Mio. Token", the remainder and the
pressure word (Reichlich · Wird knapp · Fast aufgebraucht, on the rounded percentage at the
engine's 75/90 thresholds); with no cap it reads "Kein Kontingent", without a percentage, and links
the setting only for `settings:write`. A figure with nothing to count says so in words and has no
link; there is no link beside "100 %" when nothing failed or every connector is healthy. A figure
whose read failed says "nicht lesbar" with its own retry. The bar is shown to readers with
`stats:read`, which is also what Kosten and Kontingent read; connector health reads connectors only
with `connector:read`. The figures and their reads live in `src/pages/operations-figures.ts` and
`src/pages/operations-bar.tsx`.

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

An approval is listed before anything is refused. A workflow whose schedule or webhook would start
a version no approval covers is an entry at once — "… hat eine neue Fassung v4, die auf Freigabe
wartet" — due at its next scheduled start; one whose approval ends within three days or has less
than a tenth of its runs left is a quieter one. Both lead to the workflow page's automation panel
with the step as their label ("Freigeben", "Verlängern"), never to a review sheet with nothing in
it. The first refused start turns the same entry into the stopped one; a workflow never has two.

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
- Executions, success rate, connector health, repair rate, spend and budget are the Übersicht's
  operations bar; spend and budget there only in short form. Nutzung (`/usage`) keeps the detail —
  the spend and the cap with their breakdown by axis, and a "Laufzeit" table — over one window
  its address names (`?window=24h|7d`, thirty days by default) — never the four operating figures a
  second time. Every figure links to a list that counts the same
  thing — the same window, the same filter. A count of zero has nothing to open and gets no link; a ratio, a score or a duration at
  zero is the worst state its figure can be in and keeps its way to the cause.
- Stale data is an entry on the Übersicht, and only when it is stale.
- There is no drift-scan button: the scheduler scans, and the CLI and MCP keep the manual scan.

### Installation pages

**Zugangsdaten** (`/api-access`) is the one page for everything that holds or grants rights. One
sentence says what it is for ("Wer darf auf SubKit zugreifen — und worauf greift SubKit in deinem
Namen zu."), and its three sections are named for when one needs them, each with an example:
**Apps mit Zugriff auf SubKit** (Claude, ChatGPT — added from the app itself; the empty state links
the guide), **Schlüssel für Skripte** (a script, a cron job, CI; "Schlüssel erstellen") and **Zugriff
in deinem Namen** (SubKit uses another system on the reader's behalf; "Verbinden"). They are tabs in
the pattern of Personen & Rechte — a tab strip on a wide screen, a select on a phone — each at its
own address, `?section=clients|keys|grants`; the bare address opens the apps, the OAuth callback and
the old `/connections` address land on `grants`. A tab carries a count only when someone acts on it
("2 laufen ab", "1 erneuern"); the totals stand as a line inside the section. The rights SubKit holds
on another system read "N Rechte" with the raw values behind "Details anzeigen", and carry no risk
word — the words "liest", "schreibt", "verwaltet" come from SubKit's own catalogue, which cannot judge
a foreign scope. No command line stands on the page: how a script swaps a key for a short-lived token
is one link to the developer guide. (The one deliberate exception in the Cockpit is the call block
on a workflow's page — see "Workflow page" below: there the call IS the fact the reader came for.) It carries no attention list of its own — that would be a second
task list. Keys and connections show their state as chips; renewing stays a row action.

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
setting's name, its help sentence where the catalogue has one (`settings.help.<path>`;
`settings-leaf-coverage.test.ts` requires it for every `llm`, `tokens`, `auth` and `notifications`
setting, every restart and every enum), the control, "Wirkt nach Neustart" where that holds, the
source only when it is not the installation's own value or the default, and "Gilt für" only where the
setting is tenant-scoped or a workspace's own value overrides it. There is no per-row "Technische
Angaben": for readers with `settings:write` an icon beside the name copies the key, its tooltip
showing `sk settings set <key>`, and the engine's English description is not shown. Below the list,
one closed "Wie wird gespeichert?" says that every change is a new, immutable version kept in the
audit, that most values apply at once on every instance, and that a value marked "Wirkt nach
Neustart" applies only after a restart. The control follows the engine's
`kind`: an enum is a select of its `enum_values`, a boolean a switch, a number a numeric field with its
unit where the name says one. While the value differs from the engine's `default` the row says
"Geändert · Standard: X · Zurücksetzen", and Zurücksetzen only drafts the default. A secret never shows:
"Hinterlegt · Ersetzen" or "Nicht hinterlegt · Hinterlegen", the field appears after the click, and the
note on what belongs there stands once per section. "Alle | Geändert" beside the search narrows the list
to settings not at their default ("Alles steht auf Standard." when none is). Drafts belong to the page,
not to a section: one sticky bar says "N ungespeicherte Änderungen · Verwerfen · Speichern", and saving
is one `PATCH /v1/settings` with `expected_revision` (secrets first stored as secret versions, sent as
their references), then the revision's activation — never an autosave. A 409 means somebody saved in
the meantime; the bar says so and offers the reload, the drafts stay. A restart-sensitive change still
asks first. Without `settings:write` the page says "Du darfst ansehen, nicht ändern." and every control
is disabled. `?leaf=`, `?section=`, `?q=` and `?filter=changed` address a setting, a section, a search
and the filter.

### Workflow page

A workflow's page (`src/components/cockpit/workflow-page.tsx`) answers, top to bottom, the questions
a reader arrives with: may it run on its own → how is it called → what does it take and return →
what does it do → how has it been doing. Everything a reader does not decide by is folded below.

1. **Header.** The name, the health mark and the author's one-line purpose. It carries the page's
   own actions and nothing else: "Ausführen", the one filled action, where the workflow can be
   run; "Im Chat ändern", "Zu diesem Workflow fragen" and "Metadaten bearbeiten" behind "⋯" — a
   single remaining one is a named button. What may be edited where is a tooltip, not a row of
   its own. No state puts a further action here: approving, applying, repairing and resuming are
   the panel's, the remedy for a failure is the cause block's.
2. **Automatischer Betrieb** — one state, one action (below), offered here and nowhere else on
   the page.
3. **Aufrufen** — tabs for the ways that exist: HTTP, Webhook, MCP, Zeitplan, CLI. A hook or a
   schedule is a tab only when one is bound; the tab a reader lands on is the workflow's effective
   trigger. HTTP shows the address, a ready-to-paste call (curl, Node, Python; production by
   default, the environment always in the call), one line of answers (200 / 202 / 409) and one
   line of plain text on what the call will be, taken from the panel's verdict: nothing where the panel shows
   the environment as approved, "only a trial run" where no approval exists, "an approval is
   stored but not confirmed here" where one exists and the panel does not say approved — the
   engine's own field only says that an approval is stored — and "refused" for a version in an
   earlier format. A held hook or schedule says so with a badge. Neither the line nor the badge
   links to the approval: the block shows the status, the panel carries the trigger. A list the
   reader may not see (webhooks, schedules) is not a missing tab passed over in silence: one line
   under the tabs says it cannot be shown and that there may be some.
4. **Eingabe | Ausgabe** — the schema as a table: field, type, required, example; allowed values
   and the description under the name; an object's own fields one level deep. One line says that
   input goes in the body under `input` and that there are no query parameters; for a hook-started
   workflow one more says that the caller's body arrives as `input.body`.
5. **Schritte** — one compact row per step: number, id, kind, one line on what it does, how it last
   ended. Opening a row shows the whole configuration, the last result and the step's own preview.
6. **Letzte Läufe**, then folded: **Technische Angaben** (slug, version, lifecycle, created,
   changed, last run), **Frühere Freigaben**, and **Unterhaltungen dazu**.

An unhealthy workflow keeps its cause block between the header and the panel. Its next step is an
outline action there and only there — the page's one filled action stays "Ausführen". Where the
cause is an approval that no longer fits, the block says the cause and offers nothing: the panel
directly below says the state and carries the act. The same holds where the panel already offers
the block's remedy for a reason of its own — reviewing a filed repair, or the conversation with
an author: it stands once, in the panel. A failed run in "Letzte Läufe" names its cause as text;
its row leads to the run and nowhere else.

There are no tabs and no "Steuerung" row on this page, and no fact stands twice: the version is in
the panel and the technical facts, the schedule in the panel and the call block's own tab.

**The call block is the one place a command line stands on a page.** The rule above ("no command
line stands on the page") was written for a page about credentials, where a command is a detour.
Here the call is what the reader came for, so it stands in a real fenced block with a copy button.
The same holds for a step's configuration and a run's output: they are payload, shown byte for byte.
An identifier is allowed inside such a block and nowhere else on the page — the workflow's own id
appears only in the call it is used in. A header's value is payload too: a reference such as
`Bearer {{credentials.token}}` is the configuration and is shown and copied as stored. The one
value that is masked is a literal under a credential-shaped header name with no reference in it —
a secret pasted into a definition, where it does not belong.

The CLI tab says where its command runs: it names no environment and so runs in development, and
the line points to the HTTP call for production. An input schema that names no fields is still
input — the table says it is one value, and the run dialog offers it as one JSON field; a field
that allows several types is a JSON field as well, never text by default.

**One state, one action.** Whether a workflow may run on its own is decided once, in
`src/lib/automation-state.ts`, from what the engine reports (the record, its schedules, the verified
automation status, the approvals, the gate diagnosis). The first that applies wins:

| State | When | The one action |
|---|---|---|
| Altes Format | the running version is stored in an earlier definition format; the engine refuses to run, admit or approve it | Im Chat beheben |
| Pausiert | every schedule and hook is stopped | Fortsetzen |
| Übernahme nötig | a saved change differs from the running version | Änderung prüfen |
| Reparatur nötig | the gate refuses a step — also while an approval exists | the diagnosis block's own act |
| Nicht geprüft | readiness could not be verified | Erneut prüfen |
| Freigabe nötig | something starts it and no approval covers it | Jetzt freigeben |
| Freigegeben | a current approval covers the running version | Freigabe ansehen |
| Auf Abruf | nothing starts it automatically, nothing approved | (calm; the approval is offered, nothing asks for it) |

A version in an earlier format is said plainly and nothing the engine would refuse is offered:
no "Ausführen", no approval. The way out — changing the workflow in the chat, which saves it
again — is the panel's action and, with "Ausführen" gone, the page's one filled action; the
header keeps only its menu. A saved change that already waits leads instead
("Übernahme nötig"). The run dialog and a chat card say the same refusal by its reason, with the
steps the engine names, never as a run that "could not be started".

A refusal that would simply repeat is not offered again. After the engine refused a run for a
version in an earlier format, for a missing approval or for a connector that cannot serve it,
"Ausführen" in the run dialog is switched off and one line says that another attempt would be
refused the same way; choosing another environment offers it again, except for the format, which
no environment changes. A fault — the run could not be started — leaves the button on.

"Nicht geprüft" also stands when a read the verdict rests on did not answer — the diagnosis, the
verified status — and when the reader may not see a webhook that the visible rows do not answer
for. A failed read is never "nothing to report": the panel says it could not verify and offers
"Erneut prüfen". With starts in both environments, the state names the one that still waits, and
the approval opens there. A workflow that is paused because only its webhook is switched off gets
one line saying so and no button: the engine has no act that switches a hook back on.

The panel says the state as one word and one line of facts (version, environment, valid until, runs
left), names what starts the workflow, embeds the gate diagnosis and holds the current approval
behind "Freigabe ansehen". **An approved workflow offers no approval button** — only "Freigabe
ansehen", plus "Verlängern" within three days of its end or below a tenth of its runs. The
panel's action stands in the panel only: the title does not repeat it in any state, nothing on
the page is a link that only scrolls to the panel, and no badge repeats the state. Exactly one
element of the page opens the approval dialog. On another page — the run sheet, the Übersicht —
a run whose cause is "Freigabe passt nicht mehr" leads to this panel. An approval's exact window and
checksum stand behind "Details"; approvals that no longer admit a run are history, folded. An
approval that is still valid is never out of reach: while another step is pending — for this
environment or another — "Freigabe ansehen" stays beside it, and that is where it is revoked.

The embedded diagnosis lists the refused steps and offers each act once. A repair the engine can
compute is its step's own button — it files a different repair for each step. What does the same
whichever step asks for it stands once under the list: "Reparatur prüfen" (the filed repairs wait
in one review sheet), the trial run (one run for the version) and "Im Chat beheben" (one
conversation that names every step an author has to change). A run that refused several steps is
linked at the first. Where the trial run needs a sample call, "Freigabe öffnen" appears only if
the panel's own action is not already the way into the approval.

**The approval dialog says what it is about to do.** Where opening it starts a trial run, or needs
a sample call because only a webhook starts the workflow, one line beside the opener says so
before the press. Inside:

- An approval that already covers the same version in the same environment heads the dialog —
  "Bereits freigegeben bis … · N Läufe übrig" — and the action reads "Verlängern / Grenzen ändern".
  A further approval is added beside the existing one, which stays valid until it ends or is
  revoked; the dialog says so. It is never offered as if it were the first.
- The scope is said where it is not the ordinary one: approving one environment while the
  workflow is started in the other, and approving a saved change while another version runs (the
  approval then puts the change into service).
- One line beside the limits says where the suggestion comes from — the schedule's starts, or the
  webhook's recent calls.
- A version that cannot be approved offers the act that removes the refusal — the gate
  diagnosis' own: repair automatically, review the repair, run the preparation again — as its
  filled action, with "Ursache im Chat prüfen" beside it. Where the dialog already offers its own
  repair for the same steps, that one stands alone.
- Every fact once. The environment stands in its select and is not repeated as a badge; the
  reviewed version is named where the caller knows it and never by a placeholder; "Operationen
  und externe Ziele" is offered only when there is something behind it; and "Du gibst eine
  gespeicherte Änderung frei" stands only where the change can be approved.
- "Nur in Betrieb nehmen" does only that: the saved change goes into service, nothing is
  approved and no run is prepared. Preparing the single run is the other button's act.

An approval names the connector it reaches by its name, on the workflow page as in the dialog —
never by a fragment of its identifier. Both read the same lookup; a connector the reader may not
see is "Konfigurierter Konnektor".

### Connector page

A connector's page (`src/pages/catalog-detail.tsx` with
`src/components/cockpit/connector-*.tsx`) says each state in one place and
offers each act once.

- **Header.** The name and the author's description; "Verbindung testen" is
  the one test trigger on the page. No state action stands beside the title: a
  connector's acts live where its state does.
- **State notice** (`connector-state.tsx`), only when there is something to
  say: "Abgeschaltet" with "Einschalten" for a connector that is switched off,
  and — once, after the provider sent the browser back — "Angemeldet" or
  "Angemeldet, aber abgeschaltet". Signing in never switches a connector on,
  so the two are said together and "Einschalten" is the one act that changes
  it. The new state shows at once, from the engine's answer. Without
  `connector:write` the notice stands without the button.
- **Verbindung**, **Laufzeit**, the server's tools for an MCP connector.
- **Anmeldung** — the one home of the sign-in state: a badge, one line that
  says what is the case and what the button beside it does, the permissions a
  provider withheld by name, and the one way to renew that fits the kind of
  sign-in ("Neu anmelden" at the provider, through the account connection, or
  by entering a key).
- **Workflows**, **Unterhaltungen dazu**, **Technische Angaben** (folded).

There is no "Steuerung" row: a connector has no lifecycle and no steps. The
engine's health verdict, when it is neither ok nor the sign-in again, and
"read-only" for a reader without write permission are the only things a bar
under the title still says; with neither there is no bar.

The return from a sign-in is a flag in the address (`?signed_in=1`), set by
the engine's callback on a redirect it builds itself. The flag states no
fact: the page reads the connector again, confirms only what the connector
bears out, and drops the flag from the address so a reload repeats nothing.

At most one action on the page is filled. While the sign-in card offers a
renewal, that is it and "Einschalten" stands beside it as an outline; with
the sign-in in order, "Einschalten" is the filled one.

### A kept secret is not a value

The engine hands out a connector with every credential in it masked by one fixed marker — in the
address too, where a password or a key can sit. The marker is not shown as if it were the value:
the connector page writes `•••` in its place, says once that it stands for a stored secret that
is kept, and does not offer an address that carries one for copying. No cockpit form sends a
connector's configuration back, so a masked value is never written over the stored one.

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
cause block when unhealthy, and its five latest runs with the way to all of them (see "Workflow
page" above for the rest of that page).

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

The header is the shell's top bar, filled through a slot rather than a second band below it: the
sidebar toggle, the title and — for a conversation that has a state — its one-line resume, then
compact pills, then the list, new-conversation and context controls with the status badge. A new
conversation reads "Neue Unterhaltung" and carries no line under it; the title does not pass through
"Unbenannt" while a conversation loads. The pills are the mode, the conversation's own tokens, its
cost where a rate covered a call (a floor, "mind.", where one did not), and the month's allowance
only while it is tightening or critical, linked to Nutzung. On a phone the pills take a second row.
Where the conversation came from moved into the context panel.

The mode is a pill with a short name. The open list marks the system default and explains each
option in one line; the full gate matrix (§14) sits behind "Was heißt das?" beside the pill instead
of under it on every conversation. A running conversation shows the same pill read-only.

Elsewhere the top bar stands only where it carries something: on a phone, where the navigation
opens from it, and over a record with its breadcrumb. On a wide list page the sidebar toggle stands
in the page header beside the title, and the body aligns to the start of that row. There is exactly
one toggle in the document at a time.

A request that was just sent stands in the transcript at once, where and as the saved one will —
left, under "Du" — and stays until the saved one is there. A send the engine did not keep hands its
text back to the composer. The transcript and composer remount only when the reader moves to
another conversation, never when the first send gives a new conversation its address.

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

A pending `ask_user_text` question is a question card in the transcript, like a choice or a form:
the question itself (from `prompt.question`, never `summary`), a field with the asked-for
placeholder and an "Antworten" action. A question with no tool row — one the harness parked from
prose — stands below the transcript. While it waits, a visible line above the composer names the
question and says that the next message answers it; text entered there answers that exact
question through the elicitation response endpoint. A question the page had not shown yet is
never answered by a message written without it: the append guard's refusal comes back as an
actionable hint, the text stays in the composer and the question appears. An answered question
stays readable, and the reply is marked as its answer. Ordinary failures are never replayed, and
text answers are never converted into boolean approvals.

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

- **An action exists once per view.** Never the same action — the same label or the same
  effect — beside the title and again in a section, or as a button and again as a "Zur …" link.
  The header carries the page's own action; a section's action lives in that section; every
  other place that speaks about the same thing shows its status — a sentence, a badge — and no
  trigger. A link that only scrolls to the section holding the action is a second trigger.
  A row's own action in a list of rows (copy this block, revoke this approval, repair this step)
  is one action per row; the markup marks such a row with `data-action-scope`. A menu, a dialog
  and a sheet are views of their own. The visual stands enforce the rule on the rendered page
  (`scripts/lib/cockpit-single-trigger.mjs`): no two visible triggers share an accessible name
  or an address, and the approval dialog has one opener.
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

A workflow's review card (`review_workflow_automation`, and the run refusal that carries the same
review) reads the workflow's current state from `src/lib/automation-state.ts` — the decision the
workflow page makes — so the card and the page name the same next step, also when the card is read
long after the tool ran. It has one button, named for that step ("Jetzt freigeben", "Änderung
prüfen"). Two only when starts in both environments wait at once: "Produktion prüfen", filled and
first, and "Entwicklung prüfen". A webhook-started workflow only ever offers production. The hint
says to open the review — its content is in the dialog, not "below" — and names what an approval
allows: scheduled runs, incoming webhook calls, or automatic runs for both. Only a pending
decision opens the approval: an approved or on-request workflow gets no button, a paused one the
page's own "Fortsetzen" (or the line about its switched-off webhook), and a state that could not
be verified "Erneut prüfen".

The card reads today's state, so only the newest review of a workflow is a live card in a
transcript; an earlier one stays what it is in the record, a tool call that ran. Where the
transcript shows that card, the "Automatische Läufe noch blockiert" hand-off below it is not
rendered a second time — one way into the approval per view. In the context panel the sentence
about the held schedule stands once: under "Nächste Aktion" where the stage already says it,
otherwise in the hold block.

A card for a call that runs a workflow says what the call was. A preparation with every write
held is "Probelauf ohne Wirkung", a call the engine turned away is "Lauf abgelehnt" with the
engine's reason in the reader's words, and only a run that dispatched its writes is "Workflow
ausgeführt". A person's or a permission's no stays "nicht ausgeführt".

A pending `ask_user_choice` uses an explicit selection card in both places. Show every option and its one-line effect directly, including a grounded recommendation; do not hide the decision behind a dropdown. Selection has a visible checkmark and requires a separate submit action. Keep the answer bound to the original option value and request ID; choosing an option does not submit it. Disable the text composer with an actionable hint while a selection is required. After the server accepts the selection, show its readable label as the user response and the tool as “Answered”, including after reload. Refresh the conversation and the Übersicht's attention list after each completed response. A held workflow schedule stays open until its admission requirement is resolved; answering a question or saving an inactive draft is not a run authority. Show this remaining task with a link to the affected workflow in Working Context.

Editing a saved workflow invalidates its whole-workflow check and saved status. Do not label an edited version “saved” using evidence from its previous version. An interrupted preparation offers “Continue preparing” („Vorbereitung fortsetzen“) through the normal chat turn — not “Review change”, which is the review card’s button and opens the approval; run authorization is the next task only after preparation is complete. Historical text remains historical; the header and action card reflect current server state.

Workflow preparation includes inspection, validation and the supported preview within the current request and permission mode. These are assistant tasks, not user choices. Explain the verified result, any untested effects, and the next action briefly in the user's language. Held publications and skipped dependent steps must not be presented as successfully tested or executed. Ask only for missing business input, access, an unresolved tradeoff or authority, and give an evidence-based recommendation. Human-facing labels must not expose internal tool names or bypass flags. Existing persisted technical questions may receive a narrowly matched presentation translation; request identity, option values, explicit submission and server authority remain unchanged.


## Attention grammar

What follows is a verbatim German copy of §8 of Cockpit Convention v2.2 (`COCKPIT-KONVENTION.md` in the repo root), kept in German and byte-identical on purpose: the standard has one source and no diverging copies (§13). The Übersicht's attention list and its review sheet are measured against it. SubKit offers no "remind me later" in the sheet because the engine has no deferred state, which §8.4 allows; the reason is recorded above under "Review sheet". The copy below is never adjusted to this product, or it would no longer be a copy.

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
