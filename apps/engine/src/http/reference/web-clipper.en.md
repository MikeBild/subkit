---
slug: web-clipper
summary: Save web pages and selections to your SubKit Inbox with the browser extension.
section: work
order: 4
audience: public
---
## Web Clipper

The SubKit Clipper is a browser extension. It sends a web page, a text selection or a
YouTube transcript to your SubKit engine. There it waits in the Cockpit **Inbox** until
you review it. Clipping alone never turns anything into knowledge or a skill.

The path is always the same: **collect → review in chat → confirm → knowledge or skill**.

### What the clipper captures

- **A page.** The clipper extracts the main article text and converts it to Markdown.
  Links become absolute addresses. Navigation and recommendations are left out.
- **A selection.** Select text on the page first. The clipper then takes only that text.
- **A YouTube video.** On a video page, the clipper takes the title, author, publish date,
  description and the transcript in the original audio language. You can include or
  exclude the description and the transcript under **Details and edit content**.

Along with the text, the clipper keeps the title, the source address, the source author
and the publish date when the page provides them. Image links stay in the text.
Image files are not uploaded. The clipper takes no screenshots.

When you collect from the toolbar or with the shortcut, the clipper uses your selection
if there is one. Otherwise it takes the whole article.

### Before you start

You need:

- **Google Chrome.** The clipper is made for Chrome. Other browsers are untested.
- **The `sk` CLI**, logged in to your engine. See "Use the sk CLI on your machine".
- **An engine address** that uses HTTPS. Plain HTTP works only on `localhost`,
  `127.0.0.1` or `[::1]`.
- **An account with `intake:read` and `intake:write`.** If your account lacks them,
  ask an administrator.

The clipper is not available in the Chrome Web Store. You install it from the CLI.

### Install the extension

1. Run the installer:

   ```bash
   sk clipper install
   ```

   It unpacks the extension to `~/.sk/clipper` and prints:

   ```text
   sk: clipping extension installed to /Users/you/.sk/clipper
   ```

   It also tries to open Chrome's extension page for you.

2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder the command printed.
5. Pin the SubKit Clipper to the toolbar so you can reach it quickly.

The installer copies your active profile's engine address into the extension.
You only have to add an API key.

Useful options:

| Option | What it does |
| --- | --- |
| `--dir <directory>` | Installs to another folder. |
| `--engine-url <url>` | Uses this engine address instead of the active profile's. |
| `--no-open` | Does not open Chrome. |

**Updating:** after you update the CLI, run `sk clipper install` again. Then click the
reload icon of the SubKit Clipper on `chrome://extensions`. Your connection settings stay.

### Connect it to your engine

The clipper signs in with an API key. Create a separate key for it.

1. In the Cockpit, open **API access** and create a key.
   The **Run** preset includes `intake:write` when your account has that permission.
   The key must have `intake:read` and `intake:write`.
   If your account lacks one of them, the page tells you which one is missing.
2. Open the clipper and click the gear icon (⚙). The settings open in a new tab.
3. Check the **Engine address**, for example `https://engine.example.com`.
4. Paste the key into **API key**.
5. Choose your language.
6. Click **Save connection**. Chrome asks for access to your engine's address. Allow it.

The clipper then checks the connection. It loads your categories and confirms that
the key may save clips.

If you change the engine address later, enter the API key for the new engine as well.
**Clear API key** removes the stored key from the extension.

### Collect a page

You can start a capture in three ways:

- **Toolbar:** click the SubKit Clipper icon.
- **Context menu:** right-click the page and choose **Save page to SubKit** or
  **Save selection to SubKit**.
- **Shortcut:** press **Alt+Shift+K**. You can change it at `chrome://extensions/shortcuts`.

The popup then shows what it will send:

1. Check the **Title**. You can edit it.
2. Optionally fill in **Why is this interesting?**. This note helps you during review.
3. Pick a **Category**. Your default category is preselected; at first that is `inbox`.
   Choose **New category** to create one. Category names use lowercase letters, digits
   and hyphens, for example `research` or `ai-tools`, with at most 40 characters.
4. Check the preview. It shows the word and character count.
   Under **Details and edit content** you can see the author and date and edit the Markdown.
5. Click **Collect**.

On success, the popup says for example
"Collected: research. Not yet admitted as knowledge or a skill."
Click **Review in chat** to start the review right away.

The clipper keeps a local draft for each page and engine, including your note. If saving
fails, the draft stays, and you can try again. Sending the same clip twice does not
create a second item.

### What happens next

1. **The clip lands in the Inbox.** In the Cockpit, open **Inbox**. There you can open the
   item, read its content and source, edit it, move it to another category or discard it.
2. **You review it in chat.** Use **Review in chat** in the clipper, or the item's chat
   action in the Inbox. The chat assesses the clip and prepares a proposal: the exact content,
   its sources and the destination, knowledge or skill.
3. **A person confirms it.** Only a person signed in to the Cockpit in the browser can
   confirm a proposal as **knowledge** or as a **skill**. They also need the rights of
   the destination, for example `knowledge:write` for knowledge. API keys, MCP clients
   and the clipper itself cannot confirm.

Until someone confirms it, a clip is not knowledge. Ordinary knowledge search does not
find it. Moving or editing a clip does not admit it either. If the proposal changes,
it must be reviewed again.

### Privacy

- **Where clips go:** the clipper sends clips only to the engine you configured.
  On YouTube, it may also load the page and the captions from YouTube itself
  to read the transcript.
- **Originals stay:** the engine keeps the original captured snapshot. Your later edits
  do not overwrite it. The clip stays linked to the knowledge or skill made from it.
- **No redaction:** clips are stored as captured. The clipper does not remove secrets
  or personal data. Do not clip pages that show passwords, keys, tokens or other secrets.
- **Your API key** is stored in the browser extension on this device. Use a separate key
  for the clipper and revoke it in the Cockpit when you no longer need it.
- **Visibility:** collected items follow your tenant's permissions. Categories are shared,
  not private.

### Troubleshooting

The clipper shows its messages in the selected language. **Help** in the popup and in the
settings opens this chapter on your engine.

**Connection and key**

| Message | What to do |
| --- | --- |
| "Set an engine address and API key first." | Open the settings with the gear icon, enter both and save. |
| "Set an engine address before capturing." | The settings open automatically. Enter the engine address and save. |
| "The API key is invalid or expired. …" | Create a new key under **API access** and save it in the settings. |
| "The API key lacks intake:read. …" | Use a key that has `intake:read`. |
| "The connection works, but the API key lacks intake:write. …" | Create a key with the **Run** preset under **API access**; it includes `intake:write`. Your draft stays. |
| "The SubKit API could not be reached. …" | Check the engine address and your internet connection. Make sure Chrome may access the engine's address. |
| "Use an HTTPS address or HTTP on localhost." | Use `https://`, or `http://` only with `localhost`, `127.0.0.1` or `[::1]`. The address must not contain a user name, a password, a `?query` or a `#fragment`. |
| "Allow access to this engine to save the connection." | Save again and allow access when Chrome asks. |
| "Enter an API key for the new engine." | You changed the engine address. Paste the key for the new engine. |
| "Categories currently unavailable" | Click **Check connection**. |

**Collecting**

| Message | What to do |
| --- | --- |
| "Saving is not confirmed yet. Retry; your draft remains available." | The network failed or the engine had an error. Click **Try again**. |
| "SubKit rejected the clip. …" | Check the category and the content, then try again. |
| "This clip already exists." | This clip was already collected. |
| "Choose a valid category before collecting." or "Enter a valid category." | Use lowercase letters, digits and hyphens, at most 40 characters. |
| "The saved category is unavailable. Choose another category." | Pick another category. |
| "This draft belongs to a different engine." | The draft was made for another engine address. Switch back to that engine to send it. |

**Capturing**

| Message | What to do |
| --- | --- |
| "The main content could not be captured reliably. …" | Select the relevant text on the page, then choose **Capture again**. |
| "The content was captured as simplified text. …" | Check the preview for completeness. |
| "No text was captured. …" | Click **Capture again**. For an excerpt, select the text first. |
| "No transcript is available." | The clipper could not read a transcript for this video. |
| "Open the clipper from the toolbar on this page again." | Chrome needs access to this site. Click the toolbar icon on that page. |
| "The page changed while it was being captured. Capture it again." | The page address changed during the capture. Capture again. |
| "The page could not be captured." | Reload the page and try again. |

If a capture from the context menu or the shortcut fails, the clipper opens its popup
in a tab and shows the error there.
