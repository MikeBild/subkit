---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Collect pages and ideas and review which become knowledge or skills.
section: work
order: 5
audience: public
---
## Collect ideas and turn them into knowledge or skills

Collect pages and ideas now, and decide later what becomes knowledge or a skill. Nothing you collect is knowledge until a signed-in person confirms it in the Cockpit.

The path is always the same: **collect → review in chat → confirm → knowledge or skill**.

### What you need

- For web pages: the Web Clipper in Chrome, installed and connected. To install, update or troubleshoot the Web Clipper, see "Collect web pages with the Web Clipper".
- To collect: an account with `intake:read` and `intake:write`.
- To confirm: a browser session in the Cockpit with `intake:confirm`, plus `knowledge:write` for knowledge, or `skill:write` and `skill:activate` for a skill. Replacing skills also needs `skill:archive` for each replaced skill.

### Collect something

1. Open the page.
2. Optional: select the text you want as an excerpt.
3. In the toolbar, select the Web Clipper icon ("SubKit Clipper").
4. Check the preview. The source address is captured automatically.
5. Optional: add why it matters.
6. Pick a category. Your default category is preselected, at first `inbox`.
7. Select **Collect**.

Learnings from coding-agent sessions arrive in the same Inbox, with the origin **Coding assistant**. Collected pages carry the origin **Browser**.

### Add a note

A note is an item without a source address, such as a thought or an idea.

1. In the Cockpit, open **Inbox** and select **Add entry**. If the Inbox is still empty, select **Add a note**.
2. In the **Add to intake** dialog, enter a **Title**.
3. Write the text under **Content**. Markdown is allowed.
4. Pick a **Category**, or create one with **New category…**.
5. Select **Add**.

The note carries the origin **Note**. Instead of **Open original**, its page only shows **Note**, because there is no source.

### Review and organize items

1. In the Cockpit, open **Inbox**.

   ![Inbox with three collected clips of origin "Clip" in category Inbox, status "Collected", in the Brennwerk Cockpit](images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.en.webp)

2. Optional: above the list, select **By AI**. You then only see items an agent or a chat session prepared. **All** shows every item again.
3. Click an item. Its page shows the text and the origin on the **Content** tab. For collected pages, **Open original** opens the source.
4. Optional: select **Edit item** to change title, content or category. The captured original is preserved.
5. Optional: **Discard** or **Restore**.

Inbox visibility follows the permissions of your workspace. Categories are not private.

### Review in chat

Review one item:

1. In the **Inbox**, open the item.
2. Select **Review in chat**. The chat shows the item as an `@` reference.

Review a whole category:

- In a new chat, start the category's review suggestion, or ask: "Look through my new Research entries and suggest what to keep."

The chat prepares a proposal with content, sources and destination, and links to it. The link opens the item's **Review** tab. Completed decisions appear on the **History** tab under **Proposals and decisions**.

### Confirm a proposal

You need a browser session in the Cockpit, `intake:confirm` and the destination right. API keys, MCP clients and the Web Clipper cannot confirm.

1. Open the item and select **Review**.
2. Review the proposal: content, sources and destination.
3. Select **Confirm as source** or **Confirm as skill**.

Only then can ordinary knowledge retrieval use the result, or agent briefings carry the skill. For a skill, confirming also archives the skills it replaces. The proposal shows each change.

Good to know:

- Moving, editing or discarding an item never makes it knowledge.
- If a proposal or its sources change, you review it again.
- SubKit replaces credentials such as API keys and tokens before saving an item.
- The item's original stays linked to the knowledge or skill.
- You keep maintaining confirmed sources and skills as described in "Maintain sources, skills and files".

### If something does not work

| What you see | What to do |
| --- | --- |
| The Web Clipper reports no connection or an invalid key | Follow "If something does not work" in the chapter "Collect web pages with the Web Clipper". |
| An item is missing in the **Inbox** | Check the category and the origin. Select **All** instead of **By AI**. |
| "You lack the rights for this. …" | Ask an administrator for `intake:confirm` and the destination right. |
| "This suggestion changed. Review the current content before confirming it." | Read the current content, then confirm again. |
| "A skill this suggestion refers to can no longer be loaded. …" | Revise the suggestion in the chat before you confirm. |
