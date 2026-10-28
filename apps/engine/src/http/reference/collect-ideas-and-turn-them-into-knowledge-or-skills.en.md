---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Capture pages and ideas, then decide what your team should keep.
section: work
order: 5
audience: public
---
## Collect ideas and turn them into knowledge or skills

This chapter is for anyone who wants to keep web pages, notes or learnings from AI sessions without deciding right away. Everything lands in the Cockpit under **Inbox**. It only becomes knowledge or a skill once a signed-in person with write rights confirms it in the Cockpit.

The path is always the same: **collect → review in chat → confirm → knowledge or skill**.

### What you need

- For web pages: the Web Clipper in Chrome, installed and connected. How to set it up is in the chapter "Collect web pages with the Web Clipper".
- To collect: an account with `intake:read` and `intake:write`.
- To confirm: a Cockpit sign-in with `intake:confirm`. Add `knowledge:write` for knowledge, or `skill:write` and `skill:activate` for a skill. Replacing skills also needs `skill:archive` for each replaced skill.

### Collect something

The **Inbox** collects from two directions:

- **Web pages** from the Web Clipper. They carry the origin **Browser**.
- **Learnings from sessions** with AI assistants. Their origin names the assistant, such as **Claude Code**, **Codex** or **Chat**. When it is unknown, it reads **AI assistant**.

To collect a web page:

1. Open the page in Chrome.
2. Optional: select the text you want as an excerpt.
3. In the toolbar, select the Web Clipper icon ("SubKit Clipper").
4. Check the preview. The source address is captured automatically.
5. Optional: add why the page matters.
6. Pick a category. Your default category is preselected, at first `inbox`.
7. Select **Collect**.

### Add a note

A note is an item without a source address, such as a thought or an idea.

1. In the Cockpit, open **Inbox** and select **Add entry**. If the Inbox is still empty, select **Add a note**.
2. In the **Add to intake** dialog, enter a **Title**.
3. Write the text under **Content**. Markdown is allowed.
4. Pick a **Category**, or create one with **New category…**.
5. Select **Add**.

The note carries the origin **Note**. It has no **Open original page** link, because there is no source.

### Review and organize items

1. In the Cockpit, open **Inbox**.

   ![Inbox with seven collected items of origin "Note", "Browser", "Claude Code", "Chat" and "Codex" in category Inbox, status "Collected", and the hint that three entries from your AI assistants are waiting for your review](images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.en.webp)

2. Optional: above the list, click the hint, for example "3 entries from your AI assistants are waiting for your review". You then only see items from your AI assistants. The filter **Origin: AI assistant** appears next to the search; click it to clear it.
3. Click an item. On the **Content** tab, one sentence names the origin, such as "Collected by Chat in the session … · for … · …". **Open conversation** takes you to the chat conversation, **Open original page** to the collected page.
4. Optional: select **Edit item** to change title, content or category. The captured original is preserved.
5. Optional: select **Discard** or **Restore**.

Who sees what in the Inbox follows the permissions of your workspace. Categories are not private.

### Review in chat

To review one item:

1. In the **Inbox**, open the item.
2. Select **Review in chat**. The chat shows the item as an `@` reference.

For a whole category, start the category's review suggestion in a new chat. Or ask: "Look through my new Research entries and suggest what to keep."

The chat prepares a proposal with content, sources and destination, and links to it. The link opens the item's **Review** tab. Completed decisions appear on the **History** tab under **Proposals and decisions**.

### Confirm a proposal

Only a person who is signed in to the Cockpit and has `intake:confirm` plus the right for the destination can confirm. API keys, MCP clients and the Web Clipper cannot confirm.

1. Open the item and select **Review**.
2. Read the proposal: content, sources and destination.
3. Select **Confirm as source** or **Confirm as skill**.

Only now does knowledge search find the result, and only now do agent briefings carry the skill. If a skill replaces other skills, confirming archives them. The proposal shows each of these changes beforehand.

Good to know:

- Moving, editing or discarding an item never makes it knowledge.
- If a proposal or one of its sources changes, you review it again.
- SubKit replaces credentials such as API keys and tokens before an item is saved.
- The item's original stays linked to the knowledge or skill.
- How to keep maintaining confirmed sources and skills is in the chapter "Maintain sources, skills and files".

### If something does not work

| What you see | What to do |
| --- | --- |
| The Web Clipper reports no connection or an invalid key | Follow "If something does not work" in the chapter "Collect web pages with the Web Clipper". |
| An item is missing in the **Inbox** | Check the category and the origin. Clear the **Origin** filter. |
| "You lack the rights for this. …" | Ask an administrator for `intake:confirm` and the right for the destination. |
| "This suggestion changed. Review the current content before confirming it." | Read the current content, then confirm again. |
| "A skill this suggestion refers to can no longer be loaded. …" | Revise the suggestion in the chat before you confirm. |
