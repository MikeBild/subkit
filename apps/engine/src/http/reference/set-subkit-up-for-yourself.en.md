---
slug: set-subkit-up-for-yourself
title: Set SubKit up for yourself
summary: Answer six questions and decide how SubKit works for you.
section: work
order: 13
audience: public
---
## Set SubKit up for yourself

This chapter is for anyone who comes to the Cockpit for the first time or wants to change their defaults.
Afterwards you have answered the step “How SubKit works for you” and know what each of the six answers sets and where you change it later.

### What you need

- An account in a workspace with the Administrator or Member role. The step only appears with the `settings:write` permission. Users with the User role never see it.
- Two minutes. Every question has a recommended answer.

### Answer the step “How SubKit works for you”

The step appears once, after your first sign-in to a workspace.

1. Read the question and choose an answer. Under **Settings** › **Setup**, the line “Sets: …” says what each answer does. The recommended answer carries the addition **recommended**.
2. Select **Continue** until all six questions are answered.
3. Check the summary “This is what I will set up for you”. **Change** corrects a single answer.
4. Select **Apply these**.

**Not now** skips the step. SubKit then applies the recommended settings and does not ask again.

### The six answers and what they set

| Question | Choices | Sets |
| --- | --- | --- |
| “What should SubKit do for you first?” | **File invoices**, **Daily numbers by email**, **Summarize the week**, **List open tickets**, **Watch the pricing page**, **Unlock access after payment** or **Something else** with your own text | The first suggestion in chat and the first item of “First steps”. |
| “Which services do you use for it?” | Gmail, Google Drive, Google Sheets, Slack, Jira, GitHub, Notion, HubSpot, Stripe or **Other service** | Which connectors “First steps” offers first. |
| “Who approves what SubKit may do?” | **Me** (recommended), **Someone else on the team** or **Two of us: one builds, one approves**, each with an email address | Who gets approval notifications, whether an invitation is prepared and, for two of us, whether every workflow approval needs two people. |
| “How much should SubKit do on its own in chat?” | **Always ask**, **Ask only when unexpected** (recommended) or **Plan only at first** | The chat mode **Ask**, **Automatic** or **Plan only** for new conversations. |
| “Where should new things run first?” | **Test first** (recommended) or **Straight to production** | The default environment for new workflows and tasks. |
| “When may SubKit notify you?” | **Right away** (recommended), **Only during my working hours** or **Once a day as a summary** | Notifications and quiet hours. |

The first two answers only change what the Cockpit suggests to you first. They connect no service and create no workflow. The other four change how SubKit works:

- **Chat mode.** Every new conversation starts in this mode. In the conversation you can choose another one at any time. “Chat modes and rules” explains what the modes mean.
- **Default environment.** A new task and the review of a new workflow start in this environment. You still choose the environment of a single workflow or task yourself.
- **Approvals and notifications.** Both are described in “Notifications and quiet hours”.

### Two of us: one builds, one approves

With this answer, every workflow approval in the workspace needs two different people. The first person approves, the approval waits, and only the approval of a second person who may approve lets the workflow run. Nobody can approve alone, also not in chat or through a task.

- Only an administrator switches this on. If you are not one, you read that an administrator has to switch it on.
- It needs at least two people who may approve. If the named person has not joined yet, two-person approval starts by itself once they have joined.
- A waiting approval ends after 72 hours. It also ends when the workflow changes before the second approval.
- Choosing **Me** later does not switch two-person approval off. Only an administrator switches it off again, and that is recorded in the audit log.

“Reference: pair approval, invitations, offline reports and notification pause” lists the routes and states.

### Change answers later

1. Open **Settings** and, in it, **Setup**.
2. Select **Change** on the answer you want to change.
3. Choose the new answer and then **Apply**. You read “Setting applied”.

Each change applies right away to the setting named. Open conversations keep their mode; the new chat mode applies to the next new conversation.

The overview of **Settings** shows your choice in one line, for example “Ask only when unexpected · Test first · Right away”.

### Good to know

- The answers belong to you, not to the workspace. Every person sets SubKit up for themselves.
- The audit trail records every change as “Setup choices changed”.
- The recommended values are: **Automatic**, **Test**, **Me** and **Right away**.
- If you, as an administrator, name an address that is not in the workspace yet, SubKit prepares an invitation and sends no email. The invited person joins the workspace as a member; that is why “Role: Member” is shown next to the field. This role may approve.
- If you name a person whose role may not approve, SubKit stores the choice and warns under **Settings** › **Setup**: “… cannot approve with the current role. Approval notifications stay with you until an administrator changes the role.”
- If you name an unknown address without the Administrator role, it is stored but nobody is invited. As soon as an administrator invites or adds the address, SubKit links your choice by itself; the notifications go to the person once they have joined.
- If you choose **Only during my working hours**, you enter your **Working days** besides **From** and **Until**. Monday to Friday are preset.

### If something does not work

| What you see | What to do |
| --- | --- |
| “The recommended settings were not saved” | Nothing was changed. **Continue without saving** lets you go on with the recommended settings. This browser remembers your choice; in another browser the step appears again. |
| “The setting was not applied” | Your earlier choice still applies. Try again. |
| “Your setup could not be loaded” | Select **Try again**. |
| “Enter a valid email address, for example anna@example.com.” | Check the address of the person who should approve. |
| “Choose at least one service.” | Choose a service or **Other service**. |
| The step does not appear | You already answered it or skipped it with **Not now**, or you lack `settings:write`. Your answers are under **Settings › Setup**. |

### The same over the HTTP API

`GET /v1/identity/me/setup` reads your answers. The field `unset` names what you have not chosen yet, and `recommended` the recommended values.
`PUT /v1/identity/me/setup` stores answers. Fields you leave out keep their value.

```bash
curl -s -X PUT "$SK_URL/v1/identity/me/setup" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"default_chat_mode":"ask","default_environment":"dev"}'
```

Every field is listed in “Reference: desktop app, rules, schedules and problem reports”.
