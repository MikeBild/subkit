---
slug: notifications-and-quiet-hours
title: Notifications and quiet hours
summary: Decide when SubKit notifies you and who gets approval notifications.
section: work
order: 16
audience: public
---
## Notifications and quiet hours

This chapter is for anyone who wants to hear from SubKit when something waits for them, but not at any hour.
Afterwards you can switch on notifications on a device, limit them to your working hours or to one delivery a day, and route approval notifications to another person.

### What notifies you

SubKit only reports what a person is needed for: something was stopped, something is failing or a decision is waiting.

| Way | What you get | Delayed by quiet hours |
| --- | --- | --- |
| The **Needs you** list on the **Overview** | Every open item with cause and action. | Never. The list is always current. |
| Push in the browser or in the installed web app | One notification per item. A click opens the item. | Yes, according to your choice in **Setup**. |
| SubKit Desktop | A notification of the operating system and the number on the icon. | According to the quiet hours you set in the app. |
| Subscriptions, webhooks and the `subkit` inbox | Events for programs and for the terminal. | Never. |

A notification says what happened and what to do. Names of workflows or connectors, content and approval buttons never appear in a browser push.

### Switch on notifications on a device

1. Open **Settings** and, in it, **Your profile**.
2. Under “Do you want notifications on this device?”, switch on **Notify on this device**.
3. Allow the notifications in your browser’s dialog.

The setting applies to this browser only. Repeat it on every device where you want notifications.
Above it, “Is SubKit installed on this device?” shows whether the app is installed and whether notifications are on. “Cockpit as an app” describes how to install.

### Decide when SubKit notifies you

1. Open **Settings** and, in it, **Setup**.
2. Select **Change** on **Notifications**.
3. Answer “When may SubKit notify you?” and select **Apply**.

| Choice | What happens |
| --- | --- |
| **Right away** | Push arrives as soon as an item is new or changes. This is the default. |
| **Only during my working hours** | You enter **From** and **Until**, preset to 08:00 and 18:00. Below that you choose your **Working days**; Monday to Friday are preset, and at least one day has to be chosen. Outside this time and on the other days SubKit holds push back until the next start. A period across midnight is possible and belongs to the day it starts on. |
| **Once a day as a summary** | You enter **At**, preset to 08:00. SubKit delivers at most once a day, as soon as this time is reached. |

What happens while push is held back:

- Nothing that is still open gets lost. At the next delivery SubKit reports every new item that is still open then.
- SubKit no longer reports what was settled in the meantime.
- At the daily time and at the start of your working hours, more than one new item arrives as a single summary, such as “5 items need you” with “2 failing, 3 decisions”. It opens the newest item. A single new item arrives as the usual notification.
- If nothing new is open at the daily time, no message is sent.
- The **Needs you** list shows everything at once, whatever you choose here.

You can change the same choice under **Settings › Notifications** too. **Quiet hours** with **From** and **Until** holds push back outside your working hours: **From** is the end of your working hours, **Until** their start. **Daily summary** with its time switches on the summary. Under **More options** you find **Notify on** for your working days, **Critical items may break through quiet hours** and **Time zone**, as soon as quiet hours or the daily summary are on.

### Which time zone applies

The times apply in the time zone of the workspace. It is set under **Settings › Workspace** at “Which time zone do you work in?”. Scheduled runs follow the same time zone.

If you work in a different time zone than your team, you can store your own: in **Setup** in the question on **Notifications** at **Time zone**, or under **Settings › Notifications › More options** at **Time zone**. The field appears as soon as you choose working hours or the daily summary. Over the HTTP API it is the field `timezone`, see below.

### Pause notifications

Pause notifications for a while, for example during a meeting, without changing your schedule.

1. In SubKit Desktop, open the menu bar icon and select **Pause notifications for 1 hour**. In the Cockpit, open **Settings › Notifications**.
2. To end the pause early, select **Resume notifications**.

During the pause, SubKit sends no push notifications and shows no desktop banners. The **Needs you** list and its count keep updating. Urgent items still reach you if you switched them on. The pause applies on all your devices at once: the desktop app, the Cockpit and the installed web app read the same state. A pause with an end lasts at most 30 days. **Until resumed** has no end and lasts until you select **Resume notifications**.

### Get urgent items despite quiet hours

Two kinds of items count as critical:

- A workflow in production was stopped.
- A stored secret can no longer be read.

By default these items wait for your next delivery too. With the setting `critical_breakthrough` they arrive at once, also outside working hours and before the daily delivery. In the Cockpit you switch it on in the same question or under **Settings › Notifications › More options** with **Critical items may break through quiet hours**; the HTTP API works too, see below.

### Route approval notifications to another person

If another person on your team approves what SubKit may do, route the notifications about it to them.

1. Open **Settings › Setup** and select **Change** on **Approvals**.
2. Answer “Who approves what SubKit may do?” with **Someone else on the team** and enter the **Email address**.
3. Select **Apply**. The row **Approvals** then shows the person.

What applies then:

- It affects the items that need an approval: a version waits for approval, a schedule waits for an approval, an approval or a standing permission ends soon or is missing.
- These items no longer trigger a push for you. The other person gets it when they are an active member of the workspace and may give the approval themselves. If they may not, the push stays with you.
- A prepared invitation carries the role **Member**. This role may approve.
- The items stay in your **Needs you** list, with “Waiting for approval from …”. If the person may not give the approval, that line is missing and the item stays your decision.
- If the person is not in the workspace yet, everything stays with you until they have joined.

What you read below the choice:

| What you read | Meaning |
| --- | --- |
| “… is in this workspace.” | The notifications go to this person. |
| “An invitation for … is prepared and not accepted yet.” | The notifications stay with you until the person accepts the invitation. |
| “… is not in this workspace yet. An administrator has to invite this address first.” | Ask an administrator for the invitation, or select **Open People** if you are one. As soon as the address is invited, your choice applies by itself; you do not have to make it again. |
| “… cannot approve with the current role. Approval notifications stay with you until an administrator changes the role.” | Ask an administrator to give the person the role **Member** or **Administrator**, or name someone else. |
| “Invitation prepared” | You are an administrator and named an unknown address. SubKit prepared an invitation and sent no email. Pass on the **Invitation link** yourself. It is shown only once. |

### Decide from Slack

When a notification rule posts to a Slack channel, items that need a decision arrive as a card.

| Item | Buttons in Slack |
| --- | --- |
| A task run waits for your approval | **Approve**, **Decline**, **Open in SubKit** |
| The result of a task run waits for you to confirm it | **Open in SubKit** |
| The approval of a workflow expires soon | **Open in SubKit** |

Confirming a result and approving a workflow need a signed-in session in the Cockpit, so these cards link there.

What happens when you select **Approve** or **Decline**:

1. SubKit checks that the click comes from Slack: the signature made with the app’s signing secret and a timestamp no older than five minutes. A click that arrives twice counts once.
2. SubKit looks up the person your Slack account is linked to. If it is not linked yet, only you see a message with **Link Slack account** and **Open in SubKit**. To link it, select **Link Slack account**, sign in, check the Slack account shown and select **Link account**. You do this once.
3. SubKit checks at the moment of the click whether this person may decide: an active member with the permission `conversation:approve` or `workflow:write`, and for a task run its owner or an administrator. If not, only you see “You don’t have permission to decide this. Nothing was changed.”
4. SubKit records the decision in the audit log with the source `slack`, the Slack user ID and the SubKit person.
5. The message changes for everyone in the channel: it names the outcome, who decided and when. A later click shows the state, for example “Already approved.” or “The deadline has passed. Nothing was changed.”

**Open in SubKit** always works, with or without a linked account.

#### Set up the Slack app

The Slack app of your chat workspace needs these settings:

| Setting | Value |
| --- | --- |
| **Interactivity & Shortcuts › Request URL** | `https://<your SubKit address>/v1/chat/slack/interactions`, the same URL that already serves questions in chat |
| **OAuth & Permissions › Bot token scopes** | `chat:write` to post and update cards; `chat:write.public` if SubKit posts to channels the app was not added to |
| **Basic Information › Signing Secret** | the value of `platform.slack.signing_secret` in SubKit |

SubKit builds the links from `server.public_base_url`. Without it, the cards carry no **Open in SubKit** and no **Link Slack account** button. An administrator can also link accounts with `POST /v1/chat/identities`.

### Limits

- **The choice applies to push, not to the desktop app.** SubKit Desktop reads the list directly and follows the quiet hours you set in the app. More in “SubKit Desktop”.
- **The summary only names the count per kind.** The **Needs you** list shows which items they are.
- **A person without the right to approve gets no notifications.** If the person named is an active member but may not give the approval, the push stays with you, and **Settings** › **Setup** warns you. Your **Needs you** list then does not name the person, and the item stays your decision. Name a person who may approve.
- **The Cockpit does not show whom an item waits for.** The API returns the field `waiting_on` for it.
- **Messages already sent cannot be taken back.** When you switch to working hours, it applies from the next check on.

### If something does not work

| What you see | What to do |
| --- | --- |
| “Browser permission was denied. Allow notifications in your browser settings.” | Allow notifications for the Cockpit address in your browser settings. |
| No push arrives although something is open | Check **Quiet hours** and **Daily summary** under **Settings › Notifications**. Outside working hours and before the daily time, SubKit holds push back. |
| Push arrives at the wrong hour | Check the time zone of the workspace under **Settings › Workspace**. |
| “Enter a time such as 08:00.” | Write the time with four digits and a colon. |
| “The setting was not applied” | Nothing was changed. Your earlier choice still applies. Try again. |
| The other person gets no approval notifications | Check that they are a member, have push switched on on their device and may approve. |

### The same over the HTTP API

`GET /v1/identity/me/setup` reads your choice, `PUT /v1/identity/me/setup` changes it. Fields you leave out keep their value.

```bash
curl -s -X PUT "$SUBKIT_URL/v1/identity/me/setup" \
  -H "Authorization: Bearer $SUBKIT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"notifications":{"mode":"working_hours","from":"08:00","to":"18:00","days":[1,2,3,4,5]},"timezone":"Europe/Berlin","critical_breakthrough":true}'
```

Every field is listed in “Reference: desktop app, rules, schedules and problem reports”.
