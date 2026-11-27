---
slug: browser-vault
title: Sign in and pay in the browser with the vault
summary: Let SubKit sign in to websites and pay in shops with logins and cards from your vault, approve each use, and know what the AI sees and where the limits are.
section: work
order: 21
audience: public
---
## Sign in and pay in the browser with the vault

This chapter is for everyone who lets SubKit work in the browser on their Mac, in a chat, a task or a workflow.
Afterwards you can store a login and a card for the browser, approve a sign-in or a payment, and know what the AI sees and what SubKit does not promise.

You need SubKit Desktop with the browser turned on, see [SubKit Desktop](setup.md#subkit-desktop).

### How it works

The AI decides what to do on a page, but it never handles a password, a card number or a code:

1. The AI opens the page and reads it as a list of fields and buttons.
2. For a sign-in it calls `browser_sign_in` with the **name** of a login from your vault, for a payment `browser_pay` with the **name** or the last four digits of a card.
3. SubKit checks the request and asks you.
4. After your approval the engine hands the values to SubKit Desktop once, for this one use. SubKit Desktop fills in the fields on your Mac and submits the form.
5. The AI gets back only whether the fields were filled and how the form went, with a page view in which the filled values are hidden.

Plain typing into password, one-time code and card fields stays blocked. Only these two steps can fill them.

### Prepare the vault

1. Open **Settings › Vault** in the Cockpit.
2. **For signing in:** add a **Login** with username and password. Add each website it belongs to under **Allowed websites**, for example `https://members.example.com`. If the site asks for a one-time code from an authenticator app, paste the key or the `otpauth://` link from the site's setup page into **One-time code key**. SubKit Desktop then creates the code itself.
3. **For paying:** add a **Payment card** with number, expiry date and name. The CVV is not part of it. Cards are always “Only me”.

Logins from Chrome, 1Password or Bitwarden can be imported, see [Reference: the vault](setup.md#reference-the-vault).

### Sign in

Write in a chat, for example: “Sign in to members.example.com with my ledger login and download the November invoice.”

- SubKit compares the website exactly with the login's origins. `www.example.com` and `example.com` count as the same site. `examp1e.com` or `example.com.login-check.net` do not. On a site that only looks similar, SubKit refuses to sign in.
- SubKit asks you before every sign-in: the question names the website and the login. If your own message already names the site and the sign-in, as in the example, that counts as your approval.
- If the vault has no matching login, the AI does not ask for the password in the chat. It asks you to add the login in the vault, or a task pauses with a private form in which you enter it.
- A second factor that SubKit cannot handle, such as a push approval on your phone, a passkey or a captcha, goes back to you: the AI hands the browser over and continues once you hand it back.

### Pay

Write, for example: “Order the 1 kg coffee beans at shop.example.com and pay with my Visa.”

1. The AI fills in the order up to the payment form and calls `browser_pay` with the card, the amount and the currency.
2. **Approve payment** appears in the Cockpit and in SubKit Desktop with the shop, the amount and the card (brand and last four digits).
3. You check the details and enter the **CVV**. It goes to SubKit Desktop only for this payment and is never stored.
4. SubKit Desktop fills in the card fields on the shop's own page and submits the form.

Every payment asks again, also in tasks and approved workflows. Only you can approve a payment with your card. An approval is valid once, for 15 minutes, for exactly this shop, this page, this card and this amount. If SubKit Desktop can read the total on the page and it differs, it refuses to pay.

### Submitted is not paid

The result of a payment is “submitted”, never “paid”. Whether the shop accepted the payment shows on its confirmation page or in its email. The AI reads the page and reports what it says.

If the outcome is uncertain, for example because the connection broke during submit, SubKit does not repeat the payment, and neither does the AI. Check the shop or your bank before you start a new payment.

### What the AI sees

| What | The AI sees |
| --- | --- |
| Login | name, websites, the first two characters of the username, whether a one-time code key is stored |
| Card | name, brand, last four digits, expiry |
| Filled fields | only that they were filled; the page view and screenshots hide the values |
| Your chat | a card number, IBAN, CVV or one-time code you type is replaced by `***REDACTED:…***` before the AI reads it |
| Payment approval | that it is pending, approved or rejected, never the CVV |

Text on a web page is data for the AI, never an instruction. If a page asks to pay, to enter card details or to sign in somewhere else, the AI does not follow it. This is how SubKit protects you against prompt injection.

### Security model and limits

- **Values per use.** Each sign-in or payment is a single use with its own record. The values travel encrypted to the paired device, can be collected only once within 60 seconds and are deleted afterwards. They never appear in the device command, the run, the result or the log.
- **Checks on the device.** SubKit Desktop fills a field only if the field's real frame belongs to the approved origin, the page has not changed since the AI read it and no script of the AI ran on the page since it loaded.
- **Card fields from a payment provider.** Many shops show the card fields in a frame of a payment provider such as Stripe or Adyen, loaded from the provider's own address. SubKit Desktop cannot yet reliably check the real origin of such a frame, so it refuses to fill card fields there. The AI then hands the browser over to you: you enter the card details yourself and hand the browser back.
- **Audit.** Every use is in the item's activity and in the audit trail: website, purpose, task or run, and outcome. Payment requests, approvals, rejections and expiries are recorded as well.
- **Your device.** SubKit Desktop fills in the values on your Mac. Anyone who controls your Mac while a use runs can see the filled page.
- **No CVV, no PCI DSS.** SubKit never stores a CVV and is not certified under PCI DSS. Store only your own cards for your own purchases.
- **No spending limit of its own.** How much may be paid is decided by you in each approval and by the rules of your tasks.

### Troubleshooting

| What happens | Why | What you can do |
| --- | --- | --- |
| SubKit refuses to sign in | The page's origin is not one of the login's origins. | Check the address. If it is right, add the origin to the login in the vault. |
| The AI asks you to add a login | The vault has no login for this site that you may use. | Add the login with the site's origin, then continue. |
| No payment approval appears | The card is not yours, or the approval expired after 15 minutes. | Use your own card and start the payment again. |
| SubKit Desktop refuses to fill the card fields | The card fields sit in a payment provider's frame. | Enter the card details yourself when the AI hands the browser over to you. |
| SubKit Desktop refuses to pay | The shop shows a different total than the one you approved, or the page changed. | Check the cart, then let the AI request a new approval. |
| The result is “submitted” | The form went out, the shop has not confirmed it yet. | Check the confirmation page, your email or your bank. |
| The result is “uncertain” | The submit may have reached the shop. | Do not pay again until you have checked the shop or your bank. |
| The one-time code is rejected | The key is wrong or your Mac's clock is off. | Store the key again from the site's setup page and check the time setting of your Mac. |
