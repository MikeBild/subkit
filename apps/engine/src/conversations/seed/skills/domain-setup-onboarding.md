---
slug: domain-setup-onboarding
scope: global
title: Modeling a Domain with Skills and Knowledge Sources
description: When the user asks how to teach sk about a whole business domain (an expense policy, a compliance framework, music theory), explain the connector + skill + knowledge-source trio and offer to set it up. Grounds the concept via the sk-platform-reference knowledge corpus.
activates_when: [{"kind":"intent_keyword","word":"model a domain"},{"kind":"intent_keyword","word":"model my domain"},{"kind":"intent_keyword","word":"set up a domain"},{"kind":"intent_keyword","word":"teach the engine"},{"kind":"intent_keyword","word":"teach sk about"},{"kind":"intent_keyword","word":"domain knowledge"},{"kind":"intent_keyword","word":"add a knowledge source"},{"kind":"intent_keyword","word":"add knowledge"},{"kind":"intent_keyword","word":"author a skill"},{"kind":"intent_keyword","word":"skills vs knowledge"},{"kind":"intent_keyword","word":"skills and knowledge sources"}]
side_effects: read
idempotency: none
maturity: stable
tags: [onboarding, skills, knowledge-sources, domain-modeling, authoring-only]
version: 1
---

# Modeling a Domain with Skills and Knowledge Sources

The user wants to teach sk about a whole domain — an expense policy, a
contract-review process, a compliance framework, or any specialized field. Your
job is to explain the model briefly, then **offer to set it up**, not just
describe it.

**This skill is authoring-only** — it is tagged `authoring-only` and does NOT
load on the read-only external chat channel (Google Chat / Slack / Teams), whose
palette cannot create anything. It applies only on authoring surfaces (the web
portal, the `sk` CLI, and MCP clients), where the create tools actually exist.
Never propose `create_skill` / `create_knowledge_source` on a surface that lacks
them: if you are on read-only chat, explain the model and point the user to the
`sk` CLI or web portal — do not render an Approve card for an action you cannot
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
  requests against a real, discovered surface.
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
- **Skill (operator-owned).** Offer to author the conventions as a Skill with
  `create_skill`, or — when the convention emerges from how their workflows
  actually run — to let the engine propose it as a Skill Candidate the operator
  promotes. Be honest: a Skill is prescriptive guidance a human owns; confirm the
  wording before you create it, and never claim a Skill was created that was not.
- **Connector (as needed).** If the domain has an API the user wants to call,
  route into the normal connector-creation flow.

## Set honest expectations

- Do not promise auto-magic. Skills are never auto-generated or auto-promoted;
  the operator decides what becomes canonical.
- Do not over-scope. One tight Skill plus a couple of focused Knowledge Sources
  beats a single sprawling document.
- The shape is domain-agnostic — the same trio models an expense policy, tax
  law, a product catalog, or music theory. Reassure the user that whatever their
  field, the pattern is the same.
