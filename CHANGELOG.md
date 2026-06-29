# Changelog

## [7.22.1] – 2026-06-29
- fix(authoring): ground request paths in discovered endpoints — no invented routes (v7.22.1)
- fix(docker): retry bun install in image build to survive flaky QEMU tarball extraction

## [7.22.0] – 2026-06-29
- chore(release): v7.22.0 — lean MCP conversation poll envelope
- fix(mcp): drop redundant top-level `events` from conversation_get (v7.21.8)
- fix(mcp): lean conversation poll envelope — stop shipping the full streaming replay log (v7.21.8)

## [7.21.7] – 2026-06-29
- fix(mcp): always expose confirm_tool_call + bound elicitation so the gate never dead-ends (v7.21.7)

## [7.21.6] – 2026-06-29
- fix(engine): unify write-safety on one side-effect classifier + honest hold-writes preview

## [7.21.5] – 2026-06-29
- feat(connectors): capture ALL self-description variants + document grounding

## [7.21.4] – 2026-06-29
- fix(tests): update catalogues/goldens for the new tool; keep http warm lazy

## [7.21.3] – 2026-06-29
- fix(connectors): forward connector_id from discover tool so self-description links attach

## [7.21.2] – 2026-06-29
- fix(docs): make llms-manifest.json byte-stable across filesystems

## [7.21.1] – 2026-06-29
- fix(shared): point llms-index test fixture at a real doc page

## [7.21.0] – 2026-06-29
- feat(connectors): self-description links, lazy fetch, self-healing refresh

## [7.20.0] – 2026-06-28
- feat(llms-txt): serve sk's own llms.txt/llms-full.txt and probe connectors' per spec

## [7.19.1] – 2026-06-28
- fix(connectors): resolve response cap without a hard config dependency
- fix(engine): bound connector transport, uploads and chat registry rehydrate

## [7.18.0] – 2026-06-28
- fix(engine): type-preserving HTTP bodies, MCP confirm-gate + async-ack, judge & discovery fixes

## [7.17.2] – 2026-06-28
- chore(release): 7.17.2
- fix(queue/scheduler): outbox replay, lost cron runs, fanout retry, every:N dedup (#280)

## [7.17.1] – 2026-06-28
- chore(release): 7.17.1
- Security & integrity hardening from verified code review (P0 + P1 + key P2/P3) (#279)

## [7.17.0] – 2026-06-28
- chore(release): 7.17.0
- style: drop unused userInvites import in identity service
- fix: export drawio
- chore(connectors): trim catalog to 55 verified-tier templates
- docs: fix factual drift, add per-folder index pages, gate generated docs
- feat(knowledge): ship default platform reference for MCP clients
- docs(tapes): drop the version segment from the sk REPL banner
- docs: restyle the Tier-B deep reference pages with Mermaid + outcome-first framing
- docs: reorganize docs/ into an audience-based tree with Mermaid + sk REPL tapes + llms.txt

## [7.16.0] – 2026-06-27
- chore(release): v7.16.0
- feat(mcp): author custom skills over MCP + enforce knowledge/skill write scopes (#276) (#277)

## [7.15.0] – 2026-06-27
- fix(connectors): lead Supabase auth with bearer, apikey is the Cloud-only addition
- chore(release): v7.15.0
- fix(observability): cut boot-heartbeat and discovery-cascade log noise (#275)
- fix(connectors): correct Supabase auth guidance to dual-header (apikey + Authorization: Bearer) (#274)
- feat(auth): auth.provider selector + local admin-invite provisioning (#273)
- ci: checkout/cache@v5 (Node 24), fix nightly judge-calibration, atomic SHA256SUMS

## [7.14.0] – 2026-06-26
- test(authoring): next_prompt carries the skill-candidate notice on commit
- feat(engine): graphql retry + partial-success, MCP principal, self-describing workflows

## [7.13.4] – 2026-06-26
- chore(release): v7.13.4 — official release of the MCP catalog budget-fit
- test(rbac): allowlist resources.ts in the quiet-flag guard

## [7.13.3] – 2026-06-26
- chore(release): v7.13.3 — MCP catalog budget-fit + probe/log hygiene
- refactor(mcp): extract tools/list budget-fit into catalog-budget.ts
- fix(engine): log benign migration drift at info, not warn
- fix(mcp): quiet the stats:read enumeration probe on resources/list
- fix(conversations): gate probe_connector confirm on environment, not HTTP method
- fix(mcp): fit tools/list to the strict-client token budget (search-first, essentials-first)
- docs: drop numeric prefixes from concept-doc filenames
- chore: move strategy/vision docs to Notion-bound set; keep only the 4 executable drivers

## [7.13.2] – 2026-06-26
- fix(authoring): resolve Notion-by-name failure + harden authoring loop

## [7.13.1] – 2026-06-26
- chore(release): v7.13.1 — pace backfill embedding off the event loop
- fix(embeddings): pace backfill embedding to keep the event loop responsive

## [7.13.0] – 2026-06-25
- chore(release): v7.13.0 — grounding enforcement + embedded embeddings
- feat(grounding): honest answers, semantic retrieval, embedded embeddings (#263)

## [7.11.0] – 2026-06-25
- ci(security): exempt private-key rule in *.test.ts fixtures
- chore(release): v7.11.0 — RBAC permission transparency + MCP SDK 1.29 adoption
- feat(mcp): adopt SDK 1.29 — M2M OAuth, typed JSON-schema converter, connect banner (#260)
- feat(rbac): permission transparency — displayed permissions equal enforced (#258)
- chore(release): drop dead subkit-v* tag scheme from release workflow (#262)
- ci: scope gitleaks scan to the pushed commit, not the whole object graph
- docs(mcp): scrub product names, dates and version refs from code comments
- refactor(mcp): vendor-neutral catalog-budget naming, no client special-casing (v7.10.13)
- feat(mcp): explicit tool annotations, catalog-size logging, bounded wf_ runs (v7.10.12)
- fix(mcp): validate model-driven confirmations; correct elicitation docs (v7.10.11)
- fix(mcp): make confirm-before-execution gate resolvable over MCP (v7.10.10)
- fix(mcp): ChatGPT/codex connector — consent scopes, refresh dedup, tool annotations (v7.10.5 + v7.10.6) (#259)
- feat(telemetry): per-run cost attribution, quality stats, runtime diagnostics + sk surfacing (#255)

## [7.10.4] – 2026-06-24
- refactor(mcp): drop duplicate tenant_* tool aliases — halve the MCP catalog (v7.10.4) (#257)
- feat(llm): user-level token usage attribution, budgets, and reporting (#256)

## [7.10.3] – 2026-06-24
- fix(mcp): hide draft_write tools from tools/list — unblock authoring over claude.ai (v7.10.3) (#254)
- fix(llm): register claude-opus-4-8 in model capability tables
- docs(deps): add npm dependency review report (#253)
- feat(oauth): operator-elected scope selection on the MCP consent screen (#252)

## [7.10.2] – 2026-06-24
- chore(release): v7.10.2 — default-deny execution tools (build-new hijack fix)
- fix(conversations): default-deny execution tools so build-new can't run a lookalike (#251)

## [7.10.1] – 2026-06-24
- chore(release): v7.10.1 — OAuth cleanup keeps active DCR clients
- fix(oauth): keep actively-used DCR clients in retention sweep (#249)
- feat(ci): docs-reference + phantom-dependency gates, plus housekeeping workflow (#250)

## [7.10.0] – 2026-06-24
- chore(release): v7.10.0 — judge hardening + conversation/workflow fixes
- fix(conversations): block build-new hijack, tenant-scope suggest_next, resolve Notion page ids (#248)
- feat(judge): deterministic wrong-filter guard + multi-trial calibration → blocking nightly (#247)
- fix(workflows): only reconcile trigger bindings when the trigger block changes (#246)
- refactor(ci): one rule for the nightly LLM creds — SK_OVERRIDE_ provider + key, no duplication
- fix(eval): judge-calibration runner must loadConfig() — was silently on the gateway provider in CI
- fix(ci): nightly real-LLM jobs supply anthropic creds as SK_OVERRIDE_* (config-first)

## [7.9.0] – 2026-06-24
- fix: authoring-flow integrity + grant-type-aware reauth + oauth2 refresh storm (v7.9.0) (#245)

## [7.8.2] – 2026-06-22
- fix(audit): list_audit action filter was silently dropped + gap cleanup (v7.8.2) (#244)

## [7.8.1] – 2026-06-22
- fix(conversations): load_skill must not gate on confirm (regression from tenant_write flip) (#243)

## [7.8.0] – 2026-06-22
- fix: PR-review backlog v7.8.0 — 10 verified regressions (connectors, redaction, audit, risk-signals) (#242)

## [7.7.1] – 2026-06-22
- fix(db): track applied migrations by tag, not row position (v7.7.1)

## [7.7.0] – 2026-06-22
- chore(release): v7.7.0 — recency-gated skill loading
- feat(conversations): context-aware recency-gated skill loading (K=3) (#241)
- fix: redaction no longer corrupts authored code (Gmail send outage) (#239)
- fix(sk): render startup health digest as in-context chrome, not a pre-Ink stdout dump (#240)
- feat(observability): complete error_class taxonomy across all connector drivers

## [7.6.0] – 2026-06-22
- chore(release): v7.6.0 — observability + predictive-maintenance telemetry
- Observability: error-discoverable logs + predictive-maintenance telemetry (#238)

## [7.5.1] – 2026-06-21
- fix(release): green the v7.5.0 gate (v7.5.1) (#237)

## [7.5.0] – 2026-06-21
- fix: browserless hardening + Gmail send-outage durable fix (v7.5.0) (#236)

## [7.4.0] – 2026-06-21
- chore(release): v7.4.0
- Runtime-log hardening + authoring-quality lints + count-consistency critic (#235)

## [7.3.1] – 2026-06-21
- fix(lint): enable Biome vcs so it honors .gitignore (v7.3.1)

## [7.3.0] – 2026-06-21
- chore(docker): upgrade bundled PostgreSQL 16 → 18 (v7.3.0) (#234)
- fix(e2e): bound PTY teardown so REPL suites pass within timeout (fixes red main) (#233)
- test(e2e): make missing expect a loud CI failure, not a silent skip (#232)
- ci: install expect so PTY REPL tests run instead of silently skipping (#231)
- test(e2e): add docker + multi-surface smoke/e2e coverage (#230)
- docs(quickstart): make the conversational REPL the primary interface

## [7.2.2] – 2026-06-20
- chore(release): 7.2.2
- fix(connectors): cognito reauth routes to in-chat re-issue, not a dead browser link

## [7.2.1] – 2026-06-20
- docs(quickstart): add repl walkthrough + mcp/codex embedding + smoke
- chore(release): 7.2.1
- feat(onboarding): show attached credentials (A4) + copy-paste host login

## [7.2.0] – 2026-06-20
- fix(test): setup diagnostics — public_base_url is advisory, not a warning
- chore(release): 7.2.0
- feat(onboarding): scriptable credentials, token auto-detect, provider-switch safety

## [7.1.0] – 2026-06-19
- chore(release): 7.1.0
- fix(onboarding): resolve setup/install/onboarding friction (F1–F10)

## [7.0.1] – 2026-06-19
- chore(release): drop cross-repo reference from 7.0.1 changelog
- chore(release): 7.0.1
- ci(release): dispatch deploy-release to subkit-deploy after publish

## [7.0.0] – 2026-06-19
- chore: init

