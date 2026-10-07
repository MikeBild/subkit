---
slug: knowledge-find-and-maintain
scope: global
title: Wissen finden und pflegen
description: When to look facts up with `search_knowledge` instead of answering from memory, when to propose a learning with `save_learning`, and how to tell a fact (becomes part of the domain's knowledge source) from a practice (becomes a skill).
activates_when: [{"kind":"intent_keyword","word":"remember this"},{"kind":"intent_keyword","word":"merk dir"},{"kind":"intent_keyword","word":"merke dir"},{"kind":"intent_keyword","word":"what do we know"},{"kind":"intent_keyword","word":"was wissen wir"},{"kind":"intent_keyword","word":"knowledge source"},{"kind":"intent_keyword","word":"wissensquelle"},{"kind":"intent_keyword","word":"search_knowledge"},{"kind":"intent_keyword","word":"save_learning"}]
side_effects: read
idempotency: none
maturity: stable
tags: [knowledge, learnings, agent-briefing]
version: 1
---

# Wissen finden und pflegen

sk keeps one shared memory for people and agents: knowledge sources (runbooks,
policies, reference pages, what the team learned) and skills (how to work).
Read it before you answer; propose to it when a person teaches you something.

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

## Propose what a person teaches you

When the user corrects you, states a rule, tells you a fact of their domain, or
asks you to remember something for later sessions, call `save_learning`. It only
creates a proposal; a person reviews it before anything changes.

Pick the kind:

| kind | What it says | Where it lands after approval |
|---|---|---|
| `fact` | WHAT is true: a name, number, owner, address, deadline, policy | appended to the knowledge source `learnings-<domain>` as a new version, found by `search_knowledge` |
| `practice` | HOW to work: a rule, convention, gotcha, order of steps | a skill that later sessions load |

Examples:

- "The on-call is paged by phone between 22:00 and 07:00" → `fact`.
- "Always confirm a page was acknowledged before closing the incident" →
  `practice`.

Pass the domain slug(s) from the session briefing in `domains`, and write title
and body in the user's language. One learning per call; keep the body to the
point (a sentence or a short list).

## What not to save

- Task-specific details that only matter for the current request.
- Anything the person did not confirm.
- Content already in a loaded skill or a knowledge hit — update nothing twice.

## After saving

Tell the user the learning waits for review. Do not claim it is live. A rejected
learning is never proposed again, so do not re-save it with a different title to
get around the decision. Every knowledge source keeps its versions: a person can
restore an earlier version at any time, and the restore is itself a new version.
