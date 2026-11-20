---
slug: cockpit-app
title: Cockpit as an app
summary: Launch your workspace's Cockpit as its own app in its own window.
section: work
order: 9
audience: public
---
## Cockpit as an app

This chapter is for anyone who works in the Cockpit every day and does not want to hunt for it among browser tabs. You install the Cockpit of a workspace as an app on your computer or phone, provided your browser can install web apps. You then start it like any other program, in its own window and with the workspace's name, icon and colors.

### What you need

- Access to a workspace in SubKit Cloud at https://subkit-cloud.mikebild.dev or on a self-hosted engine.
- An account you sign in with through **Sign in with work account**. An installed app cannot sign in again with an API key.
- A browser that supports web app installation.
- For branding: the `settings:write` and `identity:write` permissions in the workspace.

### Install the Cockpit of a workspace

1. Open the Cockpit in the browser and sign in.
2. Open the workspace menu in the sidebar and choose **Install this workspace**.

   ![Open workspace menu with the current workspace checked and the "Install this workspace" entry highlighted](images/cockpit-app-install.en.webp)

3. Check the name and icon in the install dialog and select **Install app**.
4. The Cockpit moves to this workspace's own address and shows the dialog again. Select **Install app** once more.
5. Confirm the installation in your browser's dialog.

The app carries the workspace name. It uses the stored app icon or the SubKit icon and takes the color of the selected color palette.

### Install in Chrome, Edge and Safari

Your browser does the last step of the installation. It looks different in each browser.

| Browser | How it works |
| --- | --- |
| Chrome and Edge on a computer | Select **Install app** in the Cockpit and confirm the browser’s dialog. |
| Safari on a Mac | In Safari, open the “File” menu and choose “Add to Dock”. |
| Safari on iPhone and iPad | In Safari, tap “Share” and then “Add to Home Screen”. |
| Other browsers | You read “Installation unavailable”. Keep using the Cockpit in the browser, or open it in one of the browsers above. |

The **User menu** also offers **Install SubKit** as long as the app is not installed on this device. The entry opens the same guide.

Whether the app is installed is shown under **Settings › Your profile** at “Is SubKit installed on this device?”: **Installed** or **Not installed**, plus **Notifications on** or **Notifications off**.

### Without a connection and after an update

The app needs your server. It only keeps its program files, no data.

- **Without a connection** the app shows the page “No connection to the server” with **Try again**. You see no data then, and the app does not collect input to send it later.
- **After an update of the server** the notice “A new version is available” appears with **Reload**. Until then the open window keeps working with its previous state.
- **With unsaved input**, **Reload** does not reload. You read “Save your input first; reloading would discard it.” Save and select **Reload** again.

### Notifications, the number on the icon and links

- **Notifications.** You get one notification per open item. The title says what happened, for example “A decision is waiting for you”. The text says what to do, for example “Review the change and decide.” More than three at once are folded into “New entries need you”.
- **Click.** A click on the notification opens exactly this item in the app or brings the open window there.
- **Open window.** When the app is visible, no notification of the operating system appears. The notice is shown in the app instead.
- **Number on the icon.** The app icon carries the number of open items, at most 99. When nothing is open, it disappears. This only works where the browser and the operating system support it.
- **Links.** Links with the scheme `web+subkit` open a page in the app, for example `web+subkit://tasks` or `web+subkit://chat/{id}`. An unknown target leads to the start page.

“Notifications and quiet hours” describes how to decide when notifications arrive.

### Web app or SubKit Desktop

Besides the installed web app there is SubKit Desktop, a program of its own for macOS, Windows and Linux. Both show the same Cockpit of your server, and neither runs anything on your device.

| | Installed web app | SubKit Desktop |
| --- | --- | --- |
| Installation | From the browser, one app per workspace | One program, one profile per server |
| Devices | Computer and phone | Computer |
| Notifications | Push through the browser | Notifications of the operating system while the program runs |
| Quiet hours | Under **Settings › Setup** | In the settings of the program |
| Icon in the menu bar or the notification area | No | Yes, with the number of open items |
| Launch when you log in to your computer | No | Yes |
| Share content from other apps | Yes | No |
| Updates | Come with the server | The program’s own updates |

More in “SubKit Desktop”.

### Use several workspaces as separate apps

If you work in several workspaces, each one gets its own app.

1. In the regular Cockpit, switch to the next workspace from the workspace menu.
2. Install it as above through **Install this workspace**.
3. Start each app on its own. Each app only ever opens its own workspace.

Each app has its own sign-in. Your sign-in in the regular Cockpit stays untouched.

### Sign in and sign out in the app

1. To sign out, open the **User menu** in the app and choose **Sign out**.
2. To sign in again, start the app and choose **Sign in with work account**.
3. If that fails, sign in to the regular Cockpit and reopen the app there through **Install this workspace**.

**Sign out** only signs out this app, not your other apps and not the regular Cockpit.

### Set the branding of a workspace

1. Open **Settings** and, under **Working with sk**, the **Workspace branding** section.
2. Under **App icon (1:1)**, upload a square PNG with at least 512 pixels per side.
3. Under **Color palette**, choose **Standard**, **Indigo** or **Teal**.

   ![Workspace branding settings of the fictional workspace Brennwerk with the organization name Brennwerk, the subtitle Logistik, the dark teal app icon with an orange flame, the light and dark logo, and the Teal palette selected; the sidebar shows the same logo and wordmark](images/cockpit-app-branding.en.webp)

4. Check the preview and select **Save changes**.

Without both permissions you can only view the branding.
The app name comes from the workspace name, not from the **Organization name** in the branding.
**Reset branding** restores the SubKit look for all members.

### Remove an installed app

1. Open the regular Cockpit in the browser and switch to the app's workspace.
2. Choose **Revoke installation** in the workspace menu and confirm. This signs the installed web app out at once. Desktop devices stay signed in; you sign them out under **Settings** › **Your profile** › **Where are you signed in?**.
3. Then remove the app from your device like any other app.

If you install again later, the app gets a new address. Old links stop working.

### Good to know

- To get notifications, open **Notifications** in the app and turn on **Enable neutral notifications**. The alerts contain no workspace or workflow details.
- Text and files you share with the app only reach the **Inbox** after you confirm them. This neither turns them into knowledge nor starts a workflow.
- Your browser or operating system may keep showing an installed app's name and icon after you sign out.

### If something does not work

| What you see | What to do |
| --- | --- |
| "Installation unavailable" | Keep using the Cockpit in the browser, or open it in a browser that can install web apps. |
| "Installed apps require an existing OIDC account to sign in again. …" | Sign in to the regular Cockpit and reopen the app there through **Install this workspace**. |
| "Browser permission was denied. Allow notifications in your browser settings." | Allow notifications for the Cockpit address in your browser settings. |
| "Open the app, sign in and share again." | Start the app, sign in and share the content again. |
| "Use a still PNG, JPEG or WebP up to 2 MiB and 4 megapixels." | Upload a square PNG of at least 512 pixels per side and at most 2 MiB as the app icon. |
