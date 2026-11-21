---
slug: local-workflow-steps
scope: global
title: Workflow Steps On A Device
description: How to author request steps on a device connector (`local_files`, `local_browser`, `local_computer`): the path names the action, the body shape per action, elements by role and name instead of refs, and what the approval binds.
activates_when: [{"kind":"intent_keyword","word":"local_files"},{"kind":"intent_keyword","word":"local_browser"},{"kind":"intent_keyword","word":"local_computer"},{"kind":"intent_keyword","word":"this device"},{"kind":"intent_keyword","word":"on my mac"},{"kind":"intent_keyword","word":"local folder"},{"kind":"intent_keyword","word":"auf meinem mac"},{"kind":"intent_keyword","word":"auf diesem gerät"},{"kind":"intent_keyword","word":"lokalen ordner"},{"kind":"intent_keyword","word":"files.write"},{"kind":"intent_keyword","word":"browser.open"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, device, local]
version: 1
---

# Workflow Steps On A Device

A step that works on the person's Mac is an ordinary `request` step on a device connector. Each device has one connector per capability it turned on, named like “MacBook Pro (Mike): Files” or „MacBook Pro (Mike): Dateien“ in the language of the device, with driver `local_files`, `local_browser` or `local_computer`. Bind the step to that connector with `connector_id`; never invent a device id.

## Path and method

- The step's `path` names the action: `/files.write`, `/browser.open`, `/computer.type`.
- Reading actions use `GET`; actions that change something use `POST`. A local step whose method does not fit its action is refused before anything is sent.
- Reading actions: `files.list`, `files.read_text`, `browser.snapshot`, `browser.wait`, `browser.extract`, `browser.screenshot`, `computer.apps`, `computer.snapshot`, `computer.screenshot`.

## Body per action

Fields sit directly in `body`. Do not wrap them in `args` or `config`.

Files (folders are the ids the person allowed on the device, paths are relative to that folder):
- `files.list`, `files.read_text`, `files.mkdir`: `{folder_id, path}`.
- `files.import`: `{folder_id, path, name?}` copies the file into SubKit; the step output is a file reference later steps can use.
- `files.write`: `{folder_id, path, content, replace?}`. `content` is text, or `{encoding: "base64", data}`. Set `replace: true` only when an existing file may be replaced; the old version goes to the Trash.
- `files.move`: `{folder_id, to_folder_id?, path, to_path}` or `{folder_id, to_folder_id?, items: [{from, to}]}`, at most 200 items.
- `files.trash`: `{folder_id, path}` or `{folder_id, paths: [...]}`, at most 200.

Browser (the site must be one the person allowed):
- `browser.open`: `{url}`.
- `browser.press`: `{action: "click", element}`, `{action: "key", key}` or `{action: "scroll", direction, pixels?}`.
- `browser.fill`: `{mode: "fill" | "type", element, text}` or `{mode: "select", element, values: [...]}`.
- `browser.wait`: `{for: "load", state?}`, `{for: "text", text}` or `{for: "ms", ms}`.
- `browser.extract`: `{element?}`. `browser.snapshot` and `browser.screenshot`: `{}`.
- `browser.download`: `{element, folder_id, name}` saves into an allowed folder with write access.

Computer (the app must be one the person allowed; `app_id` is its bundle id):
- `computer.apps`: `{}`.
- `computer.snapshot`, `computer.screenshot`: `{app_id}`.
- `computer.press`, `computer.focus`: `{app_id, element}`. `computer.type`: `{app_id, element, text}`. `computer.set_value`: `{app_id, element, value}`. `computer.select`: `{app_id, element, option}`. `computer.scroll`: `{app_id, element, direction, amount}`.
- `computer.key`: `{app_id, keys}`, for example `"cmd+s"`.

## Elements, never refs

Name an element as `element: {role, name, nth?}`, for example `{role: "button", name: "Download"}`. Add `nth` (0 is the first) only when several elements share role and name. Never write a ref such as `e12` or `@s1:e4`: refs change with every snapshot, so SubKit takes a fresh snapshot right before each such action and picks the ref itself.

## Approval

- The approval names the device and, for each local step, the folders (with read or write access), the websites and the apps it uses. Write `folder_id`, `to_folder_id`, `url` and `app_id` as fixed values. A placeholder there leaves the workflow unapprovable, and a value filled in while the run goes that the approval does not name is refused.
- Approve on the device itself. A new folder, write access where only reading was approved, a new or private website and a new app need a new approval; fewer items carry it forward.
- Browser and computer steps run only for the device's person: from their chat or task, a run they start, or a schedule they set up.
- A workflow called by another workflow refuses local steps. Put local steps in the workflow the person approves and runs.
