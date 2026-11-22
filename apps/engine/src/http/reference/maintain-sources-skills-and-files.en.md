---
slug: maintain-sources-skills-and-files
title: Maintain sources, skills and files
summary: Keep your team's knowledge current and bring back earlier states.
section: work
order: 10
audience: public
---
## Maintain sources, skills and files

This chapter is for anyone who maintains their team's knowledge in the Cockpit. You find sources, skills and files in the **Knowledge** group. Afterwards you know who changed what, and you bring back an earlier state without losing the current one.

The three terms in everyday words:

- **Source**: a document the assistant looks things up in, such as a price list or a manual.
- **Skill**: a rule the assistant follows, such as your guidelines for invoice texts.
- **File**: a file a workflow reads or produces, such as a template or a report.

### What you need

- To view: `knowledge:read` for sources, `skill:read` for skills, `file:read` for files.
- To restore and replace: `knowledge:write`, `skill:write` or `file:write`.

### Compare versions of a source or a skill

Every change to a source or a skill becomes a new version. For each version you see who saved it and when. Sources often also say why. For sources, SubKit keeps up to 50 versions.

1. Open **Sources** or **Skills** and click a source or a skill.
2. Open the **Versions** tab. The newest version is on top and marked **Current**.
3. Click a version. Under **Change since v…** you see **Before** and **After** side by side.

### Restore an earlier version

1. Open the version as above.
2. Select **Restore this version**. The current version cannot be restored.
3. The question **Restore this version?** appears. Confirm with **Restore**.

SubKit saves the restored content as a new version. The previous version stays under **Versions**, so you can always go back.

### Find conversations about a source or a skill

1. Open the source or the skill.
2. Open the **Usage** tab and expand **Conversations about this**.

The list shows conversations that name the source or the skill with an `@` reference. For a source, it also counts conversations in which the assistant read or found the source. For a skill, it also counts conversations that loaded the skill. Click a conversation to open it. If there is none yet, start one with **Ask in chat**.

### Decide skill proposals

SubKit proposes skills when a pattern keeps recurring. You decide them on the **Skill candidates** page, not in the skills table.

1. Open **Skills** and click **… proposals open** in the header.
2. Click a candidate and review its content and scope.
3. Choose **Accept** or **Discard**. To decide several candidates at once, select them in the list.

Discarding needs `skill:write`; accepting also needs `skill:activate`. SubKit does not propose a discarded candidate again.

### Replace a file

1. Open **Files** and click the file.
2. Open **More actions** and choose **Replace**.
3. Choose the new file and confirm with **Replace**.

The reference to the file stays the same. Workflows and the chat therefore use the new content right away, without you changing them. The new filename is adopted, and the previous content stays as an earlier version.

### Restore an earlier state of a file

1. Open the file and its **Usage** tab.
2. Expand **Replaced**. The section appears once a file has earlier versions.
3. Click a version. You see its preview.
4. On an earlier version, select **Restore**.

The earlier state becomes current again as a new version. The current content stays as an earlier version.

Good to know:

- SubKit keeps the last 20 earlier versions of a file.
- Deleting a file also removes all its earlier versions.

### If something does not work

| What you see | What to do |
| --- | --- |
| **Restore this version** is missing | You opened the current version. Open an earlier one. If the button is still missing, ask an administrator for the write permission for sources or skills. |
| "This version has no saved state, so it cannot be restored." | Choose another version, or change the skill directly. |
| The **Replaced** section is missing | The file was never replaced. It has no earlier versions yet. |
| **Replace** is missing in the menu | Ask an administrator for `file:write`. |

### The same in the terminal

You can also replace files with the `subkit` command line. How to set it up is in the chapter "Use the subkit CLI on your machine".

```bash
subkit files replace <file-id> <path>
subkit files versions <file-id>
subkit files restore <file-id> <version>
```
