---
slug: domain-setup-onboarding
scope: global
title: Modeling a Domain with Skills and Knowledge Sources
description: When the user asks how to teach subkit about a whole business domain (an expense policy, a compliance framework, music theory), explain the connector + skill + knowledge-source trio and offer to set it up. Grounds the concept via the sk-platform-reference knowledge corpus.
activates_when: [{"kind":"intent_keyword","word":"model a domain"},{"kind":"intent_keyword","word":"model my domain"},{"kind":"intent_keyword","word":"set up a domain"},{"kind":"intent_keyword","word":"teach the engine"},{"kind":"intent_keyword","word":"teach subkit about"},{"kind":"intent_keyword","word":"domain knowledge"},{"kind":"intent_keyword","word":"add a knowledge source"},{"kind":"intent_keyword","word":"add knowledge"},{"kind":"intent_keyword","word":"author a skill"},{"kind":"intent_keyword","word":"skills vs knowledge"},{"kind":"intent_keyword","word":"skills and knowledge sources"},{"kind":"intent_keyword","word":"claude code"},{"kind":"intent_keyword","word":"codex"},{"kind":"intent_keyword","word":"coding agent"},{"kind":"intent_keyword","word":"session briefing"}]
side_effects: read
idempotency: none
maturity: stable
tags: [onboarding, skills, knowledge-sources, domain-modeling, authoring-only]
version: 4
---

# Modeling a Domain with Skills and Knowledge Sources

The user wants to teach subkit about a whole domain — an expense policy, a
contract-review process, a compliance framework, or any specialized field. Your
job is to explain the model briefly, then **offer to set it up**, not just
describe it.

**This skill is authoring-only** — it is tagged `authoring-only` and does NOT
load on the read-only external chat channel (Google Chat / Slack / Teams), whose
palette cannot create anything. It applies only on authoring surfaces (the web
portal, the `subkit` CLI, and MCP clients), where the create tools actually exist.
Never propose `create_knowledge_source` or an intake proposal on a surface that
lacks the tool: if you are on read-only chat, explain the model and point the user to the
`subkit` CLI or web portal — do not render an Approve card for an action you cannot
carry out.

## First: ground the concept, don't improvise it

Before you explain the difference between Skills and Knowledge Sources or how to
model a domain, call `search_knowledge` — the `sk-platform-reference` corpus
carries the canonical answer (source `sk-ref-knowledge-and-skills`). Ground your
explanation in what it returns rather than reciting it from memory.

The one-liner to anchor on: **Skills prescribe; Knowledge Sources inform.** A
Skill is dense, prescriptive guidance the AI *follows*. A Knowledge Source is a
document store the AI *searches* for reference. Both improve authoring and repair
only — committed workflow execution queries neither.

## The trio to stand up

A domain is modeled with three primitives working together:

- **Connector** — the domain's system of record or API. Grounds workflow
  requests against a real, discovered surface. Five drivers: `http`, `graphql`,
  `postgres`, `s3`, and `mcp`. If the domain's system already speaks MCP, it is
  a connector like any other (`driver: "mcp"`) — not a separate kind of thing
  to register somewhere else.
- **Skill** — the house conventions the AI must obey in that domain: required
  validations, error handling, approval gates, tone. Keep each Skill tight and
  single-purpose.
- **Knowledge Source** — the domain's reference material: the policy PDF, the
  runbook, the glossary, the rate tables. Prefer several focused documents over
  one large blob so chunk-level search returns sharp matches.

## Offer to act

After the short explanation, propose concrete next steps and act on the ones the
user accepts. Call one state-changing tool at a time and wait for confirmation.

- **Knowledge Source (self-serve).** If the user has a document, offer to add it
  now: `create_knowledge_source` with inline content, or from a file the user
  uploaded (an `@attachment` reference). Suggest tags so later searches can be
  narrowed. This is the fastest win — do it first when a document is available.
- **Skill (operator-owned).** A Skill comes from reviewed material. Collect the
  conventions the user states with `save_learning` (kind `practice`); they land
  in Intake, not in the skill list. Then read the collected items with
  `get_intake_item` and prepare an intake proposal with a skill destination
  (`create_intake_proposal`, target `skill` with `new` or an existing `skill_id`).
  Only a person who confirms that proposal in the Cockpit activates the Skill;
  replaced Skills are archived in the same step. An operator who already has the
  Skill as a file can create it directly with `subkit skills create`. Be honest: a
  Skill is prescriptive guidance a human owns; confirm the wording with the user,
  and never claim a Skill exists or is active before the confirmation.
- **Connector (as needed).** If the domain has an API the user wants to call,
  route into the normal connector-creation flow.

## Set honest expectations

- Do not promise auto-magic. Skills are never auto-generated or auto-activated;
  a person confirms what becomes canonical.
- Do not over-scope. One tight Skill plus a couple of focused Knowledge Sources
  beats a single sprawling document.
- The shape is domain-agnostic — the same trio models an expense policy, tax
  law, a product catalog, or music theory. Reassure the user that whatever their
  field, the pattern is the same.

## Consuming the domain from coding agents

Once the trio exists, coding agents (Claude Code, Codex) can work inside the
domain: tag the domain's Skills and Knowledge Sources with `domain:<slug>`,
have the user run `subkit agent init --domains <slug>` in their repo, and every
new session starts with the domain briefing and searches the knowledge with
`search_knowledge`. What sessions teach is collected in Intake with origin
`session`, in the domain's shared category; a person reviews it in chat and
confirms whether it becomes knowledge, a skill, or nothing. `subkit intake list`
shows what is waiting. Offer this as the follow-up
when a user finishes modeling a domain and mentions Claude Code, Codex, or
coding sessions.
