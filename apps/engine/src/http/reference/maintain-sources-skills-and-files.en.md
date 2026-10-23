---
slug: maintain-sources-skills-and-files
title: Maintain sources, skills and files
summary: Compare earlier versions, restore them and find conversations about a source or a skill.
section: work
order: 10
audience: public
---
## Maintain sources, skills and files

You find sources, skills and files in the Cockpit in the **Knowledge** group.
SubKit keeps earlier states. You see what changed, and you bring back an earlier state.

### What you need

- To view: `knowledge:read` for sources, `skill:read` for skills, `file:read` for files.
- To restore and replace: `knowledge:write`, `skill:write` or `file:write`.

### Compare versions of a source or a skill

1. Open **Sources** or **Skills** and click a source or a skill.
2. Open the **Versions** tab. The newest version is on top and marked **Current**.
3. Click a version.
   Under **Change since v…** you see **Before** and **After** side by side.

### Restore an earlier version

1. Open the version as above.
2. Select **Restore this version**. The current version cannot be restored.
3. The question **Restore this version?** appears. Confirm with **Restore**.

SubKit saves the restored content as a new version. The previous version stays under **Versions**.

### Find conversations about a source or a skill

1. Open the source or the skill.
2. Open the **Usage** tab and expand **Conversations about this**.

The list shows conversations that name the source or the skill with an `@` reference.
For a source, it also counts conversations in which a knowledge tool read or found the source.
For a skill, it also counts conversations that loaded the skill.
Click a conversation to open it. If there is none yet, start one with **Ask in chat**.

### Replace a file

1. Open **Files** and click the file.
2. Open **More actions** and choose **Replace**.
3. Choose the new file and confirm with **Replace**.

The new filename is adopted. The reference stays the same, so workflows and the chat use the new content right away.
The previous content stays as an earlier version.

### Restore an earlier state of a file

1. Open the file and its **Usage** tab.
2. Expand **Replaced**. The section appears once a file has earlier versions.
3. Click a version. You see its preview.
4. On an earlier version, select **Restore**.

The earlier state becomes current again as a new version. The current content stays as an earlier version.

Good to know:

- SubKit keeps the last 20 earlier versions of a file.
- Deleting a file also removes all its earlier versions.

You do the same with the sk CLI:

```bash
sk files replace <file-id> <path>
sk files versions <file-id>
sk files restore <file-id> <version>
```

### If something does not work

| What you see | What to do |
| --- | --- |
| **Restore this version** is missing | You opened the current version. Open an earlier one. If the button is still missing, ask an administrator for the write permission for sources or skills. |
| "This version has no saved state, so it cannot be restored." | Choose another version, or change the skill directly. |
| The **Replaced** section is missing | The file was never replaced. It has no earlier versions yet. |
| **Replace** is missing in the menu | Ask an administrator for `file:write`. |
