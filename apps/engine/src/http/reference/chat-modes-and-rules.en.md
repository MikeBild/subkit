---
slug: chat-modes-and-rules
title: Chat modes and rules
summary: Decide when SubKit asks in chat and what it may carry out without asking.
section: work
order: 14
audience: public
---
## Chat modes and rules

This chapter is for anyone who works in chat and wants to know when SubKit asks before an action.
Afterwards you can choose the mode of a conversation, read and answer a question card and save a recurring action as a rule.
You also know exactly under which conditions something runs without a question, and where this check has its limits.

### The three modes

Above the message field, **Mode** sets how much SubKit does on its own in this conversation.

| Mode | What it does |
| --- | --- |
| **Ask** | Asks before saving anything, before every action with an outside effect and before a live run that no approval covers. |
| **Automatic** | Prepares drafts and runs what you explicitly ask for. Everything else asks. |
| **Plan only** | Plans and proposes; asks like “Ask” before any step. |

**What does this mean?** next to the selection shows two lists for the chosen mode: **Asks first** and **Without asking**.

Three things apply in every mode:

- A live run of a workflow needs an approval. “Your first workflow” describes how you give it.
- Payments, deletions, publications, settings, new accounts and credentials always ask.
- **Plan only** is an instruction to the model, not a gate of its own. The same gates apply as in **Ask**.

You set the mode a new conversation starts with under **Settings › Setup**. In the selection, that mode carries the addition **(your default)**. More in “Set SubKit up for yourself”.

### When something runs without a question

In **Automatic** mode an action runs without a question only when all of the following conditions hold. If one is missing, the question card appears.

1. **You are signed in in the browser.** The rule applies only to you in a Cockpit session: in the browser, in the installed app or in SubKit Desktop. With an API key, in the `sk` command line, from an AI client over MCP and in a task run, each of these actions asks.
2. **It is a call to a connector.** The rule applies to calls that send, create or change something through a connector, and to saving a connector draft. Tools of external MCP servers and SQL statements always ask.
3. **SubKit knows the effect, and it is ordinary.** SubKit assigns every operation an effect. Payment, deletion, publication, permissions or settings, new account and credentials always ask. So does every call with `DELETE` and every call that sets a header with credentials. When SubKit cannot tell what an operation does, it asks.
4. **You asked for it in your own words.** Your latest message contains a request such as “Send …” or “Can you create …”. An information question such as “What would happen if …” is not a request. When the request carries a condition or a “not”, SubKit asks. The verb has to match the action: “create” does not cover sending.
5. **The request is not in pasted text.** These do not count as your words: code blocks, quoted lines, forwarded emails, everything after a lead-in such as “Here is the email:” and pasted passages of 5 lines or 800 characters and more. What a web page, a file or a service returns is never a request.
6. **You named the target.** Every recipient, every address and every target comes from your last three messages or from your answers to questions SubKit asked. If you gave a name, SubKit may have looked up the address for it in this conversation. You also have to have stated amounts, values, dates and times. SubKit reads dates and times in the time zone of the workspace.
7. **The content is yours.** A text that goes out consists of your words, or SubKit showed it to you as a draft earlier in the conversation. With your words, SubKit may add a greeting, a closing and a few filler words: at most a quarter of the words and never more than three. A new link, a new address, a new number or a new “not” leads to the question. A text of more than 1,200 characters has to have been shown as a draft.
8. **It is the first time for this request.** A request covers an action exactly once. A repeat of the same action asks.

One special case: when the action only creates a draft at the service, SubKit does not check the content, because nothing goes out yet.

When an action runs without a question, the conversation shows a line below it such as “Send to anna@example.com, because you asked for it”. **Show your words** shows the sentence SubKit relies on. The audit trail records each of these actions with the reason “The person asked for it in their own words” or “A rule the person saved covers it”.

### The question card

When SubKit asks, it shows a card titled **Wants to do this**.

| Field | Meaning |
| --- | --- |
| **Action** | What happens: Send, Create, Change, Run or Save. |
| **Target** | The operation at the service, for example `POST /v1/messages`. |
| **Account** | The connector the action goes through. |
| **Recipients** | Every address, link and handle the action reaches. |
| **Content** | The full text as it would go out. |

Below the fields the card says why SubKit asks, for example “You did not name this recipient.” Below that it reads: “Applies to exactly this action, once. A different recipient or content needs a new question.”

1. Read the fields, above all **Recipients** and **Content**.
2. Select **Allow once** if exactly this should happen. The action runs once.
3. Select **Decline** if not. Nothing runs.

Two things protect you from a slip:

- **Typed text never gives an approval.** If you type “yes” into the message field while a card is open, SubKit asks “Did you mean: Allow once?”. Nothing ran. Confirm with the button or select **No, keep the card open**.
- **A reply that changes the action runs nothing.** You then read “Your reply changes the action, so nothing ran”. Allow exactly what is shown, or select **Decline and rephrase** and send your changed request.

### Save an action as a rule

A rule allows exactly one recurring action without a question. You do not create it by hand: SubKit offers it when you have confirmed the same action with **Allow once** for the second time.

1. Confirm the action as usual. Below the card, “Should this run without asking from now on?” appears with the **Scope** of the rule.
2. Check the scope: action, target, account and recipients.
3. Select **Save as rule**. Or select **No, keep asking**; SubKit then does not offer this rule again.

A rule applies like this:

| Property | What applies |
| --- | --- |
| Scope | Exactly this action through exactly this connector to exactly this operation. With recipients: only to the recipients named. Without recipients: only actions without a recipient. At most 20 recipients. |
| Content | If the text was the same in both confirmations, the rule covers only exactly this text. If it differed, the rule covers only text you wrote yourself or saw as a draft. If the action carried no text, it covers only actions without text. |
| Duration | 90 days from saving. After that the action asks again. |
| Daily limit | 20 runs per day, counted in UTC. After that the action asks until the next day. |
| Mode | Applies in **Ask** and **Automatic**, not in **Plan only**. |
| Person | Applies only to you, signed in in the browser. Other people in the workspace have their own rules. |

Payments, deletions, publications, settings, new accounts and credentials can never be saved as a rule.

When an action runs because of a rule, the conversation reads “…, per your rule” with the link **Open rules**.

### View and revoke rules

1. Open **Settings** and, in it, **Rules**.
2. **Active** lists your rules with scope, date and use, for example “Last used …” and “Approved by hand 2 times before”. **Offered** lists rules you have not decided on yet.
3. Select **Revoke** on a rule and confirm.

After the revocation SubKit asks again before carrying out this action. Anything already sent stays sent.

When an action asks although a rule exists, the card names the reason:

| What you read | Meaning |
| --- | --- |
| “Your rule for this action has expired. Renew it under Rules.” | The 90 days are over. |
| “Your rule for this action has reached its limit for today.” | The action already ran 20 times today through this rule. |
| “Your rule covers a different text than this one.” | The text differs from what the rule covers. |

### Limits of this check

The check is strict on purpose and asks when in doubt. It still is not an understanding of your request. You should know this:

- **SubKit recognizes requests by words and sentence structure.** It knows German and English phrasings. An unusual phrasing or another language leads to the question, even if you meant it that way.
- **SubKit reads the effect from the operation.** It concludes from the method, the path, the field names and the connector template whether something is a payment, a deletion or a publication. If an operation has a harmless name at the service and still triggers something like that, SubKit does not notice.
- **SubKit checks what it sends, not what the service does with it.** If a service forwards a message to a list, SubKit only sees the address of the list.
- **A few added words can change the tone.** The content stays yours, but the greeting, the closing and up to three words come from SubKit.
- **A rule with changing text checks the origin, not the meaning.** It covers any text you wrote or saw as a draft, to the recipients named.
- **Renewing is not possible on the Rules page yet.** The page shows neither the expiry date nor the daily limit and offers no renewal. An expired rule asks every time, and SubKit does not offer it again. It can only be renewed through the route `POST /v1/approval-rules/{id}/renew` from a browser session.
- **The daily limit and the duration are fixed.** You cannot set them.

### If something does not work

| What you see | What to do |
| --- | --- |
| “This chat asks before every action with an outside effect.” | The conversation runs in **Ask** or **Plan only** mode. Select **Allow once** or set the mode to **Automatic**. |
| “You did not ask for this action in your own words.” | Write the request as a sentence of its own, for example “Send the summary to anna@example.com”. |
| “The request stands in pasted or quoted text, not in your own words.” | Write the request above or before the pasted text. |
| “Your request came with a condition or a ‘not’, so SubKit asks.” | Check the card and select **Allow once**, or phrase it without a condition. |
| “You did not name this recipient.” or “You did not name this target.” | Name the address or the target in your message. |
| “The action contains a value you did not state.” | Check the value on the card. State it yourself next time. |
| “The text is not yours and you have not seen it as a draft yet. Read it before it goes out.” | Read the **Content** on the card. Or ask for a draft first and then ask for it to be sent. |
| “SubKit does not know what this operation does, so it asks.” | This operation always asks. Check the card and decide. |
| “You asked for this once, and that already ran. A repeat asks again.” | If it should run once more, select **Allow once**. |
| “Only you, signed in in the browser, can let an action run without this question.” | You work with an API key or from another client. Open the conversation in the Cockpit. |
| “The rule was not saved. Nothing changed; SubKit keeps asking.” | Select **Save as rule** again. If it stays that way, check that you are signed in in the browser. |

### The same over the HTTP API

Rules belong to a person. A system account has none, and the routes answer it with `403 person_required`.

| Route | Does |
| --- | --- |
| `GET /v1/approval-rules` | Lists your offered and active rules. `?state=` filters by `offered`, `active`, `dismissed` or `revoked`. |
| `POST /v1/approval-rules/{id}/accept` | Stores an offered rule. Works only from a browser session. |
| `POST /v1/approval-rules/{id}/dismiss` | Declines an offered rule. It is not offered again. |
| `POST /v1/approval-rules/{id}/renew` | Renews an active rule for 90 days from now, also when it has already expired. Works only from a browser session. |
| `DELETE /v1/approval-rules/{id}` | Revokes an active rule. |

When the state of the rule does not fit the route, the engine answers `409 approval_rule_wrong_state`. Every field of a rule is listed in “Reference: desktop app, rules, schedules and problem reports”.
