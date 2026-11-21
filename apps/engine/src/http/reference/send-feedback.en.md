---
slug: send-feedback
title: Report a bug
summary: Send a bug report, an idea or other feedback to the inbox of your workspace.
section: work
order: 19
audience: public
---
## Report a bug

This chapter is for anyone who notices something in the Cockpit or in SubKit Desktop.
Afterwards you can send a bug report with diagnostics and know what is sent, what is removed before and who can read the report.

### Where a report goes

A report does not leave your SubKit server. It lands as an item in the **Inbox** of your workspace, in the category `feedback`. Nobody outside gets it automatically, not even the maker of SubKit.

Every person in your workspace who may see the **Inbox** (`intake:read`) can read it. These are administrators and members, not users with the User role.

### Send a report

1. Select **Report a bug** in the page header, next to the side panel toggle. **Report a bug…** in the **User menu** and **Report a bug** in the **Technical details** of an error notice open the same dialog.
2. Under **Kind of feedback**, choose **Bug**, **Idea** or **Other**.
3. Describe what you were trying to do and what happened instead.
4. If needed, use **Attach a file** to add up to 3 files of 2 MB each: PNG, JPG, PDF, TXT or JSON.
5. Leave **Attach diagnostic report** switched on or switch it off. **View** shows exactly what goes along.
6. Check text and files for private information and select **Send feedback**.

The dialog tells you two things before you send: next to **Attach a file** it says that images and PDFs are sent as they are. Above **Send feedback** it says that the report is stored in the **Inbox** of your workspace, who reads it there, and that your text is sent as you wrote it except for secrets and file paths.

You then read “Thanks for your feedback”. When you open the dialog from an error notice, error, cause, code, request ID and time are already filled in.

When sending fails, your draft is kept: the kind, the text and the choice about the diagnostic report. You choose files and the screenshot again.

### What is sent

| Part | Content |
| --- | --- |
| What you enter | The kind of feedback and your text. |
| Files | What you attach yourself. |
| Diagnostic report, when switched on | **App** (Browser, Desktop app or Installed web app), **App version**, **Operating system**, **Server version**, **Connection status**, **Page** and the **Last 10 errors** with code and time. |
| Screenshot, only in SubKit Desktop and only when you tick it | A picture of the Cockpit window. |

Of the **Page**, only the path is sent, without parameters. Content of your workflows, runs or conversations is not sent unless you write it into the text or attach it.

### What is removed before storing

The Cockpit cleans the diagnostic report before sending, and the server cleans the whole report once more before it stores it.

| What | Where | Replaced by |
| --- | --- | --- |
| Credentials in headers such as `Authorization` and `Cookie`, tokens after `Bearer`, `Basic` or `Token`, named secrets such as `password`, `api_key`, `client_secret`, and strings that look like a secret | Text, diagnostic report, text files, file names | `[removed]` |
| Parameters, fragment and user information in addresses | Text, diagnostic report, text files, file names | The address stays without these parts. |
| Absolute file paths | Text, diagnostic report, text files, file names | `[path]` |
| Email addresses | Diagnostic report, text files, file names | `[email]` |

Under “Removed before storing”, the stored item names how many places were removed.

### The screenshot in SubKit Desktop

In SubKit Desktop the dialog also offers a **Window screenshot**. The browser and the installed web app do not have it.

1. Select **Report a problem…** in the app menu, in the **Help** menu or on the icon in the menu bar. The app takes the picture before the dialog appears, so that the dialog is not in it.
2. Look at the picture in the dialog.
3. Tick **Attach this picture of the window** only when nothing confidential is visible. The box is never ticked in advance.

Password and secret fields are hidden in the picture. Anything shown openly in the window, such as a newly created API key, stays visible.

When the app is not signed in, **Report a problem…** opens the **Diagnostics** dialog instead, with **Copy diagnostics** and **Save as file…**. The data contains the app version, operating system, server version and the last 10 errors. Add it to your message to the person who runs your server.

### Write a report while offline

If SubKit cannot reach the server, write the report anyway and select **Queue**. SubKit sends it as soon as the connection is back, one report at a time, and keeps the time you wrote it. If you were signed out in the meantime, it waits until you sign in again. Each report is sent only once, even when a send is repeated. A report that could not be sent within 14 days is dropped.

### Limits

- **Email addresses in your text stay.** That is deliberate: your text is yours and is sent as you wrote it. The server removes only secrets and file paths from it. It removes email addresses from the diagnostic report, from text files and from file names.
- **Pictures and PDFs are not cleaned.** That includes the screenshot. The dialog says so next to **Attach a file**. Look at them before you send.
- **No separate readers for feedback.** The category `feedback` has the same readers as the rest of the **Inbox**: administrators and members. A report for administrators only is not provided.
- **The title of the item is English.** It starts with “Bug report:”, “Idea:” or “Feedback:”, followed by the first line of your text.
- **Two different markers.** In the German diagnostic report the Cockpit writes `[entfernt]`, the server `[removed]`, `[email]` and `[path]`.
- **Five reports in ten minutes.** After that the dialog asks you to wait a few minutes.
- **Only from the Cockpit.** No report can be sent with an API key or from the `sk` command line.

### If something does not work

| What you see | What to do |
| --- | --- |
| “Feedback not sent” with “Your draft is saved and was not discarded. …” | Try again right away. |
| “You sent several reports in a short time. …” | Wait a few minutes and then send. |
| “The server did not accept an attached file. …” | Remove the file. PNG, JPG, PDF, TXT and JSON of at most 2 MB are allowed. |
| “No more than 3 files.” or “No more than 2 MB per file.” | Choose fewer or smaller files. |
| “This file could not be read. …” | Choose the file again or pick another one. |
| The screenshot is missing in SubKit Desktop | The window was hidden, or the picture was too large. Send without a picture or attach your own. |

### The same over the HTTP API

`POST /v1/feedback` accepts a report. The route only works with a browser session and needs no permission of its own. It answers `201` with the fields `id`, `intake_item_id` and `replayed`. `replayed` is `true` when the same `client_request_id` was filed before.

Every field, limit and error code is listed in “Reference: desktop app, rules, schedules and problem reports”.
