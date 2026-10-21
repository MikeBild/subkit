---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Collect pages and ideas and review which become knowledge or skills.
section: work
order: 5
audience: public
---
## Collect ideas and turn them into knowledge or skills

Collect pages and ideas now; decide later what becomes knowledge or a skill. Use the shared categories to organize clips, with Inbox as your personal starting default.
You can choose another default category at any time.
The process stays the same: **collect → review in chat → confirm → knowledge or skill**.
Learnings from coding-agent sessions enter the same process as collected items with origin
`session`; the Inbox shows the origin as a filter and badge.

Run `sk clipper install` to unpack the Chrome extension shipped inside the CLI.
In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select the folder printed by the command. The installer prefills the engine URL
from your active profile. In the Cockpit, open **API access**, create a key with the
**Web Clipper** preset (exactly `intake:read` and `intake:write`) and paste it into the
extension settings. Allow access to your engine host.
The clipper needs no permission to admit knowledge. You can change the engine URL
in its settings; no server address is built into the extension.

Use the toolbar, page context menu, or a shortcut configured at `chrome://extensions/shortcuts`
to collect an article or selected text. The source address is captured automatically.
Review the preview, optionally add why it matters, and press **Collect**. Your default
category is selected, initially Inbox. You can choose an existing category or enter
a new one. Categories are shared with the rest of SubKit; processing status stays separate.
The default belongs to the authenticated identity; a shared API key shares that identity.
Inbox visibility follows your tenant's permissions, rather than making categories private.

In the Cockpit, open **Inbox** to review and organize collected items using the same
table and category controls as Knowledge Sources. Open an item to see its content
and original source, edit its title, content or category, or start a review chat.
Edits preserve the captured original and require reviewing any affected proposal again.
The chat links
to the item's proposal for confirmation; completed decisions remain in its history.
In a new chat, the category-aware review suggestion helps you review new entries
together. An item's chat action instead reviews only that selected item, using a visible
`@` reference. Chat actions for existing workflows, connectors, runs, sources and skills
also carry a reference to the selected record. You can also ask:
"Look through my new Research entries. Which are
useful to us? Suggest what we should retain, as knowledge or as a skill." The chat prepares a proposal
with the exact content, original sources, and destination. You review it and explicitly
confirm **Confirm as knowledge** or **Confirm as skill**. Only then can ordinary knowledge
retrieval use the result, or agent briefings carry the skill. A skill destination creates or
updates an active skill and archives the skills it replaces in the same step; the proposal
shows each change. Confirming needs a signed-in browser session, the right `intake:confirm` and the rights of the
destination: `knowledge:write` for knowledge, `skill:write` and `skill:activate` for a skill,
plus `skill:archive` for every replaced skill. API keys and MCP clients cannot confirm.
Admitting a skill is a content decision, separate from an environment's connector or
execution approval.
Before a clip is saved, SubKit replaces recognizable secrets in it (API keys, tokens, private keys, signed-link signatures) with a marker and records only how many were replaced. The removed values are never stored, and the source, author and timestamps stay as captured.
You can discard an unneeded clip during review and restore it later; discarding
preserves its original source and never turns it into knowledge or a skill.
Changing the proposal or its sources requires another review. The original clip remains
linked to the resulting knowledge or skill. Moving clips or renaming a category never admits its clips. Category changes affecting
a proposal require reviewing it again.

The clipper keeps separate local drafts for each page and engine, including unsent notes.
Opening another page captures that page; use the draft selector to resume unsent edits.
An open clipper follows URL changes and tab switches in its source window. If Chrome
requires access to a new site, open the clipper from that site's toolbar icon. Failed
captures remain local for retry; a repeated request does not create another item.
Original source author and publication time stay separate from who collected the page
and when. Unavailable source metadata remains unknown.

On YouTube, the clipper extracts video metadata, description, and an available original
transcript. Description and transcript can be included separately under Details.
Availability depends on the video and access to captions. Extraction removes navigation
and recommendations without summarizing the content. If no main content can be identified,
the clipper reports that instead of collecting the entire page. Markdown is editable;
the original captured text remains preserved. Image links are retained; image files
are not uploaded.

Run `sk clipper install` after updating the CLI, then reload the extension in Chrome.
Use `sk clipper install --dir <directory> --no-open` to choose a directory and skip
opening Chrome. Updating an existing installation preserves its connection settings.
For a new installation, `--engine-url <url>` overrides the active profile's address.
The engine serves the same embedded archive at `/install/clipper.zip`, with its SHA-256
in the `x-subkit-sha256` response header. HTTPS engines and local HTTP engines on
`localhost`, `127.0.0.1`, or `[::1]` are supported, including an optional URL path prefix.
Changing the engine address requires entering the key for that engine; an existing
draft stays associated with its original engine. Older engines require an update to
support collecting; the clipper never falls back to writing directly into knowledge.
Existing knowledge sources remain unchanged, and old local drafts can be explicitly
collected into the Inbox without claiming that edited drafts are original page captures.

