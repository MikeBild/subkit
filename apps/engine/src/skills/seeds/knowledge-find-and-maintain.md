---
slug: knowledge-find-and-maintain
scope: global
title: Wissen finden und pflegen
description: When to look facts up with `search_knowledge` instead of answering from memory, when to collect a learning with `save_learning` into Intake for review, and how to tell a fact (may become domain knowledge) from a practice (may become a skill).
activates_when: [{"kind":"intent_keyword","word":"remember this"},{"kind":"intent_keyword","word":"merk dir"},{"kind":"intent_keyword","word":"merke dir"},{"kind":"intent_keyword","word":"what do we know"},{"kind":"intent_keyword","word":"was wissen wir"},{"kind":"intent_keyword","word":"knowledge source"},{"kind":"intent_keyword","word":"wissensquelle"},{"kind":"intent_keyword","word":"search_knowledge"},{"kind":"intent_keyword","word":"save_learning"}]
side_effects: read
idempotency: none
maturity: stable
tags: [knowledge, learnings, agent-briefing]
version: 2
---

# Wissen finden und pflegen

sk keeps one shared memory for people and agents: knowledge sources (runbooks,
policies, reference pages, what the team learned) and skills (how to work).
Read it before you answer; collect what a person teaches you for review.

## Look it up before you answer

Call `search_knowledge` FIRST whenever the request depends on the tenant's own
domain — names, owners, addresses, numbers, conventions, runbooks, internal
APIs, error codes. Do not answer such questions from prior knowledge.

1. Search with a short, focused query (3–6 words). Narrow with `tags`, for
   example `["domain:ops"]` when the session briefing names the domain.
2. Answer from the hits and name the source (`source_name`).
3. If the first search finds nothing useful, refine the query once. If it still
   finds nothing, say so plainly — never fill the gap with a guess.
4. When a snippet is not enough, read the whole source with `read_knowledge`
   (`knowledge_source_id` from the hit, `path` for one file of a bundle) instead
   of searching again.
5. `list_knowledge_sources` shows which sources exist and their tags.

## Collect what a person teaches you

When the user corrects you, states a rule, tells you a fact of their domain, or
asks you to remember something for later sessions, call `save_learning`. It
collects an Intake item with origin `session` in the shared category of the
first named domain that exists (otherwise the person's default category). It is
not knowledge and not a skill: search, briefings and authoring ignore it until a
person reviews it, confirms a proposal in the Cockpit, and so decides whether it
becomes knowledge, a skill, or nothing.

Pick the kind as a hint for that review:

| kind | What it says | Typical destination after confirmation |
|---|---|---|
| `fact` | WHAT is true: a name, number, owner, address, deadline, policy | the domain's knowledge bundle (tag `domain:<domain>`), found by `search_knowledge` |
| `practice` | HOW to work: a rule, convention, gotcha, order of steps | an active skill that later sessions and agent briefings load |

Examples:

- "The on-call is paged by phone between 22:00 and 07:00" → `fact`.
- "Always confirm a page was acknowledged before closing the incident" →
  `practice`.

Pass the domain slug(s) from the session briefing in `domains`, and write title
and body in the user's language. One learning per call; keep the body to the
point (a sentence or a short list).

## Propose a destination in a review

When a person reviews collected items with you, read each one with
`get_intake_item` and propose with `create_intake_proposal`:

- Facts go to knowledge. Pass the item's `suggested_knowledge_target`
  unchanged, so the fact lands in its domain's knowledge bundle (created on the
  first confirmation, extended afterwards). When it is empty, the item's
  category is not a domain: agree the destination with the person.
- Practices go to a skill. Use `{skill: {new: {title, scope, tags, category}}}`
  with the `domain:<domain>` tag, or `{skill: {skill_id, expected_version}}` to
  change an existing skill at the version you read. List skills the new one
  consolidates in `supersedes` as `{skill_id, expected_version}` with the
  version you read; they are archived on confirmation.

The proposal admits nothing. The person confirms content and destination in the
Cockpit.

## What not to save

- Events and status updates: a release, a deploy, a run result.
- Anything that names a credential or where one is stored.
- Task-specific details that only matter for the current request.
- Anything the person did not confirm.
- Content already in a loaded skill or a knowledge hit — update nothing twice.

## After saving

Tell the user the learning was collected for review in Intake. Do not claim it
is knowledge, a skill, or live. Saving the same title in the same category again
only adds evidence to the existing item, including a discarded one, so do not
re-save it with a different title to get around a decision. Every knowledge source keeps its versions: a person can
restore an earlier version at any time, and the restore is itself a new version.
