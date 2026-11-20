---
slug: subkit-desktop
title: SubKit Desktop
summary: Use your server's Cockpit as a program with an icon in the menu bar and notifications.
section: work
order: 18
audience: public
---
## SubKit Desktop

This chapter is for anyone who wants to keep an eye on SubKit all day without keeping a browser tab open.
Afterwards you have connected SubKit Desktop to your server, signed in and set up notifications, quiet hours and the launch at login.

### What SubKit Desktop is and is not

SubKit Desktop is a window onto your server’s Cockpit. It brings three things a browser tab does not have: an icon in the menu bar or the notification area with the number of open items, notifications of the operating system and the launch when you log in to your computer.

| SubKit Desktop does | SubKit Desktop does not |
| --- | --- |
| Show your server’s Cockpit, with the same permissions as in the browser. | Run workflows or tasks on your computer. Everything runs on the server. |
| Report what needs you, also when the window is closed. | Work without a connection to the server. It keeps no data locally. |
| Remember several servers as profiles. | Store an API key or a password. The sign-in is a session as in the browser. |
| Open outside links in your system’s browser. | Load other websites in its window. |

The table in “Cockpit as an app” shows how it differs from the installed web app.

### What you need

- A SubKit server of version 11.2.0 or later. Older servers do not offer the app’s sign-in.
- The address of the server, for example `subkit.example.com`. It has to be reachable over `https://`; only `localhost` may use `http://`.
- An account you can sign in to the Cockpit with in the browser.
- SubKit Desktop itself. There is no installer to download yet: the app for macOS, Windows and Linux is available with the public release of SubKit. Until then you use the Cockpit in the browser or as an installed web app; that works today (“Installed Cockpit sessions”).

### Connect to a server

1. Start SubKit Desktop. You see “Connect to SubKit”.
2. Enter the address of your server under **Server address** and select **Check server**.
3. Read the result. With “Found SubKit …. You can sign in.” everything fits.

The app checks whether a SubKit server answers at the address and whether the versions fit together: the server has to be new enough for the app, and the app new enough for the server.

### Sign in in the browser

The sign-in happens in your browser, not in the app. That way you use the sign-in you already know, and the app never sees your password.

1. Select **Sign in in the browser**. Your browser opens, and the app shows “Your browser is open. Sign in there and you’ll continue here automatically.”
2. Sign in to the Cockpit in the browser if you are not signed in there yet.
3. Read the page “Sign in to SubKit Desktop”. It names your computer, the workspace and the account, for example “SubKit Desktop on MacBook-Anna is asking to sign in to Brennwerk.” and “Signed in as anna@example.com”.
4. Select **Sign in**. Continue only if you just started this sign-in yourself in the app on this device.
5. The browser hands back to the app. The app shows “Finishing sign-in…” and then opens the Cockpit.

With **Cancel** on the page in the browser or **Cancel sign-in** in the app, nothing happens: no profile and no device is created.
The page in the browser is valid for 10 minutes. After that, start the sign-in again in the app.

### Devices and signing out

Every computer on which you sign in with SubKit Desktop is a device of its own with its own session. The server lists it under the name of the computer. When you sign in again on the same computer, it stays the same device.

- **Sign out** in the **User menu** of the Cockpit ends the session of this device. Your session in the browser and other devices stay signed in.
- **Remove** in the list **Your servers** deletes the local session and the profile. Nothing changes on the server.
- **Revoking a device** signs it out from outside, for example after a loss. Within a few seconds the app then shows “This device was signed out in SubKit. Sign in again to reconnect it.”

You see your devices in the Cockpit under **Settings** › **Your profile** › **Where are you signed in?**. The list shows the installed web app and every desktop device with its kind, name, the day it signed in and its last use. The device you are sitting at carries the mark **This device**.

1. Open the Cockpit in the browser and there **Settings** › **Your profile**.
2. Select **Revoke** at the device.
3. Confirm. The dialog names the device and says what happens: it is signed out at once and no longer receives notifications; other devices stay signed in.

In the app itself and in the installed web app you see the same list, but there you can only sign out **This device** with **Sign out**. You revoke another device in the browser.

**Revoke installation** in the workspace menu only concerns the installed web app. The dialog says so: desktop devices stay signed in.

### How long you stay signed in

| Rule | Value |
| --- | --- |
| Without use | 30 days. Any use of the app, also in the background at the tray icon, starts the period again. |
| At most | 90 days since the sign-in, even with daily use. After that you sign in again in the browser. |
| After a revocation or **Sign out** | Ended at once. |

When the session expires you read “Your session expired. Sign in again; your settings are kept.” Shorter periods apply to the browser and the installed web app: 8 hours without use, 24 hours at most.

### Icon, notifications and quiet hours

When you close the window, SubKit Desktop keeps running. The icon in the menu bar or the notification area shows the number of open items.

| Entry in the icon’s menu | What it does |
| --- | --- |
| **Open SubKit** | Brings the window to the front. |
| **Needs you (3)** | Opens the list of open items. When nothing is open, it reads “Nothing needs you right now”. |
| **Pause notifications for 1 hour** | Holds notifications back for an hour. **Resume notifications** ends the pause. |
| **Launch at login** | Starts SubKit Desktop with your computer, without opening a window. |
| **Check for updates** | Looks for a new version of the app. |
| **Report a problem…** | Opens the dialog from “Report a bug”. |
| **Quit SubKit** | Quits the app. No notifications arrive after that. |

A notification says what happened and what to do, for example “‘Daily report’ is waiting for your decision” and “Review the change and decide.” Unlike the push in the browser, it names the item. A click opens exactly this item in the window.

- A new item is reported within about a second, after a minute at the latest.
- When several items arrive at once, the app shows at most three notifications. You see the rest in the number on the icon.
- What is already open when the app starts is not reported again.

You set quiet hours in the app:

1. Open **Settings…** in the app menu or press ⌘, (on Windows and Linux Ctrl+,).
2. Switch on **Quiet hours** and enter **From** and **To**. The presets are 22:00 and 07:00.
3. If you like, switch on **Launch when you log in to your computer** and choose German, English or **Same as system** under **Language**.

During quiet hours and during a pause SubKit keeps counting but shows no notifications. Quiet hours follow the clock of your computer.

### Several servers

If you work with several SubKit servers, each one gets its own profile with its own session.

1. In the **Servers** menu, select **Add server…** or press ⌘N.
2. Connect and sign in as above.
3. Switch between the profiles through the **Servers** menu or with **Open** in the list **Your servers**.

### Updates

Whether your app updates itself depends on how it was built. If **Settings** reads “Automatic updates are not enabled in this build.”, new versions come with the public release of SubKit; there is no download today.

When updates are enabled, the app checks at start and every six hours after that.

| What you read | What happens |
| --- | --- |
| “You’re on the latest version, ….” | Nothing to do. |
| “Version … is available. The download starts shortly.” | The app downloads the update in the background. |
| “Version … is downloaded. Restart SubKit to install it.” | Select **Restart now**. With **Later**, the update is installed the next time you quit. |
| “The update could not be verified and was not installed. …” | Your version stays as it is. Try again later. |

When the server requires a newer app, you read “The server requires at least version … of the app and you have ….” while connecting. Update SubKit Desktop then.

### Limits

- **Notifications only arrive while the app runs.** After **Quit SubKit** it reports nothing. For notifications without a running app, use the push of the web app.
- **What was new during quiet hours or a pause is not reported later.** You see it in the number on the icon and in the **Needs you** list.
- **The quiet hours of the app are its own.** The choice under **Settings › Setup** in the Cockpit applies to push in the browser, not to the app.
- **The app reports the items of the opened profile.** Other servers report only once you switch to them.
- **Only macOS has been exercised so far.** Links, the launch at login, the icon in the notification area and the number on the icon are built for Windows and Linux but not yet tested there end to end.
- **A screenshot for a problem report can contain secrets shown openly.** More in “Report a bug”.

### If something does not work

| What you see | What to do |
| --- | --- |
| “The server can’t be reached. Check the address and your internet connection.” | Check the address and whether you can reach the server in the browser. |
| “No SubKit server answers at this address. Check the address.” | Enter the address of the server, without `/cockpit` at the end. |
| “The address must start with https:// …” | Use the `https` address of your server. |
| “This server runs SubKit …. The app needs at least …. Ask your administrator to update the server.” | The server is too old for the app. Pass the message on to the person who runs it. |
| “The server requires at least version … of the app and you have ….” | Update SubKit Desktop. |
| “This server doesn’t offer the sign-in this app needs. …” | Update SubKit Desktop or ask the person who runs the server to check it. |
| The browser shows “This sign-in attempt expired or was already used. Please sign in again.” | Start the sign-in again in the app. |
| “The sign-in expired. Start it again.” | At most one minute may pass between **Sign in** in the browser and the return to the app. Start the sign-in again. |
| “The server rejected the sign-in. Start it again.” | Start again. If it stays that way, check that your account is active in the workspace. |
| “The browser couldn’t be opened. Try again.” | Check that a default browser is set up on your system. |
| Nothing happens in the app after **Sign in** in the browser | Allow the browser to open SubKit when it asks. If the app is no longer running, start it and begin again. |
| “Your session expired. Sign in again; your settings are kept.” | Select **Sign in**. Profile, quiet hours and language are kept. |
| “SubKit can’t be reached right now. The app keeps trying, and you can retry yourself.” | Wait or check your connection. The icon shows “No connection to the server”. |
| No notifications arrive | Check whether a pause or quiet hours are active and whether your operating system allows notifications for SubKit. |
