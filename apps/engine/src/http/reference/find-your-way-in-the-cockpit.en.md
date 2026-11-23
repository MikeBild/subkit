---
slug: find-your-way-in-the-cockpit
title: Find your way in the Cockpit
summary: Use the navigation, the side panel, error notices and environment labels in the Cockpit.
section: work
order: 15
audience: public
---
## Find your way in the Cockpit

This chapter is for anyone who works in the Cockpit every day.
Afterwards you can show and hide the navigation and the side panel with the keyboard, read an error notice and tell whether something runs in test or in production.

### The two panels

The Cockpit has the navigation on the left and the side panel on the right. The page you work on sits between them.

| Panel | Content | Shortcut |
| --- | --- | --- |
| Navigation, left | The areas of the Cockpit, for example **Chat**, **Inbox** and **Workflows**. | ⌘B, on Windows and Linux Ctrl+B |
| **Side panel**, right | **Chat**, **Details** and **History** for what you are looking at. | ⌘J, on Windows and Linux Ctrl+J |

1. Press ⌘B to shrink the navigation to a narrow icon rail. Press it again to open it.
2. Press ⌘J or select **Open side panel** in the page header.
3. Drag the edge of the side panel to change its width. With the keyboard, use the arrow keys once the edge has the focus.
4. Press Esc inside the side panel to close it.

The Cockpit remembers in this browser whether the side panel is open, how wide it is and which tab was selected. In a narrow window the side panel lies over the page instead of standing next to it.

### The three tabs of the side panel

| Tab | What it shows |
| --- | --- |
| **Chat** | A conversation next to the page. On an opened page it reads “The chat knows what you are looking at here.”, otherwise “Ask about anything in this workspace.” The chat pages themselves do not have this tab. |
| **Details** | The sections **Status** and **Technical** for what you opened: IDs, versions, times and environment. |
| **History** | The audit log entries for this one object. **Show everything in the audit log** opens the whole list. |

Good to know:

- Technical details live on the **Details** tab and no longer on the page. The page stays with what you have to decide.
- When you open a run next to a page, **Details** shows the status and the facts of that run.
- **History** needs `audit:read`. Without the permission you read “Your role does not include the audit log.”
- When nothing is open, it reads “No details here”. Open a workflow, a task or a connector.

### Read an error notice

When something goes wrong, the notice appears where it happened: in the card, in the dialog or above the list. Every notice has the same structure.

| Part | What it says |
| --- | --- |
| Title | What happened. |
| Text | What that means for you. When it has nothing of its own, you read “Nothing was changed.” |
| One button | The one action that helps, for example **Try again**, **Sign in again**, **Review approval**, **Fix it in the chat** or **Ask an administrator**. |
| **Technical details** | Collapsed. It holds **Code**, **HTTP status**, **Request ID** and **Time**. |

1. Read the title and the text.
2. Select the action offered.
3. If it does not help, expand **Technical details** and select **Copy details** or **Report a bug**.

When a list or a page cannot be loaded, it offers **Try again**. “Report a bug” describes how to report a problem.

### Tell test from production

SubKit separates two environments: **Test** and **Production**. A label with one of these two words appears wherever the environment decides about the effect:

- on the items under **Needs you** on the **Overview**,
- on the connectors of a workflow and in the connector catalog,
- in the approval dialog and on the notice about an approval that ends,
- in the technical details of a task.

Read the label before you approve or renew something. An approval only ever applies to the environment named.

### View Markdown documents

Skills, knowledge sources, items in the **Inbox** and files that contain Markdown open in the same document view.

1. Open the document.
2. Under **View**, choose between **Rendered** and **Markdown**. **Rendered** shows the formatted text, **Markdown** the source for reading and copying.
3. In longer documents, jump to a heading through **Contents**. The table of contents appears from three headings on when the column is wide enough.

### Snooze an entry under Needs you

Not every entry under **Needs you** has to be handled right away. You can hide one until later. This only changes your own list.

1. Open the **Overview**.
2. On the entry, select **Snooze** and choose **For 3 hours**, **Until tomorrow morning** or **For a week**.
3. The entry moves to the collapsed **Snoozed** section. “Back on …” says when it returns.

To bring it back early, open **Snoozed** and select **Show again** on the entry.

Good to know:

- A snoozed entry sends you no push notification.
- It comes back by itself when the time is up. It comes back earlier when it needs you for a different reason.
- “Until tomorrow morning” means 8 a.m. tomorrow, “For a week” 8 a.m. in seven days, both in your device’s time.
- Over the HTTP API, `POST /v1/attention/snooze` with `attention_key` and `until` hides an entry for at most 30 days. `POST /v1/attention/unsnooze` shows it again. `GET /v1/attention` lists snoozed entries under `snoozed`.
- The audit log records “Entry snoozed” and “Snooze ended”.

### If something does not work

| What you see | What to do |
| --- | --- |
| ⌘J does not open the side panel | On Windows and Linux, use Ctrl+J, without Shift and Alt. Otherwise select **Open side panel** in the page header. |
| The hint on the button names only ⌘J | The hint always shows the Mac shortcut. On Windows and Linux, Ctrl+J works. |
| “The history could not be loaded. Nothing was changed.” | Open the tab again. If it stays that way, select **Show everything in the audit log**. |
| The **Chat** tab is missing | You are on a chat page. There the conversation already is the page. |
| “This could not be loaded” | Select **Try again**. |
| “The entry could not be snoozed. Try again.” | Select **Snooze** again. |
| “The entry could not be shown again. Try again.” | Select **Show again** once more. |
