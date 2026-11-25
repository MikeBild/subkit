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
2. Open the **Usage** tab. Each conversation appears there as a **Chat** row, next to workflows, connectors and other uses.

The tab lists conversations that name the source or the skill with an `@` reference. For a source, it also counts conversations in which the assistant read or found the source. For a skill, it also counts conversations that loaded the skill. Click a **Chat** row to open the conversation.

### See which sources an answer used

Under a chat answer, the line **Sources:** names the knowledge sources and skills SubKit used for it. Click a name to open the source or the skill.

- The line shows up to five names, followed by “and … more”.
- Documentation that SubKit read, for example about a connector, appears without a link.
- A source without a name reads “Unnamed source”.
- An answer for which SubKit used no source has no such line.

### Plan a review of a source

Knowledge goes out of date. A review date reminds your team to check that a source is still correct.

1. Open **Sources** and click the source.
2. Open **More actions** and choose **Plan a review**.
3. Under **Review date**, pick the day and save. You read “Review date saved for ….”

From that day on, the source appears on the **Overview** under **Needs you** with the label **Review due**. If several sources are due, one entry names their number, for example “3 knowledge sources are due for a review”. Select the entry to open the source or the list. On the source, **Next review** shows the date, with “due now” once it has passed.

To remove the reminder, open the dialog again and leave the field empty. Setting the date needs `knowledge:write`. The entry under **Needs you** appears for everyone with `knowledge:read`.

### Decide skill proposals

SubKit proposes skills when a pattern keeps recurring. You decide them on the **Skill candidates** page, not in the skills table.

1. Open **Skills** and click **… proposals open** in the header.
2. Click a candidate and review its content and scope.
3. Choose **Accept** or **Discard**. To decide several candidates at once, select them in the list.

Discarding needs `skill:write`; accepting also needs `skill:activate`. SubKit does not propose a discarded candidate again.

### Say who a skill is for

When the assistant drafts a workflow, it gets a list of all skills and the full text of the skills that fit the request best. It loads any other skill from the list when it needs it. A skill always arrives whole, never cut short. The skill field `audience` helps choose:

| Value | When the full text comes along |
|---|---|
| `authoring` | Rules for drafting workflows. Comes along with every draft that has room for it. |
| `connector:<slug>` | Only when the draft uses a connector with this slug or built from this template, for example `connector:google-gmail`. Comes first then. |
| `driver:<driver>` | Only when the draft uses a connector of this kind, for example `driver:http`. |
| `runtime` | Never ahead of time. Help for the chat and for running workflows. Loaded only on request. |

A skill without `audience` keeps its previous behaviour: it ranks like `authoring`. Set the field with `PATCH /v1/skills/{id}`, for example `{"audience": ["connector:google-gmail"]}`.

### Replace a file

1. Open **Files** and click the file.
2. Open **More actions** and choose **Replace**.
3. Choose the new file and confirm with **Replace**.

The reference to the file stays the same. Workflows and the chat therefore use the new content right away, without you changing them. The new filename is adopted, and the previous content stays as an earlier version.

### Restore an earlier state of a file

1. Open **Files** and click the file.
2. Open the **Versions** tab. The tab appears once the file has been replaced.
3. Click a version. You see its preview.
4. On an earlier version, select **Restore this version**.
5. In the dialog, confirm with **Restore this version**.

The earlier state becomes current again as a new version. The current content stays as an earlier version.

Good to know:

- SubKit keeps the last 20 earlier versions of a file.
- Deleting a file also removes all its earlier versions.
- If another file holds exactly the same content, the restore is refused. Once you delete that file, the restore works.

### If something does not work

| What you see | What to do |
| --- | --- |
| **Restore this version** is missing | You opened the current version. Open an earlier one. If the button is still missing, ask an administrator for the write permission for sources or skills. |
| "This version has no saved state, so it cannot be restored." | Choose another version, or change the skill directly. |
| The **Versions** tab is missing | The file was never replaced. It has no earlier versions yet. |
| **Replace** is missing in the menu | Ask an administrator for `file:write`. |
| **Plan a review** is missing under **More actions** | Ask an administrator for `knowledge:write`. |

### The same in the terminal

You can also replace files with the `subkit` command line. How to set it up is in the chapter "Use the subkit CLI on your machine".

```bash
subkit files replace <file-id> <path>
subkit files versions <file-id>
subkit files restore <file-id> <version>
```

Set or remove the review date of a source like this:

```bash
subkit knowledge-sources patch <source-id> --review-due 2026-12-31
subkit knowledge-sources patch <source-id> --review-due none
```
