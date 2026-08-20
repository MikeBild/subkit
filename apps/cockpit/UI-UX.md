# Subkit Cockpit UI/UX

Subkit implements the copied `cockpit-ui` family contract without importing runtime code from a
sibling product. The Cockpit is built, embedded and released with Subkit; it has its own routes,
session boundary, API facade and deployment lifecycle.

## Product adaptation

The home surface is a persistent, governed conversation rather than a dashboard. It combines the
family shell with the Reference Architecture's useful working pattern: a narrow history rail, a focused work surface
and an on-demand evidence drawer. The drawer never consumes the transcript's working width. Vercel
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
System, Settings, Credentials, Notifications, Audit — before anything Subkit adds to it. Audit and
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
(`src/components/cockpit/data-table.tsx`) render every list. The frame owns the heading, the visible
one-sentence page description, the single primary action and which element scrolls; the table owns
the toolbar strip, the column picker, refresh, sorting, paging and all four load states. Refresh sits
in the table's own action column rather than in the page header, because it acts on the rows and not
on the page. Cell shapes — text, state, date, size, relation link and relation chips — come from
`src/components/cockpit/table-columns.tsx` so a date on Runs and a date on Files cannot drift apart.

### Decisions surface

Every proposal that needs a person lives on one page (`/decisions`): proposed fixes, skill
candidates and conversations waiting for an answer. The navigation entry sits directly under the
overview and carries the exact open count, taken from the engine totals — when a count cannot be
read it is omitted rather than guessed. Because each of the three sources is fetched with a page
cap, the page states how many of the counted positions it is actually showing rather than letting
the badge and the column disagree in silence.

The count never appears without its sources. A bare number is a demand of unknown origin, so the
heading is followed by the split — how many are fixes distilled from failing runs, how many are
proposed skills, how many are conversations — and each filter chip carries its own share of it.
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

Deviation from the family convention, deliberate: there is no "remind me later" shelf. The engine
models a patch candidate as proposed, applied, rejected or superseded and has no deferred state;
inventing a cockpit-local snooze would show a position as parked that the engine still counts as
open. Rejecting with a note is the honest alternative, and the "decided" and "rejected" shelves
are read back from those engine states.

### Overview surface

The overview answers what is happening, and links to where it is decided. It carries the incident
banner, a compact line saying how many positions are waiting and how long the oldest has been
there, the root-cause failure groups, and the runs that happened recently.

Every number about the queue comes from one function, `countOpenDecisions`, and the overview reads
it through the same query as the navigation badge. It used to read three: the banner filtered the
health digest's `stuck` flag, the waiting line read the digest's pending patch count, and the badge
summed the three list endpoints — so one screen showed three totals for one queue and explained
none of them. The digest knows only patch candidates and cannot answer for the queue; it keeps what
it does own, the failure groups, the risks and the all-clear.

The incident banner names its shares and borrows their labels from the queue. It states one claim
per rubric it is about — "Holding something up: 1 of 8", "Expired: 1 of 8", or "at least" where a
source hit its page cap — and the label of each claim is read from the same catalog key that heads
that rubric on the decisions page, so the two cannot be worded apart. It carries exactly two claims,
because §8.7 names exactly two triggers: something is stopped, or a deadline passed unanswered. A
position that has merely been sitting is not one of them. It briefly was, summed into a single
sentence that said 25 of 30 were "blocking their workflow" — while the rubric one click away headed
three of those five with a line that reads "blocking nothing". Age keeps the surfaces it honestly
owns: Zone A's oldest-position line, the red navigation badge, and the rubric that names it.

Deviation from the family convention, deliberate: Zone A links to the decision queue without
reproducing any of it. The convention allows the overview to show the queue's top positions as well
as link to them, and this product did exactly that — the same rows as `/decisions`, not decidable
here, and titled from a different field, so the two pages disagreed about what one candidate was
called. A count and a link cannot disagree with anything.

Failures are split by origin. A person building a workflow can fail two dozen trial runs in an
afternoon, and an overview that counts those alongside a scheduled job failing nightly reports a
crisis that is not happening — so authoring and manual runs sit under their own heading beneath the
scheduled ones.

There is no "next scheduled run" tile. The engine exposes a cron expression, a timezone and a
paused flag, and computes no next-fire instant anywhere; a time this page derived itself would be a
guess presented as a fact.

### System surface

The installation's tools page holds the tools and none of their results. It used to render the
failure groups and the repair counter a second time, from a second read of the same digest, and it
showed different numbers than the overview did — because the two counted different things and
neither said which. The failure groups live on the overview, the proposed repairs live in the
decision queue, and this page links to both rather than restating either.

Checking and repairing stay two acts in one order: the drift scan reads and reports, and every
repair it proposes becomes a decision a person makes. There is no button that does both.

### Conversation surface

Chat does not take the shared page frame, and that is a recorded decision rather than an oversight:
it is a two-column workspace with three independent scroll regions, not a heading above a scrolling
body.

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

### Product-family evidence

The shared contract is copied into each repository; no Cockpit imports another product at runtime.

| Product | Pattern retained for Subkit | Product-specific boundary |
| --- | --- | --- |
| WorkKit | One scroll owner per pane, `min-h-0`/`min-w-0`, account submenu, context help | Mission and run semantics stay in WorkKit |
| WikiKit | Fixed responsive tables and stable table-view contracts | Sources, pages and decisions stay in WikiKit |
| ContentKit | Tooltip/context-help composition and compact page hierarchy | Publishing and moderation stay in ContentKit |
| WatchKit | Wrapped, fixed-layout tables with no horizontal page scroll | Drift and evidence semantics stay in WatchKit |
| CodeKit | Neutral selection and explicit action hierarchy | Projects, tasks and credentials stay in CodeKit |
| Subkit | Conversation-first work surface, governed tool and approval cards | Workflows, connectors and tenant governance stay in Subkit |

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
raw tool payload excerpts, visible UUIDs and resource error states. It also records Chat tool,
tooltip and user-menu states for visual comparison. The production deployment verifier repeats the
authenticated bilingual route sweep after SSO and publishes its screenshots as a workflow artifact.

## Entscheidungs-Grammatik

Wortgleiche Kopie von §8 der Cockpit-Konvention v1.4 (`COCKPIT-KONVENTION.md` im Repo-Root). Sie steht hier, weil die Entscheidungs-Seite dieses Produkts an ihr gemessen wird; der Maßstab hat eine Quelle und keine abweichenden Kopien (§13). Wo Subkit bewusst abweicht, steht die Begründung oben unter „Decisions surface" — die Queue ist keine 780-px-Spalte (§8.2), und es gibt kein „Später erinnern"-Regal (§8.3/§8.5), weil die Engine keinen zurückgestellten Zustand kennt. Beide Abweichungen bleiben bestehen; die Kopie unten wird davon nicht angepasst, sonst wäre sie keine.

### 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? WorkKit ist die Referenz-Implementierung; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Default-Sortierung: ablaufend zuerst, dann älteste zuerst. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Filter-Chips nach Art, Gruppieren-Umschalter (Keine / Art / Verursacher), Persistenz lokal.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet die Zeile: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt die Zeile, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Regale.** Unter der aktiven Queue: einklappbare Sektionen „Zurückgestellt" (mit Wiedervorlage-Zeit), „Verworfen", „Entschieden" — gedimmt, mit Rückhol-Aktion wo die API es erlaubt. Grundsatz dahinter: **Zustand und Geschichte sind getrennte Flächen.** Die Queue zeigt nur den aktuellen Zustand (Erledigtes verschwindet, nichts wird durchgestrichen); die vollständige Geschichte wohnt im Audit/Aktivitätsprotokoll (append, nie gekürzt).

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, Regale, Leere-Zustände und der Banner-Vertrag.
