---
slug: features
title: SubKit features at a glance
summary: Find every SubKit feature in one list, with where it is available and the chapter that explains it.
section: reference
order: 8
audience: public
---
## SubKit features at a glance

This page lists every feature of SubKit in one place, grouped by area, so rarely used ones are easy to find again.
Each line says what you get and links to the chapter that explains it.

### Legend

| Mark | Meaning |
| --- | --- |
| **All** | Available in SubKit Cloud and on your own engine. |
| **Self-hosted** | Only when you run the engine yourself. |
| **Cloud** | Only in SubKit Cloud. |
| **Admin** | Only people with the Admin role, or the engine operator, can use or change it. |
| **Optional** | Off by default. You or an administrator switch it on. |

### Workflows and runs

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Workflow from a sentence | Describe the task in chat, and the AI drafts a workflow you review and save. | All | [Your first workflow](setup.md#your-first-workflow) |
| Fixed steps | A workflow runs request, transform, call, wait, wait for event, branch, parallel and loop steps, the same way every time. | All | [Your first workflow](setup.md#your-first-workflow) |
| Versions | Every change is a new version; the approved version keeps running until a new one is approved. | All | [Your first workflow](setup.md#your-first-workflow) |
| Test and production | Every run and approval belongs to an environment, and the Cockpit labels which one you are in. | All | [Find your way in the Cockpit](setup.md#find-your-way-in-the-cockpit) |
| Trial run | Without an approval, a run is a dry run: writes are held back and nothing is sent. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |
| Run result | Every run shows its state, steps, version and why it was allowed, with a link to the audit trail. | All | [Your first workflow](setup.md#your-first-workflow) |
| Markdown result | A run can hand over a written result in Markdown that the Cockpit shows. | All | [Reference: files from the desktop, run results and sign-in signals](setup.md#reference-files-from-the-desktop-run-results-and-sign-in-signals) |
| Fix it in chat | When a step fails or blocks an approval, SubKit suggests a fix in chat that you review again. | All | [Your first workflow](setup.md#your-first-workflow) |
| Automation check | Saving a workflow or schedule tells you whether it can run on its own or which step needs a change. | All | [Use the HTTP API](setup.md#use-the-http-api) |
| Sandbox data tools | Transform steps calculate, parse and validate data with built-in helpers in an isolated sandbox. | All | [Sandbox data tools](setup.md#sandbox-data-tools) |
| Packages | Export workflows, connectors, skills, schedules, sources and files and import them into another engine. | All | [Use the sk CLI on your machine](setup.md#use-the-sk-cli-on-your-machine) |

### Approvals and permissions

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Approve what it may touch | A person approves the environment, the validity and the reads, writes and services before the first real run. | All | [Your first workflow](setup.md#your-first-workflow) |
| Approval until revoked | An approval can stand until revoked or end at a date or after a number of runs. | All | [Your first workflow](setup.md#your-first-workflow) |
| Approval follows a new version | A new version needs no new approval as long as it reaches no further; otherwise SubKit names the difference. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |
| Renew before it ends | SubKit reports an approval three days before it ends, and you can renew it. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Two-person approval (“approve together”) | Every workflow approval needs two different people, for teams that must not let one person approve sensitive workflows alone. Off by default; the setting appears only when at least two people in the workspace may approve, and only administrators change it. | Admin · Optional | [Reference: pair approval, invitations, offline reports and notification pause](setup.md#reference-pair-approval-invitations-offline-reports-and-notification-pause) |
| Allow once | A write tool called from an AI client pauses until a person selects **Allow once** or **Decline**. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |
| Roles, groups and grants | Roles, permissions and scoped API keys apply the same way to the Cockpit, `sk`, the API and MCP. | Admin | [Execution identity and permission](setup.md#execution-identity-and-permission) |
| Who started a run | Every run names its caller, and you can trace it across channels. | All | [Execution identity and permission](setup.md#execution-identity-and-permission) |

### Tasks

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Goal as a task | Hand over a goal with limits; SubKit plans the way, works through it and asks when it needs you. | All | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |
| Standing permission | A task starts on its own only with a standing permission that ends when the task changes. | All | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |
| Follow and step in | Follow a run, answer its questions and confirm or reject its written result. | All | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |
| Task to workflow | Turn a proven task run into a workflow. | All | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |
| Admins step in | Administrators can manage every task and release or decline writes a run holds back. | Admin | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |

### Schedules, webhooks and events

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Schedules | Run a workflow or task at fixed times. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Failure reasons | A failed or waiting scheduled run says why and what to do. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Pause after repeated failures | A schedule that fails five times in a row for the same reason pauses and says so once. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Schedule history | See what became of every scheduled time. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Stop a run | Stop a run that is still going. | All | [Keep an eye on schedules](setup.md#keep-an-eye-on-schedules) |
| Inbound webhooks | A webhook from another system starts a workflow. | All | [Execution identity and permission](setup.md#execution-identity-and-permission) |
| Subscriptions | Programs receive SubKit events through subscriptions and webhooks. | All | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |

### Chat and AI assistant

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Chat in the Cockpit | Draft workflows, ask questions and start approved workflows in conversation. | All | [Your first workflow](setup.md#your-first-workflow) |
| When SubKit asks | Your request decides what runs without a question; **Always ask first** makes every write ask. | All | [When SubKit asks](setup.md#when-subkit-asks) |
| Always ask first | A rule of your own: every step that writes asks you first, in chat, in tasks and on your Mac. | All | [When SubKit asks](setup.md#when-subkit-asks) |
| Rules | After the second **Allow once** for the same action, save it as a rule for 90 days. | All | [When SubKit asks](setup.md#when-subkit-asks) |
| Files in chat | Attach files to a message, also from SubKit Desktop. | All | [Reference: files from the desktop, run results and sign-in signals](setup.md#reference-files-from-the-desktop-run-results-and-sign-in-signals) |
| Slack and Google Chat | Ask questions and start approved workflows where your team works; in SubKit Cloud only after the chat workspace's ownership is verified. | All | [Use SubKit Cloud](setup.md#use-subkit-cloud) |
| Your own model | Anthropic, OpenAI, Google Gemini, Azure, Amazon Bedrock or Vertex AI with your own key, plus a fallback provider. | All | [Settings](settings.md) |
| Web search | With an Anthropic model, the assistant can use the model's built-in web search, billed per search to your key; on unless switched off. | All | [Use SubKit Cloud](setup.md#use-subkit-cloud) |

### Knowledge, inbox and skills

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Inbox | Notes, chat findings, coding-agent findings, files and clipped pages land in one list. | All | [Collect ideas and turn them into knowledge or skills](setup.md#collect-ideas-and-turn-them-into-knowledge-or-skills) |
| Review and confirm | You decide whether an entry becomes a knowledge source or a skill; nothing is adopted on its own. | All | [Collect ideas and turn them into knowledge or skills](setup.md#collect-ideas-and-turn-them-into-knowledge-or-skills) |
| Knowledge sources | Your team's notes, runbooks and rules, searchable inside the engine. | All | [Maintain sources, skills and files](setup.md#maintain-sources-skills-and-files) |
| Skills | Reusable instructions for chat and workflow drafting; proposals wait for your decision. | All | [Maintain sources, skills and files](setup.md#maintain-sources-skills-and-files) |
| Versions and restore | Compare versions of a source or skill and restore an earlier one. | All | [Maintain sources, skills and files](setup.md#maintain-sources-skills-and-files) |
| Files | Upload, replace and restore files with their earlier versions. | All | [Maintain sources, skills and files](setup.md#maintain-sources-skills-and-files) |
| Web Clipper | Save pages, selections and YouTube transcripts from Chrome to your inbox. | All | [Collect web pages with the Web Clipper](setup.md#collect-web-pages-with-the-web-clipper) |
| Coding-agent briefings | Claude Code, Codex and Hermes get your team's knowledge as a briefing and can collect findings. | All | [Use SubKit from a coding agent](coding-agents.md#use-subkit-from-a-coding-agent) |

### Connectors and integrations

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Connector catalog | 61 connector templates and 248 ready-made recipes, from GitHub to Stripe. | All | [Connector & recipe catalog](connectors.md) |
| MCP server as a connector | Workflows and the chat call the tools of an MCP server your team already uses. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |
| External MCP over OAuth | Connect external MCP servers over OAuth without redirecting secrets. | All | [External MCP OAuth credentials](setup.md#external-mcp-oauth-credentials) |
| Signed-JWT credentials | Connect APIs such as App Store Connect that accept a signed JWT directly. | All | [Direct signed-JWT connector credentials](setup.md#direct-signed-jwt-connector-credentials) |
| Email replies | Confirm a signed form request with exactly one email to its sender. | All | [Reply by email to a signed request](transactional-email.md#reply-by-email-to-a-signed-request) |
| Your own app | An app with its own sign-in starts workflows for its users. | Admin | [Onboard an app](setup.md#onboard-an-app) |
| Product sign-in and budgets | App users call SubKit with the app's token, limited by a daily quota per caller. | Admin | [Product bearer tokens and caller budgets](setup.md#product-bearer-tokens-and-caller-budgets) |
| Identity binding | Link an app's users to a SubKit account with minimal rights. | Admin | [Product identity binding](setup.md#product-identity-binding) |
| Supabase data | Use your Supabase project's data in product workflows without exposing keys. | Admin | [Supabase-backed product workflows](setup.md#supabase-backed-product-workflows) |
| Private network addresses | Connectors reach services such as `localhost` or internal company servers. | Self-hosted | [Use SubKit Cloud](setup.md#use-subkit-cloud) |

### Cockpit and installed app

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Overview and Needs you | See what ran, what failed and what waits for your decision. | All | [What is SubKit?](setup.md#what-is-subkit) |
| Find your way | Navigation, side panel, error notices with remedies and a Markdown viewer. | All | [Find your way in the Cockpit](setup.md#find-your-way-in-the-cockpit) |
| Setup in five questions | Your answers set the default environment, approver and notifications. | All | [Set SubKit up for yourself](setup.md#set-subkit-up-for-yourself) |
| English and German | The Cockpit and this documentation come in both languages. | All | [What is SubKit?](setup.md#what-is-subkit) |
| Branding | Give the Cockpit your company's name, logo and colors. | Admin | [Cockpit branding](setup.md#cockpit-branding) |
| Cockpit as an app | Install a workspace's Cockpit as its own app on computer and phone, with push and sharing from other apps. | All | [Cockpit as an app](setup.md#cockpit-as-an-app) |

### SubKit Desktop

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| SubKit Desktop | Your server's Cockpit as a Mac app for Apple Silicon (macOS 13 or later), with a menu bar icon, notifications and launch at login. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Welcome and invitation link | The first start explains what SubKit does and opens the invitation link from your email, so you join a workspace in a few steps. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Sign in through the browser | The app signs in through your browser; every Mac is a device you can revoke. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Several servers | SubKit Desktop keeps one profile per server. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Menu bar | The count of what needs you, quiet hours, pause, quick note, live view, updates and “Report a problem” in one menu. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Quick note | ⌥ Space opens a note from anywhere; it lands in your inbox. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Drop sheet | Drop files on the window, the Dock icon or the menu bar icon and choose: store as file, ingest as source, attach in chat or put into the inbox. | All | [Reference: files from the desktop, run results and sign-in signals](setup.md#reference-files-from-the-desktop-run-results-and-sign-in-signals) |
| Pause | Hold notifications back for an hour or until you resume them, right from the menu bar. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Report a bug | Send a bug report or idea to your workspace's inbox, with a screenshot and optional diagnostics. A report written offline waits in a queue and goes out once you are back online. | All | [Report a bug](setup.md#report-a-bug) |
| Desktop versions and devices | Decide which app version your server accepts and revoke devices. | Admin · Self-hosted | [Operate the desktop sign-in](setup.md#operate-the-desktop-sign-in) |

### SubKit on your Mac

These features need SubKit Desktop on a Mac with Apple Silicon. Nothing runs on your Mac until you turn it on under **Local capabilities**.

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Local files | Chat, tasks and workflows read and write files in folders you allowed, with read or read-and-write access per folder. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Browser | SubKit works in websites you allowed, in a browser of its own on your Mac. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Computer use | SubKit uses buttons and fields in apps you allowed. Password managers, banking, terminals, System Settings and other sensitive apps stay blocked. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Local allowances | Folders, websites and apps you allow, plus a list of what stays off limits, kept on the Mac itself. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Live view | See what SubKit does on your Mac with the latest redacted screenshot and every step; stop it at any time with ⌘⇧⎋. | All | [SubKit Desktop](setup.md#subkit-desktop) |
| Confirmations on the Mac | A step that writes and that your request does not cover asks you first, in the chat and in the live view; a sign-in is handed to you and back. | All | [When SubKit asks](setup.md#when-subkit-asks) |
| Local workflow steps | Workflows with fixed steps for files, browser and apps; the approval names the device, folders, websites and apps. | All | [Reference: workflow steps on your device](setup.md#reference-workflow-steps-on-your-device) |
| Fully local workspace | Run a workspace only on your Mac, with its own database, backups and your own AI key or local model server; move it to a server later. | Self-hosted | [SubKit Desktop](setup.md#subkit-desktop) |

### sk CLI, HTTP API and MCP

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| sk CLI | Draft, change and run workflows as files from the terminal, on several engines. | All | [Use the sk CLI on your machine](setup.md#use-the-sk-cli-on-your-machine) |
| Command reference | Every `sk` command with its arguments. | All | [sk CLI reference](cli.md) |
| HTTP API | Start workflows from your own code and read their results; described in OpenAPI at `/openapi.json`. | All | [Use the HTTP API](setup.md#use-the-http-api) |
| MCP server | Every approved workflow is a tool in Claude Code, Codex and other MCP clients, with browser sign-in or an API key. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |
| Tasks from an AI client | Create and follow tasks from an MCP client. | All | [Connect AI clients via MCP](setup.md#connect-ai-clients-via-mcp) |

### Notifications

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Push notifications | One notification per item that needs you, in the browser, the installed app or SubKit Desktop. | All | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |
| Quiet hours | Decide when SubKit may notify you. | All | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |
| Pause notifications | Hold notifications back for a while or until you resume them. | All | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |
| Urgent despite quiet hours | Let critical items through quiet hours and pauses. | Optional | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |
| Route approvals | Send approval notifications to another person on the team. | All | [Notifications and quiet hours](setup.md#notifications-and-quiet-hours) |
| Invitations | An administrator issues an invitation link and hands it over. | Admin | [Reference: pair approval, invitations, offline reports and notification pause](setup.md#reference-pair-approval-invitations-offline-reports-and-notification-pause) |

### Usage and costs

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Usage | AI cost per run, workflow, person and model in a time window you choose. | All | [Keep track of usage and costs](setup.md#keep-track-of-usage-and-costs) |
| Monthly AI budget | One limit on AI cost in US dollars, $50 for a new workspace. At 100% chat, tasks and model steps pause; workflows without a model step keep running. | Admin | [Keep track of usage and costs](setup.md#keep-track-of-usage-and-costs) |
| Prices | Built-in model prices, overridable per model. | Admin | [Keep track of usage and costs](setup.md#keep-track-of-usage-and-costs) |
| Export | Export the usage figures. | All | [Keep track of usage and costs](setup.md#keep-track-of-usage-and-costs) |
| Task costs | See what each task's runs cost. | All | [Hand over a goal as a task](setup.md#hand-over-a-goal-as-a-task) |

### SubKit Cloud and self-hosting

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| SubKit Cloud | SubKit runs for you; you sign in from the browser. Beta by invitation. | Cloud | [Use SubKit Cloud](setup.md#use-subkit-cloud) |
| Own AI key per workspace | Every cloud workspace brings its own provider and key; the operator's AI access is never used. | Cloud | [Use SubKit Cloud](setup.md#use-subkit-cloud) |
| Several workspaces | Switch accounts and workspaces, and delete a workspace. | Cloud | [Use SubKit Cloud](setup.md#use-subkit-cloud) |
| Workspace limits | Request, storage and resource limits set by the operator, with clear messages. | Cloud | [Use SubKit Cloud](setup.md#use-subkit-cloud) |
| Own engine | Run SubKit with Docker Compose on your own server. | Self-hosted | [Run the engine](setup.md#run-the-engine) |
| First-run setup | Create the admin account, workspace and AI provider after the first start. | Self-hosted | [First-run setup](setup.md#first-run-setup) |
| Backup and recovery | Back up the whole installation and restore it with the same image. | Self-hosted | [Run the engine](setup.md#run-the-engine) |
| Browser crawling | Crawl pages for connector discovery with a derived image. | Self-hosted · Optional | [Run the engine](setup.md#run-the-engine) |
| Engine operator | One workspace administers the whole engine. | Admin · Self-hosted | [Engine operator](setup.md#engine-operator) |
| Runtime settings | Every engine setting with description and default, changed with `sk settings`, the API or the config file. | Admin | [Settings](settings.md) |

### Security and audit

| Feature | What you get | Where | More |
| --- | --- | --- | --- |
| Audit trail | Every run, approval and change is recorded with who did it, and each object shows its own history. | All | [Find your way in the Cockpit](setup.md#find-your-way-in-the-cockpit) |
| Vault | API keys, logins and connector credentials in one place, encrypted, for the workspace or only for you. Workflows name them by handle, the AI never sees a value, and every use, reveal and rotation is in the audit trail. | All | [Reference: the vault](setup.md#reference-the-vault) |
| Sign-in sessions | Installed apps keep a session and sign out cleanly. | All | [Installed Cockpit sessions](setup.md#installed-cockpit-sessions) |
| Redaction | Secrets are removed from clipped pages and bug reports before they are stored. | All | [Report a bug](setup.md#report-a-bug) |
| License | Open source under the Apache License 2.0. | All | [License](setup.md#license) |
