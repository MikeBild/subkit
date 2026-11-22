---
slug: subkit-desktop
title: SubKit Desktop
summary: Install SubKit Desktop on your Mac or Windows PC, sign in, and on a Mac let SubKit work with your files, a browser and your apps while you watch in the live view.
section: work
order: 18
audience: public
---
## SubKit Desktop

This chapter is for anyone who wants SubKit on their Mac or Windows PC: to keep an eye on it all day, and on a Mac to let it work with files, websites and apps on that Mac.
Afterwards you have installed SubKit Desktop, signed in, allowed what SubKit may use on your Mac, and you know how to follow and stop it in the live view.
You can also run a workspace only on your Mac and move it to a server later.

### What SubKit Desktop is

SubKit Desktop is your server’s Cockpit as a Mac app, plus three things a browser tab cannot do:

- **It stays with you.** An icon in the menu bar shows what needs you, notifications arrive while the window is closed, and the app starts when you log in.
- **It works on your Mac, if you allow it.** Chat, tasks and workflows can read and write files in folders you allowed, work in websites you allowed and use apps you allowed. Nothing of this is on until you turn it on.
- **It can run a workspace of its own.** With **Only on this Mac**, the database and the engine run on your Mac, without a server.

| SubKit Desktop does | SubKit Desktop does not |
| --- | --- |
| Show your server’s Cockpit, with the same permissions as in the browser. | Touch a folder, website or app you have not allowed. |
| Report what needs you, also when the window is closed. | Store your password. The sign-in is a session as in the browser. |
| Ask before a step on your Mac writes, unless your request covers it. | Follow instructions that a web page or a file contains. |
| Show every step on your Mac in the live view, with a Stop button. | Keep working after you stop it. Later steps don’t run. |

The table in “Cockpit as an app” shows how it differs from the installed web app.

### What you need

- A Mac with Apple Silicon and macOS 13 or later, or a PC with Windows 10 or 11 (64-bit, x64). Intel Macs and Linux are not supported.
- Files, browser, apps, the live view and the local workspace exist only on the Mac. On Windows SubKit Desktop brings the Cockpit, the tray icon, notifications, the quick note, “Where should this go?” for dropped files and updates; the app says so where a Mac-only feature would be.
- For a server: a SubKit server of version @@DESKTOP_MIN_SERVER_VERSION@@ or later. Its address has to be reachable over `https://`; only `localhost` may use `http://`.
- An account you can sign in to the Cockpit with in the browser, an invitation link from your invitation email, or a new account for a workspace of your own.
- For a workspace only on your Mac: no server, but an API key of Anthropic, OpenAI or Google Gemini, or a model server on your Mac.

### Install

SubKit Desktop is a signed DMG file for Macs with Apple Silicon.

1. Download [SubKit for Mac](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-mac-arm64.dmg).
2. Open the DMG file.
3. Drag **SubKit** into **Applications**.
4. Start SubKit from **Applications**. On the first start, macOS asks whether you want to open an app from the internet. Select **Open**.
5. Select **Get started** and connect to SubKit Cloud at `https://subkit-cloud.mikebild.dev` or to your own server, as described in “Connect to a server”.
6. Sign in in your browser. Then allow the folders and apps SubKit may use, as described in “Let SubKit work on your Mac”.

The app updates itself, so you download it only once.

On Windows SubKit Desktop is a signed installer for Windows x64.

1. Download [SubKit for Windows](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-win-x64.exe).
2. Open the installer. It installs SubKit for your Windows account, without administrator rights.
3. Start SubKit from the Start menu.

### Welcome and invitation link

On the first start you see “Welcome to SubKit Desktop”. It names four things: see what needs your approval, chat and draft workflows, get tasks done step by step, and “You stay in control”.

- **Get started** leads to “Connect server”.
- **Create a new workspace** also leads to “Connect server”. When you sign in in the browser, SubKit then asks for your name, the name of the workspace, the time zone and the key of your AI provider. After that you sign the device in as usual. This works with an account that does not belong to a workspace yet, and only when the server allows new workspaces. Otherwise the browser tells you.
- **Use an invitation link** is for an invitation email. Paste the whole link under **Invitation link** and select **Open invitation**. You read, for example, “Anna invited you to the workspace ‘Brennwerk’.” with the address and the validity. **Join and sign in** opens the invitation in your browser, and the app waits for the confirmation. Join in the browser. Right after that, the browser shows “Sign in to SubKit Desktop” (see “Sign in in the browser”, from step 3). After **Sign in** you are signed in to the app, without a second step in the app.

An invitation that has expired, was withdrawn or was already used says so. Ask the person who invited you for a new one.

### Connect to a server

1. In “Connect server”, keep **Connect to a server**. **Only on this Mac** starts a local workspace instead (see “A workspace only on this Mac”).
2. Enter the address of your server under **Server address** and select **Check connection**. **Examples** lists the servers the app already knows and `localhost:3000`.
3. Read the result. With “Connected” everything fits, and **Next** leads to the sign-in.

The app checks whether a SubKit server answers at the address and whether the versions fit together. When the server is too old, **Ask an administrator** copies a message for the person who runs it.

### Sign in in the browser

The sign-in happens in your browser, not in the app. That way you use the sign-in you already know, and the app never sees your password.

1. In the step “Sign in with browser”, select **Open browser**. Your browser opens, and the app shows “Waiting for confirmation in the browser…”.
2. Sign in to the Cockpit in the browser if you are not signed in there yet.
3. Read the page “Sign in to SubKit Desktop”. It names your Mac, the workspace and the account, for example “SubKit Desktop on MacBook-Anna is asking to sign in to Brennwerk.” and “Signed in as anna@example.com”.
4. Select **Sign in**. Continue only if you just started this sign-in yourself in the app on this device.
5. The browser hands back to the app. You read “Device registered” with the device name, the server and the status. **Open SubKit** opens the Cockpit.

With **Cancel** on the page in the browser or **Cancel** in the app, nothing happens: no profile and no device is created.
The page in the browser is valid for 10 minutes. After that, start the sign-in again in the app.

### The first start after the sign-in

The app asks up to three questions once:

1. **Workspace.** If you have access to several workspaces, choose one. You can switch later at any time.
2. **Allow notifications.** **Allow** lets macOS show SubKit’s notifications. A test notification confirms it: “Notifications are on”.
3. **Diagnostics.** “Should your bug reports include diagnostics?” **Attach diagnostics** adds a cleaned diagnostics report to every bug report you send. Diagnostics stay off unless you choose this.

**Not now** skips a question. You change all three later under **Settings** in the Cockpit.

### Menu bar, notifications and quiet hours

When you close the window, SubKit Desktop keeps running. The icon in the menu bar shows the number of open items.

| Entry in the icon’s menu | What it does |
| --- | --- |
| **Open SubKit** | Brings the window to the front. |
| **Needs you (3)** | Opens the list of open items. When nothing is open, it reads “Nothing needs you right now”. |
| **Open live view** | Shows what SubKit does on your Mac right now. Appears while SubKit works on your Mac. |
| **Pause notifications for 1 hour** | Holds notifications back for an hour. Below it you read until when, for example “Paused until 15:05”. **Resume notifications** ends the pause. |
| **Launch at login** | Starts SubKit Desktop with your Mac, without opening a window. |
| **Check for updates** | Looks for a new version of the app. |
| **Quick note …** | Opens a note for your inbox (⌥ Space). |
| **Settings…** | Opens the app’s settings. |
| **Report a problem…** | Opens the dialog from “Report a bug”. |
| **Quit SubKit** | Quits the app. No notifications arrive after that. |

A notification says what happened and what to do, for example “‘Daily report’ is waiting for your decision” and “Review the change and decide.” A click opens exactly this item in the window.

- A new item is reported within about a second, after a minute at the latest.
- When several items arrive at once, the app shows at most three notifications. You see the rest in the number on the icon.
- What is already open when the app starts is not reported again.

You set quiet hours in the app:

1. Open **Settings…** in the app menu or press ⌘,.
2. Switch on **Quiet hours** and enter **From** and **To**. The presets are 22:00 and 07:00.
3. If you like, switch on **Launch when you log in to your computer** and choose German, English or **Same as system** under **Language**.

During quiet hours and during a pause SubKit keeps counting but shows no notifications. The menu then reads, for example, “Quiet hours until 07:00”. Quiet hours follow the clock of your Mac.

### Quick note

Press ⌥ Space anywhere, or select **Quick note …** in the menu bar. A small window asks “What do you want to capture?”.

1. Type your note.
2. Press ⌘ ↩ or select **Into the inbox**. Esc closes the window without sending.

You read “Note in the inbox”. The note waits there for your review, as described in “Collect ideas and turn them into knowledge or skills”.

### Drop files: “Where should this go?”

Drag files onto the window, the Dock icon or the menu bar icon. SubKit asks “Where should this go?” and offers four choices:

| Choice | What happens | Limit |
| --- | --- | --- |
| **Store as file** | The file lands under **Files**, with an `@attachment:` reference. | 5 MB per file |
| **Ingest as source** | SubKit splits it into sections and keeps it as a knowledge source. | 50 MB per file |
| **Attach in chat** | The files wait for your next chat message. | 10 files |
| **Into the inbox** | SubKit reviews it and suggests what it becomes. | 1 MB for text files |

You can drop up to 20 files at once. A choice that does not fit says why, for example “Larger than 5 MB” or “File type not supported”. While the app is offline, nothing is placed.

### Let SubKit work on your Mac

SubKit can do three things on your Mac. All three are off until you turn them on, and each uses only what you allow.

| Capability | What SubKit does | What you allow |
| --- | --- | --- |
| **Files** | Reads files, saves, creates folders, moves files and puts them in the Trash. | Folders, each with **Read** or **Read and write** |
| **Browser** | Opens pages, reads them, fills in fields, presses buttons and downloads files, in a browser of its own. | Websites, as an origin such as `https://shop.example.com` |
| **Apps** | Reads and uses buttons and fields in an app window, types and takes redacted screenshots. | Apps, chosen one by one |

Turn them on:

1. Open **Settings…** in the app and, in it, **Local capabilities**. Select **Manage**.
2. Switch on **Let chat and tasks use this Mac**.
3. Under **Local allowances**, add what SubKit may use:
   - **Folders**: **Choose folder…**, then choose **Read** or **Read and write** under **Access**.
   - **Websites**: enter an origin, for example `https://shop.example.com:8443` or an address in your local network, without a path, and select **Add**.
   - **Apps**: **Choose app…**.
4. Under **Off limits for SubKit**, add what SubKit must never use.

Some things are always blocked and cannot be allowed: SubKit itself, security prompts and sign-in windows, password managers, crypto wallets, banking and payments, terminals and shells, scripts and automation, System Settings and installers, remote support and the Finder. SubKit also refuses a whole disk, a system or hidden folder and your entire home folder. Choose a subfolder instead.

The allowances live on your Mac. The server learns which folders, websites and apps the Mac offers, so an approval can name them. In the Cockpit, **Settings** › **Devices** › “Which devices run local steps?” lists every Mac with what it offers, for example “3 folders”.

Once you turn a capability on, SubKit creates a connector for it, for example “MacBook Pro (Anna): Files”, named in the language of the app. Chat and tasks use it from then on. How a workflow uses it with fixed steps is in “Reference: workflow steps on your device”.

**Remove** on an entry takes the allowance back. Workflows, tasks and chat can no longer use it afterwards.

### macOS permissions

For **Apps**, macOS has to allow SubKit two things. **Check permissions** under **Local capabilities** shows both with **Granted** or **Missing**.

| Permission | Why SubKit needs it |
| --- | --- |
| **Accessibility** | SubKit reads and uses buttons and fields in the apps you have allowed. |
| **Screen Recording** | SubKit takes screenshots of the app window with password fields blacked out. |

1. Select **Open System Settings** next to a missing permission.
2. Switch SubKit on in **Privacy & Security**.
3. Back in SubKit, select **Check again**. When macOS asks for it, select **Restart SubKit**.

Files and the browser need no extra permission. When macOS asks whether SubKit may access your Desktop, Documents or Downloads folder, it is because you allowed a folder there.

### When SubKit asks on your Mac

On your Mac, the same rule applies as everywhere: your request decides what runs without a question.

- **Reading and preparing run without a question.** Opening a page, reading a file, taking a screenshot, scrolling and selecting.
- **A step that writes runs without a question only when your request covers it.** Saving a file, pressing a button that sends, filling in a field, typing. Otherwise SubKit asks: in the chat with **Allow once** or **Decline**, in the live view with **Allow once** or **Deny**.
- **Some steps always ask.** Putting a file in the Trash, payments, publishing and sending to recipients you did not name.
- **Always ask first** makes every step that changes something ask you, also on your Mac. You turn it on under **Settings** › **Rules** in the Cockpit.
- **What a page says is not your request.** When a page contains an instruction, the live view shows “The page contains an instruction. SubKit does not follow it.”

“When SubKit asks” explains the rule in full.

When a page asks you to sign in, SubKit hands over to you. The live view reads “Your turn – sign in, then ‘Hand back to SubKit’”. Sign in yourself, then select **Hand back to SubKit**. SubKit does not act in the window while it is your turn.

A workflow step on your Mac needs its approval as every workflow step does. The approval names the Mac, the folders, websites and apps.

### Live view

While SubKit works on your Mac, a small bar at the top of the screen shows “SubKit is using ‘Safari’” with **Stop**. **Open live view** in the menu bar shows more:

- Where the work comes from: “Started by you in chat”, “From your task” or “From your schedule”.
- The **Latest redacted screenshot**. Password fields and fields marked as sensitive are blacked out on your Mac, before anything leaves it.
- **Steps**, each with its result, for example **Done**, **Waiting for you**, **Refused** or **Not run**.
- A question, when a step waits for you, with **Allow once** and **Deny**.

The status says what is going on:

| Status | Meaning |
| --- | --- |
| **Running** | SubKit is working. |
| **Waiting for you** | A step needs your decision. |
| **Waiting until you stop typing** | You are typing on your Mac. SubKit waits so it does not type into your text. |
| **Your turn – sign in, then “Hand back to SubKit”** | A sign-in is handed to you. |
| **Stopped. Later steps won’t run.** | You stopped it. |
| **Device unavailable** | The Mac lost its connection to the server. |
| **Finished** | Everything is done. |

**Stop** or ⌘⇧⎋ stops SubKit at once, from any app. The step that is running ends, and later steps don’t run. The run shows which steps were done.

Screenshots of a run are kept encrypted for 30 days and then deleted. In the Cockpit, the person of the device can see a run’s redacted screenshot on its steps.

### A workspace only on this Mac

With **Only on this Mac**, SubKit runs the database and the engine on your Mac, without a server. Besides your AI provider and the services your workflows call, nothing leaves the Mac. That suits trying SubKit out, or working alone.

1. In “Connect server”, select **Only on this Mac**.
2. **Data folder**: keep the suggested folder or choose **Choose another folder…**. The folder has to be on this Mac and must not be synced, for example not in iCloud Drive.
3. **You**: enter **Your name**.
4. **AI access**: choose a **Provider** (Anthropic, OpenAI or Google Gemini) and enter its **API key**, or choose **Local model server** and enter its address, for example `http://localhost:11434`. The key is stored encrypted in your local workspace. **Set up later** skips this step; workflows without AI run anyway.
5. **Setting up**: SubKit starts the database, the engine and the workspace. Then the Cockpit opens.

The local workspace runs while the app is open and the Mac is awake.

Under **Settings…** › **Local workspace** you find:

- **Running** or **Stopped**, and the size of the data.
- **Backups**: SubKit makes one automatically before every update and before every restore. **Create backup** makes one by hand. **Restore** replaces the workspace with a backup. Newer changes are lost; allowed folders stay.
- **Open at login**: starts the local workspace when you log in.
- **Move to a server**: exports the workspace as a bundle and imports it into your server workspace (see below).
- **Remove all local data**: stops the engine, moves the data to the Trash and forgets the keys. Workflows, runs and backups on this Mac are gone afterwards.

A model on a local model server has to be able to call tools. If it cannot, you read “Model can’t call tools”: chat and tasks don’t work with it, workflows keep running. Choose another model or a provider key under **Settings** › **AI assistant** in the Cockpit.

#### Move to a server

1. Under **Local workspace**, select **Move to a server**.
2. Enter the server address with `https://` and select **Move now**. SubKit exports the workspace for the server and stops it on this Mac.
3. Sign in to the server. The workspace now runs there.

This Mac stays connected as a device with its allowed folders. You renew the approvals of your workflows on the server. The local data stays on the Mac until you remove it. **Export bundle** saves the bundle without moving, for example to import it yourself.

### Devices and signing out

Every Mac on which you sign in with SubKit Desktop is a device of its own with its own session. The server lists it under the name of the Mac. When you sign in again on the same Mac, it stays the same device.

- **Sign out** in the account menu of the Cockpit ends the session of this device. Your session in the browser and other devices stay signed in.
- **Remove** in the list **Your servers** deletes the local session and the profile. Nothing changes on the server.
- **Revoking a device** signs it out from outside, for example after a loss. Within a few seconds the app then shows “Signed out of …” with **Sign in again**.

You see your devices in the Cockpit under **Settings** › **Devices**. The list shows the installed web app and every desktop device with its kind, name, the day it signed in and its last use. The device you are sitting at carries the mark **This device**.

1. Open the Cockpit in the browser and there **Settings** › **Devices**.
2. Select **Revoke** at the device.
3. Confirm. The dialog names the device and says what happens: it is signed out at once and no longer receives notifications; other devices stay signed in.

In the app itself you see the same list, but there you can only sign out **This device** with **Sign out**. You revoke another device in the browser.

When a Mac that runs local steps is revoked, local steps stop running on it, and approvals that name it can no longer run.

### How long you stay signed in

| Rule | Value |
| --- | --- |
| Without use | 30 days. Any use of the app, also in the background at the menu bar icon, starts the period again. |
| At most | 90 days since the sign-in, even with daily use. After that you sign in again in the browser. |
| After a revocation or **Sign out** | Ended at once. |

When the session expires you read “Session expired” and “Sign in again; your settings are kept.” Shorter periods apply to the browser and the installed web app: 8 hours without use, 24 hours at most.

### Several servers

If you work with several SubKit servers, each one gets its own profile with its own session.

1. In the **Servers** menu, select **Add server…** or press ⌘N.
2. Connect and sign in as above.
3. Switch between the profiles through the **Servers** menu or with **Open** in the list **Your servers**.

### Updates

The app checks for updates at start and every six hours after that, on the Mac and on Windows alike. If **Settings** reads “Automatic updates are not enabled in this build.”, your build was made without updates. Download SubKit again as described in “Install”.

| What you read | What happens |
| --- | --- |
| “You’re on the latest version, ….” | Nothing to do. |
| “Version … is available. The download starts shortly.” | The app downloads the update in the background. |
| “Version … is downloaded. Restart SubKit to install it.” | Select **Restart now**. With **Later**, the update is installed the next time you quit. |
| “The update could not be verified and was not installed. …” | Your version stays as it is. Try again later. |
| “Runs still active in the local workspace: …. A restart stops them.” | Wait until the runs are done, or select **Restart anyway**. |

When the server requires a newer app, you read it while connecting. Update SubKit Desktop then.

### Limits

- **Notifications only arrive while the app runs.** After **Quit SubKit** it reports nothing. For notifications without a running app, use the push of the web app.
- **What was new during quiet hours or a pause is not reported later.** You see it in the number on the icon and in the **Needs you** list.
- **The quiet hours of the app are its own.** The choice under **Settings › Setup** in the Cockpit applies to push in the browser, not to the app.
- **The app reports the items of the opened profile.** Other servers report only once you switch to them.
- **Local steps run only while the app is open and the Mac is awake.** A run that needs the Mac waits for it and says “A run is waiting for its device to come online.”
- **Browser and app steps run only for the person of the Mac.** From their chat or task, a run they start, or a schedule they set up.
- **Redaction covers password fields and fields marked as sensitive.** A secret that a page or app shows as plain text stays in the screenshot.
- **On Windows, SubKit does not work on the PC.** Files, browser, apps, the live view and **Only on this Mac** are Mac-only for now. **Local capabilities** and the connect screen say so on Windows.

### If something does not work

| What you see | What to do |
| --- | --- |
| “Server not reachable” | Check the address and whether you can reach the server in the browser. |
| “Not a SubKit server” | Enter the address of the server, without `/cockpit` at the end. |
| The address does not start with `https` | Use the `https` address of your server. |
| “Version … isn’t supported” | The server is too old for the app. Select **Ask an administrator** and pass the message on. |
| “App too old” | Update SubKit Desktop. |
| “Sign-in not supported” | Update the server or SubKit Desktop. |
| “This isn’t a complete invitation link.” | Copy the whole link from the invitation email. |
| “This invitation has expired” or “This invitation was already used” | Ask the person who invited you for a new invitation. |
| “Sign-in expired, start it again” | At most one minute may pass between **Sign in** in the browser and the return to the app. Start the sign-in again. |
| “The server declined” | Start again. If it stays that way, check that your account is active in the workspace. |
| “The browser couldn’t be opened” | Check that a default browser is set up on your Mac. |
| Nothing happens in the app after **Sign in** in the browser | Allow the browser to open SubKit when it asks. If the app is no longer running, start it and begin again. |
| “Server offline” | SubKit tries to restore the connection automatically. The icon shows “No connection to the server”. |
| “SubKit can’t allow this folder.” | Choose a subfolder, not a whole disk, a system or hidden folder, or your entire home folder. |
| “An allowed folder was replaced. Allow it again.” | The folder was deleted and created again. Remove it under **Local capabilities**, choose it again and renew the approvals that name it. |
| “This device is missing a system permission.” | Open **Check permissions** under **Local capabilities** and grant the missing permission. |
| A step is **Refused** | The folder, website or app is not allowed, or it is off limits. Allow it under **Local capabilities**, or ask SubKit for something else. |
| “Model can’t call tools” | Choose a model that calls tools or a provider key under **Settings** › **AI assistant**. |
| “Port is busy” | Select **Use another port**. |
| “The database can’t run here.” | Choose a folder on this Mac that isn’t synced. |
| “Local workspace doesn’t start” | Select **Try again**. If it stays that way, report a problem with diagnostics. |
| No notifications arrive | Check whether a pause or quiet hours are active and whether macOS allows notifications for SubKit. |
