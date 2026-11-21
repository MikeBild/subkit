---
slug: reference-local-steps
title: Reference: workflow steps on your device
summary: Look up the body of every local step for files, browser and computer, and what the approval of such a workflow binds.
section: reference
order: 9
audience: public
---
## Reference: workflow steps on your device

A workflow can read and write files in folders you allowed on your Mac, work in a website you allowed, and act in an app you allowed. Each such step is an ordinary `request` step on a device connector.
This page lists the step bodies and the rules of the approval. It is for people who write workflows by hand and for developers who build on them.

### Device connectors

When SubKit Desktop is connected and you turn a capability on in Settings › Local capabilities, SubKit creates one connector per capability for that device, for example “MacBook Pro (Mike): Files”, “MacBook Pro (Mike): Browser” and “MacBook Pro (Mike): Computer”. The name uses the language of SubKit Desktop on that device, German or English, and English otherwise. A connector keeps its name when the language changes later. They have the driver `local_files`, `local_browser` or `local_computer`, `config: {device_id}` and no credential.
Bind a step to one of them with `connector_id`. When you disconnect the device, its connectors stay, switched off, so existing workflows show what they used.

### Path and method

| Field | Meaning |
| --- | --- |
| `path` | The action, for example `/files.write`, `/browser.open` or `/computer.type`. |
| `method` | `GET` for an action that only reads, `POST` for an action that changes something. A step whose method does not fit its action is refused before anything is sent. |
| `body` | The fields of the action, directly in `body`. |

Reading actions: `files.list`, `files.read_text`, `browser.snapshot`, `browser.wait`, `browser.extract`, `browser.screenshot`, `computer.apps`, `computer.snapshot`, `computer.screenshot`.

### Files

`folder_id` is the id of a folder you allowed on the device. `path` is relative to that folder.

| Action | Body | Result |
| --- | --- | --- |
| `files.list` | `{folder_id, path?}` | `entries`, `truncated`, `omitted` (at most 500 entries). |
| `files.read_text` | `{folder_id, path}` | `text`, `size`, `sha256` (at most 256 KiB). |
| `files.import` | `{folder_id, path, name?}` | A SubKit file the next steps can use: `file`, `filename`, `content_type`, `size_bytes`, `file_id`, `sha256` (at most 90 MiB). |
| `files.write` | `{folder_id, path, content, replace?}` | `size`, `sha256`, `replaced`, `previous_in_trash`, versions. `content` is text or `{encoding: "base64", data}`; at most 10 MiB. |
| `files.mkdir` | `{folder_id, path}` | – |
| `files.move` | `{folder_id, to_folder_id?, path, to_path}` or `{folder_id, to_folder_id?, items: [{from, to}]}` | One result per item, at most 200. |
| `files.trash` | `{folder_id, path}` or `{folder_id, paths: [...]}` | One result per item, at most 200. |

A move or trash step succeeds only when every item was done. Replaced and removed files go to the Trash. Hidden files, secret files such as keys, and programs are always refused.

### Browser

| Action | Body |
| --- | --- |
| `browser.open` | `{url}` on a website you allowed. |
| `browser.press` | `{action: "click", element}`, `{action: "key", key}` or `{action: "scroll", direction, pixels?}` |
| `browser.fill` | `{mode: "fill" or "type", element, text}` or `{mode: "select", element, values}` |
| `browser.wait` | `{for: "load", state?}`, `{for: "text", text}` or `{for: "ms", ms}` (at most 30 s) |
| `browser.extract` | `{element?}` returns the text of the element or the page. |
| `browser.snapshot`, `browser.screenshot` | `{}` |
| `browser.download` | `{element, folder_id, name}` saves into a folder with write access. |

`browser.pdf` and `browser.handover` are not available in workflows yet.

### Computer

`app_id` is the bundle ID of an app you allowed, for example `com.apple.iWork.Numbers`. SubKit acts in the app's window that has focus, otherwise in its first window.

| Action | Body |
| --- | --- |
| `computer.apps` | `{}` lists the windows of allowed apps. |
| `computer.snapshot`, `computer.screenshot` | `{app_id}` |
| `computer.press`, `computer.focus` | `{app_id, element}` |
| `computer.type` | `{app_id, element, text}` |
| `computer.set_value` | `{app_id, element, value}` |
| `computer.select` | `{app_id, element, option}` |
| `computer.scroll` | `{app_id, element, direction, amount}` |
| `computer.key` | `{app_id, keys}`, for example `"cmd+s"` |

### Elements

Name an element as `element: {role, name, nth?}`, for example `{role: "button", name: "Download"}`. `nth` picks among several elements with the same role and name, starting at 0. Refs like `e12` are not allowed in a workflow: they change with every snapshot. SubKit takes a fresh snapshot right before each such action and finds the element there. If no element or more than one element matches, the step fails with `element_not_found` or `element_ambiguous` and nothing is changed.

### Screenshots

A screenshot is redacted on the device: password fields and fields marked as sensitive are blacked out. The step result keeps only `screenshot_ref`, the SHA-256 of the PNG. The image itself is kept encrypted with the device's answer for 30 days and then deleted.

### Approval and growth

- The approval names the device and, for each local step, the folders with read or write access, the websites and the apps the step uses. An import only reads its folder.
- Write `folder_id`, `to_folder_id`, `url` and `app_id` as fixed values. A placeholder there leaves the workflow unapprovable. A value that is only filled in while the run goes and that the approval does not name is refused with `outside_boundary`.
- A workflow with a device is approved on that device.
- A new version needs a new approval when it adds a folder, needs write access where reading was approved, adds a website or private address, or adds an app. Fewer items carry the approval forward.
- Browser and computer steps run only for the device's person: from their chat or task, a run they start, or a schedule they set up.
- A workflow that another workflow calls refuses local steps. Keep local steps in the workflow you approve and run.

### Errors

| Code | Means |
| --- | --- |
| `outside_boundary` | The step goes beyond the approval. Review and approve it again on the device. |
| `outside_allowance`, `origin_not_allowed`, `private_address` | The device does not allow this folder, website or app. |
| `folder_changed` | The allowed folder was replaced. Allow it again and renew the approval. |
| `permission_missing` | A macOS permission is missing (Accessibility or Screen Recording). |
| `kind_not_ready` | This action is not available in workflows yet. |
| `local_method_mismatch`, `local_step_invalid` | Method or body do not fit the action. |
| `files_partly_done` | Not every item of a move or trash was done; the result lists each item. |
| `screenshot_unverified` | The screenshot does not match its hash. It was not kept. |

Every error comes with a remedy in `guidance`.
