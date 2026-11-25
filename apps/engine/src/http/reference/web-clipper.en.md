---
slug: web-clipper
summary: Save pages, selections and YouTube transcripts from Chrome to your inbox.
section: work
order: 4
audience: public
---
## Collect web pages with the Web Clipper

This chapter is for anyone who collects material for their team while reading in the browser.
You install the Web Clipper, connect it to your engine and collect your first page.
Afterwards, whatever you find worth keeping lands in your Cockpit **Inbox** with its source and waits there for a review.

The Web Clipper is a Chrome extension. It drops a page, a selection or a YouTube transcript into your inbox as Markdown; it only becomes knowledge once a person confirms it. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/odefbnmjeehgfbanpaajiaocliccldma); it then updates itself. For unmanaged or offline setups there is a ZIP file and `subkit clipper install`.

The path is always the same: **collect → review in chat → confirm → knowledge or skill**.

### What you need

- **Google Chrome.** Microsoft Edge and other Chromium browsers are untested. Firefox is not supported, because the extension uses a Chrome background service worker.
- **An engine address** that uses HTTPS. Plain HTTP works only with `localhost`, `127.0.0.1` or `[::1]`. In SubKit Cloud it is `https://subkit-cloud.mikebild.dev`, without `/cockpit`.
- **An account with `intake:read` and `intake:write`.** If it lacks them, ask an administrator.
- **To install with the CLI:** the `subkit` CLI, signed in to your engine. See "Use the subkit CLI on your machine". Otherwise use the Chrome Web Store or the ZIP file.

### Install the extension

Install the Web Clipper from the Chrome Web Store. The ZIP file and the CLI are the fallback for unmanaged or offline setups; all ways load the same extension.

| Way | Engine address | Good for |
| --- | --- | --- |
| [Chrome Web Store](https://chromewebstore.google.com/detail/odefbnmjeehgfbanpaajiaocliccldma) | you enter it when you connect | everyone; updates itself |
| ZIP file from the latest release | you enter it when you connect | anyone, without the CLI |
| ZIP file from your engine | you enter it when you connect | the exact version your engine runs |
| `subkit clipper install` | taken from your active profile | people who use the CLI |

#### Install from the Chrome Web Store

1. Open [SubKit Clipper in the Chrome Web Store](https://chromewebstore.google.com/detail/odefbnmjeehgfbanpaajiaocliccldma) and select **Add to Chrome**.
2. Pin the "SubKit Clipper" extension to the toolbar.

#### Download the ZIP file

1. Download the latest version from [github.com/MikeBild/subkit/releases/latest/download/subkit-clipper.zip](https://github.com/MikeBild/subkit/releases/latest/download/subkit-clipper.zip). Your engine offers the version it runs at `<engine address>/install/clipper.zip`, for example `https://subkit-cloud.mikebild.dev/install/clipper.zip`.
2. Unpack the file into a folder you keep. Chrome loads the extension from that folder.
3. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
4. Select **Load unpacked** and choose the unpacked folder.
5. Pin the "SubKit Clipper" extension to the toolbar.

#### Install with the CLI

1. Run the installer:

   ```sh
   subkit clipper install
   ```

   The command unpacks the extension to `~/.subkit/clipper`, copies your active profile's engine address into it and tries to open Chrome's extension page. The output names the folder.
2. In Chrome, open `chrome://extensions` if it did not open by itself, turn on **Developer mode** and select **Load unpacked** with the folder from the output.
3. Pin the "SubKit Clipper" extension to the toolbar.

The command has three options:

| Option | What it does |
| --- | --- |
| `--dir <directory>` | Installs to another folder. |
| `--engine-url <url>` | Uses this engine address instead of the active profile's. |
| `--no-open` | Does not open Chrome. |

### Update the extension

The Web Clipper from the Chrome Web Store updates itself, and it never shows an update hint. A Web Clipper you loaded unpacked stays on its version until you replace it, so it watches for you:

- When you open the popup or the settings, at most once a day, it asks your engine for its version. It sends no API key and nothing about your pages.
- When the engine runs a newer version, the popup and the settings show "Update available: version …" with a **Download** link to `<engine address>/install/clipper.zip`.

To update:

1. Download the new ZIP file and unpack it into the same folder, replacing the old files. With the CLI, update the CLI first, then run `subkit clipper install` again.
2. On `chrome://extensions`, reload the "SubKit Clipper" extension.

The engine address and language stay. Paste the API key again after the reload.

### Connect it to your engine

The Web Clipper signs in with its own API key.

1. In the Cockpit, open **API access**.
2. Select **Create key** and pick the **Web Clipper** preset. It grants exactly `intake:read` and `intake:write`.

   !["Create key" dialog with the Web Clipper preset, which grants only View and Edit on collected items](images/web-clipper-api-key.en.webp)

3. Copy the key and keep it in a password manager.
4. In the Web Clipper, select the gear icon (⚙). The settings open in a new tab.
5. Check the **Engine address** and paste the key into **API key**.
6. Select **Save connection**.
7. Allow access when Chrome asks for it.

The Web Clipper checks the connection, loads your categories and confirms that the key may save items.
After a browser restart, paste the key again; "Privacy" explains why.

If the engine address changes, you need the key for the new engine. **Clear API key** removes the key from the extension.

### Collect a page

1. In the toolbar, select the "SubKit Clipper" icon.
2. Check the **Title**.
3. Optional: fill in **Why is this interesting?**.
4. Pick a **Category**, or select **New category**. Names use lowercase letters, digits and hyphens, up to 40 characters.
5. Check the preview.
6. Optional: open **Details and edit content** to see author and date and to edit the Markdown.
7. Select **Collect**.

It is quicker to right-click and select **Save page to SubKit** or **Save selection to SubKit**, or to press **Alt+Shift+K**. Change the shortcut at `chrome://extensions/shortcuts`.

On success, the popup says for example "Collected: research. Not yet admitted as knowledge or a skill." **Review in chat** starts the review right away.
If saving fails, your draft stays in the Web Clipper. Trying again never creates a second item. If you collect a page whose item is still open in the **Inbox**, SubKit adds the new capture to that item instead of creating another one.

### What happens next

1. **Inbox:** in the Cockpit, open **Inbox** and click the item. On its page you read, edit or discard it.
2. **Review:** select **Review in chat** in the Web Clipper or in the item's menu. The chat prepares a proposal: the exact content, its sources and the destination (knowledge or skill).
3. **Confirm:** a person signed in to the Cockpit in the browser confirms the proposal on the item's **Review** tab as a source or skill.

To confirm, that person needs `intake:confirm` and the right of the destination:

| Destination | Needed rights |
| --- | --- |
| Knowledge | `knowledge:write` |
| Skill | `skill:write` and `skill:activate` |
| Skill that replaces others | also `skill:archive` for each replaced skill |

API keys, MCP clients and the Web Clipper itself cannot confirm.
Until it is confirmed, an item is not knowledge, and ordinary knowledge search does not find it. Moving or editing it changes nothing about that; if the proposal changes, you review it again.
More in the chapter "Collect ideas and turn them into knowledge or skills".

### What the Web Clipper captures

- **A page:** the main article text as Markdown, links as absolute addresses, without navigation and recommendations.
- **A selection:** only the selected text. From the toolbar or the shortcut, the Web Clipper uses your selection if there is one, otherwise the whole article.
- **A YouTube video:** title, author, publish date, description and the transcript in the original audio language. Include or exclude description and transcript under **Details and edit content**.

It also keeps the source address, author and publish date when the page provides them. Image links stay in the text; the Web Clipper uploads no image files and no screenshots.

### Privacy

- **Destination:** items and the daily update check go only to the engine you configured. For a transcript, the Web Clipper may also load the page and captions directly from YouTube.
- **Credentials are redacted:** before saving, SubKit replaces recognizable credentials (API keys, tokens, private keys, signed-link signatures) with a marker. The values are never stored. Personal data is kept, so don't clip pages that show passwords or keys.
- **Your API key** sits only in the browser's session storage and is never written to your device. That is why you paste it again after a browser restart or a reload of the extension. A key from the **Web Clipper** preset only views and edits collected items (`intake:read`, `intake:write`), including other people's clips in this workspace. Revoke it in the Cockpit when you no longer need it.
- **What the key can reach:** the **Web Clipper** preset grants only viewing and editing collected items (`intake:read`, `intake:write`), including other people's clips in your workspace. Revoke the key in the Cockpit when you no longer need it.
- **Originals stay:** the engine keeps the original captured snapshot. Later edits do not overwrite it, and the item stays linked to the knowledge or skill made from it.
- **Visibility:** items follow the permissions of your workspace. Categories are shared, not private.

### If something does not work

The Web Clipper shows messages in the selected language. **Help** in the popup and in the settings opens this chapter on your engine.
If a capture from the context menu or the shortcut fails, the Web Clipper opens its popup in a tab and shows the error there.

#### Connection and key

| What you see | What to do |
| --- | --- |
| "Set an engine address and API key first. …" or "Set an engine address before capturing." | Enter both in the settings (⚙) and save. After a browser restart, paste the key again. |
| "The API key is invalid or expired. …" | Create a new key with the **Web Clipper** preset under **API access** and save it in the settings. |
| "The API key lacks intake:read. …" or "… lacks intake:write. …" | Create a key with the **Web Clipper** preset under **API access**. Your draft stays. |
| "The SubKit API could not be reached. …" | Check the engine address, your internet connection and whether Chrome may access the address. |
| "Use an HTTPS address or HTTP on localhost." | Use `https://`, or `http://` only with `localhost`, `127.0.0.1` or `[::1]`. The address must not contain a user name, a password, a `?query` or a `#fragment`. |
| "Allow access to this engine to save the connection." | Save again and allow access when Chrome asks. |
| "Enter an API key for the new engine." | You changed the engine address. Paste the key for the new engine. |
| "Categories currently unavailable" | Select **Check connection**. |

#### Capturing

| What you see | What to do |
| --- | --- |
| "The main content could not be captured reliably. …" | Select the relevant text, then select **Capture again**. |
| "The content was captured as simplified text. …" | Check in the preview that everything is there. |
| "No text was captured. …" | Select **Capture again**. For an excerpt, select the text first. |
| "No transcript is available." | The Web Clipper could not read a transcript for this video. |
| "Open the clipper from the toolbar on this page again." | Chrome needs access to this site. Select the toolbar icon on that page. |
| "The page changed while it was being captured. Capture it again." | Capture again. |
| "The page could not be captured." | Reload the page and try again. |

#### Collecting

| What you see | What to do |
| --- | --- |
| "Saving is not confirmed yet. Retry; your draft remains available." | The network or the engine failed. Select **Try again**. |
| "SubKit rejected the clip. …" | Check the category and the content, then try again. |
| "This clip already exists." | This clip was already sent with different content. Capture again. |
| "Choose a valid category before collecting." or "Enter a valid category." | Use lowercase letters, digits and hyphens, at most 40 characters. |
| "The saved category is unavailable. Choose another category." | Pick another category. |
| "This draft belongs to a different engine." | Switch back to the engine it was made for to send it. |
