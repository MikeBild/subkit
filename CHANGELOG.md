# Changelog

## [5.0.0](https://github.com/MikeBild/subkit/compare/subkit-v4.12.5...subkit-v5.0.0) (2026-05-19)


### ⚠ BREAKING CHANGES

* **tunnels:** connectors with config.tunnel_target set will fail at runtime because the field is no longer in the connector schema. The feature was unused by every shipped template; tenants that registered a tunnel manually should remove the connector binding before upgrading.
* **engine,sk,docs:** API consumers calling the `commit_draft` tool by name must switch to `save_workflow_draft`. The REST/MCP surface, the audit `commit_intent_kind` field values, and the `force_commit` input field all rename per repo's no-backwards-compat policy.
* 41 historical migrations consolidated into a single v3 baseline. Existing 2.x deployments must run scripts/db/upgrade-to-v3-baseline.sh before deploying v3 binaries.
* **execution:** runExecution() accepts a discriminated `source` union instead of a bare workflow_id. All three kinds (saved, draft, step) flow through the same runtime pipeline; only the origin differs.

### Features

* **4.2.0:** retire docker — systemd-native engine + drop tool-step sandbox ([#152](https://github.com/MikeBild/subkit/issues/152)) ([2c194c2](https://github.com/MikeBild/subkit/commit/2c194c2ed40c19a0a4c8146e92a02e8702a3c645))
* add cleanup conversation write tools ([6d73d6a](https://github.com/MikeBild/subkit/commit/6d73d6a5653a1ee8b0484ddd815917886ad23d39))
* add direct automation workflow surface ([caa4449](https://github.com/MikeBild/subkit/commit/caa4449bd7b3926645667cded669c79e8bc4c2ec))
* **ai-sdk-6:** authoring critic — second-stage LLM verifier ([#170](https://github.com/MikeBild/subkit/issues/170)) ([#179](https://github.com/MikeBild/subkit/issues/179)) ([1ebc4ce](https://github.com/MikeBild/subkit/commit/1ebc4ce309b7f39d20b6cd17391c90698e67c4e9))
* **ai-sdk-6:** foundation ([#163](https://github.com/MikeBild/subkit/issues/163), [#164](https://github.com/MikeBild/subkit/issues/164), [#165](https://github.com/MikeBild/subkit/issues/165), [#166](https://github.com/MikeBild/subkit/issues/166)) ([#176](https://github.com/MikeBild/subkit/issues/176)) ([878b730](https://github.com/MikeBild/subkit/commit/878b730d20f0d748d43ee838c6eb490f37ac7e75))
* **ai-sdk-6:** workflow MCP resources ([#169](https://github.com/MikeBild/subkit/issues/169)) + inputExamples fix ([#177](https://github.com/MikeBild/subkit/issues/177)) + close API-key issues [skip-review] ([#178](https://github.com/MikeBild/subkit/issues/178)) ([b55f59d](https://github.com/MikeBild/subkit/commit/b55f59dcbc63047f1ef3943645fcfa92e8393974))
* align runtime with documented envelope + surface drift feedback ([d3775b1](https://github.com/MikeBild/subkit/commit/d3775b193435942c93d8fefb598b3b815a60653a))
* **authoring,llm,sk:** schema-first authoring redesign — KK→QQ + reference-aligned discipline ([f01d3a7](https://github.com/MikeBild/subkit/commit/f01d3a79bac464a8db631089becbd63e31e73100))
* **authoring,sk,chat-ui:** close residual reference-impl gaps — RR→UU ([e65af7a](https://github.com/MikeBild/subkit/commit/e65af7a17b92e9e1da0365147e8ab95afe1d47cd))
* **authoring,sk,llm,observability:** close root-cause UX + observability gaps from sessions f00b8d1c/820c1664/80eec7c8 ([c0b72df](https://github.com/MikeBild/subkit/commit/c0b72dfa6f936b99a31dbae931b2adfd7df3e5f1))
* **authoring:** close remaining FOLLOWUP gaps — preview parity, credentials, structured panes, richer snapshot ([d9b53e0](https://github.com/MikeBild/subkit/commit/d9b53e05fc8c38f796a570e9b9ba36b36a913cda))
* **authoring:** harden guided state, palette, and prompt flow ([6e5eed1](https://github.com/MikeBild/subkit/commit/6e5eed14c717a2d9a67b895f18d02304679bad54))
* **authoring:** inline $item.&lt;field&gt; + validation state into authoring context ([02d9b75](https://github.com/MikeBild/subkit/commit/02d9b753fb57062112253b6dee021735b7c9cd96))
* **authoring:** masked secrets + 3 more cards + route-doc parity gate ([af1ca67](https://github.com/MikeBild/subkit/commit/af1ca673d32acc857684c052c3e017fea47b1db6))
* bundle migrations + seed into engine binary, surface drift to o… ([#150](https://github.com/MikeBild/subkit/issues/150)) ([d5acd23](https://github.com/MikeBild/subkit/commit/d5acd2346636982ed3fb8c83008fe6b3afff600c))
* claude-review redaction + tenant_filter AST scan [skip-review] ([#143](https://github.com/MikeBild/subkit/issues/143)) ([11aff48](https://github.com/MikeBild/subkit/commit/11aff48d173aab5c79cb830c77a542b20b72fced))
* **cli-core:** generated engine API client from OpenAPI (B1) ([5b937e6](https://github.com/MikeBild/subkit/commit/5b937e686c70709e314b72fefdb75bc5f12d5af0))
* **cli:** skills delete, --show-source, scaffolders, persona docs ([aa7a0a4](https://github.com/MikeBild/subkit/commit/aa7a0a44c6b324f05bac3129fee10b645127a61a))
* close end-to-end prompting/eval/context/execution/verification gaps ([85c9400](https://github.com/MikeBild/subkit/commit/85c9400311da8ab546e9baaa2487f94cd12d3e4b))
* complete guided authoring and operator verification ([41ad42e](https://github.com/MikeBild/subkit/commit/41ad42ee9f058940a1e1fd2f710bff716c9afcfe))
* **connectors,credentials:** cognito/jwt-bearer/device-code/sigv4 auth flows + GraphQL type-preserving resolver ([738c0fc](https://github.com/MikeBild/subkit/commit/738c0fceb7687ca9b6208df0288edf008f507a0d))
* **connectors,discovery:** GraphQL connector save auto-runs introspection discovery ([175d6d6](https://github.com/MikeBild/subkit/commit/175d6d6c50d3028088e52b68deb22d9a94b37f2d))
* **connectors,docs:** A3 + A8 — auth-chain + Schedule+State recipe few-shot examples ([f4298d8](https://github.com/MikeBild/subkit/commit/f4298d8fd65af8555520be6972e3378c8ead1d18))
* **connectors,llm,mcp,discovery,events:** close 4 behavioral gaps via reference-project audit ([c5218c5](https://github.com/MikeBild/subkit/commit/c5218c5cb0430f19479abd92dd700a9f7f7e81da))
* **connectors,scripts:** Layer-3 vendor-drift sweep + verified_at stamp ([#63](https://github.com/MikeBild/subkit/issues/63)) ([d950a79](https://github.com/MikeBild/subkit/commit/d950a796f29fd938870f30f2de5ab9d3525b757f))
* **connectors:** add redis, mssql, ftp, sftp, smb drivers ([50f416e](https://github.com/MikeBild/subkit/commit/50f416e34f260add631228ce612dff3c4d5a2f03))
* **connectors:** enrich template model with URL matching, smart probes, OAuth2 details, and spec import ([78742ba](https://github.com/MikeBild/subkit/commit/78742ba3e45eaaefabf46866e553f753f10d70ab))
* **connectors:** web-scraper template + three transform languages ([#144](https://github.com/MikeBild/subkit/issues/144)) [skip-review] ([#182](https://github.com/MikeBild/subkit/issues/182)) ([6dc0b72](https://github.com/MikeBild/subkit/commit/6dc0b72cbb9fdc7e739425a07f2357a3aa5c8f73))
* **conversation:** inline auto-persist on green probe and green dry-run ([6bebb09](https://github.com/MikeBild/subkit/commit/6bebb09dc09d599c3731e1a8c6f66ef071abe1e1))
* **conversations,connectors,security:** conversational creation rebuild — skill-gated palette, harness auto-persist, secret hygiene, live API discovery ([629bb82](https://github.com/MikeBild/subkit/commit/629bb828058f3f48f90e27cbe140448455fb02b1))
* **conversations,http:** file-attachment system + [@attachment](https://github.com/attachment):&lt;slug&gt; resolver ([80f0fdd](https://github.com/MikeBild/subkit/commit/80f0fdd55139890db21e45b026cd44ca7f460284))
* **conversations,llm:** tenant-snapshot converse pipeline + connector-template binding ([5beeeaa](https://github.com/MikeBild/subkit/commit/5beeeaab8ceea6543de7210cb27e5d26672a5385))
* **conversations,recipes:** multi-connector recipe binding via connector_bindings ([#54](https://github.com/MikeBild/subkit/issues/54)) ([cc8f735](https://github.com/MikeBild/subkit/commit/cc8f735b52a6b622f554317075ce41d8fa501dfc))
* **conversations,sk:** draft checkpoints + skill autoload + sk session commands ([085578b](https://github.com/MikeBild/subkit/commit/085578b7df973b901c5dd1eb8a42fb68c72d3c15))
* **conversations,sk:** guided authoring — real preview, probe/commit gates, resume summary, context block ([0e2178e](https://github.com/MikeBild/subkit/commit/0e2178ec07dbc219228b3a71dc46098bc3718272))
* **conversations,sk:** tool-policy hooks (credentialFields, prerequisites, buildPendingOutput) + setup-validation in /v1/status ([984aeb0](https://github.com/MikeBild/subkit/commit/984aeb04efb6fb6dabebd535f3620d8e01f86779))
* **conversations,workflows:** build_workflow one-shot + sampleToSchema ([6a0fdff](https://github.com/MikeBild/subkit/commit/6a0fdff207092e988fe2f75dcf4e7e2a1801993f))
* **conversations:** add match_connector_template_by_url and import_connector_from_spec tools ([47e8600](https://github.com/MikeBild/subkit/commit/47e8600c5e7d41328126e77729f6895ee5d2020d))
* **conversations:** add transform_authoring_requires_inspect gate ([82ad3ec](https://github.com/MikeBild/subkit/commit/82ad3ec4109249b609484d008f352ee06955924f))
* **conversations:** anchor tool calls + elicitations to parent message ([baadbbb](https://github.com/MikeBild/subkit/commit/baadbbbd932ea70786e91ef650e485422a7135cb))
* **conversations:** chat-authored schedules + loop hardening ([#187](https://github.com/MikeBild/subkit/issues/187)) ([d72b20a](https://github.com/MikeBild/subkit/commit/d72b20abb4868d63557fba822e00dde54bffb9e4))
* **conversations:** discovery artifact tools — list / get / approve ([a932cfb](https://github.com/MikeBild/subkit/commit/a932cfb780a78a6aec4abe53c9078f9c5c1b41c4))
* **conversations:** dry_run_transform — jsonata/jsonpath/template probe ([49689d9](https://github.com/MikeBild/subkit/commit/49689d94ca93446545184ce77b68a0aed0722565))
* **conversations:** generic update_&lt;resource&gt; tools across all CRUD-shaped resources ([d5cc559](https://github.com/MikeBild/subkit/commit/d5cc559657e027837c574a09eef52846e1b28cd4))
* **conversations:** probe_connector tool — authenticated one-shot HTTP probe ([bef2f2a](https://github.com/MikeBild/subkit/commit/bef2f2a5beb07ca12a42f6ddc9463fbd0b25bef5))
* **conversations:** SDK tool-calling loop with streamText + fallback (A5) ([a2670a2](https://github.com/MikeBild/subkit/commit/a2670a27e5a20a73b50e91b0f3a76fd8f0d29a8b))
* **conversations:** static verifier + onboarding hint ([a4adc9c](https://github.com/MikeBild/subkit/commit/a4adc9c735e663b55f39bd1295ad9cedbd7e879d))
* **conversations:** wire interaction_log events through elicitation flow ([8fbd6a3](https://github.com/MikeBild/subkit/commit/8fbd6a3474df2376b2364ee803e3ad4aeb1315a9))
* **conversations:** wire transform-authoring gate into build_workflow and update_param ([61bbf27](https://github.com/MikeBild/subkit/commit/61bbf27c3bc3af7e363256e813f8f38788d1e5ea))
* **credentials,connectors:** A4 token_mint mode + Salesforce OAuth2 password grant ([a35b4fe](https://github.com/MikeBild/subkit/commit/a35b4fe21d6a45e0bb686865e2b58db123d0e8c5))
* **db:** migration 0028 convo-quality — skills seed, attachments, DLP, drafts ([7d3cf97](https://github.com/MikeBild/subkit/commit/7d3cf9703bdd0a7ad8f6a3ab2041a4c5edd7f342))
* **deploy:** consolidate local + CI deploy into one versioned pipeline ([f18e76b](https://github.com/MikeBild/subkit/commit/f18e76bf930758412b917bfe1bf4838f541deb13))
* **deploy:** switch production engine to engine-with-cli + sync prod compose per release ([9ecdf7d](https://github.com/MikeBild/subkit/commit/9ecdf7d329e0095d8606e667da08be9467974604))
* **discovery:** codebase archive upload + extractor ([b6c4a0a](https://github.com/MikeBild/subkit/commit/b6c4a0af7f2f90f414d23d32158dd325f1020c67))
* **discovery:** postgres+mssql introspection, SDL corpus, html→markdown, swaggerhub /apis-docs ([cd4fcae](https://github.com/MikeBild/subkit/commit/cd4fcae46618f4b87eb834c71d6652bb4a1489d7))
* **docs-ingestion:** knowledge-ingress cascade orchestrator ([e95c018](https://github.com/MikeBild/subkit/commit/e95c018763906d32c778ad9c0219a6cd79a74435))
* **docs,knowledge:** close 8 documentation+knowledge gaps to reach reference parity ([c0b8ddf](https://github.com/MikeBild/subkit/commit/c0b8ddf42c2c0b3fec208fef1b1256913bd1d1c1))
* **e2e+engine:** real-LLM E2E suite + diagnostics endpoint + provider routing fix ([83f6b09](https://github.com/MikeBild/subkit/commit/83f6b09722f64a3bcb6a05a4a3bfa4c523d3987b))
* **engine,connectors:** add CloudWatch + STS + EventBridge + OAuth2 templates with recipes ([d06dcf6](https://github.com/MikeBild/subkit/commit/d06dcf62c2641f8efea89265ad915ed22879c8b9))
* **engine,connectors:** widen save_connector_draft credential union with cognito_user_password + aws_sigv4 ([2158bba](https://github.com/MikeBild/subkit/commit/2158bba067dc925a593da9b1cb503c16f06830a1))
* **engine,conversations:** per-step model routing, tool-call repair, deterministic critic, streaming guard short-circuit ([eb71e22](https://github.com/MikeBild/subkit/commit/eb71e22b1c8096ca403fed9f48b6ace62fd3b96b))
* **engine,llm,conversations:** enrich recipe context + add inspect_recipe tool ([32c1d4f](https://github.com/MikeBild/subkit/commit/32c1d4fcd1211fa570182ebd37748b7c51c0f969))
* **engine,llm:** add critic rubric + step-router scaffold for the converse loop ([f95b688](https://github.com/MikeBild/subkit/commit/f95b68839bb8550e633a030551c5a5479db17dd5))
* **engine,llm:** default enable_prompt_cache to true ([bfa435b](https://github.com/MikeBild/subkit/commit/bfa435bf2f956b5f64b61ea1d29a06609af8733e))
* **engine,recipes:** add demonstration recipes for unused step primitives ([06bb860](https://github.com/MikeBild/subkit/commit/06bb860e6a15d4584a9e80d3bf2d438220bee628))
* **engine,recipes:** add lint:recipes quality gate + intent_keywords fixer ([3c8a403](https://github.com/MikeBild/subkit/commit/3c8a4030e1972fba2c4015679a3d611b7f1afb35))
* **engine,recipes:** extend ConnectorRecipeSchema + migrate 190 recipes ([7bcee7e](https://github.com/MikeBild/subkit/commit/7bcee7eb00869c5eb2181b03b6a56bf397b7d8ba))
* **engine,sk,mcp,http:** expose recipes on HTTP + CLI + MCP surfaces ([d2bc7d0](https://github.com/MikeBild/subkit/commit/d2bc7d01b98b771f9cb0df3ef6be9560ae0849fe))
* **engine,workflows,execution:** wire per-step outputs[].secret scrubber ([f72ddd4](https://github.com/MikeBild/subkit/commit/f72ddd442bb1edc41e528817d1c96ae5a7b23128))
* **engine:** add --issue-admin-key CLI flag for droplet ops ([a9a4d90](https://github.com/MikeBild/subkit/commit/a9a4d90e7792925faa539acf252814dd81d59efa))
* **engine:** add structured runtime logs and enterprise compliance audit trails ([97f4ae7](https://github.com/MikeBild/subkit/commit/97f4ae7a493ef60ece18523a18af93671b96962e))
* **engine:** answer-before-action, vendor-recipe lookup, visible approvals, output-guard repair ([0798405](https://github.com/MikeBild/subkit/commit/079840588e6b7f1ac82c6382dea71adbce4aa9e3))
* **engine:** grounded-output guard, runtime context, abstention + transcript-closing slice ([079ee9f](https://github.com/MikeBild/subkit/commit/079ee9fd290e46abf94c51b64fcea2a8a175598a))
* **engine:** implement Approach 2 pre-analyzed multi-step workflows ([f793e52](https://github.com/MikeBild/subkit/commit/f793e52724a75bc0f04c9d303871272cd1f97e31))
* **engine:** seed RBAC essentials on startup ([7329df6](https://github.com/MikeBild/subkit/commit/7329df67fe836c9bb8c9ad21e3cd8f12bac18040))
* **engine:** shared schema spine + observability + audit coverage ([603c7ec](https://github.com/MikeBild/subkit/commit/603c7ecdeb2a02c4f2a84170c90e469500e82fcf))
* enhance connector recipes and authoring determinism ([61a3f85](https://github.com/MikeBild/subkit/commit/61a3f85d9166fecb5c8f7d236303ed1337d32d62))
* **eval:** aggregate metrics + integration fixtures ([8ca6759](https://github.com/MikeBild/subkit/commit/8ca675957f8cd54ee640516e9d93e95a6b0018b7))
* **eval:** conversation-quality fixtures + validators ([0208e5a](https://github.com/MikeBild/subkit/commit/0208e5ad5f8705cfd2b0b9d3979c15ab088b9058))
* **events:** publish connector.oauth.callback_succeeded externally + complete the channel enum ([a72f10b](https://github.com/MikeBild/subkit/commit/a72f10b0ce4dde77b16e26dce1241467fe1c7870))
* **execution:** definition-driven run model with saved/draft/step sources ([40131f8](https://github.com/MikeBild/subkit/commit/40131f874406d8d0e580e8ebdcf506355ebc0162))
* **execution:** per-step retry overrides + response-filter scopes ([be6181f](https://github.com/MikeBild/subkit/commit/be6181f0449364df8995daf6c8be758a23f6a879))
* **execution:** S3-backed large-payload offload ([f1d6fae](https://github.com/MikeBild/subkit/commit/f1d6faed060adade199e78e0118d8876ecb16830))
* **execution:** surface request_meta and connector_resolutions in run result ([5aa1708](https://github.com/MikeBild/subkit/commit/5aa170886859dc2297b5e018d134384d0fd5c83d))
* **execution:** tenant DLP layer — response-filters with defaults ([4ce6c1f](https://github.com/MikeBild/subkit/commit/4ce6c1f3b24ea65e4499d3050282c95a046a01d8))
* **http,mcp,self-healing:** expose URL match and spec import, rate-limit classifier, inline_schema indexer ([693c2ea](https://github.com/MikeBild/subkit/commit/693c2eae1dab9a48186b6cd0e87960b54422721b))
* **http,sk:** /v1/settings routes + sk settings command ([600e33c](https://github.com/MikeBild/subkit/commit/600e33cd2b949768093195b9558a2da3a32537de))
* **http:** GET /install route serves a sk install script (Tailscale pattern) ([9477535](https://github.com/MikeBild/subkit/commit/947753566dc63209dbac3dfe6ad2999b0c6b3139))
* **install:** bundle sk + tunnel-agent binaries inside engine image (closes [#64](https://github.com/MikeBild/subkit/issues/64)) ([31f2280](https://github.com/MikeBild/subkit/commit/31f22804e2521ed3c6461a3768cce34bc5b55a61))
* **llm+conversation:** parity wiring — core, tools, policies, confirmation, streaming, eval ([6fa9794](https://github.com/MikeBild/subkit/commit/6fa9794107432cb1098faa5bd9b8ad5583bbeead))
* **llm:** extended converse prompt + five pseudo-message builders ([68ef177](https://github.com/MikeBild/subkit/commit/68ef17792c19fc3648eab47a00957bf00aacb8d4))
* **llm:** generateObject + prompt caching + provider registry ([b8928cb](https://github.com/MikeBild/subkit/commit/b8928cbb86f04db481b5ea790e093b22f4256dcf))
* **llm:** per-flow env provider/model overrides ([a8b143c](https://github.com/MikeBild/subkit/commit/a8b143c4d614b91e7f1e9e12602984d23884c861))
* **llm:** per-tenant vendor-recipe overrides ([057ff88](https://github.com/MikeBild/subkit/commit/057ff881d875feab787445195dec38c3297ba6a6))
* **llm:** placeholder substitution system — parser + resolver + get_connector ([b7edbb3](https://github.com/MikeBild/subkit/commit/b7edbb36e44ecd9baab49dfa4b79a4e97259539f))
* **logging:** add errorFields helper to surface drizzle .cause ([f7ded93](https://github.com/MikeBild/subkit/commit/f7ded93a0e5a9b72ac7f8c9a69ca771081566370))
* **mcp:** destructive-action gate, synthesized input schemas, transform warnings ([7301007](https://github.com/MikeBild/subkit/commit/7301007e4700ac2066dbb0a36f893489faec9e17))
* **mcp:** mode-split tool catalog with native authenticate tool ([868dd1d](https://github.com/MikeBild/subkit/commit/868dd1dea22bfc570bda4fce27d67097cca51132))
* **oauth2:** auto-resume conversation on OAuth callback via pubsub + SSE ([3c55a83](https://github.com/MikeBild/subkit/commit/3c55a8377d986f558eb0ae7fb67a2a76e26cb444))
* **observability:** langfuse tool spans + defense-in-depth redaction ([f0cf866](https://github.com/MikeBild/subkit/commit/f0cf866f8ab51950d39fae98d0b217a92fbc028c))
* **observability:** OpenTelemetry tracer bootstrap with Langfuse (A6) ([c7e53d5](https://github.com/MikeBild/subkit/commit/c7e53d5790f97a32bd31cf85741a4353607dc76d))
* **onboarding,http,sk:** first-run bootstrap thin-slice + POST /v1/setup + sk init ([#60](https://github.com/MikeBild/subkit/issues/60)) ([11789dd](https://github.com/MikeBild/subkit/commit/11789dd64d782ac1202825f8bf5c5692e1cef33a))
* **onboarding:** demo-seed workflows + expertise tone hint ([db86d77](https://github.com/MikeBild/subkit/commit/db86d77228417e2da7eead43c73865a805004bfa))
* **output-guard:** chat-first scanner — runtime gate for curl/shell suggestions ([5b9abfd](https://github.com/MikeBild/subkit/commit/5b9abfdc4dc9018131a5df8b59f8dd02a576c442))
* P11 elicitations and Claude Code UX for sk ([1e7e89c](https://github.com/MikeBild/subkit/commit/1e7e89cb0a12139401d5fdfcf0f3fe59d6cd4861))
* **release/version.sh:** current_version = max(manifest, package.json) ([51c2f15](https://github.com/MikeBild/subkit/commit/51c2f153f60290e8a9844fd98857c76511b261fc))
* **sandbox:** sk-stdlib with version tracking and drift detection ([2d5fe5f](https://github.com/MikeBild/subkit/commit/2d5fe5f5449fcdffce6f2cd5bb0c40bcc7beaba3))
* **scheduler,recipes,sk:** schedule trigger end-to-end (cron+tz+skip) ([#47](https://github.com/MikeBild/subkit/issues/47)) ([c17265f](https://github.com/MikeBild/subkit/commit/c17265f1eec44afb8358f5b206eded1a9c8a209e))
* **security,execution,discovery,sk:** conversational creation rebuild round 2 — SSRF guard, pagination resume, GraphQL+llms.txt+playwright discovery, multi-driver call_connector, sk CLI ergonomics ([d9125c7](https://github.com/MikeBild/subkit/commit/d9125c7ae214ec02fccf9f96c2288fcb6e8e0459))
* **self-healing:** proactive drift scan + admin HTTP/MCP/sk surfaces ([acb1837](https://github.com/MikeBild/subkit/commit/acb183768c5a36c4e861c391546d459fb223d308))
* **self-update:** harden audit, signing, rollback, /v1/health ([#151](https://github.com/MikeBild/subkit/issues/151) P0) ([#158](https://github.com/MikeBild/subkit/issues/158)) ([fc87016](https://github.com/MikeBild/subkit/commit/fc87016acf9d77887869823a9771b1eaf7cffafa))
* sk ctx gauge + engine context-window safety fixes ([#74](https://github.com/MikeBild/subkit/issues/74)) ([a7edb1d](https://github.com/MikeBild/subkit/commit/a7edb1dd44bfb026599a00a4218223c89e999fcb))
* **sk,approval:** describeApprovalTarget helper + richer external-write card ([35c0f06](https://github.com/MikeBild/subkit/commit/35c0f06cfcdd49ac8612169dac22df553558f044))
* **sk:** /settings 10-tab palette + connector hub + fork-from-message ([#159](https://github.com/MikeBild/subkit/issues/159)) ([#161](https://github.com/MikeBild/subkit/issues/161)) ([3b1ad61](https://github.com/MikeBild/subkit/commit/3b1ad61347b26bf277eff8210b8f1392d4cdce52))
* **sk:** add full debug trace logging ([236d978](https://github.com/MikeBild/subkit/commit/236d978c13d90f7aaf2b2ad8f268b4a81abd4b9e))
* **sk:** add setup diagnostics UX ([5ba0c73](https://github.com/MikeBild/subkit/commit/5ba0c7308f611efc39a9f2baabb9176959cefc68))
* **sk:** consolidate subkit admin CLI into unified sk binary ([13f38cc](https://github.com/MikeBild/subkit/commit/13f38cc0f93f42a9d499f8420682b37396221dde))
* **sk:** doctor command for first-line operator diagnostic ([6cf911d](https://github.com/MikeBild/subkit/commit/6cf911d020211846ed2fa26516bb7f587a871550))
* **sk:** enrich transcript and session surfaces ([049dc60](https://github.com/MikeBild/subkit/commit/049dc60c809d6cfcdbdb54fddc0e5a21795ed9ed))
* **sk:** full CLI UX/UI overhaul — engine bootstrap + 13-token theme + 13 new components + PTY e2e ([#145](https://github.com/MikeBild/subkit/issues/145)) ([da7b8f7](https://github.com/MikeBild/subkit/commit/da7b8f7990f5bf44207e20a76525d7aa19cd9e96))
* **skills,connectors,llm:** A1 + A5 + A6 — recipe-coverage gate, step_kind activation, recipe budget cap ([766fcbf](https://github.com/MikeBild/subkit/commit/766fcbfab81b3ad9103803c7eecce10ea75ef44f))
* **skills,tools:** 10 Markdown skills + seed loader + description compiler ([0bb0f27](https://github.com/MikeBild/subkit/commit/0bb0f2741ec2215ae79989aba30242c7672ec485))
* **sk:** next-command preview — ghost-text suggestion after every turn ([#162](https://github.com/MikeBild/subkit/issues/162)) ([4e7582b](https://github.com/MikeBild/subkit/commit/4e7582bbc1541c293e3696e80d472f356d18ff40))
* **sk:** run command supports saved/draft/step sources, new sk auth ([6775c0f](https://github.com/MikeBild/subkit/commit/6775c0f4c301aa9727f3bf5d3265402c13ecd1f8))
* **sk:** shift+enter and backslash-enter for newline (codex parity) ([3413aed](https://github.com/MikeBild/subkit/commit/3413aedc41efd82670e1b7170fbba2c9b6ccd586))
* **sk:** unify guided action UX ([bade164](https://github.com/MikeBild/subkit/commit/bade1642fcc234357c727472dd671eee0c6fe3ff))
* **tunnels:** add TCP passthrough for multi-protocol routing ([3d0db26](https://github.com/MikeBild/subkit/commit/3d0db2651d71988897d34d8d1ffe71e0f3887d88))
* unified files resource (sk-cli + engine + workflows + LLM context) ([#186](https://github.com/MikeBild/subkit/issues/186)) ([9c37da0](https://github.com/MikeBild/subkit/commit/9c37da0101c4c0beaceb70f6282f61b56bbf70bb))
* v3.0.0 release prep — gates, baseline, settings, type-safety, OSS surface ([790f3f7](https://github.com/MikeBild/subkit/commit/790f3f7a74ba8b5f148717701a35affaeff45081))
* **webhooks,recipes,sk:** webhook trigger end-to-end Stripe → Slack ([#46](https://github.com/MikeBild/subkit/issues/46)) ([7ca43e4](https://github.com/MikeBild/subkit/commit/7ca43e449348d3ab861c34202032448d3e5877cd))
* **webhooks:** failure classification, dead-letter, payload-reconstructing replay ([aa31f7b](https://github.com/MikeBild/subkit/commit/aa31f7ba274aac9e2332e65b89c3333045eb8481))
* **workflows,audit,webhooks,scheduler:** WorkflowDef.trigger + reverse bind/unbind + AuditAction sweep ([#67](https://github.com/MikeBild/subkit/issues/67)) ([504fce4](https://github.com/MikeBild/subkit/commit/504fce495e2482620709030d4ebb59eb9f49e80f))
* **workflows,execution,audit:** [#48](https://github.com/MikeBild/subkit/issues/48) wait restart-safety + 24h cap + step-level audit pair ([3f92edb](https://github.com/MikeBild/subkit/commit/3f92edba14eed575860617f58319ec351dba5f08))
* **workflows,execution,audit:** per-run LLM token budget + external_write audit ([#53](https://github.com/MikeBild/subkit/issues/53)) ([1d126ff](https://github.com/MikeBild/subkit/commit/1d126ffb262e89cde26ffef8a26c4aa6e0a16729))
* **workflows,execution,http:** [#49](https://github.com/MikeBild/subkit/issues/49) wait-for-event with HMAC-signed approval URL ([98bb081](https://github.com/MikeBild/subkit/commit/98bb0813722c63214a6367be96eebc98fc2ac8de))
* **workflows,execution,llm:** [#51](https://github.com/MikeBild/subkit/issues/51) persistent per-workflow state for cross-run cursors ([49163cc](https://github.com/MikeBild/subkit/commit/49163cc5cc0504e64a98d66483b6c44a6d09540d))


### Bug Fixes

* **agent:** handle --version / -v before parseArgs ([8f4e58a](https://github.com/MikeBild/subkit/commit/8f4e58acc6899ab2ebecaef496ef7f888c4d1f4e))
* align authoring, eval, and sk surface contracts ([22a1eb6](https://github.com/MikeBild/subkit/commit/22a1eb6157071c305fbabb77766ebd9e39c8bc72))
* **audit:** emit full {items,next_cursor} envelope in JSON mode; broaden auth error regex ([5e18177](https://github.com/MikeBild/subkit/commit/5e18177346b0b997319140093731c44dda2cd5f0))
* **audit:** pr_template skips release-please-generated PRs ([eaa95a1](https://github.com/MikeBild/subkit/commit/eaa95a1ea1ed2e35a04d4fc2cafcf96a0841296c))
* **authoring:** harden seeded skills and graphql drafts ([75b0b8a](https://github.com/MikeBild/subkit/commit/75b0b8a0e26c8347b6a4e42530a1eb067f8f42d8))
* **build:** commit bun.lock so Docker build + frozen-lockfile work ([6218a3a](https://github.com/MikeBild/subkit/commit/6218a3a08f1f9ee66efaf4d9060be8a6c5e7462f))
* **build:** defer jsdom xhr-sync-worker require.resolve for bun compile ([c56e27e](https://github.com/MikeBild/subkit/commit/c56e27e9b66f161688af315c4e1f9811f714df85))
* **build:** patch css-tree to use static ESM JSON imports for bun --compile ([a4b924f](https://github.com/MikeBild/subkit/commit/a4b924f8f0f39c3a2048bec257a900f0303b7acf))
* **chat-ui/elicit:** finish TextPrompt single-owner input rewrite ([24fad4f](https://github.com/MikeBild/subkit/commit/24fad4f8352748701565da19077018035310ea5d))
* **chat:** avoid double rate-limit on notifications dispatch path ([9eb5dae](https://github.com/MikeBild/subkit/commit/9eb5dae57fdc00702858cd9ed1e2d82ded0e0ee3))
* **ci/release:** grant actions:read so publish-release can gh run download ([870604a](https://github.com/MikeBild/subkit/commit/870604aa76efb7cebbbeafb993c3f7abda55762b))
* **ci:** ci.yml accepts workflow_dispatch so release gate can dispatch it ([753400f](https://github.com/MikeBild/subkit/commit/753400f4b3e7c3533a5f99e307f224d4bbe24d50))
* **ci:** cross-compile darwin-x64 from macos-14 to escape macos-13 queue ([45684dc](https://github.com/MikeBild/subkit/commit/45684dcfc7851e692a981f7c3b2c74aba97e571d))
* **ci:** deploy health check via Docker HEALTHCHECK, not host port ([d878635](https://github.com/MikeBild/subkit/commit/d878635fc17b36327358e2d0d24e75d9e5211d70))
* **ci:** drop release:published trigger to prevent dual-fire ([a0dcc6d](https://github.com/MikeBild/subkit/commit/a0dcc6da1904fb5a6206f4b0a4b833a16df45184))
* **ci:** gate Docker + deploy jobs on DEPLOY_ENABLED repo variable ([858a756](https://github.com/MikeBild/subkit/commit/858a7563b0d625202dcda15d806e245bce6e455e))
* **ci:** gate gitleaks + dependency-review for private repos ([cf7f011](https://github.com/MikeBild/subkit/commit/cf7f011655a17352ee32eaead7b3f6393270afb3))
* **ci:** gate publish/deploy jobs on tag ref ([a0a90b6](https://github.com/MikeBild/subkit/commit/a0a90b63f2f7f86271cb04b21dcca479db6ac4fe))
* **ci:** invoke terminology gate with bash, not sh (dash lacks pipefail) ([7073c08](https://github.com/MikeBild/subkit/commit/7073c0893cc28f72bd262d48ddd955bdabb2655a))
* **ci:** matrix build ships all 20 binaries, not just 4 windows ([c4a0458](https://github.com/MikeBild/subkit/commit/c4a0458ee44b84c6e3c3b77a7f3f8726137ebb7b))
* **ci:** pin Bun to 1.3.12 so release binaries sign cleanly on darwin-arm64 ([a620c50](https://github.com/MikeBild/subkit/commit/a620c50c06e2463c140ca269fe01355f61c8751c))
* **ci:** publish-release — per-artifact retry via gh run download ([024aeb0](https://github.com/MikeBild/subkit/commit/024aeb08842f73f5ab51fb6dc02a5fb38e4c7dff))
* **ci:** release deploy retry now captures the real ssh exit code ([0d2853b](https://github.com/MikeBild/subkit/commit/0d2853b426c900939cb7abcaadf72bb68133b9b5))
* **ci:** release gate dispatches ci.yml against tag ref, not SHA ([1bbc8d8](https://github.com/MikeBild/subkit/commit/1bbc8d8bed4a5e2c8a28cb71af9f9c06e44f3c7a))
* **ci:** release workflow — trigger on `release: published` + manual dispatch ([397f339](https://github.com/MikeBild/subkit/commit/397f33927c1659cb1fd29dff889ce73f075028cc))
* **ci:** release.yml gate needs actions:write to dispatch ci.yml ([ebdd3b6](https://github.com/MikeBild/subkit/commit/ebdd3b660eea2a6de3877ea77119eae8dff46d01))
* **ci:** retry once on Tier 1.x real-LLM nightly flake ([83b68c3](https://github.com/MikeBild/subkit/commit/83b68c38546199943eab28db77689d28b542564d))
* **ci:** retry transient SSH failures during release deploy ([ffa336a](https://github.com/MikeBild/subkit/commit/ffa336ae5a8b8808f0a81f5e50b758b12977cbc5))
* **ci:** stop biome reformatting auto-generated embedded.ts ([28c283b](https://github.com/MikeBild/subkit/commit/28c283b95fa59c6f5c82a142effaf1edbbbe2c52))
* **ci:** unblock secret-scan, bump nightly model, fix tier-1.3 gate ([f9de0b7](https://github.com/MikeBild/subkit/commit/f9de0b7ef0ecadbe7ace728fc4c1d89aa53a272f))
* **ci:** wire inputs.tag end-to-end for dispatch-from-main recovery ([ffba285](https://github.com/MikeBild/subkit/commit/ffba2855c5a25eda90d8cdbe78bca578a68d6b32))
* **cli-core,sk:** treat empty objects as effectively empty content ([82781a2](https://github.com/MikeBild/subkit/commit/82781a2414bc6e77bc87da0a6905f03806ae12d1))
* **compose:** seed service must not try to pull subkit/migrate:local ([#73](https://github.com/MikeBild/subkit/issues/73)) ([eb11810](https://github.com/MikeBild/subkit/commit/eb11810bde49ea0e8c0b985e485f6e4c5f8a5239))
* **config:** trim server.public_base_url description to ≤200 chars ([ee72940](https://github.com/MikeBild/subkit/commit/ee72940fee92c59dd0b9b3bfc1334e36e901200e))
* **connectors,authoring:** reuse saved connectors by URL + GraphQL step-level headers + workflow upsert clarity ([edfade0](https://github.com/MikeBild/subkit/commit/edfade0982e3be1b98cf5ed7f544317bc762c4f4))
* **connectors,authoring:** seed config.oauth from URL-matched template so cache + probe see the Cognito flow ([f2819bc](https://github.com/MikeBild/subkit/commit/f2819bc0f185839b12654964ccfbb3dfa4473ee5))
* **connectors,authoring:** stop the AppSync re-prompt loop — upsert connectors, widen aws_region lookup, parse AWS JSON, honour step Authorization ([f5c0143](https://github.com/MikeBild/subkit/commit/f5c0143cffe5082a2033efa41740498615ba6d25))
* **connectors,authoring:** URL match wins among multi-template candidates + OAuth2 metadata URLs allow-listed ([2a1d13c](https://github.com/MikeBild/subkit/commit/2a1d13cc070323d694edd14636d9c2b7609b4c87))
* **connectors,authoring:** URL-pattern match wins over text match for connector template selection ([3e51cb9](https://github.com/MikeBild/subkit/commit/3e51cb9344bf0a056eb91a8c35bd2a13f08ecb68))
* **connectors,credentials:** cache draft creds for oauth2/cognito + aws_sigv4 from ask_user_form ([3df7774](https://github.com/MikeBild/subkit/commit/3df7774d70d55112c19a78847dc0cd36b7782a68))
* **connectors,credentials:** wire cognito_user_password + aws_sigv4 bootstrap into draft credential flow ([ed14263](https://github.com/MikeBild/subkit/commit/ed142631f3fcb0a18e6f750257f59bc0f6165fb5))
* **connectors,docs:** recipe-lint + subsystem-count parity for the recipe-sweep batch ([8ddb13c](https://github.com/MikeBild/subkit/commit/8ddb13c7ac7e592805f2e5c47543856231040cda))
* **connectors:** apply draft-time bearer/header/basic auth from config ([c686133](https://github.com/MikeBild/subkit/commit/c686133fad89b9a69296fd924ab22e846645921d))
* **connectors:** refresh square + gitlab OpenAPI ingestion URLs ([#75](https://github.com/MikeBild/subkit/issues/75)) ([42ca197](https://github.com/MikeBild/subkit/commit/42ca197b73cc89c6cc8e90a36d0231351c72992b))
* **connectors:** templates.json schema accepts new auth + nullable fields shipped with auth-flows ([34a6971](https://github.com/MikeBild/subkit/commit/34a6971873f722f7f952a538c3c7e4a7e444a5cc))
* **conversations,cli:** honor permission_mode + update-in-place commit_draft + selection-safe transcript ([c80a47c](https://github.com/MikeBild/subkit/commit/c80a47c6dfd159528f90290c1fe67abf8141f934))
* **conversations,sk:** chat-first repair palette, single-confirmation, speaker labels, paste UX ([5ddd22e](https://github.com/MikeBild/subkit/commit/5ddd22e4acf0241c3ad35a988cc8a09455416d3b))
* **conversations,sk:** close 12 root-cause UX gaps from real-user transcript ([aa84cd0](https://github.com/MikeBild/subkit/commit/aa84cd08704076795b103e67e7e72369be6a5b44))
* **conversations,sk:** permission_mode=auto skips ask_user_confirm; bare 'approve' resolves open elicits ([f0e9116](https://github.com/MikeBild/subkit/commit/f0e9116429e56256ae8c4eba61f3f83afb83ef13))
* **conversations,workflows:** kill the parallel-run_workflow loop + add update_workflow ([e4f342c](https://github.com/MikeBild/subkit/commit/e4f342c27027728f3d1bfac73f87c47e4a1498b5))
* **conversations:** auto-resolve ask_user_confirm when permission_mode=auto ([7f43dea](https://github.com/MikeBild/subkit/commit/7f43dea45136641914e0d9b21a83b2120894c2f2))
* **conversations:** canned list-users plan force-commits past probe gate ([070741f](https://github.com/MikeBild/subkit/commit/070741ff40d46904d6a18673bac350ac953feb6f))
* **conversations:** cleanup tools always reachable + auto-mode skips commit_draft confirm ([71fe903](https://github.com/MikeBild/subkit/commit/71fe903cbcd82f94deddba17a65eef12be767a99))
* **conversations:** close 3 root causes behind "omitted_chars" output and missing schedule tools ([d851d60](https://github.com/MikeBild/subkit/commit/d851d606f0ba116ee183e82fe644b486baaf4c8e))
* **conversations:** drop silent slug-adopt; require explicit target_workflow_id ([1a518d6](https://github.com/MikeBild/subkit/commit/1a518d632159778e72b493bea80405847a5df955))
* **conversations:** edit_workflow_patch gates fire on DELTA, not pre-existing state ([27ebdcd](https://github.com/MikeBild/subkit/commit/27ebdcd8548d85fd20c945076f1a0b17845740b9))
* **conversations:** probe-evidence exemption recognises placeholder-based connector binding ([54d24f5](https://github.com/MikeBild/subkit/commit/54d24f5dbea9639a9b3724a40db70fa372c70c53))
* **conversations:** single-token-entry connector save + loop-item teaching + override warning ([0cbd8f4](https://github.com/MikeBild/subkit/commit/0cbd8f49d382744ed6687c0a7ab4d4336a875047))
* **conversations:** steer toolChoice from explicit user run intent ([af8f94c](https://github.com/MikeBild/subkit/commit/af8f94c2f1a3d9f1470c66e15a2baad871dcfcd7))
* **conversation:** unblock workflow output read path + URL-driven authoring [skip-review] ([#183](https://github.com/MikeBild/subkit/issues/183)) ([23b7f33](https://github.com/MikeBild/subkit/commit/23b7f33a15215b2e993847fa241c89fbeace7d2a))
* **credentials:** cognito_user_password persists username/region/use_access_token for refresh ([50a29fb](https://github.com/MikeBild/subkit/commit/50a29fb56f57902f046bae57e2e87ad7a47a3284))
* **db:** idempotent migrations + hash-first runner ([22bdc44](https://github.com/MikeBild/subkit/commit/22bdc4461c731c21955aa83995f2e86d0fa2273d))
* **db:** reconciliation SQL for legacy-lineage drifted droplets ([cd1c983](https://github.com/MikeBild/subkit/commit/cd1c983e61e178920536ca49faddf9b27e2c718c))
* **deploy.sh:** portable mkdir-based lock (flock absent on macOS) ([3944c1e](https://github.com/MikeBild/subkit/commit/3944c1e3c660713f8d202f81ce32d26688038348))
* **deploy:** caddy step uses --no-deps to avoid postgres recreate ([6d575ff](https://github.com/MikeBild/subkit/commit/6d575ff51e4ebe63a9cf703dd842db67b85601a7))
* **deploy:** honor CONFIGURATION_DIRECTORY + seed persistent files.dir ([2629a17](https://github.com/MikeBild/subkit/commit/2629a17a2d1c6c7888674785240bac18a9077d8c))
* **deploy:** sync base compose + Caddyfile to droplet on every release ([2c50d4c](https://github.com/MikeBild/subkit/commit/2c50d4cc0ea2a75f0b6855f94f2d573c8718a63b))
* **deploy:** thread VERIFY_API_KEY + SSH_HOST + SKIP_* into verify.sh ([298bcbe](https://github.com/MikeBild/subkit/commit/298bcbee05c12e52efce67e7ce1a2db329b12766))
* **docker-e2e:** create dummy-http connector inline, don't rely on seed ([#80](https://github.com/MikeBild/subkit/issues/80)) ([f3ba102](https://github.com/MikeBild/subkit/commit/f3ba1021032e7c1e950603a9b242bc830225a836))
* **docker-e2e:** drop stale 'rejects invalid workflow' assertion ([#81](https://github.com/MikeBild/subkit/issues/81)) ([f9b56ba](https://github.com/MikeBild/subkit/commit/f9b56ba13334cfae521e1497e8d5c2843edf5b7b))
* **docker:** copy scripts/ before bun install so postinstall runs ([fac4318](https://github.com/MikeBild/subkit/commit/fac43185d9b65fb3f8c210d3e4efef63ceae3e19))
* **docker:** pre-create /etc/subkit/ chown'd nobody for engine container ([#136](https://github.com/MikeBild/subkit/issues/136)) ([a6bf960](https://github.com/MikeBild/subkit/commit/a6bf9601be3a7ebe27f1ba5f800ab4ade86cd5af))
* **docker:** split engine-with-cli into a separate Dockerfile ([742e09b](https://github.com/MikeBild/subkit/commit/742e09b29f306b808f2dbdf53be95f6da8cad758))
* **e2e:** accept peer tools in Tier 1.3 + 1.4 real-LLM assertions ([f28c479](https://github.com/MikeBild/subkit/commit/f28c479e9de9742f58604d399ad26da4d315ceaf))
* **e2e:** align weather/sk-user-story/deep-surface with paused-stop behavior ([809e999](https://github.com/MikeBild/subkit/commit/809e999018d9cdfbc262aa1d54b6a558910431a5))
* **e2e:** drop dag wrapper from mcp-surface delete-workflow fixture ([c2735a1](https://github.com/MikeBild/subkit/commit/c2735a1ed78d3245d6c4770187a621433141dc97))
* **e2e:** tier-1 real-LLM suite skips cleanly when LLM_PROVIDER=mock ([9f8d0f1](https://github.com/MikeBild/subkit/commit/9f8d0f18fa00cf96237a2f8d7d622d40642b1d53))
* **engine,authoring:** clean six-phase connector lifecycle + nested config.oauth + url placeholder validator ([cfdbceb](https://github.com/MikeBild/subkit/commit/cfdbceba8a56a12ffaf8478fb8be66a085e8478f))
* **engine,auto-persist:** fall back to template oauth metadata when draft.config.oauth is empty ([8fd37fc](https://github.com/MikeBild/subkit/commit/8fd37fcc3089180d601574aee8d09c2ce0b3c71d))
* **engine,connectors:** nightly+weekly findings — thinking adaptive, URL probe + template URLs ([#76](https://github.com/MikeBild/subkit/issues/76)) ([ec2bc16](https://github.com/MikeBild/subkit/commit/ec2bc16b8207de2ed7d543ea92535fb90b325ec0))
* **engine,conversations:** auto-freshen connector checkpoints before save ([516d408](https://github.com/MikeBild/subkit/commit/516d408da784f4a2da50e2f712bd106ae99748be))
* **engine,conversations:** force tool-call after auto-persist save when user asked for connector AND workflow ([1e4ae7f](https://github.com/MikeBild/subkit/commit/1e4ae7f095d4be58584feba87b374c815d1bdff8))
* **engine,conversations:** identity-gate commit_draft on draft slug pivot ([717a666](https://github.com/MikeBild/subkit/commit/717a666418966a3cb3b28d18c007bf39b87cd5be))
* **engine,conversations:** tighten commit-draft elicitation + extract credential-from-form helper ([4c1f409](https://github.com/MikeBild/subkit/commit/4c1f4098a0d1bc7eb61ad3922209d2a7d32145fb))
* **engine,http,tests:** unblock release CI on stale tests + missing aws_sigv4 route schema ([4f4fdef](https://github.com/MikeBild/subkit/commit/4f4fdef8992e6a20584e770109d2278511b4f9e8))
* **engine,sk,llm,docs:** close audit gaps + lock leads vs reference impl ([cfecc86](https://github.com/MikeBild/subkit/commit/cfecc86cc4d4a0023ab823a65a001471a1de6880))
* **engine,tests:** unblock pre-push gate — refresh 3 stale test assertions ([7e7b863](https://github.com/MikeBild/subkit/commit/7e7b86346c652f4de12602ef4572138fa082b7b1))
* **engine,workflows:** reject Authorization header on connector_id request steps ([5ddb16c](https://github.com/MikeBild/subkit/commit/5ddb16cccbcbfe4d83f55b6f87f094e7fee8194d))
* **engine:** /v1/status version from OPENAPI_INFO, not env ([1a231c0](https://github.com/MikeBild/subkit/commit/1a231c010cdf8459575973c9cbb668a471ed2f4c))
* **engine:** close Approach 2 wiring gaps + 3 journey-test regressions ([b7148e7](https://github.com/MikeBild/subkit/commit/b7148e7db931f471eecb4537f3ab7bc4d9c7d266))
* **engine:** close five anti-pattern classes surfaced by 730c568a ([713e486](https://github.com/MikeBild/subkit/commit/713e486ea8565eae3426e9d8c4c2413fd557b84e))
* **engine:** make env validation lazy so --smoke / --version run unconfigured ([8d02102](https://github.com/MikeBild/subkit/commit/8d02102956c267a4f713640bffb877b3f533332c))
* **engine:** restore build_workflow response contract ([1e8fa1e](https://github.com/MikeBild/subkit/commit/1e8fa1e9b6962c10e8bdfb820d752ff454af2bdf))
* **env-example:** clear AI_GATEWAY_MODEL so the pair check passes ([#79](https://github.com/MikeBild/subkit/issues/79)) ([17f191b](https://github.com/MikeBild/subkit/commit/17f191b78bd1959478c8ab148a8be6b34ffb905e))
* **execution,sk:** resolve loop-item placeholders, populate request_meta on failure, route free-text approvals ([c35ef1c](https://github.com/MikeBild/subkit/commit/c35ef1c86c97a735f0a5b228d77f48a56fb6912f))
* **firebase:** extract inline CSS/JS to external files ([ba36089](https://github.com/MikeBild/subkit/commit/ba360898a7895df6b718670269df1cf18038e20d))
* **hooks:** remove stale build:cli from pre-push gate ([950e555](https://github.com/MikeBild/subkit/commit/950e555b705e39d517ff82158b62ba3c202083cc))
* **hooks:** widen e2e test timeout to 60s ([d9f980a](https://github.com/MikeBild/subkit/commit/d9f980a2e89f296383b3f5c04a7de31168fcf479))
* **http:** import oauth callback event schema via pubsub/index, not pubsub/types ([f41be42](https://github.com/MikeBild/subkit/commit/f41be4267611f1f67df34a6bc33c86d136be9615))
* **install:** align port + sk command surface in docs ↔ code ([#124](https://github.com/MikeBild/subkit/issues/124)) ([6b6894e](https://github.com/MikeBild/subkit/commit/6b6894ee0918a60014a0aee31a9fcccee718cd11))
* **install:** release tag prefix + sk init --token follow-up ([#125](https://github.com/MikeBild/subkit/issues/125)) ([73e58da](https://github.com/MikeBild/subkit/commit/73e58da186ab8700116d30b036c2daffc7851f7f))
* **journeys:** per-hook 60s timeout + named teardown stack (closes [#98](https://github.com/MikeBild/subkit/issues/98)) ([#133](https://github.com/MikeBild/subkit/issues/133)) ([9094baa](https://github.com/MikeBild/subkit/commit/9094baa586cff3e88188bb7172fc4e02111778eb))
* **llm:** collapse to Vercel AI Gateway — root cause of v1.10.0 prod 500 cluster ([0a00705](https://github.com/MikeBild/subkit/commit/0a0070557f4129aa7330bebf10fab880a6521f51))
* **llm:** model-init tests tolerate @ai-sdk/anthropic not hoisted on CI ([82885bc](https://github.com/MikeBild/subkit/commit/82885bcaaa03a6721f13853ab5f275901c204d17))
* **mcp:** await audit.policy_denied write before returning MCP deny ([f5dfeff](https://github.com/MikeBild/subkit/commit/f5dfeff67749fdcdead9d3f16a29c2de30f164a8))
* **oauth2:** canonicalise token_type to Bearer + Google access_type ([c881456](https://github.com/MikeBild/subkit/commit/c881456e1b4ab097667645b4844c93ad9235a6ee))
* **oauth2:** close all gaps from the v4.7.3 deep review ([00992e1](https://github.com/MikeBild/subkit/commit/00992e19a8cab3becfd42712156d2f92e4513800))
* **oauth2:** discard SSE replay events received before the hello frame ([bb530a7](https://github.com/MikeBild/subkit/commit/bb530a7868eb58e3d61d9dc38d4ab97746e5c71a))
* **oauth2:** drop SUBKIT_PUBLIC_BASE_URL env fallback (retired key) ([0aa6041](https://github.com/MikeBild/subkit/commit/0aa60410f8c21268b3f85a92ff4ab9c0b0dbb096))
* **oauth2:** register migration 0017 + scrub banned-term ref ([56f3bfa](https://github.com/MikeBild/subkit/commit/56f3bfae18c05351cde90e071454b74978941835))
* **oauth2:** route through credentials index + annotate state lookup ([330a491](https://github.com/MikeBild/subkit/commit/330a491451c41a7452fe40443ea84f68596a3892))
* **oauth2:** synthesize canonical redirect_uri server-side ([dfa85b8](https://github.com/MikeBild/subkit/commit/dfa85b8b64b08992570c22391db286514a935608))
* **oauth2:** unblock OAuth2 connector save → authenticate → probe ([c5bbc18](https://github.com/MikeBild/subkit/commit/c5bbc18c23ef943529735839250950b73d944f9c))
* **rbac,cli:** resource-scoped execution RBAC, portal-token deny reason, slash MCP label drift ([2f348e4](https://github.com/MikeBild/subkit/commit/2f348e44e4c09d5ca6c75c3aba8eab0a52c67d89))
* **release/version.sh:** use prefixed vars to avoid clobbering caller's _SCRIPT_DIR ([cb69502](https://github.com/MikeBild/subkit/commit/cb6950212719328ed9627fe6c4276f566c7f47fc))
* **release:** align workflow + deploy.sh to DROPLET_* secret names ([4daf817](https://github.com/MikeBild/subkit/commit/4daf81725e2313744ee9c384534fa733ee644032))
* **release:** retry transient registry auth during deploy ([2458c79](https://github.com/MikeBild/subkit/commit/2458c793ff3deda43e1b0d155a6fd18b7d90f50d))
* **release:** tag_name emits v&lt;VERSION&gt;, not subkit-v&lt;VERSION&gt; ([#126](https://github.com/MikeBild/subkit/issues/126)) ([01a32a9](https://github.com/MikeBild/subkit/commit/01a32a9190519e3760eff020d0c87a9b54d2a393))
* **review:** close all PR [#152](https://github.com/MikeBild/subkit/issues/152) review WARN/SUGG (round 9) ([#153](https://github.com/MikeBild/subkit/issues/153)) ([7cded86](https://github.com/MikeBild/subkit/commit/7cded86bbda62cf768c5787d49194e450faeb3bb))
* **sandboxes:** embed sk-stdlib.js into compiled engine binary ([2c02125](https://github.com/MikeBild/subkit/commit/2c021255551704182c53dcb2f9b163521b2b17b0))
* **scheduler:** close two-engine race in reconcileWorkflowSchedules with CAS ([#103](https://github.com/MikeBild/subkit/issues/103)) ([7be268e](https://github.com/MikeBild/subkit/commit/7be268efa7f26bbfe8d3bd0b5c3e9365a34afc1d))
* **scheduler:** pg-boss queue + PR-187 follow-up review fixes ([#189](https://github.com/MikeBild/subkit/issues/189)) ([186ca73](https://github.com/MikeBild/subkit/commit/186ca739fe58e7462318645b80cf6016912c9749))
* **scheduler:** remove colon from per-workflow queue name ([#190](https://github.com/MikeBild/subkit/issues/190)) ([a3d3bef](https://github.com/MikeBild/subkit/commit/a3d3bef9089bb649c9cdde78ca3fa95586a3117c))
* **scheduler:** stabilise isCronDue test with fixed clocks ([7ee5070](https://github.com/MikeBild/subkit/commit/7ee5070d2e440d1e15cfb210be878041c365bafd))
* **scripts,ci:** pin openapi.json info.version to "0.0.0-dev" in gen output ([cf7cb44](https://github.com/MikeBild/subkit/commit/cf7cb448bc20ca1ee39b01a8ce8cce86018350c9))
* **scripts,tests:** stamp ENGINE_VERSION on .env, swap test.skip for test.skipIf in live e2es ([2743b83](https://github.com/MikeBild/subkit/commit/2743b8351161a4a4693ff7b4178acc9c76f22385))
* **sk,ink:** stop duplicating tool cards on orphan→parented transition + drop empty {} assistant rows ([48724ed](https://github.com/MikeBild/subkit/commit/48724ed71f6e07f0f3064db49b397e52a6958331))
* **sk/ink-tests:** poll lastFrame() with deadline to absorb CI scheduler latency ([46bb4eb](https://github.com/MikeBild/subkit/commit/46bb4ebae1c47a5871d05715024a86b7942ff9d2))
* **sk:** align command interfaces with test expectations ([8fd350d](https://github.com/MikeBild/subkit/commit/8fd350dbc0827bdc65ce697842ad5e28fe8a443a))
* **sk:** elicitation owns input focus while open; revert keyword-match hack ([729247d](https://github.com/MikeBild/subkit/commit/729247d38ba800c2a9c064ca9eb65d10dfa2517a))
* **skills:** skip confirm prompt when stdin is not a TTY ([191350f](https://github.com/MikeBild/subkit/commit/191350ff022856dbbd217dab6c70c0feb7fb9ff6))
* **sk:** label LLM-provider quota errors clearly instead of "validation errors · internal" ([33f17be](https://github.com/MikeBild/subkit/commit/33f17be9f8c8091a4ecd6e38dd86550c25152897))
* **sk:** remove unused emitList import in health command ([eb12a61](https://github.com/MikeBild/subkit/commit/eb12a616abc16bf5925d51f78576460bded662d6))
* **sk:** reserve spinner row when idle so the composer stops jumping ([f395fe0](https://github.com/MikeBild/subkit/commit/f395fe028732fc9e0e73a2b927d020c04d5f7f15))
* **sk:** simplify transcript and approval flow ([d07cad7](https://github.com/MikeBild/subkit/commit/d07cad706fbb9a1c05cc838bf5df277b19f9b98c))
* **sk:** strengthen chat guidance and routing ([#18](https://github.com/MikeBild/subkit/issues/18)) ([5fd133b](https://github.com/MikeBild/subkit/commit/5fd133b036340a0784d4f11bbf401c95b71c7afb))
* **sk:** surface pending_elicitation in headless JSON output ([18d457f](https://github.com/MikeBild/subkit/commit/18d457f41a0812e8d2c061a8250fef6708dbf871))
* **suggest-next:** append user nudge when message tail is assistant role ([f4dc097](https://github.com/MikeBild/subkit/commit/f4dc0976c2464f1d6dce5b29c85a4cec51759e2a))
* **test:** AC2 reads pending elicitation from resume_summary.pending_approval ([9a46130](https://github.com/MikeBild/subkit/commit/9a46130a3a68caa13d1bf2bcbb47d2685d1be6a3))
* **testing:** stabilize tty-sensitive release gate ([bc1a342](https://github.com/MikeBild/subkit/commit/bc1a342ea1469f5594e8becd00d19c4576fc6378))
* **test:** poll AC2 elicit-resume frame instead of fixed-tick wait ([cbb0166](https://github.com/MikeBild/subkit/commit/cbb01666cfb88c888c7ba498801f8f91dfe152dd))
* **test:** replace wall-clock setTimeout with waitFor/flush in oauth-callback test ([4e12489](https://github.com/MikeBild/subkit/commit/4e12489e50d239163bfd4037e4f897c7b0692a2d))
* **tests,hooks:** widen hook-timeout budget under parallel load ([a16bb45](https://github.com/MikeBild/subkit/commit/a16bb45b9b8af82a3943fa924f10bbf2c0f27469))
* **tests:** determinism lint — wait-checkpoint and token-mint tests ([45f9ae4](https://github.com/MikeBild/subkit/commit/45f9ae4117eac1a8165606fcd534c4f86d1af342))
* **tests:** drop pre-rebuild ask_user_confirm in cannedListUsersPlan, harden audit-provenance beforeAll ([7008603](https://github.com/MikeBild/subkit/commit/7008603e82acf4e4a9b6c54d0655c5c6b5f24e81))
* **tests:** journey 13 AC4 renames nested workflow draft too ([4733136](https://github.com/MikeBild/subkit/commit/4733136940aad06792c4440cbad28a991230c657))
* **tests:** land fixture follow-ups for the conversational creation rebuild ([9878342](https://github.com/MikeBild/subkit/commit/98783427bc4f8bb47db394b994c60fcc24082689))
* **tests:** pass the determinism lint gate ([90168ca](https://github.com/MikeBild/subkit/commit/90168ca0ac2236ee609a95cbb1e8c98554873f17))
* **tests:** pre-pull alpine image and disable update-check in e2e CLI env ([d66638c](https://github.com/MikeBild/subkit/commit/d66638cb8cc7b1a0ccd931d8fb044705b3fe04ac))
* **tests:** rename SUBKIT.md → SK.md in memory-pipeline journey ([c6e5757](https://github.com/MikeBild/subkit/commit/c6e5757dbea36b0b352ac1f4a00f015ad28f491b))
* **tests:** use real Date.now() for TEST_NOW_MS instead of fixed Nov-2023 timestamp ([764c35c](https://github.com/MikeBild/subkit/commit/764c35ca6e6e2967b513910f3df323c42d427e2a))
* **tests:** use skipIf+env flag instead of test.skip (determinism gate) ([4b0ff08](https://github.com/MikeBild/subkit/commit/4b0ff0875cd577c68e1ac23011fc98641c348ad8))
* **v3.5:** audit pass 6 — coverage matrix, structured logs, env retire cleanup ([#137](https://github.com/MikeBild/subkit/issues/137)) ([c5900c8](https://github.com/MikeBild/subkit/commit/c5900c8122fec03349adc0e80db88236344e816c))
* **v3.5:** reset config state in process.env-driven LLM provider tests ([#135](https://github.com/MikeBild/subkit/issues/135)) ([b846a0b](https://github.com/MikeBild/subkit/commit/b846a0bebd29968d723549c87712fc101d073369))


### Refactoring

* **chat:** remove unused link-token feature ([#129](https://github.com/MikeBild/subkit/issues/129)) ([255e431](https://github.com/MikeBild/subkit/commit/255e4318185e3bd984c8cb5358b75a8a4512a6be))
* **cli-core:** drop transcript-cell layer, replay turn events directly ([c448631](https://github.com/MikeBild/subkit/commit/c44863122dee0c90f58cb32b8501244ae1afb02b))
* **conversations,llm:** agent-registry + skill-driven prompts ([5446d43](https://github.com/MikeBild/subkit/commit/5446d43b6f78c69f8542a6ed2ef1ac7f5f3d1109))
* **conversations:** split authoring-state.ts into normalize + summary modules ([#113](https://github.com/MikeBild/subkit/issues/113)) ([c6cd9a2](https://github.com/MikeBild/subkit/commit/c6cd9a2d53893b4aba4dc9efcfefcf2bd562231d))
* **conversations:** split sdk-wrap.ts (1803 LOC) per audit §4.2 ([#112](https://github.com/MikeBild/subkit/issues/112)) ([61d8ce7](https://github.com/MikeBild/subkit/commit/61d8ce7c6ff538236ff86808b45c87ce07ee1f62))
* **conversations:** split service.ts into per-operation modules ([#123](https://github.com/MikeBild/subkit/issues/123)) ([1bb1ac9](https://github.com/MikeBild/subkit/commit/1bb1ac94ae2f51ea928f56e3368884ea7beb67cf))
* drop stale 'reserved for a future' comments and an unused enum value ([#131](https://github.com/MikeBild/subkit/issues/131)) ([75e8b91](https://github.com/MikeBild/subkit/commit/75e8b910ccc1042bae257364f6b033937ad1f3cb))
* **engine,db:** retire BOOTSTRAP_* env vars (now driven by /v1/setup) ([#70](https://github.com/MikeBild/subkit/issues/70)) ([bf37875](https://github.com/MikeBild/subkit/commit/bf37875fc1c9c77d2b3cd8b7051cbc6db1cdc016))
* **engine,llm:** replace per-skill summary blocks with per-scope index ([7873fa9](https://github.com/MikeBild/subkit/commit/7873fa9d855bc77cf2a20a145c739a79229112dc))
* **engine,sk,docs:** rename commit_draft → save_workflow_draft repo-wide ([1d0996a](https://github.com/MikeBild/subkit/commit/1d0996a03e9a901821f9ab76361ed98c2ccf43f7))
* **execution:** extract engine helpers into engine/ subdir ([#121](https://github.com/MikeBild/subkit/issues/121)) ([8f4913b](https://github.com/MikeBild/subkit/commit/8f4913bbdb7b56042328d29bcc6c805611b6d6cf))
* **execution:** split request.ts (1804 LOC) per audit §4.2 ([#111](https://github.com/MikeBild/subkit/issues/111)) ([74e897e](https://github.com/MikeBild/subkit/commit/74e897e6617a2ce26ac3b4e1a92dc022ed7a60c6))
* **http:** split connector-templates route god-file into per-sub-resource modules ([#116](https://github.com/MikeBild/subkit/issues/116)) ([3a48260](https://github.com/MikeBild/subkit/commit/3a48260883a473168fbcbcb619a9c4783b50ddf9))
* **http:** split connectors route god-file into per-sub-resource modules ([#117](https://github.com/MikeBild/subkit/issues/117)) ([d7b1774](https://github.com/MikeBild/subkit/commit/d7b17741d2ea38ec9e94ae598ffbd6dc48209259))
* **http:** split conversations route god-file into per-sub-resource modules ([#115](https://github.com/MikeBild/subkit/issues/115)) ([1654e76](https://github.com/MikeBild/subkit/commit/1654e76ab5ad6f634450f830a244db4efe7afc1e))
* **http:** split diagnostics route god-file into per-route modules ([#119](https://github.com/MikeBild/subkit/issues/119)) ([efa61ab](https://github.com/MikeBild/subkit/commit/efa61abe462dc17806eff27d2d5653c890cdfdf5))
* **http:** split executions route god-file into per-sub-resource modules ([#109](https://github.com/MikeBild/subkit/issues/109)) ([f4e138d](https://github.com/MikeBild/subkit/commit/f4e138d2888e3129104c06af82e3dce704fd093b))
* **http:** split notifications route god-file into per-sub-resource modules ([#108](https://github.com/MikeBild/subkit/issues/108)) ([513f040](https://github.com/MikeBild/subkit/commit/513f040759564d1cd66a6f87a97d154a915c06c1))
* **http:** split rbac route god-file into per-resource modules ([#118](https://github.com/MikeBild/subkit/issues/118)) ([2834c0c](https://github.com/MikeBild/subkit/commit/2834c0c2e23bd9152de4b7534d63ff0387a5818f))
* **install:** collapse to a single engine image; drop -with-cli variant ([cb8ccda](https://github.com/MikeBild/subkit/commit/cb8ccda7269dd47eb7990ccb8a4aecbcc1b883de))
* **llm:** consolidate token/budget accounting into llm/accounting/ ([#105](https://github.com/MikeBild/subkit/issues/105)) ([f8b095e](https://github.com/MikeBild/subkit/commit/f8b095ec154bdf3e8971cc4d0cafb1a946e7a94d))
* **llm:** split context-assembler.ts into formatters/loaders/skill-picker ([#114](https://github.com/MikeBild/subkit/issues/114)) ([b820dd6](https://github.com/MikeBild/subkit/commit/b820dd6f34d2f65d72e0f7e745c0e728dde6dedc))
* **persistence:** split auto-persist.ts into per-concern modules ([#122](https://github.com/MikeBild/subkit/issues/122)) ([b6d453b](https://github.com/MikeBild/subkit/commit/b6d453b6aa7878c17eb572c14165b0f80d24172e))
* remove three more half-implemented features ([#130](https://github.com/MikeBild/subkit/issues/130)) ([0cd9cde](https://github.com/MikeBild/subkit/commit/0cd9cdedb936c653aeb487d79c2e1b19e9b579b5))
* **shared:** extract redaction + scrub-secrets to packages/shared ([06757d3](https://github.com/MikeBild/subkit/commit/06757d302d833cfdd380bc2a85123dce08e98069))
* **sk-cli:** /settings 5-tab palette + claude-code shape ([6f394ff](https://github.com/MikeBild/subkit/commit/6f394ff850c426c7c88ddfac068629e0442fe257))
* **sk:** extract persona-probe to shared module, tier-gate the probe set ([32d7be5](https://github.com/MikeBild/subkit/commit/32d7be5859e76fbdba0633d42aef5b5109e338f9))
* **tunnels,pubsub:** bound TunnelRegistry + document pubsub restart contract ([#107](https://github.com/MikeBild/subkit/issues/107)) ([17e3ea3](https://github.com/MikeBild/subkit/commit/17e3ea3b9fdf63f6ba60aaf006f0d37db0f1714d))
* **tunnels:** remove tunnel-agent subsystem [skip-review] ([#155](https://github.com/MikeBild/subkit/issues/155)) ([8c1351e](https://github.com/MikeBild/subkit/commit/8c1351e5dfac7e7220b0e1003a0b85710963a1ae))
* unified MCP/conversation tool palette [skip-review] ([#191](https://github.com/MikeBild/subkit/issues/191)) ([1bb929c](https://github.com/MikeBild/subkit/commit/1bb929c6e10491aaefcb9c1b1f6f49c579829bdd))
* zero out non-null assertions across production source ([#132](https://github.com/MikeBild/subkit/issues/132)) ([4ac8469](https://github.com/MikeBild/subkit/commit/4ac8469078383c56135c2802b237cb2ef86031a3))


### Documentation

* add agent-facing guidance for Claude Code ([55bd3cd](https://github.com/MikeBild/subkit/commit/55bd3cdb02382911a77f0a9b2c347901994c8de2))
* align authoring + connector docs with inline auto-persist contract ([f13e2c5](https://github.com/MikeBild/subkit/commit/f13e2c5afe1cdcc7d58300770d79f3f8f27d55c9))
* align terminology — 'automation' → 'workflow', 'integration' → 'connector' ([039b384](https://github.com/MikeBild/subkit/commit/039b384f187bf7a004b545f94792ec9fad0517a8))
* **audit:** record actual phase 4 outcome; pin allowlist as steady state ([#128](https://github.com/MikeBild/subkit/issues/128)) ([5f80e4a](https://github.com/MikeBild/subkit/commit/5f80e4a57d360fde7c9373661dad18e915ec88ba))
* **changelog:** seed 4.4.1 (unreleased) entry for the release-pipeline fix ([fa51fc9](https://github.com/MikeBild/subkit/commit/fa51fc9fcc54fbd280764ddaff524cdd2336309a))
* cleanup ([4b41b3f](https://github.com/MikeBild/subkit/commit/4b41b3f438c9c376d97d96219a128dfa065d912e))
* **deployment:** document bun run release + scripts/release/* pipeline ([a2f38fc](https://github.com/MikeBild/subkit/commit/a2f38fc3ae821bd91ed0b16b84dcf6e5a6ca6bb8))
* drop the orphan German end-to-end sequences doc ([2c3edfe](https://github.com/MikeBild/subkit/commit/2c3edfe69f6f24923447b9303da052c32d0c1ce2))
* **engine,tools:** surface config.oauth immutability in update_connector_draft schema ([655caa9](https://github.com/MikeBild/subkit/commit/655caa981bb1e48a7009b47784066818fee81dcd))
* **execution,recipes:** document WorkflowDef.trigger discriminator ([#68](https://github.com/MikeBild/subkit/issues/68)) ([7f237fa](https://github.com/MikeBild/subkit/commit/7f237fa74decbb7990ab64cbaf30ef7266569f3d))
* **followup:** record 1.10.0 landings (masked secrets, 3 cards, route-doc parity gate) ([f6c806e](https://github.com/MikeBild/subkit/commit/f6c806e7942b1c712f4c4e2e8d2ff1dbae446a01))
* **followup:** record second-pass landings (preview parity, credentials, structured panes, richer snapshot, draft-dedup) ([e388453](https://github.com/MikeBild/subkit/commit/e388453c08acbb94dd5de341bae09b610776dba8))
* **install:** reframe with-cli as production default; sync compose from laptop deploys too ([94991ac](https://github.com/MikeBild/subkit/commit/94991ace6fbe74ba99510c771b3e17cfe9c76f62))
* **quickstart/operator:** match what compose:up actually does ([#127](https://github.com/MikeBild/subkit/issues/127)) ([ca72f92](https://github.com/MikeBild/subkit/commit/ca72f92425fbda4405f3d23e6d43078868ad6a0c))
* **recipes:** add authoring guide ([8c0123e](https://github.com/MikeBild/subkit/commit/8c0123e619d0978a222ba983095ab8abac2e2bd6))
* **skills:** document transform gate + auto-surfaced validation across the skill stack ([a5acadd](https://github.com/MikeBild/subkit/commit/a5acadd9899840ee4546d3be132c6d9bf91a4334))
* **skills:** mssql/redis/file-transport connector skills + postgres introspection note ([805642e](https://github.com/MikeBild/subkit/commit/805642e26b8a7b5210777d13028024900ef2ca13))
* **slash,executions:** close pre-existing route-doc parity drift ([#106](https://github.com/MikeBild/subkit/issues/106)) ([29de17f](https://github.com/MikeBild/subkit/commit/29de17f827ddb8b1a14d547405510b0489e85cfb))


### Miscellaneous

* **audit:** land Phase 1 stabilisation — guard tests + canonical doc ([#94](https://github.com/MikeBild/subkit/issues/94)) ([5420291](https://github.com/MikeBild/subkit/commit/5420291acecd860f54e2dbba5e8d711658215008))
* **audit:** phase 2 wrap-up — populate coverage-floor.json + enforce coverage_floor ([#104](https://github.com/MikeBild/subkit/issues/104)) ([84ff8dc](https://github.com/MikeBild/subkit/commit/84ff8dc2bb6ed5cf00449cb74d967d9b58b0bb6e))
* ci + docs follow-up to stabilization ([#142](https://github.com/MikeBild/subkit/issues/142)) ([95cfde5](https://github.com/MikeBild/subkit/commit/95cfde5f79021bd0441410825d4c693e90e10014))
* **ci:** release-please runs on workflow_dispatch only ([2898a16](https://github.com/MikeBild/subkit/commit/2898a16dcdcc2c0dae7ffe53fb512e8b99692259))
* **cli-core:** regenerate OpenAPI client to match current engine surface ([d3c0c0e](https://github.com/MikeBild/subkit/commit/d3c0c0eb4f97fa2b5cfe0daafd4f6b675c88882f))
* **deps:** sync bun.lock with package.json (graphql, playwright) ([980dcce](https://github.com/MikeBild/subkit/commit/980dcced97ba58be3705c3b6ee4f365985e705f3))
* **determinism:** add baseline ratchet for warning-level rules ([#77](https://github.com/MikeBild/subkit/issues/77)) ([3253b11](https://github.com/MikeBild/subkit/commit/3253b11511b96e2e4ff96d7c76cd92fde2cf6fa7))
* **docs:** tighten inline comments + add ticket-coupling gate ([3f8959c](https://github.com/MikeBild/subkit/commit/3f8959ccfc8ba15700df1edf7a8f05758497fa1e))
* **engine,shared:** full reference-impl parity audit + cleanup loop ([f073888](https://github.com/MikeBild/subkit/commit/f073888a13cd91a2ad661d65467118f4db952ab0))
* **engine:** tidy biome noTemplateCurlyInString suppressions ([3ac25e4](https://github.com/MikeBild/subkit/commit/3ac25e4f78ab81b130ca6fb88938a9754e03bb0a))
* **eval:** untrack eval/out runtime artifacts ([77d2521](https://github.com/MikeBild/subkit/commit/77d2521ac39c4c2a900d42403648c42a31702f03))
* **githooks:** trim pre-push gate to lint+typecheck+build ([59aa1a1](https://github.com/MikeBild/subkit/commit/59aa1a10132bc856a862aa473d4cd44467afca55))
* **gitignore:** ignore .claude/scheduled_tasks.lock runtime artifact ([7fc79f7](https://github.com/MikeBild/subkit/commit/7fc79f79de1c5f8d45f3fd929dcdd34b7811fd14))
* ignore .env.deploy (laptop deploy overrides) ([9543bf3](https://github.com/MikeBild/subkit/commit/9543bf3889769c0b5c7ef99708d59397b1480d71))
* **main:** release subkit 1.10.0 ([#14](https://github.com/MikeBild/subkit/issues/14)) ([2b08f7e](https://github.com/MikeBild/subkit/commit/2b08f7e4feaf37525988e2f192a739b2bdf51923))
* **main:** release subkit 1.10.1 ([#15](https://github.com/MikeBild/subkit/issues/15)) ([47d7239](https://github.com/MikeBild/subkit/commit/47d7239b492ed9251c828ae2b37d8496f4cd5854))
* **main:** release subkit 1.10.10 ([#19](https://github.com/MikeBild/subkit/issues/19)) ([b8a2784](https://github.com/MikeBild/subkit/commit/b8a27849c664ffb0940f869d0f3eb1624b4f5493))
* **main:** release subkit 1.10.2 ([#16](https://github.com/MikeBild/subkit/issues/16)) ([525f3c8](https://github.com/MikeBild/subkit/commit/525f3c8036d7ee5636c840ffb7b885c49e1509fd))
* **main:** release subkit 1.10.8 ([#17](https://github.com/MikeBild/subkit/issues/17)) ([187bf28](https://github.com/MikeBild/subkit/commit/187bf282e32e466b302329bee9f4b793d2fb3e04))
* **main:** release subkit 1.11.0 ([#20](https://github.com/MikeBild/subkit/issues/20)) ([5a4431a](https://github.com/MikeBild/subkit/commit/5a4431af8eb106537b68bf8d11c73aa428d9883a))
* **main:** release subkit 1.12.0 ([#21](https://github.com/MikeBild/subkit/issues/21)) ([d6ea21c](https://github.com/MikeBild/subkit/commit/d6ea21caa36d84c198a2f7fd9bfcf32a78d8ae68))
* **main:** release subkit 1.13.0 ([#22](https://github.com/MikeBild/subkit/issues/22)) ([220c43a](https://github.com/MikeBild/subkit/commit/220c43aab2927ff35e55424c68dfd3fffd31e74c))
* **main:** release subkit 1.13.1 ([#23](https://github.com/MikeBild/subkit/issues/23)) ([a95da77](https://github.com/MikeBild/subkit/commit/a95da774264f851f47e9519c066b416b2d71ce69))
* **main:** release subkit 1.14.0 ([#25](https://github.com/MikeBild/subkit/issues/25)) ([6ffad18](https://github.com/MikeBild/subkit/commit/6ffad18b350c2bd3c21db4e94fbcc31b8fd32b0c))
* **main:** release subkit 1.15.0 ([#26](https://github.com/MikeBild/subkit/issues/26)) ([859e522](https://github.com/MikeBild/subkit/commit/859e5226f8fec7cb4ab4de7fb2b56a52f0bf1044))
* **main:** release subkit 1.16.0 ([#27](https://github.com/MikeBild/subkit/issues/27)) ([271d6d9](https://github.com/MikeBild/subkit/commit/271d6d92769cc7c04458f69cabe1f3980a2f6124))
* **main:** release subkit 1.17.0 ([#28](https://github.com/MikeBild/subkit/issues/28)) ([03f038d](https://github.com/MikeBild/subkit/commit/03f038d1806758e9d000803b5b2826f487645bbe))
* **main:** release subkit 1.18.0 ([#29](https://github.com/MikeBild/subkit/issues/29)) ([7c0bf0f](https://github.com/MikeBild/subkit/commit/7c0bf0f298df4ce2c8796a417386048604f59163))
* **main:** release subkit 1.2.0 ([#4](https://github.com/MikeBild/subkit/issues/4)) ([cd1d75b](https://github.com/MikeBild/subkit/commit/cd1d75bff2f6b9f9796bfdded1eb5d0932b61079))
* **main:** release subkit 1.3.0 ([#5](https://github.com/MikeBild/subkit/issues/5)) ([d526534](https://github.com/MikeBild/subkit/commit/d5265349655a2e721c9d569b0a30a88a2638001e))
* **main:** release subkit 1.4.0 ([#6](https://github.com/MikeBild/subkit/issues/6)) ([70f4a3c](https://github.com/MikeBild/subkit/commit/70f4a3c463454a8e8a0dc043f237978b00c0f45f))
* **main:** release subkit 1.5.0 ([#7](https://github.com/MikeBild/subkit/issues/7)) ([999e0df](https://github.com/MikeBild/subkit/commit/999e0df9d9758cb6954a53d2a75c17606e167c1c))
* **main:** release subkit 1.6.0 ([#8](https://github.com/MikeBild/subkit/issues/8)) ([da9d821](https://github.com/MikeBild/subkit/commit/da9d8210d1588ec5213cd07b0b8ab0ede2ea9429))
* **main:** release subkit 1.6.1 ([#9](https://github.com/MikeBild/subkit/issues/9)) ([62f32bf](https://github.com/MikeBild/subkit/commit/62f32bffadb81146f4eded40700836e7c44438fe))
* **main:** release subkit 1.6.4 ([#10](https://github.com/MikeBild/subkit/issues/10)) ([f19f859](https://github.com/MikeBild/subkit/commit/f19f859db89032a3ff507489db6093a0b21eb89c))
* **main:** release subkit 1.7.0 ([#11](https://github.com/MikeBild/subkit/issues/11)) ([69362e8](https://github.com/MikeBild/subkit/commit/69362e8df2af2b53717347278ce480feb5c385b8))
* **main:** release subkit 1.8.0 ([#12](https://github.com/MikeBild/subkit/issues/12)) ([5c51a64](https://github.com/MikeBild/subkit/commit/5c51a644c52d96cce0147a1678c27db1795f8ab9))
* **main:** release subkit 1.9.0 ([#13](https://github.com/MikeBild/subkit/issues/13)) ([147d318](https://github.com/MikeBild/subkit/commit/147d3185ebabe07c24a5cc259d97a152d0c154af))
* **main:** release subkit 2.0.0 ([#30](https://github.com/MikeBild/subkit/issues/30)) ([d522315](https://github.com/MikeBild/subkit/commit/d522315ea003b18be8970a7be238302ea6df744b))
* **main:** release subkit 2.1.0 ([#31](https://github.com/MikeBild/subkit/issues/31)) ([dc27598](https://github.com/MikeBild/subkit/commit/dc27598b2e21551cf32bb759c5cf4eed7b7fe17c))
* **main:** release subkit 2.2.0 ([#32](https://github.com/MikeBild/subkit/issues/32)) ([f7a4c96](https://github.com/MikeBild/subkit/commit/f7a4c967900841f9c0683303b2e1495306c34257))
* **main:** release subkit 2.2.1 ([#33](https://github.com/MikeBild/subkit/issues/33)) ([9693dba](https://github.com/MikeBild/subkit/commit/9693dba38b6263f80de2f6d71d24aeb17e334413))
* **main:** release subkit 2.2.2 ([#34](https://github.com/MikeBild/subkit/issues/34)) ([ee37f06](https://github.com/MikeBild/subkit/commit/ee37f06cdcd8be197ce268b77d8e3a2792fe524c))
* **main:** release subkit 2.3.0 ([#35](https://github.com/MikeBild/subkit/issues/35)) ([00d089b](https://github.com/MikeBild/subkit/commit/00d089b952a41887e1a41b0f2d434ae38a0b7be6))
* **main:** release subkit 2.3.1 ([#36](https://github.com/MikeBild/subkit/issues/36)) ([f612164](https://github.com/MikeBild/subkit/commit/f612164b0cab87d66d1c633ba2e5b8e3754225b2))
* **main:** release subkit 2.4.0 ([#37](https://github.com/MikeBild/subkit/issues/37)) ([f4126a2](https://github.com/MikeBild/subkit/commit/f4126a241ca0662723faa5dfd86ed5cebacb3f2e))
* **main:** release subkit 2.5.0 ([#38](https://github.com/MikeBild/subkit/issues/38)) ([053aa4c](https://github.com/MikeBild/subkit/commit/053aa4c72b958eff875388462c2287fd7aaa4dc6))
* **main:** release subkit 2.6.0 ([#39](https://github.com/MikeBild/subkit/issues/39)) ([90eb9cc](https://github.com/MikeBild/subkit/commit/90eb9ccf67e421523e61f1f3b1ae8eeafd568c6f))
* **main:** release subkit 2.7.0 ([#40](https://github.com/MikeBild/subkit/issues/40)) ([95f060e](https://github.com/MikeBild/subkit/commit/95f060e2cec67acb1814c997f8b3132c03c12a26))
* **main:** release subkit 2.8.0 ([#41](https://github.com/MikeBild/subkit/issues/41)) ([9893433](https://github.com/MikeBild/subkit/commit/9893433c1f9fea6c882f82f60f38dff5c1d6cab6))
* **main:** release subkit 3.1.0 ([#42](https://github.com/MikeBild/subkit/issues/42)) ([09a1102](https://github.com/MikeBild/subkit/commit/09a1102ce9fd43b8eba7746580b3d42572cf5467))
* **main:** release subkit 3.2.0 ([#43](https://github.com/MikeBild/subkit/issues/43)) ([013a5b3](https://github.com/MikeBild/subkit/commit/013a5b3aa94e6772fde336f542966490e2617c95))
* **main:** release subkit 3.2.1 ([#44](https://github.com/MikeBild/subkit/issues/44)) ([67d5254](https://github.com/MikeBild/subkit/commit/67d5254922b9307d062270f34b4247274767df38))
* **main:** release subkit 4.0.0 ([#138](https://github.com/MikeBild/subkit/issues/138)) ([97e31d0](https://github.com/MikeBild/subkit/commit/97e31d0d1a73aedff70c3395fd5b96573cfb7fdf))
* **main:** release subkit 4.10.0 ([#180](https://github.com/MikeBild/subkit/issues/180)) ([4cf6853](https://github.com/MikeBild/subkit/commit/4cf6853d6ae774d5eb4fdf938921a0d3f487d9c8))
* **main:** release subkit 4.10.1 ([#181](https://github.com/MikeBild/subkit/issues/181)) ([6ef8559](https://github.com/MikeBild/subkit/commit/6ef8559cc1f402aa08011030091cb484fb7182ee))
* **main:** release subkit 4.11.0 ([#184](https://github.com/MikeBild/subkit/issues/184)) ([8c35eb1](https://github.com/MikeBild/subkit/commit/8c35eb1d14b3e194261509446ecfcdf87ce6d012))
* **main:** release subkit 4.11.1 ([#185](https://github.com/MikeBild/subkit/issues/185)) ([da476e4](https://github.com/MikeBild/subkit/commit/da476e4b1521c450f4c9c8c434b2c9642f6a92a2))
* **main:** release subkit 4.11.2 ([7614044](https://github.com/MikeBild/subkit/commit/761404483d22248318459bf849bd43d042f705a6))
* **main:** release subkit 4.11.3 ([7a380ed](https://github.com/MikeBild/subkit/commit/7a380ed54f5bda43e7dad5e33468b4d113eadd4e))
* **openapi:** regenerate client for /install/{asset} + /install/sha256sums ([ef1f8f5](https://github.com/MikeBild/subkit/commit/ef1f8f5fb1b0a788250967ce13fb4d9b1654e7cc))
* **openapi:** regenerate client for connector.oauth.callback_succeeded ([c1513f7](https://github.com/MikeBild/subkit/commit/c1513f74da37f7cd60d1793d8e8ca45cfa3ac500))
* **openapi:** regenerate client for E1 + E2 recipe routes ([2bb2237](https://github.com/MikeBild/subkit/commit/2bb2237242a5a8a1f3f380e107305c889a0d2094))
* **release:** bump version 3.2.0 → 3.3.0 ([f5ed7da](https://github.com/MikeBild/subkit/commit/f5ed7da38e7be79167ff32b0059a2eb7563822cb))
* **release:** correct 4.5.0 date to 2026-05-11 ([22a1056](https://github.com/MikeBild/subkit/commit/22a1056900c2ecf476b2ddd9863c444236ca9366))
* **release:** cut v3.4.0 ([0ea8f48](https://github.com/MikeBild/subkit/commit/0ea8f4812092bb9c9cfabeea3471f07070b23ddd))
* **release:** cut v3.4.1 ([9e3901e](https://github.com/MikeBild/subkit/commit/9e3901ec8b1ea5439761f2b55230ade84bf07e8b))
* **release:** rename 4.3.0 (unreleased) to 4.4.0 (2026-05-10) ([95ccf5c](https://github.com/MikeBild/subkit/commit/95ccf5c5e17b740ca7b846a0473d9e17da89976a))
* **release:** rename 4.4.1 (unreleased) to 4.5.0 (2026-05-10) ([b39a504](https://github.com/MikeBild/subkit/commit/b39a5049552eeae1b9300d0b1d7cb5c02dc4ba80))
* **release:** subkit 1.10.3 ([1603a7f](https://github.com/MikeBild/subkit/commit/1603a7f17ec3b4d7d7917ca20009e0b403ddd755))
* **release:** subkit 1.10.4 ([df9cafb](https://github.com/MikeBild/subkit/commit/df9cafbdc69095cff02714b3bd6eee4e789c3b4e))
* **release:** subkit 1.10.5 ([4bbcfd8](https://github.com/MikeBild/subkit/commit/4bbcfd81e0c43d227791c52ecd5cb767371b28e1))
* **release:** subkit 1.10.6 ([9a34515](https://github.com/MikeBild/subkit/commit/9a345154b11c354146cfde420fdfd5ee5142abf0))
* **release:** subkit 1.10.7 ([305454b](https://github.com/MikeBild/subkit/commit/305454b5147ea50dd047fd45a52c34b8a7ca0f39))
* **release:** subkit 1.10.9 ([2826b7f](https://github.com/MikeBild/subkit/commit/2826b7f7da90b56166899d521aa1b839abb8ac59))
* **release:** subkit 1.17.1 ([d6fb802](https://github.com/MikeBild/subkit/commit/d6fb8029934241875b50e603c89f56609106dcc4))
* **release:** subkit 1.18.1 ([939d8d2](https://github.com/MikeBild/subkit/commit/939d8d2894e89afb5efc15e7582c6b0f1847961c))
* **release:** subkit 1.19.0 ([fcfedbe](https://github.com/MikeBild/subkit/commit/fcfedbef12dae757f4c4fc488d7c0f0a3c35ba39))
* **release:** subkit 1.6.2 ([08d7f9d](https://github.com/MikeBild/subkit/commit/08d7f9dbd04c68ba9c4408c1288704d1408dfdd1))
* **release:** subkit 1.6.3 ([c2fb3be](https://github.com/MikeBild/subkit/commit/c2fb3be9cdaef47c67705b2c0016440e29dbb720))
* **release:** subkit 2.0.1 ([8d1fb00](https://github.com/MikeBild/subkit/commit/8d1fb00d5176dc1d49880e7cc7e83dd0b0419560))
* **release:** subkit 3.0.0 ([1b16bc3](https://github.com/MikeBild/subkit/commit/1b16bc37448827c9a4ae78d3b898c69e80c9de18))
* **release:** subkit 3.5.0 ([70ce6de](https://github.com/MikeBild/subkit/commit/70ce6deeb891d67078804a3f75c67e93c24b1516))
* **release:** subkit 3.5.1 ([22c935f](https://github.com/MikeBild/subkit/commit/22c935fb7baa2336ec1a50349957c4691ed89316))
* **release:** subkit 4.0.1 ([363bb23](https://github.com/MikeBild/subkit/commit/363bb23d9d34a522d51302354001cd89b3196951))
* **release:** subkit 4.1.0 ([e6b9dd8](https://github.com/MikeBild/subkit/commit/e6b9dd8ddbe91953b6c6f32f605ccbd59015c01f))
* **release:** subkit 4.12.1 ([3fc3b2c](https://github.com/MikeBild/subkit/commit/3fc3b2c282900e732654a568be25ecb8badc5cd6))
* **release:** subkit 4.12.2 ([4da2183](https://github.com/MikeBild/subkit/commit/4da2183f57d0291110dbb05d45cd695de1561ca8))
* **release:** subkit 4.12.3 ([772f89d](https://github.com/MikeBild/subkit/commit/772f89d07e18baf3a43fecf2f889afc1a4b224ee))
* **release:** subkit 4.12.4 ([52fa51c](https://github.com/MikeBild/subkit/commit/52fa51c9a706c8d93ed2e54c31ae167c0efc9134))
* **release:** subkit 4.12.5 ([e99f076](https://github.com/MikeBild/subkit/commit/e99f076c25fa52cf4bb8ec8d1ff05b0cd13656d5))
* **release:** subkit 4.4.0 ([170d5df](https://github.com/MikeBild/subkit/commit/170d5dfee47de7f6b16df812cfff9c25f3120027))
* **release:** subkit 4.5.0 ([b5d4e33](https://github.com/MikeBild/subkit/commit/b5d4e33a809ccb840eceaef786cd009f7eb5f933))
* **release:** subkit 4.6.0 ([549ad76](https://github.com/MikeBild/subkit/commit/549ad76565985406952c231ac9ea48aa7e495494))
* **release:** subkit 4.7.0 ([28da45a](https://github.com/MikeBild/subkit/commit/28da45a0d3ec937e99769c1e42e57aa569ae4bcd))
* **release:** subkit 4.7.1 ([b7ec468](https://github.com/MikeBild/subkit/commit/b7ec46885ed3f5abb2fbde85327e1119381450c7))
* **release:** subkit 4.7.2 ([4c03e72](https://github.com/MikeBild/subkit/commit/4c03e724c7ad8aeb638dfdf5ecab8ac4493db1aa))
* **release:** subkit 4.7.3 ([3dc0358](https://github.com/MikeBild/subkit/commit/3dc0358884494bef475f6852cf86841e9b31fa60))
* **release:** subkit 4.7.4 ([39e325c](https://github.com/MikeBild/subkit/commit/39e325ca051eac97501eb76c61c74cf7e07365ba))
* **release:** subkit 4.7.5 + fix verify.sh date flag ([07f05f3](https://github.com/MikeBild/subkit/commit/07f05f3acef186877e846d8d10d771ce34a730ed))
* **release:** subkit 4.7.6 ([38db7c7](https://github.com/MikeBild/subkit/commit/38db7c7c0c319847141082c35aa52bf89ae9b370))
* **release:** subkit 4.7.7 ([d8f0575](https://github.com/MikeBild/subkit/commit/d8f0575366f4a6c2bae20e7e571c9184a55ccb9b))
* **release:** subkit 4.7.8 ([d7f6de3](https://github.com/MikeBild/subkit/commit/d7f6de329be27f91fb9319b080ef92f76c0d8459))
* **release:** subkit 4.8.0 ([554eb5c](https://github.com/MikeBild/subkit/commit/554eb5c0f63976e8192c2509f0686176f21cf248))
* **release:** subkit 4.8.1 ([69540c9](https://github.com/MikeBild/subkit/commit/69540c98905064cda0f937ef1da3e82b1b071a64))
* **release:** subkit 4.8.2 ([ef5903e](https://github.com/MikeBild/subkit/commit/ef5903e630b36bd128dd54312e65f239e828e6d0))
* **release:** subkit 4.8.3 ([956f127](https://github.com/MikeBild/subkit/commit/956f1275d6c2894c0b1c61bcf22f5b8e53365b93))
* **release:** subkit 4.9.0 ([66b844e](https://github.com/MikeBild/subkit/commit/66b844e4239facdb1370138bfa5650ac0d6c29ab))
* stabilization — claude-review CI, banned-term scrub, doc + lint cleanup ([#139](https://github.com/MikeBild/subkit/issues/139)) ([ee41254](https://github.com/MikeBild/subkit/commit/ee412547c0c6603d1c5b2be3e745b7a547fad736))

## [4.12.0](https://github.com/MikeBild/subkit/compare/subkit-v4.11.3...subkit-v4.12.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* **files:** `storage.knowledge.*` config keys renamed to `storage.files.*`. Operators must `sk settings configure` (or set `SK_OVERRIDE_STORAGE__FILES__*` env vars). Was: `storage.knowledge.backend`, `storage.knowledge.dir`. Now: `storage.files.backend`, `storage.files.dir`, **new** `storage.files.bucket` (required when `backend=s3`).
* **files:** `conversation_attachments` table dropped. Migration `0019` backfills existing rows into the unified `files` + `file_links` tables. Production engines migrate automatically on boot — no operator action required.
* **audit:** Audit actions `conversation.attachment_created` and `conversation.attachment_deleted` removed. Replaced by `file.created` + `file.link_added` + `file.deleted`. Compliance dashboards filtering on the old action names must be updated. SIEM migration: existing rows keep their historical `conversation.attachment_*` action strings (audit_log is append-only); only the TypeScript constants are gone. Update SIEM filters to also accept the new `file.*` vocabulary (`file.created`, `file.batch_created`, `file.finalized`, `file.downloaded`, `file.deleted`, `file.link_added`, `file.link_removed`, `file.scan_completed`, `file.upload_received`). Every `FILE_*` metadata schema now carries an optional `request_source` field (`api` / `cli` / `scheduler` / `mcp` / `webhook` / `tool-chain` / `ui`) so dispatch-channel splits work without joining on `trace_id`.


### Features

* **files:** unified `files` resource exposing 10 HTTP routes under `/v1/files/*` — inline + presigned upload, dedup by content hash, finalize, list/get/download/delete, link, stats. Single `requireFileForTenant` chokepoint enforces tenant isolation across every surface.
* **mcp:** `file://<fid>` resource scheme. `list_resources` + `read_resource` gated by the `file:read` permission.
* **sk:** `sk files {list,get,upload,download,delete,link,stats}` command tree plus the `sk attach <conv-id> <path>` shortcut.
* **sk:** headless `sk -p --attach <path>` for CI/automation pipelines.
* **sk:** REPL `/upload <path>`, `/files`, and `@file:fid_...` mention completions.
* **workflows:** `sk workflows run --input-file K=<path>` uploads the file and substitutes `{$file: fid}` into the input JSON before enqueue.
* **executions:** `sk executions get` text output now lists produced output files with a `sk files download` hint.
* **workflows:** workflow `input_schema` gained a typed `file` leaf (additive — existing schemas unchanged). `RequestStepSchema.multipart` for multipart-out connectors.
* **llm:** `chooseFileStrategy` resolves provider Files API → inline base64 (≤250 KiB cumulative per turn) → text_extract. Provider `file_id` is reused across turns; a cleanup cron clears expired ids.
* **connectors:** `generic_multipart_upload` template demonstrating file-in workflows.


### Observability

* **observability:** 7 new Prometheus metrics under the `subkit_files_*` namespace.
* **audit:** 9 new audit actions: `file.created`, `file.batch_created`, `file.finalized`, `file.downloaded`, `file.deleted`, `file.link_added`, `file.link_removed`, `file.scan_completed`, `file.upload_received`.
* **audit:** presigned-URL query params (`X-Amz-Signature`, `X-Goog-Signature`, `signature=`) automatically redacted in both audit entries and structured logs.


### Operator notes

* **files:** deploy a real `FileScanner` (e.g. clamd) before accepting tenant uploads; the default `NoopScanner` reports every file as clean. The engine now logs `files.scanner.noop_in_production` at boot when `NODE_ENV=production` and no real scanner is wired.

### Limitations / follow-ups

* **knowledge:** knowledge-source ingestion chunker does not yet read via `files.file_id`; the schema column exists and is backfilled, but `createKnowledgeSource` still consumes a caller-supplied buffer. Locked by `apps/engine/src/knowledge/tests/chunker-file-resolve.test.ts`.
* **discovery:** the `POST /v1/discovery/runs/from-archive` route still parses multipart in-process and has not yet been routed through `POST /v1/files/inline`. Locked by `apps/engine/src/discovery/tests/analyze-archive-via-files-inline.test.ts`.
* Both gaps are non-blocking — knowledge and discovery still work end-to-end; they are simply not yet unified through the files API.

## [4.11.3](https://github.com/MikeBild/subkit/compare/subkit-v4.11.2...subkit-v4.11.3) (2026-05-14)


### Bug Fixes

* **build:** defer jsdom xhr-sync-worker require.resolve so the compiled engine binary doesn't crash on boot when the build-time runner workspace path is absent at runtime ([c56e27e](https://github.com/MikeBild/subkit/commit/c56e27e))

## [4.11.2](https://github.com/MikeBild/subkit/compare/subkit-v4.11.1...subkit-v4.11.2) (2026-05-14)


### Bug Fixes

* **build:** inline jsdom default-stylesheet.css for bun --compile so the compiled engine binary no longer needs filesystem access to the build-time runner workspace ([0352b48](https://github.com/MikeBild/subkit/commit/0352b48a1da098cfec905152bf716854d2ed8384))

## [4.11.1](https://github.com/MikeBild/subkit/compare/subkit-v4.11.0...subkit-v4.11.1) (2026-05-14)


### Bug Fixes

* **build:** patch css-tree to use static ESM JSON imports for bun --compile ([a4b924f](https://github.com/MikeBild/subkit/commit/a4b924f8f0f39c3a2048bec257a900f0303b7acf))

## [4.11.0](https://github.com/MikeBild/subkit/compare/subkit-v4.10.1...subkit-v4.11.0) (2026-05-14)


### Features

* **connectors:** web-scraper template + three transform languages ([#144](https://github.com/MikeBild/subkit/issues/144)) [skip-review] ([#182](https://github.com/MikeBild/subkit/issues/182)) ([6dc0b72](https://github.com/MikeBild/subkit/commit/6dc0b72cbb9fdc7e739425a07f2357a3aa5c8f73))
* **self-healing:** proactive drift scan + admin HTTP/MCP/sk surfaces ([acb1837](https://github.com/MikeBild/subkit/commit/acb183768c5a36c4e861c391546d459fb223d308))


### Bug Fixes

* **conversation:** unblock workflow output read path + URL-driven authoring [skip-review] ([#183](https://github.com/MikeBild/subkit/issues/183)) ([23b7f33](https://github.com/MikeBild/subkit/commit/23b7f33a15215b2e993847fa241c89fbeace7d2a))


### Miscellaneous

* **docs:** tighten inline comments + add ticket-coupling gate ([3f8959c](https://github.com/MikeBild/subkit/commit/3f8959ccfc8ba15700df1edf7a8f05758497fa1e))

## [4.10.1](https://github.com/MikeBild/subkit/compare/subkit-v4.10.0...subkit-v4.10.1) (2026-05-13)


### Bug Fixes

* **suggest-next:** append user nudge when message tail is assistant role ([f4dc097](https://github.com/MikeBild/subkit/commit/f4dc0976c2464f1d6dce5b29c85a4cec51759e2a))

## [4.10.0](https://github.com/MikeBild/subkit/compare/subkit-v4.9.0...subkit-v4.10.0) (2026-05-13)


### Features

* **conversation:** inline auto-persist on green probe and green dry-run ([6bebb09](https://github.com/MikeBild/subkit/commit/6bebb09dc09d599c3731e1a8c6f66ef071abe1e1))


### Documentation

* align authoring + connector docs with inline auto-persist contract ([f13e2c5](https://github.com/MikeBild/subkit/commit/f13e2c5afe1cdcc7d58300770d79f3f8f27d55c9))

## [4.9.0] (2026-05-13)

### Changed

- **`sk settings` reshaped to a 5-tab palette matching claude-code's
  Status/Config/Usage shape**, plus subkit's two AI-pipeline surfaces
  (`Skills`, `Knowledge`) at the same depth — down from 10 outer tabs
  + 17 engine-section sub-tabs. The activity heatmap merges into
  Status; the operator surfaces (`Permissions`, `Profile`, `Admin`)
  move out of `/settings` into their own SinglePane slash commands
  (`/permissions`, `/profile`, `/admin`). Config is now a flat
  searchable list across every engine setting with curated
  human-readable row labels.
- **Slash deep-links** (`/config`, `/usage`, `/skills`, `/knowledge`)
  open the matching tab inside `sk settings`. The legacy 4-field
  user-settings prompt moved from `/config` to `/config-form`. New
  registrations: `/usage`, `/admin`, `/config-form`. `/permissions`
  and `/admin` are mounted via SinglePane, with `AdminCommand`
  probing `skBootstrap` for an in-pane "no admin permissions"
  message for non-admins (server RBAC still enforces every mutation
  independently).
- **Two-step Esc adopts claude-code's `ownsEsc` pattern**
  (generalised as `onInnerEscape`): every Esc-consuming tab + sub-tab
  + form (`ConfigTab`, `KnowledgeTab`, `SkillsTab`, `ProfileTab`,
  `AdminTab` → `GenericListSubTab` / `ApiKeysSubTab` /
  `PortalTokensSubTab`) propagates its inner-state flag so first Esc
  clears the inner state and second Esc dismisses the outer shell.
- **Config row bodies render curated human labels for all 94 engine
  leaves** (`apps/sk/src/settings-ui/lib/config-labels.ts:LABEL_BY_PATH`)
  — `llm.api_key` → "Primary API key", `repl.portalTokenTtlMin` →
  "Portal token TTL (minutes)", etc. A coverage-lock test
  (`apps/sk/src/settings-ui/__tests__/config-labels.test.ts`) fails
  when a new leaf lands in the engine schema without a curated
  label. Section dividers use humanized headers (`AI / LLM`,
  `REPL chrome`, …). Description footer surfaces the engine
  schema's `.describe(...)` text plus the canonical dotted path for
  the selected row.
- **User-facing copy de-jargoned**: `audit events` → `actions`,
  `llm.invocation audit rows` → `AI requests`,
  `prompt/completion` → `input/output tokens`, `leaf` → `setting`.

### Fixed

- **Activity heatmap was rendering empty for every tenant**
  regardless of activity. Root cause: `bucketize` read
  `entry.created_at` while the engine's audit-log endpoint emits
  `entry.ts` — every row was silently dropped before the bucket map
  was populated. Plus `GLYPHS[0] = " "` (a literal space) made
  zero-count days invisible. Now reads `ts`, renders `·` for empty
  days, and the regression test in `StatusTab.heatmap.ink.test.tsx`
  asserts the peak glyph appears against seeded items.
- **`/usage` was being autocompleted in place of `/audit`** for
  member personas: fuzzy search on "audit" matched `/usage` (which
  had no `requires`) once the member couldn't see `/audit`.
  `/usage` now requires `audit:read` — semantically correct since
  the Usage tab aggregates `llm.invocation` audit rows.

### Removed

- **Dead code swept**: `SettingsTab.tsx` (engine-section view),
  `StatsTab.tsx` (heatmap moved into Status),
  `components/Footer.tsx` (orphan after SettingsTab deletion),
  `groupBySection` helper (callers all migrated to flat fields),
  and 4 orphan keybinding actions (`settings:close`,
  `settings:tab-next/prev`, `help:toggle`) with no consumer.

## [4.8.3] (2026-05-13)

### Fixed

- **`critic-integration.test.ts` fixture seeds `latest_preview`** so the
  v4.8.0 transform-authoring gate (which fires on transforms reading
  from un-previewed scope) does not block fixtures that exercise the
  critic-verdict layer above it. Same pattern as
  `edit-workflow-patch.test.ts` and `cycle-rejected-at-build.test.ts`.
  Tests were green pre-v4.8.0 only because the gate didn't exist.

## [4.8.2] (2026-05-13)

### Fixed

- **Transform-authoring gate now mirrors the loop-gate's probe-evidence
  exemption.** v4.8.0 shipped the new gate without the
  `probedConnectorSlugs` option the loop-gate already used, so any
  workflow that successfully probed a connector and then authored a
  transform reading from that probe's request step would be rejected
  unless an extra `dry_run_workflow` ran in between — the exact UX
  regression the loop-gate's exemption was designed to prevent.
- **Both authoring gates now recognise three connector-binding shapes,
  not just one.** `transitivelyExempt` (used by both loop- and
  transform-gate) and `collectProbedConnectorSlugs` previously only
  looked at `step.connector_id` / `step.connector_slug`. They now also
  walk for `${connector.<slug>.*}` placeholders in any string leaf of
  the step config, which is how reference-impl-style and legacy
  workflows bind a step to a connector. Without this, the v4.8.0 CI
  fixtures (and a dozen `build_workflow + authoring-critic` tests) all
  failed the moment the new transform gate started firing.

## [4.8.1] (2026-05-13)

### Added

- **`transform_authoring_requires_inspect` gate is now wired everywhere
  a transform expression can be authored** — `build_workflow` (full
  one-shot) and `update_param` (single-field `expression`/`body`/
  `language` edit) join the existing `propose_step` /
  `edit_workflow_patch` enforcement from v4.8.0. Closes the bypass that
  let a one-shot `build_workflow` author a `$scope.<X>`-citing transform
  without an upstream preview.
- **`connector.oauth.callback_succeeded` registered in
  `EVENT_CATALOG`** — external webhook subscribers can now match the
  event the OAuth callback already publishes. Uses the existing
  `ConnectorOauthCallbackPayloadSchema` so internal + external consumers
  share one Zod validation.
- **Skill content updated for v4.8.0 contracts** —
  `workflow-authoring.md` documents the symmetric transform gate and
  the auto-surfaced validation pattern; `conversational-authoring.md`
  and `chat-first-contract.md` soften their `validate_draft`
  prescriptions; `validate-draft.ts` description explains it is now
  repeat-capped and reserved for external-change re-checks. Pinned by
  two new assertions in `skill-content-coverage.test.ts`.

### Fixed

- **SSE replay race in `subscribeConnectorOAuthCallback`** —
  `/v1/events/stream` replays the last 50 outbox rows on open before
  the `hello` frame. A prior `connector.oauth.callback_succeeded` for
  the same connector_id would auto-confirm the current in-flight
  elicitation BEFORE the user finished the browser dance. Two-phase
  reader now ignores frames until `hello` arrives.
- **Prometheus `subkit_authoring_gate_blocks_total` help text** —
  appended `transform_authoring_requires_inspect` and `critic_rejected`
  so the help string matches the `AUTHORING_GATE_CODES` allow-list.
- **`POST /v1/events` (admin emit) channel enum** — accept
  `workflow.lifecycle` now that `OutboxChannel` + `LISTENER_CHANNELS`
  both declare it.

### Tests

- `oauth.test.ts` happy path asserts the
  `connector.oauth.callback_succeeded` event row is written with the
  documented payload shape (tenant-scoped query implicitly exercises
  tenant isolation).
- `engine-client-oauth-callback.test.ts` pins the replay-discard
  contract.
- `webhooks/events/tests/catalog.test.ts` covers the new event type.

## [4.8.0] (2026-05-12)

### Added

- **OAuth callback auto-resume via pubsub + SSE.** The OAuth callback
  route now publishes `connector.oauth.callback_succeeded` on the
  `connector.oauth` channel after persisting the credential, and sk-cli
  subscribes via `/v1/events/stream`. The in-flight conversation
  auto-resolves its `review_after_execution` elicitation when the event
  arrives — no manual "done" type-back from the operator.
- **`transform_authoring_requires_inspect` gate** — symmetric to the
  existing `loop_authoring_requires_inspect` gate. Refuses a transform
  step whose JSONata `expression` cites `$scope.<X>` for an
  un-previewed sibling X. Wired into `propose_step` and
  `edit_workflow_patch`.
- **`$item.<field>` keys inlined into the authoring context block.**
  When rendering a loop step's manifest the engine resolves the loop's
  source step, reads its recorded `output_preview` from
  `latest_preview.step_traces`, and enumerates the top-level keys (cap
  12) so the LLM can author `$item.id`, `$item.name`, … against real
  data instead of guessing.
- **Inline validation state in the authoring context.** Every authoring
  turn re-runs `validateWorkflowDef` in-process and inlines the error
  list at the top of the block. `validate_draft` is no longer exempt
  from the per-tool repeat cap.

### Fixed

- `apps/engine/src/http/routes/connectors/oauth.ts` imports the OAuth
  callback payload schema via `pubsub/index.ts` so the route-layering
  invariant (`audit:invariants/route_layering`) stays green.
- Three `setTimeout` wall-clock waits in the new OAuth-callback unit
  tests switched to `waitFor`/`flush` from
  `apps/engine/src/test-helpers/determinism/wait.ts` so the determinism
  gate stays green.

## [4.7.8] (2026-05-12)

### Fixed

- OAuth2 token_type canonicalised to `Bearer`; Google `access_type`
  applied so refresh tokens are issued on first consent.

## [4.7.7] (2026-05-12)

### Fixed

- Dropped retired `SUBKIT_PUBLIC_BASE_URL` env fallback in OAuth2
  redirect URI synthesis; rely on `server.public_base_url` setting.

## [4.7.6] (2026-05-12)

### Fixed

- CI: stop biome reformatting auto-generated `embedded.ts`.
- Config: trim `server.public_base_url` description to ≤200 chars.

## [4.7.5] (2026-05-12)

### Fixed

- `verify.sh` date flag for macOS compatibility.

## [4.7.4] (2026-05-12)

### Fixed

- OAuth2: register migration `0017_drop_connector_oauth_redirect_uri` +
  scrub banned-term ref.

## [4.7.3] (2026-05-12)

### Fixed

- OAuth2 v4.7.3 deep review: close all gaps (migration order, state
  lookup, credentials index, redirect_uri synthesis).
- OAuth2: route through credentials index + annotate state lookup.
- OAuth2: synthesize canonical `redirect_uri` server-side.

## [4.6.0] (2026-05-11)

### Added

- **AI SDK 6 / Tools Registry foundation (PR #176)** — three landing
  zones, all additive, no breaking changes.
  - **DB schema** (issue #166): two new tables shipped in migration
    `0015_ai_sdk_6_foundation.sql`. `external_call_metering` mirrors
    `llm_usage` for non-LLM provider costs (Cohere rerank, Firecrawl,
    Exa, Browserbase, …): append-only, per-tenant, month-bucketed for
    cheap `sum(...)` budget rollups. `mcp_servers` holds per-tenant
    configuration for external MCP servers the conversation loop will
    consume (issue #171 writer): `namespace` is unique per tenant and
    used as the tool-name prefix in the merged palette
    (`mcp_<namespace>__<remote_tool_name>`). Both tables carry
    `tenant_id` cascades, tenant-prefixed indexes, and server-side
    CHECK constraints for stringly-typed columns (`transport`,
    `status`, `result`) plus a namespace shape gate and a
    secret-by-reference fence on `auth_config` (rejects root-level
    `client_secret`, `password`, `api_key`, `access_token`,
    `refresh_token`, … — writers MUST reference the `credentials`
    table). Nine `mcp_server.*` / `external_provider.*` audit-action
    constants reserved ahead of the writers landing in #167 / #168 /
    #171 / #174; presence-asserted by
    `audit/tests/mcp-writer-audit-contract.test.ts` with `it.todo`
    slots for the future integration tests.
  - **DevTools wrap** (issue #164): `LanguageModel` is wrapped with
    `@ai-sdk/devtools` middleware when `NODE_ENV !== "production"`.
    Composition order `[scrubAuthHeaders, devtools]` redacts
    `Authorization` / `x-api-key` / `api-key` / `x-auth-token` /
    `x-amz-security-token` *before* the devtools sink writes them to
    `.devtools/generations.json`. The devtools package is loaded via
    `await import(...)` so a production-pruned `node_modules` falls
    back to the unwrapped model. Asserted by unit tests for the scrub
    middleware itself plus a middleware-order regression test that
    fails fast if a future SDK bump flips `wrapLanguageModel`'s
    `reverse().reduce(...)` contract.
  - **Strict-mode tool opt-in** (issue #165): adds an opt-in
    `strict?: boolean` field on `ConversationTool` and threads it
    (plus `example_input` → `inputExamples`) through to AI SDK's
    `tool()` factory. `propose_skill` opts in because its input
    schema is all concrete types; `build_workflow` and `propose_step`
    stay non-strict because their inputs include `z.record(z.unknown())`
    which provider strict mode does not accept. A structural test
    walks each tool's JSON-Schema-7 projection and asserts the
    presence (or absence) of an unrestricted-object node, so a future
    schema tightening on the strict-off tools will fail the test and
    remind the next agent that strict mode is now an option.

### Fixed

- **BYO OAuth2 credential persistence** — Gmail / Google-* / MS Graph
  / Slack drafts that the operator authored via the
  `ask_user_form(type: password, sensitive: true)` flow correctly
  persist `client_id` and `client_secret` through
  `save_connector_draft`. Prior to this fix the form output was
  cached in memory but discarded on save, so the next probe fell
  through to anonymous and surfaced an "auth required" error
  indistinguishable from a real provider 401. Schema-coverage
  cross-check at `extract-credential-from-form-output.test.ts`
  iterates every `AtomicCredentialInput` variant — the test layer
  that would have caught this bug class.

## [4.5.0] (2026-05-11)

### Added

- **Next-message preview (`feat/sk-next-command-preview`)**: after every
  assistant turn, the engine emits a `next_suggestion` SSE event riding
  on the existing converse stream. sk-cli paints the suggestion as
  ghost text in the input composer — the inverted first grapheme acts
  as the cursor, the rest renders dim. Right-Arrow / Tab accept;
  Esc dismisses; typing the matching prefix consumes the ghost
  character-by-character; any divergent keystroke or paste clears it.
  Slash-kind suggestions (`/skill release-notes draft`) accepted via
  Right-Arrow route through the existing slash dispatcher rather than
  being typed back into the LLM.
  Generation runs in a try-pipeline: deterministic English offer-parse
  fast path (`Want me to X?` → `X`) at zero token cost, falling back
  to a Haiku-class model call with a minimal history-only prompt
  (≤30 completion tokens, no skills, no knowledge — the suggestion
  flow has its own `assembleSuggestionPrompt` so it cannot route
  through the heavy converse assembler). Filtered through a 13-rule
  port of Claude Code's `shouldFilterSuggestion` so meta-text,
  evaluative phrasing, and assistant-voice never reach the operator.
  Telemetry: `sk_suggest_next_total{tenant_id, outcome, kind}` covers
  generation outcomes (generated / suppressed / budget_pressure /
  error) and acceptance outcomes (accepted / dismissed / typed_over)
  via the new `POST /v1/conversations/{id}/suggest-next/feedback`
  route. Operators can disable globally via
  `nextCommandPreviewEnabled: false` in `~/.sk/settings.json`; the
  `client_suppress` request flag covers per-conversation opt-out.
  Wins on three axes vs. Claude Code: zero extra round-trip (single
  SSE stream), ~60% of turns produce a zero-token suggestion via
  offer-parse, and skill-aware suggestions resolve to one-keypress
  slash invocations.

### Fixed

- **Release pipeline secret-name alignment** — workflow `release.yml`
  referenced `secrets.DEPLOY_SSH_KEY` / `DEPLOY_HOST` / `DEPLOY_USER`,
  but the repo secrets were named `DROPLET_*` (the names
  `do-bootstrap.sh` writes during digitalocean provisioning). The
  v4.4.0 tag-push deploy job exited 1 — empty SSH key file + empty
  `ssh-keyscan` host — and the GitHub release was published without
  the smoke-verified deploy. Renamed every workflow ref to
  `DROPLET_SSH_KEY` / `DROPLET_HOST` / `DROPLET_USER` so the
  workflow reads from the existing secrets without operator action.
  Widened `scripts/deploy.sh` to accept `DROPLET_HOST` /
  `DROPLET_USER` / `DROPLET_SSH_KEY_PATH` as fallbacks for the
  matching `DEPLOY_*` names, so the laptop deploy and the CI deploy
  read from the same variable names without per-operator env-file
  edits. Re-dispatched the v4.4.0 release; deploy + smoke +
  publish-release all green, prod confirmed at
  `subkit-api.mikebild.dev/v1/health → version 4.4.0`.

## [4.4.0] (2026-05-10)

> Closes [#159](https://github.com/MikeBild/subkit/issues/159) — the full
> 13-milestone sk-cli surface consolidation. `v4.3.0` was tagged before the
> #159 merge, so this entry is the first release that ships the work.
> All M1–M13 deliverables, the G-series follow-ups (G1–G11), and PR #161
> review rounds 1–6 land here.

### Added

- **sk-cli welcome banner (M1 of #159)**: new "what's new" headline row pulled from `SK_WHATS_NEW_URL` (default `https://updates.subkit.dev/whats-new.json`) with a 24h on-disk cache at `~/.sk/whats-new-cache.json`. Async — never blocks first paint. Three-step fallback when the remote is unreachable: (1) last-good cached headline if any, (2) head of the bundled `CHANGELOG.md` (build-time embedded via Bun's text-import so the binary carries it), (3) `null` (banner row hidden) only if even the bundled changelog has no version header — which the typecheck never lets happen.
- **sk-cli welcome banner (M1 of #159)**: `signedIn` prop — when false, replaces the persona/tenant slot with a `not signed in · /profile to sign in` hint.
- **sk-cli /settings 10-tab palette skeleton (M2 of #159)**: replaces the dynamic-from-engine-section tab list in `SettingsModal` with a fixed 10-tab outer shell — `Settings · Status · Config · Usage · Stats · Skills · Permissions · Knowledge · Profile · Admin`. Existing engine-section sub-tab navigation (tab/shift+tab over `llm`, `notifications`, etc.) is preserved inside the `Settings` tab. Outer tabs cycle with leftarrow/rightarrow or `[` / `]`. The Admin tab is hidden unless the principal holds at least one admin-scoped permission (`rbac:read`, `api_key:read`, `audit:read`, `identity:read`, `portal_token:read`); server-side RBAC remains the security source of truth. Two-step Esc: outer Esc closes the modal unless an inner tab's search is active (in which case the inner clears it first).
- **sk-cli /settings → Config tab (M3 of #159)**: flat searchable list of every setting leaf across all engine sections. `/` focuses the filter; typing narrows by path or description; Enter opens the existing FieldEditor for inline editing; first Esc clears the filter, second Esc closes the modal. Reuses `SettingItem`, `FieldEditor`, `ConfirmModal`, `SearchInput` from `settings-ui/components/`.
- **sk-cli /settings → Status tab (M4 of #159)**: runtime snapshot — CLI version, cwd, **session id, session name, login email, tenant, role, engine base URL, active model, permission mode, session token count, week token count**, MCP catalog counts (tools / prompts / resources), and aggregated setting-source diagnostics. MCP catalog refreshes every 5s while the tab is foreground; the polling interval is cancelled on tab switch and modal close (no-leak verified by test). REPL-state rows are populated when the modal is opened from the REPL via `/settings`, and fall back to `—` for the standalone `sk settings` CLI.
- **sk-cli /settings slash + SettingsPane (G2 of #159 follow-up)**: new `/settings` slash (alias `/preferences`) opens the 10-tab palette **inside the REPL** (not as a child Ink instance) via a new `kind: "settings"` PaneSpec. Plumbs `sessionId`, `permissionMode`, `sessionTokens`, `weekTokens` from `InkAppProps` through `SettingsPane` to `StatusTab`. New `engineClient` prop on `InkApp` carries the active client to the embedded modal.
- **sk-cli /settings → Usage tab (M5 + G6 of #159)**: top-5 flows by total tokens, sourced from the existing `llm.invocation` audit events (engine already emits these from `apps/engine/src/llm/core/invoke.ts:619` with `prompt_tokens` + `completion_tokens` + `flow` in metadata). UsageTab now calls `tailAuditLog({ action: "llm.invocation" })` and aggregates by `metadata.flow`, rendering totals (prompt + completion = grand) plus per-flow horizontal bars. `r` refreshes; non-`llm.invocation` rows are filtered out.
- **sk-cli /settings → Stats tab (M5 of #159)**: ASCII activity heatmap of recent audit events grouped by day; toggle window with `1` (Last 7), `2` (Last 30), `3` (All time). Renders totals and a current-day streak counter. No new dependency — the heatmap is built from five glyphs based on count quintiles.
- **sk-cli /settings → Skills tab (M6 of #159)**: lists all skills (active, draft, archived) with status checkbox; `space` or Enter toggles between `active` and `archived` via the existing per-skill `/activate` and `/archive` engine routes. `/` opens an inline filter; toggle errors render inline without flipping the row state. RBAC is enforced server-side (no client gate beyond the Admin tab visibility check).
- **sk-cli /settings → Permissions tab (M6 + G4 of #159)**: radio over `Default / Auto-review / Plan only / Full Access` mapping to the REPL permission modes `ask / auto / plan / yolo`. Persists via the new engine setting `repl.permissionMode` (tenant-scoped, default `ask`). PermissionsTab calls `client.setSetting("repl.permissionMode", mode, { tenant })` on Enter; success/error rendered inline. Tab hydrates current value from `listSettings` on mount.
- **engine `repl.permissionMode` setting (G4 closure of #159 M6)**: new `repl` config section, tenant-scoped, four-value enum (`ask | auto | plan | yolo`), surfaced in `skBootstrap.prefs` so the CLI's startup picks it up alongside `theme`, `personality`, `title.format`, `statusline.format`. OpenAPI types regenerated.
- **sk-cli ConsentPrompt component (M6 of #159)**: generic `1. Yes · 2. Not now` numbered consent at `apps/sk/src/repl/components/ConsentPrompt.tsx`. Pressing `1` confirms; `2` or Esc cancels. Designed to be reused from `/memory`, `/install`, and the Permissions selector.
- **sk-cli /settings → Knowledge tab (M7 + G8 of #159)**: list of tenant knowledge sources from `/v1/knowledge-sources` with status + last-indexed timestamp; `↑/↓` navigate, `/` filter, `d` delete (uses `ConsentPrompt`), `r` refresh, **`i` ingest** opens an inline path prompt that reads the file from disk (absolute path or relative to cwd), guesses MIME by extension, and POSTs via `createKnowledgeSource`. Errors render inline; success refreshes the list automatically.
- **sk-cli /settings → Profile tab (M7 + G7 of #159)**: identity card from `skBootstrap` plus an inline action menu — `n` start a new session (clears session.conversationId in the host), `t` switch tenant (loads `listIdentityTenants`, persists via `saveProfile()`, surfaces a "restart sk to apply" notice), `s` sign out (clears `api_key` in config, emits sign-out action, host exits the REPL). The new `onProfileAction` callback chain plumbs from `ProfileTab` → `SettingsModal` → `SettingsPane` → ink-app's `setSession` / `onExit`.
- **sk-cli /settings → Admin tab (M8 + G9 of #159)**: 7 sub-tabs over admin resources — `RBAC`, `Subscriptions`, `API Keys`, `System Accounts`, `Hooks`, `Notifications`, `Portal Tokens`. `1`–`7` jump directly to a sub-tab. The Admin tab is hidden unless the principal holds an admin-scoped permission (UX gate; server enforces independently). **Inline create + revoke flows for every sub-tab**: a generic `AdminCreateForm` component renders multi-field text inputs that POST to the matching engine route (`createRole`, `createSubscription`, `issueApiKey`, `createSystemAccount`, `createHookInbound`, `createNotificationChannel`, `issuePortalToken`); revocation flows reuse `ConsentPrompt`. API key + portal token issuance render the plaintext secret exactly once in a yellow-bordered panel with a `y to copy` shortcut wired to OSC 52, then clear it. Every mutation hits an existing engine route that already writes a tenant-scoped audit entry.
- **sk-cli quick-action slashes (M9 of #159)**: `/copy` writes the last assistant message to the clipboard via OSC 52 (with a clean fallback message on non-TTY); `/rename <title>` renames the active conversation via `patchConversation`; `/fork` detaches the current session locally so the next prompt starts a fresh conversation while the original stays resumable on the server; `/mention` returns a discoverability hint pointing at the existing `@`-prefix composer picker. `/init`, `/draft`, `/export` were already in the registry and are unchanged here.
- **sk-cli /resume rewind toggle (M10 + G10 of #159)**: ConversationBrowser responds to `t` by switching into a real assistant-turn timeline (sourced from `session.messages`); `↑/↓` navigate, Enter calls `onForkFromTurn(message_id)` which posts `POST /v1/conversations/{id}/fork-from-message/{message_id}` and switches the active conversation to the new fork. Empty state ("no assistant turns") rendered when the session has no assistant messages yet.
- **engine fork-from-message route (G10 closure of #159 M10)**: new `POST /v1/conversations/{id}/fork-from-message/{message_id}` route + `forkConversation` service in `apps/engine/src/conversations/service/fork.ts`. Inserts a new conversation row copying connector/workflow/draft/memory/model from the source, then copies every message with `created_at <= anchor.created_at` from `conversation_messages` into the new conversation. Tool-calls and elicitations are intentionally NOT copied — re-running them would duplicate side effects. Audit row carries `forked_from`, `anchor_message_id`, `copied_message_count` metadata. OpenAPI types regenerated.
- **sk-cli value pickers (M11 + G5 of #159)**: stand-alone Ink pickers at `apps/sk/src/settings-ui/components/ValuePickers.tsx` for `Theme`, `Personality`, `Title format`, and `Status line`. The Theme picker renders side-by-side live preview at terminal width ≥ 120 cols and falls back to single-column below. Enter commits, Esc cancels and restores the snapshot. **Surfaced from the Config tab**: a `PICKER_PATHS` set maps `ui.theme`, `ui.personality`, `ui.title.format`, `ui.statusline.format` to their respective pickers; pressing Enter on those rows opens the matching picker instead of the generic FieldEditor and persists via the same setSetting call.
- **engine `ui.*` settings (G5 closure of #159 M11)**: new `ui` config section with tenant-scoped enums for `theme` (auto/light/dark/high-contrast), `personality` (concise/balanced/verbose), `title.format` (session-id / tenant-session / model-tenant-session), `statusline.format` (minimal/compact/detailed). Surfaced in `skBootstrap.prefs` so the CLI's first paint matches the operator's configured chrome.
- **sk-cli push notifications module (M12 of #159)**: `apps/sk/src/repl/notifications/index.ts` exports `notify(title, body, elapsedMs, opts)` which emits OSC 9 (iTerm2 / WezTerm / modern terminals) followed by a BEL fallback when the elapsed time crosses `thresholdMs` (default 30 s) and the operator has opted in. Quiet hours are honored via a caller-supplied predicate. **Wired into `applyEventStream` in ink-app.tsx**: every turn's elapsed wall-clock is measured; on stream completion `notify()` is called with the last assistant message as the body. Opt-in via `SK_PUSH_NOTIFY=1`; threshold via `SK_PUSH_NOTIFY_THRESHOLD_MS` (defaults to 30 s). Engine-side `notifications.push.*` settings will replace the env-var read once they land in a follow-up.
- **sk-cli /session slash (M12 of #159)**: mints a 15-minute portal token via `client.issuePortalToken` scoped to a single workflow id (the engine requires `allowed_workflows.length >= 1`) and renders a terminal QR code via `qrcode-terminal` (new dependency, Apache-2.0). Usage `/session <workflow-id>`. Audit entry written by the engine on token mint; the token is single-use and tenant-scoped. The slash requires the `portal_token:read` permission.
- **sk-cli removed-slash guidance + destructive M13 pass (M13 + G11 of #159)**: `apps/sk/src/repl/slash/dispatcher.ts` exports `REMOVED_SLASH_GUIDANCE` + `removedSlashGuidance(name)`. The destructive delete pass shipped with G11: per-service install slashes (`/install-slack`, `/install-teams`, `/install-github`, `/install-google-workspace`, `/install-salesforce`, `/install-jira`, `/install-hubspot`) are removed from `SLASH_COMMANDS`; their handler file `apps/sk/src/repl/slash/handlers/install-wizards.ts` is deleted; the unified `/install` slash is registered in their place. Two cohorts in the guidance map: (a) **deleted in M13** — the seven install-* shims, redirecting to `/install`; (b) **agentic-coding slashes that subkit intentionally never ships** (`/agents`, `/fast`, `/plan`, `/diff`, `/output-style`, `/rewind`) — guidance is permanent. New parity test `apps/sk/src/tests/slash-dispatcher-contract.test.ts` enforces (i) every registered slash + alias resolves to a non-`unknown` routing, (ii) no entry in `REMOVED_SLASH_GUIDANCE` overlaps a registered command, (iii) the seven install-* shims are gone, (iv) `/install` is registered. Wider CLI-group consolidation (`apps/sk/src/commands/` → 10 scripted verbs) is intentionally deferred — the engine routes those CLI verbs target are still the operator's primary scripting surface, and removing them at the same time as the slash UI work would broaden the regression surface beyond what one PR series can stabilize. `apps/sk/AGENTS.md` updated to document the consolidation + the embeddable `SettingsPane`.

### Removed

- **tunnel-agent**: removed the tunnel-agent subsystem (engine WS server, agent binary, sk tunnels CLI, tunnel:* RBAC permissions, tunnels DB tables, deploy port 3001 and subkit-tunnel.* DNS).

## [4.0.0](https://github.com/MikeBild/subkit/compare/subkit-v3.5.1...subkit-v4.0.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* **engine,sk,docs:** API consumers calling the `commit_draft` tool by name must switch to `save_workflow_draft`. The REST/MCP surface, the audit `commit_intent_kind` field values, and the `force_commit` input field all rename per repo's no-backwards-compat policy.
* 41 historical migrations consolidated into a single v3 baseline. Existing 2.x deployments must run scripts/db/upgrade-to-v3-baseline.sh before deploying v3 binaries.
* **execution:** runExecution() accepts a discriminated `source` union instead of a bare workflow_id. All three kinds (saved, draft, step) flow through the same runtime pipeline; only the origin differs.

### Features

* add cleanup conversation write tools ([6d73d6a](https://github.com/MikeBild/subkit/commit/6d73d6a5653a1ee8b0484ddd815917886ad23d39))
* add direct automation workflow surface ([caa4449](https://github.com/MikeBild/subkit/commit/caa4449bd7b3926645667cded669c79e8bc4c2ec))
* align runtime with documented envelope + surface drift feedback ([d3775b1](https://github.com/MikeBild/subkit/commit/d3775b193435942c93d8fefb598b3b815a60653a))
* **authoring,llm,sk:** schema-first authoring redesign — KK→QQ + reference-aligned discipline ([f01d3a7](https://github.com/MikeBild/subkit/commit/f01d3a79bac464a8db631089becbd63e31e73100))
* **authoring,sk,chat-ui:** close residual reference-impl gaps — RR→UU ([e65af7a](https://github.com/MikeBild/subkit/commit/e65af7a17b92e9e1da0365147e8ab95afe1d47cd))
* **authoring,sk,llm,observability:** close root-cause UX + observability gaps from sessions f00b8d1c/820c1664/80eec7c8 ([c0b72df](https://github.com/MikeBild/subkit/commit/c0b72dfa6f936b99a31dbae931b2adfd7df3e5f1))
* **authoring:** close remaining FOLLOWUP gaps — preview parity, credentials, structured panes, richer snapshot ([d9b53e0](https://github.com/MikeBild/subkit/commit/d9b53e05fc8c38f796a570e9b9ba36b36a913cda))
* **authoring:** harden guided state, palette, and prompt flow ([6e5eed1](https://github.com/MikeBild/subkit/commit/6e5eed14c717a2d9a67b895f18d02304679bad54))
* **authoring:** masked secrets + 3 more cards + route-doc parity gate ([af1ca67](https://github.com/MikeBild/subkit/commit/af1ca673d32acc857684c052c3e017fea47b1db6))
* CLI commands, MCP resources, scheduler, edge case + journey tests ([a944ba8](https://github.com/MikeBild/subkit/commit/a944ba88f2cc5cbf933dff32d422f2e8ddd942e6))
* **cli-core:** generated engine API client from OpenAPI (B1) ([5b937e6](https://github.com/MikeBild/subkit/commit/5b937e686c70709e314b72fefdb75bc5f12d5af0))
* **cli:** skills delete, --show-source, scaffolders, persona docs ([aa7a0a4](https://github.com/MikeBild/subkit/commit/aa7a0a44c6b324f05bac3129fee10b645127a61a))
* close end-to-end prompting/eval/context/execution/verification gaps ([85c9400](https://github.com/MikeBild/subkit/commit/85c9400311da8ab546e9baaa2487f94cd12d3e4b))
* complete guided authoring and operator verification ([41ad42e](https://github.com/MikeBild/subkit/commit/41ad42ee9f058940a1e1fd2f710bff716c9afcfe))
* **connectors,credentials:** cognito/jwt-bearer/device-code/sigv4 auth flows + GraphQL type-preserving resolver ([738c0fc](https://github.com/MikeBild/subkit/commit/738c0fceb7687ca9b6208df0288edf008f507a0d))
* **connectors,discovery:** GraphQL connector save auto-runs introspection discovery ([175d6d6](https://github.com/MikeBild/subkit/commit/175d6d6c50d3028088e52b68deb22d9a94b37f2d))
* **connectors,docs:** A3 + A8 — auth-chain + Schedule+State recipe few-shot examples ([f4298d8](https://github.com/MikeBild/subkit/commit/f4298d8fd65af8555520be6972e3378c8ead1d18))
* **connectors,llm,mcp,discovery,events:** close 4 behavioral gaps via reference-project audit ([c5218c5](https://github.com/MikeBild/subkit/commit/c5218c5cb0430f19479abd92dd700a9f7f7e81da))
* **connectors,scripts:** Layer-3 vendor-drift sweep + verified_at stamp ([#63](https://github.com/MikeBild/subkit/issues/63)) ([d950a79](https://github.com/MikeBild/subkit/commit/d950a796f29fd938870f30f2de5ab9d3525b757f))
* **connectors:** add redis, mssql, ftp, sftp, smb drivers ([50f416e](https://github.com/MikeBild/subkit/commit/50f416e34f260add631228ce612dff3c4d5a2f03))
* **connectors:** enrich template model with URL matching, smart probes, OAuth2 details, and spec import ([78742ba](https://github.com/MikeBild/subkit/commit/78742ba3e45eaaefabf46866e553f753f10d70ab))
* **conversations,connectors,security:** conversational creation rebuild — skill-gated palette, harness auto-persist, secret hygiene, live API discovery ([629bb82](https://github.com/MikeBild/subkit/commit/629bb828058f3f48f90e27cbe140448455fb02b1))
* **conversations,http:** file-attachment system + [@attachment](https://github.com/attachment):&lt;slug&gt; resolver ([80f0fdd](https://github.com/MikeBild/subkit/commit/80f0fdd55139890db21e45b026cd44ca7f460284))
* **conversations,llm:** tenant-snapshot converse pipeline + connector-template binding ([5beeeaa](https://github.com/MikeBild/subkit/commit/5beeeaab8ceea6543de7210cb27e5d26672a5385))
* **conversations,recipes:** multi-connector recipe binding via connector_bindings ([#54](https://github.com/MikeBild/subkit/issues/54)) ([cc8f735](https://github.com/MikeBild/subkit/commit/cc8f735b52a6b622f554317075ce41d8fa501dfc))
* **conversations,sk:** draft checkpoints + skill autoload + sk session commands ([085578b](https://github.com/MikeBild/subkit/commit/085578b7df973b901c5dd1eb8a42fb68c72d3c15))
* **conversations,sk:** guided authoring — real preview, probe/commit gates, resume summary, context block ([0e2178e](https://github.com/MikeBild/subkit/commit/0e2178ec07dbc219228b3a71dc46098bc3718272))
* **conversations,sk:** tool-policy hooks (credentialFields, prerequisites, buildPendingOutput) + setup-validation in /v1/status ([984aeb0](https://github.com/MikeBild/subkit/commit/984aeb04efb6fb6dabebd535f3620d8e01f86779))
* **conversations,workflows:** build_workflow one-shot + sampleToSchema ([6a0fdff](https://github.com/MikeBild/subkit/commit/6a0fdff207092e988fe2f75dcf4e7e2a1801993f))
* **conversations:** add match_connector_template_by_url and import_connector_from_spec tools ([47e8600](https://github.com/MikeBild/subkit/commit/47e8600c5e7d41328126e77729f6895ee5d2020d))
* **conversations:** anchor tool calls + elicitations to parent message ([baadbbb](https://github.com/MikeBild/subkit/commit/baadbbbd932ea70786e91ef650e485422a7135cb))
* **conversations:** discovery artifact tools — list / get / approve ([a932cfb](https://github.com/MikeBild/subkit/commit/a932cfb780a78a6aec4abe53c9078f9c5c1b41c4))
* **conversations:** dry_run_transform — jsonata/jsonpath/template probe ([49689d9](https://github.com/MikeBild/subkit/commit/49689d94ca93446545184ce77b68a0aed0722565))
* **conversations:** generic update_&lt;resource&gt; tools across all CRUD-shaped resources ([d5cc559](https://github.com/MikeBild/subkit/commit/d5cc559657e027837c574a09eef52846e1b28cd4))
* **conversations:** probe_connector tool — authenticated one-shot HTTP probe ([bef2f2a](https://github.com/MikeBild/subkit/commit/bef2f2a5beb07ca12a42f6ddc9463fbd0b25bef5))
* **conversations:** SDK tool-calling loop with streamText + fallback (A5) ([a2670a2](https://github.com/MikeBild/subkit/commit/a2670a27e5a20a73b50e91b0f3a76fd8f0d29a8b))
* **conversations:** static verifier + onboarding hint ([a4adc9c](https://github.com/MikeBild/subkit/commit/a4adc9c735e663b55f39bd1295ad9cedbd7e879d))
* **conversations:** wire interaction_log events through elicitation flow ([8fbd6a3](https://github.com/MikeBild/subkit/commit/8fbd6a3474df2376b2364ee803e3ad4aeb1315a9))
* **credentials,connectors:** A4 token_mint mode + Salesforce OAuth2 password grant ([a35b4fe](https://github.com/MikeBild/subkit/commit/a35b4fe21d6a45e0bb686865e2b58db123d0e8c5))
* **db:** migration 0028 convo-quality — skills seed, attachments, DLP, drafts ([7d3cf97](https://github.com/MikeBild/subkit/commit/7d3cf9703bdd0a7ad8f6a3ab2041a4c5edd7f342))
* **deploy:** consolidate local + CI deploy into one versioned pipeline ([f18e76b](https://github.com/MikeBild/subkit/commit/f18e76bf930758412b917bfe1bf4838f541deb13))
* **deploy:** switch production engine to engine-with-cli + sync prod compose per release ([9ecdf7d](https://github.com/MikeBild/subkit/commit/9ecdf7d329e0095d8606e667da08be9467974604))
* **discovery:** codebase archive upload + extractor ([b6c4a0a](https://github.com/MikeBild/subkit/commit/b6c4a0af7f2f90f414d23d32158dd325f1020c67))
* **discovery:** postgres+mssql introspection, SDL corpus, html→markdown, swaggerhub /apis-docs ([cd4fcae](https://github.com/MikeBild/subkit/commit/cd4fcae46618f4b87eb834c71d6652bb4a1489d7))
* **docs-ingestion:** knowledge-ingress cascade orchestrator ([e95c018](https://github.com/MikeBild/subkit/commit/e95c018763906d32c778ad9c0219a6cd79a74435))
* **docs,knowledge:** close 8 documentation+knowledge gaps to reach reference parity ([c0b8ddf](https://github.com/MikeBild/subkit/commit/c0b8ddf42c2c0b3fec208fef1b1256913bd1d1c1))
* **e2e+engine:** real-LLM E2E suite + diagnostics endpoint + provider routing fix ([83f6b09](https://github.com/MikeBild/subkit/commit/83f6b09722f64a3bcb6a05a4a3bfa4c523d3987b))
* **engine,connectors:** add CloudWatch + STS + EventBridge + OAuth2 templates with recipes ([d06dcf6](https://github.com/MikeBild/subkit/commit/d06dcf62c2641f8efea89265ad915ed22879c8b9))
* **engine,connectors:** widen save_connector_draft credential union with cognito_user_password + aws_sigv4 ([2158bba](https://github.com/MikeBild/subkit/commit/2158bba067dc925a593da9b1cb503c16f06830a1))
* **engine,conversations:** per-step model routing, tool-call repair, deterministic critic, streaming guard short-circuit ([eb71e22](https://github.com/MikeBild/subkit/commit/eb71e22b1c8096ca403fed9f48b6ace62fd3b96b))
* **engine,llm,conversations:** enrich recipe context + add inspect_recipe tool ([32c1d4f](https://github.com/MikeBild/subkit/commit/32c1d4fcd1211fa570182ebd37748b7c51c0f969))
* **engine,llm:** add critic rubric + step-router scaffold for the converse loop ([f95b688](https://github.com/MikeBild/subkit/commit/f95b68839bb8550e633a030551c5a5479db17dd5))
* **engine,llm:** default enable_prompt_cache to true ([bfa435b](https://github.com/MikeBild/subkit/commit/bfa435bf2f956b5f64b61ea1d29a06609af8733e))
* **engine,recipes:** add demonstration recipes for unused step primitives ([06bb860](https://github.com/MikeBild/subkit/commit/06bb860e6a15d4584a9e80d3bf2d438220bee628))
* **engine,recipes:** add lint:recipes quality gate + intent_keywords fixer ([3c8a403](https://github.com/MikeBild/subkit/commit/3c8a4030e1972fba2c4015679a3d611b7f1afb35))
* **engine,recipes:** extend ConnectorRecipeSchema + migrate 190 recipes ([7bcee7e](https://github.com/MikeBild/subkit/commit/7bcee7eb00869c5eb2181b03b6a56bf397b7d8ba))
* **engine,sk,mcp,http:** expose recipes on HTTP + CLI + MCP surfaces ([d2bc7d0](https://github.com/MikeBild/subkit/commit/d2bc7d01b98b771f9cb0df3ef6be9560ae0849fe))
* **engine,workflows,execution:** wire per-step outputs[].secret scrubber ([f72ddd4](https://github.com/MikeBild/subkit/commit/f72ddd442bb1edc41e528817d1c96ae5a7b23128))
* **engine:** add structured runtime logs and enterprise compliance audit trails ([97f4ae7](https://github.com/MikeBild/subkit/commit/97f4ae7a493ef60ece18523a18af93671b96962e))
* **engine:** answer-before-action, vendor-recipe lookup, visible approvals, output-guard repair ([0798405](https://github.com/MikeBild/subkit/commit/079840588e6b7f1ac82c6382dea71adbce4aa9e3))
* **engine:** grounded-output guard, runtime context, abstention + transcript-closing slice ([079ee9f](https://github.com/MikeBild/subkit/commit/079ee9fd290e46abf94c51b64fcea2a8a175598a))
* **engine:** implement Approach 2 pre-analyzed multi-step workflows ([f793e52](https://github.com/MikeBild/subkit/commit/f793e52724a75bc0f04c9d303871272cd1f97e31))
* **engine:** seed RBAC essentials on startup ([7329df6](https://github.com/MikeBild/subkit/commit/7329df67fe836c9bb8c9ad21e3cd8f12bac18040))
* **engine:** shared schema spine + observability + audit coverage ([603c7ec](https://github.com/MikeBild/subkit/commit/603c7ecdeb2a02c4f2a84170c90e469500e82fcf))
* enhance connector recipes and authoring determinism ([61a3f85](https://github.com/MikeBild/subkit/commit/61a3f85d9166fecb5c8f7d236303ed1337d32d62))
* **eval:** aggregate metrics + integration fixtures ([8ca6759](https://github.com/MikeBild/subkit/commit/8ca675957f8cd54ee640516e9d93e95a6b0018b7))
* **eval:** conversation-quality fixtures + validators ([0208e5a](https://github.com/MikeBild/subkit/commit/0208e5ad5f8705cfd2b0b9d3979c15ab088b9058))
* **execution:** definition-driven run model with saved/draft/step sources ([40131f8](https://github.com/MikeBild/subkit/commit/40131f874406d8d0e580e8ebdcf506355ebc0162))
* **execution:** per-step retry overrides + response-filter scopes ([be6181f](https://github.com/MikeBild/subkit/commit/be6181f0449364df8995daf6c8be758a23f6a879))
* **execution:** S3-backed large-payload offload ([f1d6fae](https://github.com/MikeBild/subkit/commit/f1d6faed060adade199e78e0118d8876ecb16830))
* **execution:** surface request_meta and connector_resolutions in run result ([5aa1708](https://github.com/MikeBild/subkit/commit/5aa170886859dc2297b5e018d134384d0fd5c83d))
* **execution:** tenant DLP layer — response-filters with defaults ([4ce6c1f](https://github.com/MikeBild/subkit/commit/4ce6c1f3b24ea65e4499d3050282c95a046a01d8))
* expand connector template catalog to 89 production-quality templates ([ae257d5](https://github.com/MikeBild/subkit/commit/ae257d5bf7155e87328cefba5165cffc3c93661f))
* H2 Knowledge Sources, H2.5 Discovery, H3 Self-Improving Skills ([249320c](https://github.com/MikeBild/subkit/commit/249320c8a2566fcd309987dc06fbcf687ba4de17))
* **http,mcp,self-healing:** expose URL match and spec import, rate-limit classifier, inline_schema indexer ([693c2ea](https://github.com/MikeBild/subkit/commit/693c2eae1dab9a48186b6cd0e87960b54422721b))
* **http,sk:** /v1/settings routes + sk settings command ([600e33c](https://github.com/MikeBild/subkit/commit/600e33cd2b949768093195b9558a2da3a32537de))
* **http:** GET /install route serves a sk install script (Tailscale pattern) ([9477535](https://github.com/MikeBild/subkit/commit/947753566dc63209dbac3dfe6ad2999b0c6b3139))
* initial commit — subkit workflow engine ([befda15](https://github.com/MikeBild/subkit/commit/befda15e261f74bf0efe64e069522c9c89912182))
* **install:** bundle sk + tunnel-agent binaries inside engine image (closes [#64](https://github.com/MikeBild/subkit/issues/64)) ([31f2280](https://github.com/MikeBild/subkit/commit/31f22804e2521ed3c6461a3768cce34bc5b55a61))
* **llm+conversation:** parity wiring — core, tools, policies, confirmation, streaming, eval ([6fa9794](https://github.com/MikeBild/subkit/commit/6fa9794107432cb1098faa5bd9b8ad5583bbeead))
* **llm:** extended converse prompt + five pseudo-message builders ([68ef177](https://github.com/MikeBild/subkit/commit/68ef17792c19fc3648eab47a00957bf00aacb8d4))
* **llm:** generateObject + prompt caching + provider registry ([b8928cb](https://github.com/MikeBild/subkit/commit/b8928cbb86f04db481b5ea790e093b22f4256dcf))
* **llm:** per-flow env provider/model overrides ([a8b143c](https://github.com/MikeBild/subkit/commit/a8b143c4d614b91e7f1e9e12602984d23884c861))
* **llm:** per-tenant vendor-recipe overrides ([057ff88](https://github.com/MikeBild/subkit/commit/057ff881d875feab787445195dec38c3297ba6a6))
* **llm:** placeholder substitution system — parser + resolver + get_connector ([b7edbb3](https://github.com/MikeBild/subkit/commit/b7edbb36e44ecd9baab49dfa4b79a4e97259539f))
* **mcp:** destructive-action gate, synthesized input schemas, transform warnings ([7301007](https://github.com/MikeBild/subkit/commit/7301007e4700ac2066dbb0a36f893489faec9e17))
* **mcp:** mode-split tool catalog with native authenticate tool ([868dd1d](https://github.com/MikeBild/subkit/commit/868dd1dea22bfc570bda4fce27d67097cca51132))
* **observability:** langfuse tool spans + defense-in-depth redaction ([f0cf866](https://github.com/MikeBild/subkit/commit/f0cf866f8ab51950d39fae98d0b217a92fbc028c))
* **observability:** OpenTelemetry tracer bootstrap with Langfuse (A6) ([c7e53d5](https://github.com/MikeBild/subkit/commit/c7e53d5790f97a32bd31cf85741a4353607dc76d))
* **onboarding,http,sk:** first-run bootstrap thin-slice + POST /v1/setup + sk init ([#60](https://github.com/MikeBild/subkit/issues/60)) ([11789dd](https://github.com/MikeBild/subkit/commit/11789dd64d782ac1202825f8bf5c5692e1cef33a))
* **onboarding:** demo-seed workflows + expertise tone hint ([db86d77](https://github.com/MikeBild/subkit/commit/db86d77228417e2da7eead43c73865a805004bfa))
* OTA auto-update system for all binaries with comprehensive tests ([a019f26](https://github.com/MikeBild/subkit/commit/a019f2605767c78a18a8c93956e486ce9f02f67d))
* **output-guard:** chat-first scanner — runtime gate for curl/shell suggestions ([5b9abfd](https://github.com/MikeBild/subkit/commit/5b9abfdc4dc9018131a5df8b59f8dd02a576c442))
* P11 elicitations and Claude Code UX for sk ([1e7e89c](https://github.com/MikeBild/subkit/commit/1e7e89cb0a12139401d5fdfcf0f3fe59d6cd4861))
* **release/version.sh:** current_version = max(manifest, package.json) ([51c2f15](https://github.com/MikeBild/subkit/commit/51c2f153f60290e8a9844fd98857c76511b261fc))
* **sandbox:** sk-stdlib with version tracking and drift detection ([2d5fe5f](https://github.com/MikeBild/subkit/commit/2d5fe5f5449fcdffce6f2cd5bb0c40bcc7beaba3))
* **scheduler,recipes,sk:** schedule trigger end-to-end (cron+tz+skip) ([#47](https://github.com/MikeBild/subkit/issues/47)) ([c17265f](https://github.com/MikeBild/subkit/commit/c17265f1eec44afb8358f5b206eded1a9c8a209e))
* **security,execution,discovery,sk:** conversational creation rebuild round 2 — SSRF guard, pagination resume, GraphQL+llms.txt+playwright discovery, multi-driver call_connector, sk CLI ergonomics ([d9125c7](https://github.com/MikeBild/subkit/commit/d9125c7ae214ec02fccf9f96c2288fcb6e8e0459))
* sk ctx gauge + engine context-window safety fixes ([#74](https://github.com/MikeBild/subkit/issues/74)) ([a7edb1d](https://github.com/MikeBild/subkit/commit/a7edb1dd44bfb026599a00a4218223c89e999fcb))
* **sk,approval:** describeApprovalTarget helper + richer external-write card ([35c0f06](https://github.com/MikeBild/subkit/commit/35c0f06cfcdd49ac8612169dac22df553558f044))
* **sk:** add full debug trace logging ([236d978](https://github.com/MikeBild/subkit/commit/236d978c13d90f7aaf2b2ad8f268b4a81abd4b9e))
* **sk:** add setup diagnostics UX ([5ba0c73](https://github.com/MikeBild/subkit/commit/5ba0c7308f611efc39a9f2baabb9176959cefc68))
* **sk:** consolidate subkit admin CLI into unified sk binary ([13f38cc](https://github.com/MikeBild/subkit/commit/13f38cc0f93f42a9d499f8420682b37396221dde))
* **sk:** doctor command for first-line operator diagnostic ([6cf911d](https://github.com/MikeBild/subkit/commit/6cf911d020211846ed2fa26516bb7f587a871550))
* **sk:** enrich transcript and session surfaces ([049dc60](https://github.com/MikeBild/subkit/commit/049dc60c809d6cfcdbdb54fddc0e5a21795ed9ed))
* **skills,connectors,llm:** A1 + A5 + A6 — recipe-coverage gate, step_kind activation, recipe budget cap ([766fcbf](https://github.com/MikeBild/subkit/commit/766fcbfab81b3ad9103803c7eecce10ea75ef44f))
* **skills,tools:** 10 Markdown skills + seed loader + description compiler ([0bb0f27](https://github.com/MikeBild/subkit/commit/0bb0f2741ec2215ae79989aba30242c7672ec485))
* **sk:** run command supports saved/draft/step sources, new sk auth ([6775c0f](https://github.com/MikeBild/subkit/commit/6775c0f4c301aa9727f3bf5d3265402c13ecd1f8))
* **sk:** shift+enter and backslash-enter for newline (codex parity) ([3413aed](https://github.com/MikeBild/subkit/commit/3413aedc41efd82670e1b7170fbba2c9b6ccd586))
* **sk:** unify guided action UX ([bade164](https://github.com/MikeBild/subkit/commit/bade1642fcc234357c727472dd671eee0c6fe3ff))
* **tunnels:** add TCP passthrough for multi-protocol routing ([3d0db26](https://github.com/MikeBild/subkit/commit/3d0db2651d71988897d34d8d1ffe71e0f3887d88))
* v3.0.0 release prep — gates, baseline, settings, type-safety, OSS surface ([790f3f7](https://github.com/MikeBild/subkit/commit/790f3f7a74ba8b5f148717701a35affaeff45081))
* **webhooks,recipes,sk:** webhook trigger end-to-end Stripe → Slack ([#46](https://github.com/MikeBild/subkit/issues/46)) ([7ca43e4](https://github.com/MikeBild/subkit/commit/7ca43e449348d3ab861c34202032448d3e5877cd))
* **webhooks:** failure classification, dead-letter, payload-reconstructing replay ([aa31f7b](https://github.com/MikeBild/subkit/commit/aa31f7ba274aac9e2332e65b89c3333045eb8481))
* **workflows,audit,webhooks,scheduler:** WorkflowDef.trigger + reverse bind/unbind + AuditAction sweep ([#67](https://github.com/MikeBild/subkit/issues/67)) ([504fce4](https://github.com/MikeBild/subkit/commit/504fce495e2482620709030d4ebb59eb9f49e80f))
* **workflows,execution,audit:** [#48](https://github.com/MikeBild/subkit/issues/48) wait restart-safety + 24h cap + step-level audit pair ([3f92edb](https://github.com/MikeBild/subkit/commit/3f92edba14eed575860617f58319ec351dba5f08))
* **workflows,execution,audit:** per-run LLM token budget + external_write audit ([#53](https://github.com/MikeBild/subkit/issues/53)) ([1d126ff](https://github.com/MikeBild/subkit/commit/1d126ffb262e89cde26ffef8a26c4aa6e0a16729))
* **workflows,execution,http:** [#49](https://github.com/MikeBild/subkit/issues/49) wait-for-event with HMAC-signed approval URL ([98bb081](https://github.com/MikeBild/subkit/commit/98bb0813722c63214a6367be96eebc98fc2ac8de))
* **workflows,execution,llm:** [#51](https://github.com/MikeBild/subkit/issues/51) persistent per-workflow state for cross-run cursors ([49163cc](https://github.com/MikeBild/subkit/commit/49163cc5cc0504e64a98d66483b6c44a6d09540d))


### Bug Fixes

* address code review findings — discovery routes, validation, budgets ([3a74d5c](https://github.com/MikeBild/subkit/commit/3a74d5c89126a5010417def91d28760297fdcb58))
* **agent:** handle --version / -v before parseArgs ([8f4e58a](https://github.com/MikeBild/subkit/commit/8f4e58acc6899ab2ebecaef496ef7f888c4d1f4e))
* align authoring, eval, and sk surface contracts ([22a1eb6](https://github.com/MikeBild/subkit/commit/22a1eb6157071c305fbabb77766ebd9e39c8bc72))
* **audit:** emit full {items,next_cursor} envelope in JSON mode; broaden auth error regex ([5e18177](https://github.com/MikeBild/subkit/commit/5e18177346b0b997319140093731c44dda2cd5f0))
* **audit:** pr_template skips release-please-generated PRs ([eaa95a1](https://github.com/MikeBild/subkit/commit/eaa95a1ea1ed2e35a04d4fc2cafcf96a0841296c))
* **authoring:** harden seeded skills and graphql drafts ([75b0b8a](https://github.com/MikeBild/subkit/commit/75b0b8a0e26c8347b6a4e42530a1eb067f8f42d8))
* **build:** commit bun.lock so Docker build + frozen-lockfile work ([6218a3a](https://github.com/MikeBild/subkit/commit/6218a3a08f1f9ee66efaf4d9060be8a6c5e7462f))
* **chat-ui/elicit:** finish TextPrompt single-owner input rewrite ([24fad4f](https://github.com/MikeBild/subkit/commit/24fad4f8352748701565da19077018035310ea5d))
* **chat:** avoid double rate-limit on notifications dispatch path ([9eb5dae](https://github.com/MikeBild/subkit/commit/9eb5dae57fdc00702858cd9ed1e2d82ded0e0ee3))
* **ci/release:** grant actions:read so publish-release can gh run download ([870604a](https://github.com/MikeBild/subkit/commit/870604aa76efb7cebbbeafb993c3f7abda55762b))
* **ci:** cross-compile darwin-x64 from macos-14 to escape macos-13 queue ([45684dc](https://github.com/MikeBild/subkit/commit/45684dcfc7851e692a981f7c3b2c74aba97e571d))
* **ci:** deploy health check via Docker HEALTHCHECK, not host port ([d878635](https://github.com/MikeBild/subkit/commit/d878635fc17b36327358e2d0d24e75d9e5211d70))
* **ci:** drop release:published trigger to prevent dual-fire ([a0dcc6d](https://github.com/MikeBild/subkit/commit/a0dcc6da1904fb5a6206f4b0a4b833a16df45184))
* **ci:** gate Docker + deploy jobs on DEPLOY_ENABLED repo variable ([858a756](https://github.com/MikeBild/subkit/commit/858a7563b0d625202dcda15d806e245bce6e455e))
* **ci:** gate gitleaks + dependency-review for private repos ([cf7f011](https://github.com/MikeBild/subkit/commit/cf7f011655a17352ee32eaead7b3f6393270afb3))
* **ci:** gate publish/deploy jobs on tag ref ([a0a90b6](https://github.com/MikeBild/subkit/commit/a0a90b63f2f7f86271cb04b21dcca479db6ac4fe))
* **ci:** invoke terminology gate with bash, not sh (dash lacks pipefail) ([7073c08](https://github.com/MikeBild/subkit/commit/7073c0893cc28f72bd262d48ddd955bdabb2655a))
* **ci:** matrix build ships all 20 binaries, not just 4 windows ([c4a0458](https://github.com/MikeBild/subkit/commit/c4a0458ee44b84c6e3c3b77a7f3f8726137ebb7b))
* **ci:** pin Bun to 1.3.12 so release binaries sign cleanly on darwin-arm64 ([a620c50](https://github.com/MikeBild/subkit/commit/a620c50c06e2463c140ca269fe01355f61c8751c))
* **ci:** publish-release — per-artifact retry via gh run download ([024aeb0](https://github.com/MikeBild/subkit/commit/024aeb08842f73f5ab51fb6dc02a5fb38e4c7dff))
* **ci:** release workflow — trigger on `release: published` + manual dispatch ([397f339](https://github.com/MikeBild/subkit/commit/397f33927c1659cb1fd29dff889ce73f075028cc))
* **ci:** release.yml gate needs actions:write to dispatch ci.yml ([ebdd3b6](https://github.com/MikeBild/subkit/commit/ebdd3b660eea2a6de3877ea77119eae8dff46d01))
* **ci:** wire inputs.tag end-to-end for dispatch-from-main recovery ([ffba285](https://github.com/MikeBild/subkit/commit/ffba2855c5a25eda90d8cdbe78bca578a68d6b32))
* **cli-core,sk:** treat empty objects as effectively empty content ([82781a2](https://github.com/MikeBild/subkit/commit/82781a2414bc6e77bc87da0a6905f03806ae12d1))
* **compose:** seed service must not try to pull subkit/migrate:local ([#73](https://github.com/MikeBild/subkit/issues/73)) ([eb11810](https://github.com/MikeBild/subkit/commit/eb11810bde49ea0e8c0b985e485f6e4c5f8a5239))
* **connectors,authoring:** reuse saved connectors by URL + GraphQL step-level headers + workflow upsert clarity ([edfade0](https://github.com/MikeBild/subkit/commit/edfade0982e3be1b98cf5ed7f544317bc762c4f4))
* **connectors,authoring:** seed config.oauth from URL-matched template so cache + probe see the Cognito flow ([f2819bc](https://github.com/MikeBild/subkit/commit/f2819bc0f185839b12654964ccfbb3dfa4473ee5))
* **connectors,authoring:** stop the AppSync re-prompt loop — upsert connectors, widen aws_region lookup, parse AWS JSON, honour step Authorization ([f5c0143](https://github.com/MikeBild/subkit/commit/f5c0143cffe5082a2033efa41740498615ba6d25))
* **connectors,authoring:** URL match wins among multi-template candidates + OAuth2 metadata URLs allow-listed ([2a1d13c](https://github.com/MikeBild/subkit/commit/2a1d13cc070323d694edd14636d9c2b7609b4c87))
* **connectors,authoring:** URL-pattern match wins over text match for connector template selection ([3e51cb9](https://github.com/MikeBild/subkit/commit/3e51cb9344bf0a056eb91a8c35bd2a13f08ecb68))
* **connectors,credentials:** cache draft creds for oauth2/cognito + aws_sigv4 from ask_user_form ([3df7774](https://github.com/MikeBild/subkit/commit/3df7774d70d55112c19a78847dc0cd36b7782a68))
* **connectors,credentials:** wire cognito_user_password + aws_sigv4 bootstrap into draft credential flow ([ed14263](https://github.com/MikeBild/subkit/commit/ed142631f3fcb0a18e6f750257f59bc0f6165fb5))
* **connectors,docs:** recipe-lint + subsystem-count parity for the recipe-sweep batch ([8ddb13c](https://github.com/MikeBild/subkit/commit/8ddb13c7ac7e592805f2e5c47543856231040cda))
* **connectors:** apply draft-time bearer/header/basic auth from config ([c686133](https://github.com/MikeBild/subkit/commit/c686133fad89b9a69296fd924ab22e846645921d))
* **connectors:** refresh square + gitlab OpenAPI ingestion URLs ([#75](https://github.com/MikeBild/subkit/issues/75)) ([42ca197](https://github.com/MikeBild/subkit/commit/42ca197b73cc89c6cc8e90a36d0231351c72992b))
* **connectors:** templates.json schema accepts new auth + nullable fields shipped with auth-flows ([34a6971](https://github.com/MikeBild/subkit/commit/34a6971873f722f7f952a538c3c7e4a7e444a5cc))
* **conversations,cli:** honor permission_mode + update-in-place commit_draft + selection-safe transcript ([c80a47c](https://github.com/MikeBild/subkit/commit/c80a47c6dfd159528f90290c1fe67abf8141f934))
* **conversations,sk:** chat-first repair palette, single-confirmation, speaker labels, paste UX ([5ddd22e](https://github.com/MikeBild/subkit/commit/5ddd22e4acf0241c3ad35a988cc8a09455416d3b))
* **conversations,sk:** close 12 root-cause UX gaps from real-user transcript ([aa84cd0](https://github.com/MikeBild/subkit/commit/aa84cd08704076795b103e67e7e72369be6a5b44))
* **conversations,sk:** permission_mode=auto skips ask_user_confirm; bare 'approve' resolves open elicits ([f0e9116](https://github.com/MikeBild/subkit/commit/f0e9116429e56256ae8c4eba61f3f83afb83ef13))
* **conversations,workflows:** kill the parallel-run_workflow loop + add update_workflow ([e4f342c](https://github.com/MikeBild/subkit/commit/e4f342c27027728f3d1bfac73f87c47e4a1498b5))
* **conversations:** auto-resolve ask_user_confirm when permission_mode=auto ([7f43dea](https://github.com/MikeBild/subkit/commit/7f43dea45136641914e0d9b21a83b2120894c2f2))
* **conversations:** canned list-users plan force-commits past probe gate ([070741f](https://github.com/MikeBild/subkit/commit/070741ff40d46904d6a18673bac350ac953feb6f))
* **conversations:** cleanup tools always reachable + auto-mode skips commit_draft confirm ([71fe903](https://github.com/MikeBild/subkit/commit/71fe903cbcd82f94deddba17a65eef12be767a99))
* **conversations:** drop silent slug-adopt; require explicit target_workflow_id ([1a518d6](https://github.com/MikeBild/subkit/commit/1a518d632159778e72b493bea80405847a5df955))
* **conversations:** single-token-entry connector save + loop-item teaching + override warning ([0cbd8f4](https://github.com/MikeBild/subkit/commit/0cbd8f49d382744ed6687c0a7ab4d4336a875047))
* **conversations:** steer toolChoice from explicit user run intent ([af8f94c](https://github.com/MikeBild/subkit/commit/af8f94c2f1a3d9f1470c66e15a2baad871dcfcd7))
* **credentials:** cognito_user_password persists username/region/use_access_token for refresh ([50a29fb](https://github.com/MikeBild/subkit/commit/50a29fb56f57902f046bae57e2e87ad7a47a3284))
* **db:** idempotent migrations + hash-first runner ([22bdc44](https://github.com/MikeBild/subkit/commit/22bdc4461c731c21955aa83995f2e86d0fa2273d))
* **deploy.sh:** portable mkdir-based lock (flock absent on macOS) ([3944c1e](https://github.com/MikeBild/subkit/commit/3944c1e3c660713f8d202f81ce32d26688038348))
* **docker-e2e:** create dummy-http connector inline, don't rely on seed ([#80](https://github.com/MikeBild/subkit/issues/80)) ([f3ba102](https://github.com/MikeBild/subkit/commit/f3ba1021032e7c1e950603a9b242bc830225a836))
* **docker-e2e:** drop stale 'rejects invalid workflow' assertion ([#81](https://github.com/MikeBild/subkit/issues/81)) ([f9b56ba](https://github.com/MikeBild/subkit/commit/f9b56ba13334cfae521e1497e8d5c2843edf5b7b))
* **docker:** copy scripts/ before bun install so postinstall runs ([fac4318](https://github.com/MikeBild/subkit/commit/fac43185d9b65fb3f8c210d3e4efef63ceae3e19))
* **docker:** pre-create /etc/subkit/ chown'd nobody for engine container ([#136](https://github.com/MikeBild/subkit/issues/136)) ([a6bf960](https://github.com/MikeBild/subkit/commit/a6bf9601be3a7ebe27f1ba5f800ab4ade86cd5af))
* **docker:** split engine-with-cli into a separate Dockerfile ([742e09b](https://github.com/MikeBild/subkit/commit/742e09b29f306b808f2dbdf53be95f6da8cad758))
* **e2e:** align weather/sk-user-story/deep-surface with paused-stop behavior ([809e999](https://github.com/MikeBild/subkit/commit/809e999018d9cdfbc262aa1d54b6a558910431a5))
* **e2e:** drop dag wrapper from mcp-surface delete-workflow fixture ([c2735a1](https://github.com/MikeBild/subkit/commit/c2735a1ed78d3245d6c4770187a621433141dc97))
* **e2e:** tier-1 real-LLM suite skips cleanly when LLM_PROVIDER=mock ([9f8d0f1](https://github.com/MikeBild/subkit/commit/9f8d0f18fa00cf96237a2f8d7d622d40642b1d53))
* **engine,authoring:** clean six-phase connector lifecycle + nested config.oauth + url placeholder validator ([cfdbceb](https://github.com/MikeBild/subkit/commit/cfdbceba8a56a12ffaf8478fb8be66a085e8478f))
* **engine,auto-persist:** fall back to template oauth metadata when draft.config.oauth is empty ([8fd37fc](https://github.com/MikeBild/subkit/commit/8fd37fcc3089180d601574aee8d09c2ce0b3c71d))
* **engine,connectors:** nightly+weekly findings — thinking adaptive, URL probe + template URLs ([#76](https://github.com/MikeBild/subkit/issues/76)) ([ec2bc16](https://github.com/MikeBild/subkit/commit/ec2bc16b8207de2ed7d543ea92535fb90b325ec0))
* **engine,conversations:** auto-freshen connector checkpoints before save ([516d408](https://github.com/MikeBild/subkit/commit/516d408da784f4a2da50e2f712bd106ae99748be))
* **engine,conversations:** force tool-call after auto-persist save when user asked for connector AND workflow ([1e4ae7f](https://github.com/MikeBild/subkit/commit/1e4ae7f095d4be58584feba87b374c815d1bdff8))
* **engine,conversations:** identity-gate commit_draft on draft slug pivot ([717a666](https://github.com/MikeBild/subkit/commit/717a666418966a3cb3b28d18c007bf39b87cd5be))
* **engine,conversations:** tighten commit-draft elicitation + extract credential-from-form helper ([4c1f409](https://github.com/MikeBild/subkit/commit/4c1f4098a0d1bc7eb61ad3922209d2a7d32145fb))
* **engine,http,tests:** unblock release CI on stale tests + missing aws_sigv4 route schema ([4f4fdef](https://github.com/MikeBild/subkit/commit/4f4fdef8992e6a20584e770109d2278511b4f9e8))
* **engine,sk,llm,docs:** close audit gaps + lock leads vs reference impl ([cfecc86](https://github.com/MikeBild/subkit/commit/cfecc86cc4d4a0023ab823a65a001471a1de6880))
* **engine,tests:** unblock pre-push gate — refresh 3 stale test assertions ([7e7b863](https://github.com/MikeBild/subkit/commit/7e7b86346c652f4de12602ef4572138fa082b7b1))
* **engine,workflows:** reject Authorization header on connector_id request steps ([5ddb16c](https://github.com/MikeBild/subkit/commit/5ddb16cccbcbfe4d83f55b6f87f094e7fee8194d))
* **engine:** /v1/status version from OPENAPI_INFO, not env ([1a231c0](https://github.com/MikeBild/subkit/commit/1a231c010cdf8459575973c9cbb668a471ed2f4c))
* **engine:** close Approach 2 wiring gaps + 3 journey-test regressions ([b7148e7](https://github.com/MikeBild/subkit/commit/b7148e7db931f471eecb4537f3ab7bc4d9c7d266))
* **engine:** close five anti-pattern classes surfaced by 730c568a ([713e486](https://github.com/MikeBild/subkit/commit/713e486ea8565eae3426e9d8c4c2413fd557b84e))
* **engine:** make env validation lazy so --smoke / --version run unconfigured ([8d02102](https://github.com/MikeBild/subkit/commit/8d02102956c267a4f713640bffb877b3f533332c))
* **engine:** restore build_workflow response contract ([1e8fa1e](https://github.com/MikeBild/subkit/commit/1e8fa1e9b6962c10e8bdfb820d752ff454af2bdf))
* **env-example:** clear AI_GATEWAY_MODEL so the pair check passes ([#79](https://github.com/MikeBild/subkit/issues/79)) ([17f191b](https://github.com/MikeBild/subkit/commit/17f191b78bd1959478c8ab148a8be6b34ffb905e))
* **execution,sk:** resolve loop-item placeholders, populate request_meta on failure, route free-text approvals ([c35ef1c](https://github.com/MikeBild/subkit/commit/c35ef1c86c97a735f0a5b228d77f48a56fb6912f))
* **firebase:** extract inline CSS/JS to external files ([ba36089](https://github.com/MikeBild/subkit/commit/ba360898a7895df6b718670269df1cf18038e20d))
* harden install.sh — function wrap, retry, validation ([9d01385](https://github.com/MikeBild/subkit/commit/9d013855684cec17fae6fb48b4d1c828a2730010))
* **hooks:** remove stale build:cli from pre-push gate ([950e555](https://github.com/MikeBild/subkit/commit/950e555b705e39d517ff82158b62ba3c202083cc))
* **hooks:** widen e2e test timeout to 60s ([d9f980a](https://github.com/MikeBild/subkit/commit/d9f980a2e89f296383b3f5c04a7de31168fcf479))
* **install:** align port + sk command surface in docs ↔ code ([#124](https://github.com/MikeBild/subkit/issues/124)) ([6b6894e](https://github.com/MikeBild/subkit/commit/6b6894ee0918a60014a0aee31a9fcccee718cd11))
* **install:** release tag prefix + sk init --token follow-up ([#125](https://github.com/MikeBild/subkit/issues/125)) ([73e58da](https://github.com/MikeBild/subkit/commit/73e58da186ab8700116d30b036c2daffc7851f7f))
* **journeys:** per-hook 60s timeout + named teardown stack (closes [#98](https://github.com/MikeBild/subkit/issues/98)) ([#133](https://github.com/MikeBild/subkit/issues/133)) ([9094baa](https://github.com/MikeBild/subkit/commit/9094baa586cff3e88188bb7172fc4e02111778eb))
* **llm:** collapse to Vercel AI Gateway — root cause of v1.10.0 prod 500 cluster ([0a00705](https://github.com/MikeBild/subkit/commit/0a0070557f4129aa7330bebf10fab880a6521f51))
* **llm:** model-init tests tolerate @ai-sdk/anthropic not hoisted on CI ([82885bc](https://github.com/MikeBild/subkit/commit/82885bcaaa03a6721f13853ab5f275901c204d17))
* make URL reachability tests opt-in (CHECK_URLS=1) ([e1b2747](https://github.com/MikeBild/subkit/commit/e1b2747bc1073e826c9d6b0290a1b3d865b72562))
* **mcp:** await audit.policy_denied write before returning MCP deny ([f5dfeff](https://github.com/MikeBild/subkit/commit/f5dfeff67749fdcdead9d3f16a29c2de30f164a8))
* migration 0022 — incremental ALTER TABLE only ([255a9b4](https://github.com/MikeBild/subkit/commit/255a9b4e4a8832c828db57a0336212b24e5c6745))
* profile slash handler uses injected config path in tests ([2af5ab2](https://github.com/MikeBild/subkit/commit/2af5ab296703579b11b12434307800f906926604))
* **rbac,cli:** resource-scoped execution RBAC, portal-token deny reason, slash MCP label drift ([2f348e4](https://github.com/MikeBild/subkit/commit/2f348e44e4c09d5ca6c75c3aba8eab0a52c67d89))
* register knowledge.ingest and skill-candidate.analyze queues ([e49d1ab](https://github.com/MikeBild/subkit/commit/e49d1ab9b77538d999463249efbda12ed3e0e1de))
* release workflow runs unit+integration tests only (matches CI) ([7c86754](https://github.com/MikeBild/subkit/commit/7c86754c6ea2d42e074a80a79418cdef65489980))
* release workflow tag pattern matches subkit-v* prefix ([cb66e12](https://github.com/MikeBild/subkit/commit/cb66e12d9e1731157205df53940bba861e382efb))
* **release/version.sh:** use prefixed vars to avoid clobbering caller's _SCRIPT_DIR ([cb69502](https://github.com/MikeBild/subkit/commit/cb6950212719328ed9627fe6c4276f566c7f47fc))
* **release:** retry transient registry auth during deploy ([2458c79](https://github.com/MikeBild/subkit/commit/2458c793ff3deda43e1b0d155a6fd18b7d90f50d))
* **release:** tag_name emits v&lt;VERSION&gt;, not subkit-v&lt;VERSION&gt; ([#126](https://github.com/MikeBild/subkit/issues/126)) ([01a32a9](https://github.com/MikeBild/subkit/commit/01a32a9190519e3760eff020d0c87a9b54d2a393))
* resolve all remaining medium + low severity review findings ([3396170](https://github.com/MikeBild/subkit/commit/33961706400956b369a6f934c46e07bf5e7c330b))
* resolve CI lint failures and enable GitHub Actions PR permissions ([a9a1ee6](https://github.com/MikeBild/subkit/commit/a9a1ee6769c84bacef470ac2bc691f1dad5046e3))
* runtime failures + add tests for 0-coverage phases ([28faf45](https://github.com/MikeBild/subkit/commit/28faf45e89eadf5d76a7b66f49948561b35a9cfb))
* **sandboxes:** embed sk-stdlib.js into compiled engine binary ([2c02125](https://github.com/MikeBild/subkit/commit/2c021255551704182c53dcb2f9b163521b2b17b0))
* **scheduler:** close two-engine race in reconcileWorkflowSchedules with CAS ([#103](https://github.com/MikeBild/subkit/issues/103)) ([7be268e](https://github.com/MikeBild/subkit/commit/7be268efa7f26bbfe8d3bd0b5c3e9365a34afc1d))
* **scheduler:** stabilise isCronDue test with fixed clocks ([7ee5070](https://github.com/MikeBild/subkit/commit/7ee5070d2e440d1e15cfb210be878041c365bafd))
* **scripts,ci:** pin openapi.json info.version to "0.0.0-dev" in gen output ([cf7cb44](https://github.com/MikeBild/subkit/commit/cf7cb448bc20ca1ee39b01a8ce8cce86018350c9))
* **scripts,tests:** stamp ENGINE_VERSION on .env, swap test.skip for test.skipIf in live e2es ([2743b83](https://github.com/MikeBild/subkit/commit/2743b8351161a4a4693ff7b4178acc9c76f22385))
* **sk,ink:** stop duplicating tool cards on orphan→parented transition + drop empty {} assistant rows ([48724ed](https://github.com/MikeBild/subkit/commit/48724ed71f6e07f0f3064db49b397e52a6958331))
* **sk/ink-tests:** poll lastFrame() with deadline to absorb CI scheduler latency ([46bb4eb](https://github.com/MikeBild/subkit/commit/46bb4ebae1c47a5871d05715024a86b7942ff9d2))
* **sk:** align command interfaces with test expectations ([8fd350d](https://github.com/MikeBild/subkit/commit/8fd350dbc0827bdc65ce697842ad5e28fe8a443a))
* **sk:** elicitation owns input focus while open; revert keyword-match hack ([729247d](https://github.com/MikeBild/subkit/commit/729247d38ba800c2a9c064ca9eb65d10dfa2517a))
* **skills:** skip confirm prompt when stdin is not a TTY ([191350f](https://github.com/MikeBild/subkit/commit/191350ff022856dbbd217dab6c70c0feb7fb9ff6))
* **sk:** label LLM-provider quota errors clearly instead of "validation errors · internal" ([33f17be](https://github.com/MikeBild/subkit/commit/33f17be9f8c8091a4ecd6e38dd86550c25152897))
* **sk:** remove unused emitList import in health command ([eb12a61](https://github.com/MikeBild/subkit/commit/eb12a616abc16bf5925d51f78576460bded662d6))
* **sk:** reserve spinner row when idle so the composer stops jumping ([f395fe0](https://github.com/MikeBild/subkit/commit/f395fe028732fc9e0e73a2b927d020c04d5f7f15))
* **sk:** simplify transcript and approval flow ([d07cad7](https://github.com/MikeBild/subkit/commit/d07cad706fbb9a1c05cc838bf5df277b19f9b98c))
* **sk:** strengthen chat guidance and routing ([#18](https://github.com/MikeBild/subkit/issues/18)) ([5fd133b](https://github.com/MikeBild/subkit/commit/5fd133b036340a0784d4f11bbf401c95b71c7afb))
* **sk:** surface pending_elicitation in headless JSON output ([18d457f](https://github.com/MikeBild/subkit/commit/18d457f41a0812e8d2c061a8250fef6708dbf871))
* split CI tests — run unit/integration before build, e2e after ([1a53ef0](https://github.com/MikeBild/subkit/commit/1a53ef0f4f22809b67f058fc4efdcf623e1ce68b))
* **test:** AC2 reads pending elicitation from resume_summary.pending_approval ([9a46130](https://github.com/MikeBild/subkit/commit/9a46130a3a68caa13d1bf2bcbb47d2685d1be6a3))
* **testing:** stabilize tty-sensitive release gate ([bc1a342](https://github.com/MikeBild/subkit/commit/bc1a342ea1469f5594e8becd00d19c4576fc6378))
* **test:** poll AC2 elicit-resume frame instead of fixed-tick wait ([cbb0166](https://github.com/MikeBild/subkit/commit/cbb01666cfb88c888c7ba498801f8f91dfe152dd))
* **tests,hooks:** widen hook-timeout budget under parallel load ([a16bb45](https://github.com/MikeBild/subkit/commit/a16bb45b9b8af82a3943fa924f10bbf2c0f27469))
* **tests:** determinism lint — wait-checkpoint and token-mint tests ([45f9ae4](https://github.com/MikeBild/subkit/commit/45f9ae4117eac1a8165606fcd534c4f86d1af342))
* **tests:** drop pre-rebuild ask_user_confirm in cannedListUsersPlan, harden audit-provenance beforeAll ([7008603](https://github.com/MikeBild/subkit/commit/7008603e82acf4e4a9b6c54d0655c5c6b5f24e81))
* **tests:** journey 13 AC4 renames nested workflow draft too ([4733136](https://github.com/MikeBild/subkit/commit/4733136940aad06792c4440cbad28a991230c657))
* **tests:** land fixture follow-ups for the conversational creation rebuild ([9878342](https://github.com/MikeBild/subkit/commit/98783427bc4f8bb47db394b994c60fcc24082689))
* **tests:** pass the determinism lint gate ([90168ca](https://github.com/MikeBild/subkit/commit/90168ca0ac2236ee609a95cbb1e8c98554873f17))
* **tests:** pre-pull alpine image and disable update-check in e2e CLI env ([d66638c](https://github.com/MikeBild/subkit/commit/d66638cb8cc7b1a0ccd931d8fb044705b3fe04ac))
* **tests:** rename SUBKIT.md → SK.md in memory-pipeline journey ([c6e5757](https://github.com/MikeBild/subkit/commit/c6e5757dbea36b0b352ac1f4a00f015ad28f491b))
* **tests:** use real Date.now() for TEST_NOW_MS instead of fixed Nov-2023 timestamp ([764c35c](https://github.com/MikeBild/subkit/commit/764c35ca6e6e2967b513910f3df323c42d427e2a))
* **tests:** use skipIf+env flag instead of test.skip (determinism gate) ([4b0ff08](https://github.com/MikeBild/subkit/commit/4b0ff0875cd577c68e1ac23011fc98641c348ad8))
* **v3.5:** audit pass 6 — coverage matrix, structured logs, env retire cleanup ([#137](https://github.com/MikeBild/subkit/issues/137)) ([c5900c8](https://github.com/MikeBild/subkit/commit/c5900c8122fec03349adc0e80db88236344e816c))
* **v3.5:** reset config state in process.env-driven LLM provider tests ([#135](https://github.com/MikeBild/subkit/issues/135)) ([b846a0b](https://github.com/MikeBild/subkit/commit/b846a0bebd29968d723549c87712fc101d073369))


### Refactoring

* **chat:** remove unused link-token feature ([#129](https://github.com/MikeBild/subkit/issues/129)) ([255e431](https://github.com/MikeBild/subkit/commit/255e4318185e3bd984c8cb5358b75a8a4512a6be))
* **cli-core:** drop transcript-cell layer, replay turn events directly ([c448631](https://github.com/MikeBild/subkit/commit/c44863122dee0c90f58cb32b8501244ae1afb02b))
* **conversations,llm:** agent-registry + skill-driven prompts ([5446d43](https://github.com/MikeBild/subkit/commit/5446d43b6f78c69f8542a6ed2ef1ac7f5f3d1109))
* **conversations:** split authoring-state.ts into normalize + summary modules ([#113](https://github.com/MikeBild/subkit/issues/113)) ([c6cd9a2](https://github.com/MikeBild/subkit/commit/c6cd9a2d53893b4aba4dc9efcfefcf2bd562231d))
* **conversations:** split sdk-wrap.ts (1803 LOC) per audit §4.2 ([#112](https://github.com/MikeBild/subkit/issues/112)) ([61d8ce7](https://github.com/MikeBild/subkit/commit/61d8ce7c6ff538236ff86808b45c87ce07ee1f62))
* **conversations:** split service.ts into per-operation modules ([#123](https://github.com/MikeBild/subkit/issues/123)) ([1bb1ac9](https://github.com/MikeBild/subkit/commit/1bb1ac94ae2f51ea928f56e3368884ea7beb67cf))
* drop stale 'reserved for a future' comments and an unused enum value ([#131](https://github.com/MikeBild/subkit/issues/131)) ([75e8b91](https://github.com/MikeBild/subkit/commit/75e8b910ccc1042bae257364f6b033937ad1f3cb))
* **engine,db:** retire BOOTSTRAP_* env vars (now driven by /v1/setup) ([#70](https://github.com/MikeBild/subkit/issues/70)) ([bf37875](https://github.com/MikeBild/subkit/commit/bf37875fc1c9c77d2b3cd8b7051cbc6db1cdc016))
* **engine,llm:** replace per-skill summary blocks with per-scope index ([7873fa9](https://github.com/MikeBild/subkit/commit/7873fa9d855bc77cf2a20a145c739a79229112dc))
* **engine,sk,docs:** rename commit_draft → save_workflow_draft repo-wide ([1d0996a](https://github.com/MikeBild/subkit/commit/1d0996a03e9a901821f9ab76361ed98c2ccf43f7))
* **execution:** extract engine helpers into engine/ subdir ([#121](https://github.com/MikeBild/subkit/issues/121)) ([8f4913b](https://github.com/MikeBild/subkit/commit/8f4913bbdb7b56042328d29bcc6c805611b6d6cf))
* **execution:** split request.ts (1804 LOC) per audit §4.2 ([#111](https://github.com/MikeBild/subkit/issues/111)) ([74e897e](https://github.com/MikeBild/subkit/commit/74e897e6617a2ce26ac3b4e1a92dc022ed7a60c6))
* **http:** split connector-templates route god-file into per-sub-resource modules ([#116](https://github.com/MikeBild/subkit/issues/116)) ([3a48260](https://github.com/MikeBild/subkit/commit/3a48260883a473168fbcbcb619a9c4783b50ddf9))
* **http:** split connectors route god-file into per-sub-resource modules ([#117](https://github.com/MikeBild/subkit/issues/117)) ([d7b1774](https://github.com/MikeBild/subkit/commit/d7b17741d2ea38ec9e94ae598ffbd6dc48209259))
* **http:** split conversations route god-file into per-sub-resource modules ([#115](https://github.com/MikeBild/subkit/issues/115)) ([1654e76](https://github.com/MikeBild/subkit/commit/1654e76ab5ad6f634450f830a244db4efe7afc1e))
* **http:** split diagnostics route god-file into per-route modules ([#119](https://github.com/MikeBild/subkit/issues/119)) ([efa61ab](https://github.com/MikeBild/subkit/commit/efa61abe462dc17806eff27d2d5653c890cdfdf5))
* **http:** split executions route god-file into per-sub-resource modules ([#109](https://github.com/MikeBild/subkit/issues/109)) ([f4e138d](https://github.com/MikeBild/subkit/commit/f4e138d2888e3129104c06af82e3dce704fd093b))
* **http:** split notifications route god-file into per-sub-resource modules ([#108](https://github.com/MikeBild/subkit/issues/108)) ([513f040](https://github.com/MikeBild/subkit/commit/513f040759564d1cd66a6f87a97d154a915c06c1))
* **http:** split rbac route god-file into per-resource modules ([#118](https://github.com/MikeBild/subkit/issues/118)) ([2834c0c](https://github.com/MikeBild/subkit/commit/2834c0c2e23bd9152de4b7534d63ff0387a5818f))
* **install:** collapse to a single engine image; drop -with-cli variant ([cb8ccda](https://github.com/MikeBild/subkit/commit/cb8ccda7269dd47eb7990ccb8a4aecbcc1b883de))
* **llm:** consolidate token/budget accounting into llm/accounting/ ([#105](https://github.com/MikeBild/subkit/issues/105)) ([f8b095e](https://github.com/MikeBild/subkit/commit/f8b095ec154bdf3e8971cc4d0cafb1a946e7a94d))
* **llm:** split context-assembler.ts into formatters/loaders/skill-picker ([#114](https://github.com/MikeBild/subkit/issues/114)) ([b820dd6](https://github.com/MikeBild/subkit/commit/b820dd6f34d2f65d72e0f7e745c0e728dde6dedc))
* **persistence:** split auto-persist.ts into per-concern modules ([#122](https://github.com/MikeBild/subkit/issues/122)) ([b6d453b](https://github.com/MikeBild/subkit/commit/b6d453b6aa7878c17eb572c14165b0f80d24172e))
* remove three more half-implemented features ([#130](https://github.com/MikeBild/subkit/issues/130)) ([0cd9cde](https://github.com/MikeBild/subkit/commit/0cd9cdedb936c653aeb487d79c2e1b19e9b579b5))
* **shared:** extract redaction + scrub-secrets to packages/shared ([06757d3](https://github.com/MikeBild/subkit/commit/06757d302d833cfdd380bc2a85123dce08e98069))
* **sk:** extract persona-probe to shared module, tier-gate the probe set ([32d7be5](https://github.com/MikeBild/subkit/commit/32d7be5859e76fbdba0633d42aef5b5109e338f9))
* **tunnels,pubsub:** bound TunnelRegistry + document pubsub restart contract ([#107](https://github.com/MikeBild/subkit/issues/107)) ([17e3ea3](https://github.com/MikeBild/subkit/commit/17e3ea3b9fdf63f6ba60aaf006f0d37db0f1714d))
* zero out non-null assertions across production source ([#132](https://github.com/MikeBild/subkit/issues/132)) ([4ac8469](https://github.com/MikeBild/subkit/commit/4ac8469078383c56135c2802b237cb2ef86031a3))


### Documentation

* add agent-facing guidance for Claude Code ([55bd3cd](https://github.com/MikeBild/subkit/commit/55bd3cdb02382911a77f0a9b2c347901994c8de2))
* align terminology — 'automation' → 'workflow', 'integration' → 'connector' ([039b384](https://github.com/MikeBild/subkit/commit/039b384f187bf7a004b545f94792ec9fad0517a8))
* **audit:** record actual phase 4 outcome; pin allowlist as steady state ([#128](https://github.com/MikeBild/subkit/issues/128)) ([5f80e4a](https://github.com/MikeBild/subkit/commit/5f80e4a57d360fde7c9373661dad18e915ec88ba))
* cleanup ([4b41b3f](https://github.com/MikeBild/subkit/commit/4b41b3f438c9c376d97d96219a128dfa065d912e))
* **deployment:** document bun run release + scripts/release/* pipeline ([a2f38fc](https://github.com/MikeBild/subkit/commit/a2f38fc3ae821bd91ed0b16b84dcf6e5a6ca6bb8))
* drop the orphan German end-to-end sequences doc ([2c3edfe](https://github.com/MikeBild/subkit/commit/2c3edfe69f6f24923447b9303da052c32d0c1ce2))
* **engine,tools:** surface config.oauth immutability in update_connector_draft schema ([655caa9](https://github.com/MikeBild/subkit/commit/655caa981bb1e48a7009b47784066818fee81dcd))
* **execution,recipes:** document WorkflowDef.trigger discriminator ([#68](https://github.com/MikeBild/subkit/issues/68)) ([7f237fa](https://github.com/MikeBild/subkit/commit/7f237fa74decbb7990ab64cbaf30ef7266569f3d))
* **followup:** record 1.10.0 landings (masked secrets, 3 cards, route-doc parity gate) ([f6c806e](https://github.com/MikeBild/subkit/commit/f6c806e7942b1c712f4c4e2e8d2ff1dbae446a01))
* **followup:** record second-pass landings (preview parity, credentials, structured panes, richer snapshot, draft-dedup) ([e388453](https://github.com/MikeBild/subkit/commit/e388453c08acbb94dd5de341bae09b610776dba8))
* full documentation overhaul — problem-led README, mermaid-first format, missing features ([dfdc0c1](https://github.com/MikeBild/subkit/commit/dfdc0c16c6755472c935a2d932e18b763c3539e4))
* **install:** reframe with-cli as production default; sync compose from laptop deploys too ([94991ac](https://github.com/MikeBild/subkit/commit/94991ace6fbe74ba99510c771b3e17cfe9c76f62))
* **quickstart/operator:** match what compose:up actually does ([#127](https://github.com/MikeBild/subkit/issues/127)) ([ca72f92](https://github.com/MikeBild/subkit/commit/ca72f92425fbda4405f3d23e6d43078868ad6a0c))
* **recipes:** add authoring guide ([8c0123e](https://github.com/MikeBild/subkit/commit/8c0123e619d0978a222ba983095ab8abac2e2bd6))
* **skills:** mssql/redis/file-transport connector skills + postgres introspection note ([805642e](https://github.com/MikeBild/subkit/commit/805642e26b8a7b5210777d13028024900ef2ca13))
* **slash,executions:** close pre-existing route-doc parity drift ([#106](https://github.com/MikeBild/subkit/issues/106)) ([29de17f](https://github.com/MikeBild/subkit/commit/29de17f827ddb8b1a14d547405510b0489e85cfb))


### Miscellaneous

* **audit:** land Phase 1 stabilisation — guard tests + canonical doc ([#94](https://github.com/MikeBild/subkit/issues/94)) ([5420291](https://github.com/MikeBild/subkit/commit/5420291acecd860f54e2dbba5e8d711658215008))
* **audit:** phase 2 wrap-up — populate coverage-floor.json + enforce coverage_floor ([#104](https://github.com/MikeBild/subkit/issues/104)) ([84ff8dc](https://github.com/MikeBild/subkit/commit/84ff8dc2bb6ed5cf00449cb74d967d9b58b0bb6e))
* **ci:** release-please runs on workflow_dispatch only ([2898a16](https://github.com/MikeBild/subkit/commit/2898a16dcdcc2c0dae7ffe53fb512e8b99692259))
* **cli-core:** regenerate OpenAPI client to match current engine surface ([d3c0c0e](https://github.com/MikeBild/subkit/commit/d3c0c0eb4f97fa2b5cfe0daafd4f6b675c88882f))
* **deps:** sync bun.lock with package.json (graphql, playwright) ([980dcce](https://github.com/MikeBild/subkit/commit/980dcced97ba58be3705c3b6ee4f365985e705f3))
* **determinism:** add baseline ratchet for warning-level rules ([#77](https://github.com/MikeBild/subkit/issues/77)) ([3253b11](https://github.com/MikeBild/subkit/commit/3253b11511b96e2e4ff96d7c76cd92fde2cf6fa7))
* **engine,shared:** full reference-impl parity audit + cleanup loop ([f073888](https://github.com/MikeBild/subkit/commit/f073888a13cd91a2ad661d65467118f4db952ab0))
* **engine:** tidy biome noTemplateCurlyInString suppressions ([3ac25e4](https://github.com/MikeBild/subkit/commit/3ac25e4f78ab81b130ca6fb88938a9754e03bb0a))
* **eval:** untrack eval/out runtime artifacts ([77d2521](https://github.com/MikeBild/subkit/commit/77d2521ac39c4c2a900d42403648c42a31702f03))
* **githooks:** trim pre-push gate to lint+typecheck+build ([59aa1a1](https://github.com/MikeBild/subkit/commit/59aa1a10132bc856a862aa473d4cd44467afca55))
* **gitignore:** ignore .claude/scheduled_tasks.lock runtime artifact ([7fc79f7](https://github.com/MikeBild/subkit/commit/7fc79f79de1c5f8d45f3fd929dcdd34b7811fd14))
* ignore .env.deploy (laptop deploy overrides) ([9543bf3](https://github.com/MikeBild/subkit/commit/9543bf3889769c0b5c7ef99708d59397b1480d71))
* **main:** release subkit 1.0.0 ([#1](https://github.com/MikeBild/subkit/issues/1)) ([62ca88c](https://github.com/MikeBild/subkit/commit/62ca88ca647ba4446e9cb983e541561c687b4377))
* **main:** release subkit 1.1.0 ([#2](https://github.com/MikeBild/subkit/issues/2)) ([f5c3d90](https://github.com/MikeBild/subkit/commit/f5c3d900f6046f47e8911406bb4448425a515bbe))
* **main:** release subkit 1.1.1 ([#3](https://github.com/MikeBild/subkit/issues/3)) ([6cc6c69](https://github.com/MikeBild/subkit/commit/6cc6c6946f6f686972b12d4ae0ac98d88b0fd417))
* **main:** release subkit 1.10.0 ([#14](https://github.com/MikeBild/subkit/issues/14)) ([2b08f7e](https://github.com/MikeBild/subkit/commit/2b08f7e4feaf37525988e2f192a739b2bdf51923))
* **main:** release subkit 1.10.1 ([#15](https://github.com/MikeBild/subkit/issues/15)) ([47d7239](https://github.com/MikeBild/subkit/commit/47d7239b492ed9251c828ae2b37d8496f4cd5854))
* **main:** release subkit 1.10.10 ([#19](https://github.com/MikeBild/subkit/issues/19)) ([b8a2784](https://github.com/MikeBild/subkit/commit/b8a27849c664ffb0940f869d0f3eb1624b4f5493))
* **main:** release subkit 1.10.2 ([#16](https://github.com/MikeBild/subkit/issues/16)) ([525f3c8](https://github.com/MikeBild/subkit/commit/525f3c8036d7ee5636c840ffb7b885c49e1509fd))
* **main:** release subkit 1.10.8 ([#17](https://github.com/MikeBild/subkit/issues/17)) ([187bf28](https://github.com/MikeBild/subkit/commit/187bf282e32e466b302329bee9f4b793d2fb3e04))
* **main:** release subkit 1.11.0 ([#20](https://github.com/MikeBild/subkit/issues/20)) ([5a4431a](https://github.com/MikeBild/subkit/commit/5a4431af8eb106537b68bf8d11c73aa428d9883a))
* **main:** release subkit 1.12.0 ([#21](https://github.com/MikeBild/subkit/issues/21)) ([d6ea21c](https://github.com/MikeBild/subkit/commit/d6ea21caa36d84c198a2f7fd9bfcf32a78d8ae68))
* **main:** release subkit 1.13.0 ([#22](https://github.com/MikeBild/subkit/issues/22)) ([220c43a](https://github.com/MikeBild/subkit/commit/220c43aab2927ff35e55424c68dfd3fffd31e74c))
* **main:** release subkit 1.13.1 ([#23](https://github.com/MikeBild/subkit/issues/23)) ([a95da77](https://github.com/MikeBild/subkit/commit/a95da774264f851f47e9519c066b416b2d71ce69))
* **main:** release subkit 1.14.0 ([#25](https://github.com/MikeBild/subkit/issues/25)) ([6ffad18](https://github.com/MikeBild/subkit/commit/6ffad18b350c2bd3c21db4e94fbcc31b8fd32b0c))
* **main:** release subkit 1.15.0 ([#26](https://github.com/MikeBild/subkit/issues/26)) ([859e522](https://github.com/MikeBild/subkit/commit/859e5226f8fec7cb4ab4de7fb2b56a52f0bf1044))
* **main:** release subkit 1.16.0 ([#27](https://github.com/MikeBild/subkit/issues/27)) ([271d6d9](https://github.com/MikeBild/subkit/commit/271d6d92769cc7c04458f69cabe1f3980a2f6124))
* **main:** release subkit 1.17.0 ([#28](https://github.com/MikeBild/subkit/issues/28)) ([03f038d](https://github.com/MikeBild/subkit/commit/03f038d1806758e9d000803b5b2826f487645bbe))
* **main:** release subkit 1.18.0 ([#29](https://github.com/MikeBild/subkit/issues/29)) ([7c0bf0f](https://github.com/MikeBild/subkit/commit/7c0bf0f298df4ce2c8796a417386048604f59163))
* **main:** release subkit 1.2.0 ([#4](https://github.com/MikeBild/subkit/issues/4)) ([cd1d75b](https://github.com/MikeBild/subkit/commit/cd1d75bff2f6b9f9796bfdded1eb5d0932b61079))
* **main:** release subkit 1.3.0 ([#5](https://github.com/MikeBild/subkit/issues/5)) ([d526534](https://github.com/MikeBild/subkit/commit/d5265349655a2e721c9d569b0a30a88a2638001e))
* **main:** release subkit 1.4.0 ([#6](https://github.com/MikeBild/subkit/issues/6)) ([70f4a3c](https://github.com/MikeBild/subkit/commit/70f4a3c463454a8e8a0dc043f237978b00c0f45f))
* **main:** release subkit 1.5.0 ([#7](https://github.com/MikeBild/subkit/issues/7)) ([999e0df](https://github.com/MikeBild/subkit/commit/999e0df9d9758cb6954a53d2a75c17606e167c1c))
* **main:** release subkit 1.6.0 ([#8](https://github.com/MikeBild/subkit/issues/8)) ([da9d821](https://github.com/MikeBild/subkit/commit/da9d8210d1588ec5213cd07b0b8ab0ede2ea9429))
* **main:** release subkit 1.6.1 ([#9](https://github.com/MikeBild/subkit/issues/9)) ([62f32bf](https://github.com/MikeBild/subkit/commit/62f32bffadb81146f4eded40700836e7c44438fe))
* **main:** release subkit 1.6.4 ([#10](https://github.com/MikeBild/subkit/issues/10)) ([f19f859](https://github.com/MikeBild/subkit/commit/f19f859db89032a3ff507489db6093a0b21eb89c))
* **main:** release subkit 1.7.0 ([#11](https://github.com/MikeBild/subkit/issues/11)) ([69362e8](https://github.com/MikeBild/subkit/commit/69362e8df2af2b53717347278ce480feb5c385b8))
* **main:** release subkit 1.8.0 ([#12](https://github.com/MikeBild/subkit/issues/12)) ([5c51a64](https://github.com/MikeBild/subkit/commit/5c51a644c52d96cce0147a1678c27db1795f8ab9))
* **main:** release subkit 1.9.0 ([#13](https://github.com/MikeBild/subkit/issues/13)) ([147d318](https://github.com/MikeBild/subkit/commit/147d3185ebabe07c24a5cc259d97a152d0c154af))
* **main:** release subkit 2.0.0 ([#30](https://github.com/MikeBild/subkit/issues/30)) ([d522315](https://github.com/MikeBild/subkit/commit/d522315ea003b18be8970a7be238302ea6df744b))
* **main:** release subkit 2.1.0 ([#31](https://github.com/MikeBild/subkit/issues/31)) ([dc27598](https://github.com/MikeBild/subkit/commit/dc27598b2e21551cf32bb759c5cf4eed7b7fe17c))
* **main:** release subkit 2.2.0 ([#32](https://github.com/MikeBild/subkit/issues/32)) ([f7a4c96](https://github.com/MikeBild/subkit/commit/f7a4c967900841f9c0683303b2e1495306c34257))
* **main:** release subkit 2.2.1 ([#33](https://github.com/MikeBild/subkit/issues/33)) ([9693dba](https://github.com/MikeBild/subkit/commit/9693dba38b6263f80de2f6d71d24aeb17e334413))
* **main:** release subkit 2.2.2 ([#34](https://github.com/MikeBild/subkit/issues/34)) ([ee37f06](https://github.com/MikeBild/subkit/commit/ee37f06cdcd8be197ce268b77d8e3a2792fe524c))
* **main:** release subkit 2.3.0 ([#35](https://github.com/MikeBild/subkit/issues/35)) ([00d089b](https://github.com/MikeBild/subkit/commit/00d089b952a41887e1a41b0f2d434ae38a0b7be6))
* **main:** release subkit 2.3.1 ([#36](https://github.com/MikeBild/subkit/issues/36)) ([f612164](https://github.com/MikeBild/subkit/commit/f612164b0cab87d66d1c633ba2e5b8e3754225b2))
* **main:** release subkit 2.4.0 ([#37](https://github.com/MikeBild/subkit/issues/37)) ([f4126a2](https://github.com/MikeBild/subkit/commit/f4126a241ca0662723faa5dfd86ed5cebacb3f2e))
* **main:** release subkit 2.5.0 ([#38](https://github.com/MikeBild/subkit/issues/38)) ([053aa4c](https://github.com/MikeBild/subkit/commit/053aa4c72b958eff875388462c2287fd7aaa4dc6))
* **main:** release subkit 2.6.0 ([#39](https://github.com/MikeBild/subkit/issues/39)) ([90eb9cc](https://github.com/MikeBild/subkit/commit/90eb9ccf67e421523e61f1f3b1ae8eeafd568c6f))
* **main:** release subkit 2.7.0 ([#40](https://github.com/MikeBild/subkit/issues/40)) ([95f060e](https://github.com/MikeBild/subkit/commit/95f060e2cec67acb1814c997f8b3132c03c12a26))
* **main:** release subkit 2.8.0 ([#41](https://github.com/MikeBild/subkit/issues/41)) ([9893433](https://github.com/MikeBild/subkit/commit/9893433c1f9fea6c882f82f60f38dff5c1d6cab6))
* **main:** release subkit 3.1.0 ([#42](https://github.com/MikeBild/subkit/issues/42)) ([09a1102](https://github.com/MikeBild/subkit/commit/09a1102ce9fd43b8eba7746580b3d42572cf5467))
* **main:** release subkit 3.2.0 ([#43](https://github.com/MikeBild/subkit/issues/43)) ([013a5b3](https://github.com/MikeBild/subkit/commit/013a5b3aa94e6772fde336f542966490e2617c95))
* **main:** release subkit 3.2.1 ([#44](https://github.com/MikeBild/subkit/issues/44)) ([67d5254](https://github.com/MikeBild/subkit/commit/67d5254922b9307d062270f34b4247274767df38))
* **openapi:** regenerate client for /install/{asset} + /install/sha256sums ([ef1f8f5](https://github.com/MikeBild/subkit/commit/ef1f8f5fb1b0a788250967ce13fb4d9b1654e7cc))
* **openapi:** regenerate client for E1 + E2 recipe routes ([2bb2237](https://github.com/MikeBild/subkit/commit/2bb2237242a5a8a1f3f380e107305c889a0d2094))
* **release:** bump version 3.2.0 → 3.3.0 ([f5ed7da](https://github.com/MikeBild/subkit/commit/f5ed7da38e7be79167ff32b0059a2eb7563822cb))
* **release:** cut v3.4.0 ([0ea8f48](https://github.com/MikeBild/subkit/commit/0ea8f4812092bb9c9cfabeea3471f07070b23ddd))
* **release:** cut v3.4.1 ([9e3901e](https://github.com/MikeBild/subkit/commit/9e3901ec8b1ea5439761f2b55230ade84bf07e8b))
* **release:** subkit 1.10.3 ([1603a7f](https://github.com/MikeBild/subkit/commit/1603a7f17ec3b4d7d7917ca20009e0b403ddd755))
* **release:** subkit 1.10.4 ([df9cafb](https://github.com/MikeBild/subkit/commit/df9cafbdc69095cff02714b3bd6eee4e789c3b4e))
* **release:** subkit 1.10.5 ([4bbcfd8](https://github.com/MikeBild/subkit/commit/4bbcfd81e0c43d227791c52ecd5cb767371b28e1))
* **release:** subkit 1.10.6 ([9a34515](https://github.com/MikeBild/subkit/commit/9a345154b11c354146cfde420fdfd5ee5142abf0))
* **release:** subkit 1.10.7 ([305454b](https://github.com/MikeBild/subkit/commit/305454b5147ea50dd047fd45a52c34b8a7ca0f39))
* **release:** subkit 1.10.9 ([2826b7f](https://github.com/MikeBild/subkit/commit/2826b7f7da90b56166899d521aa1b839abb8ac59))
* **release:** subkit 1.17.1 ([d6fb802](https://github.com/MikeBild/subkit/commit/d6fb8029934241875b50e603c89f56609106dcc4))
* **release:** subkit 1.18.1 ([939d8d2](https://github.com/MikeBild/subkit/commit/939d8d2894e89afb5efc15e7582c6b0f1847961c))
* **release:** subkit 1.19.0 ([fcfedbe](https://github.com/MikeBild/subkit/commit/fcfedbef12dae757f4c4fc488d7c0f0a3c35ba39))
* **release:** subkit 1.6.2 ([08d7f9d](https://github.com/MikeBild/subkit/commit/08d7f9dbd04c68ba9c4408c1288704d1408dfdd1))
* **release:** subkit 1.6.3 ([c2fb3be](https://github.com/MikeBild/subkit/commit/c2fb3be9cdaef47c67705b2c0016440e29dbb720))
* **release:** subkit 2.0.1 ([8d1fb00](https://github.com/MikeBild/subkit/commit/8d1fb00d5176dc1d49880e7cc7e83dd0b0419560))
* **release:** subkit 3.0.0 ([1b16bc3](https://github.com/MikeBild/subkit/commit/1b16bc37448827c9a4ae78d3b898c69e80c9de18))
* **release:** subkit 3.5.0 ([70ce6de](https://github.com/MikeBild/subkit/commit/70ce6deeb891d67078804a3f75c67e93c24b1516))
* **release:** subkit 3.5.1 ([22c935f](https://github.com/MikeBild/subkit/commit/22c935fb7baa2336ec1a50349957c4691ed89316))
* remove unused skillEffectiveness import ([b138ea2](https://github.com/MikeBild/subkit/commit/b138ea2fd87c1a5a57b346fd653260059fd05e44))
* resolve all biome lint warnings ([97d6865](https://github.com/MikeBild/subkit/commit/97d6865ad1d3401d374827775ee6f19b2f352a18))

## [3.4.1](https://github.com/MikeBild/subkit/compare/v3.4.0...v3.4.1) (2026-05-05)


### Refactoring

* **install:** collapse to a single engine image; drop `-with-cli` variant. Every released `engine:<version>` now bundles `sk` + `tunnel-agent` binaries unconditionally — production runs only this image and operators on any deploy can `curl /install | bash` against it. Removes the `engine-with-cli` variant tag, the second Dockerfile, and the `build-and-push-with-cli` CI job. The install script's GitHub-Releases fallback stays for fork / dev-mode builds where `docker/binaries/` is empty ([cb8ccda](https://github.com/MikeBild/subkit/commit/cb8ccda7269dd47eb7990ccb8a4aecbcc1b883de))

## [3.4.0](https://github.com/MikeBild/subkit/compare/v3.3.0...v3.4.0) (2026-05-05)


### Features

* **install:** bundle sk + tunnel-agent binaries inside engine image — new `engine-with-cli` variant serves them at `/install/sk-:platform-:arch`, `/install/agent-:platform-:arch`, `/install/sha256sums` so `curl … /install | bash` works without GitHub egress. Closes [#64](https://github.com/MikeBild/subkit/issues/64) ([31f2280](https://github.com/MikeBild/subkit/commit/31f22804e2521ed3c6461a3768cce34bc5b55a61))
* **sk:** `sk ctx` token gauge + engine context-window safety fixes ([#74](https://github.com/MikeBild/subkit/pull/74)) ([a7edb1d](https://github.com/MikeBild/subkit/commit/a7edb1dd44bfb026599a00a4218223c89e999fcb))
* **connectors:** Layer-3 vendor-drift sweep + `verified_at` stamp ([#63](https://github.com/MikeBild/subkit/pull/63)) ([d950a79](https://github.com/MikeBild/subkit/commit/d950a796f29fd938870f30f2de5ab9d3525b757f))
* **onboarding,http,sk:** first-run bootstrap thin-slice + POST /v1/setup + `sk init` ([#60](https://github.com/MikeBild/subkit/pull/60)) ([11789dd](https://github.com/MikeBild/subkit/commit/11789dd64d782ac1202825f8bf5c5692e1cef33a))
* **workflows,execution,audit:** per-run LLM token budget + `external_write` audit ([#53](https://github.com/MikeBild/subkit/pull/53)) ([1d126ff](https://github.com/MikeBild/subkit/commit/1d126ffb262e89cde26ffef8a26c4aa6e0a16729))
* **conversations,recipes:** multi-connector recipe binding via `connector_bindings` ([#54](https://github.com/MikeBild/subkit/pull/54)) ([cc8f735](https://github.com/MikeBild/subkit/commit/cc8f735b52a6b622f554317075ce41d8fa501dfc))
* **webhooks,recipes,sk:** webhook trigger end-to-end Stripe → Slack ([#46](https://github.com/MikeBild/subkit/pull/46)) ([7ca43e4](https://github.com/MikeBild/subkit/commit/7ca43e449348d3ab861c34202032448d3e5877cd))
* **scheduler,recipes,sk:** schedule trigger end-to-end (cron+tz+skip) ([#47](https://github.com/MikeBild/subkit/pull/47)) ([c17265f](https://github.com/MikeBild/subkit/commit/c17265f1eec44afb8358f5b206eded1a9c8a209e))
* **workflows,audit,webhooks,scheduler:** `WorkflowDef.trigger` + reverse bind/unbind + `AuditAction` sweep ([#67](https://github.com/MikeBild/subkit/pull/67)) ([504fce4](https://github.com/MikeBild/subkit/commit/504fce495e2482620709030d4ebb59eb9f49e80f))


### Bug Fixes

* **engine:** make env validation lazy so `--smoke` / `--version` / `--check-update` / `--self-update` run on an unconfigured binary ([8d02102](https://github.com/MikeBild/subkit/commit/8d02102956c267a4f713640bffb877b3f533332c))
* **agent:** handle `--version` / `-v` before `parseArgs` ([8f4e58a](https://github.com/MikeBild/subkit/commit/8f4e58acc6899ab2ebecaef496ef7f888c4d1f4e))
* **docker:** split `engine-with-cli` into a separate Dockerfile so BuildKit's whole-graph COPY pre-resolution doesn't break the slim build ([742e09b](https://github.com/MikeBild/subkit/commit/742e09b29f306b808f2dbdf53be95f6da8cad758))
* **journeys:** per-hook 60s timeout + named teardown stack. Closes [#98](https://github.com/MikeBild/subkit/issues/98) ([9094baa](https://github.com/MikeBild/subkit/commit/9094baa586cff3e88188bb7172fc4e02111778eb))
* **release:** `tag_name` emits `v<VERSION>`, not `subkit-v<VERSION>` ([#126](https://github.com/MikeBild/subkit/pull/126)) ([01a32a9](https://github.com/MikeBild/subkit/commit/01a32a9190519e3760eff020d0c87a9b54d2a393))
* **install:** release tag prefix + `sk init --token` follow-up ([#125](https://github.com/MikeBild/subkit/pull/125)) ([73e58da](https://github.com/MikeBild/subkit/commit/73e58da186ab8700116d30b036c2daffc7851f7f))
* **install:** align port + sk command surface in docs ↔ code ([#124](https://github.com/MikeBild/subkit/pull/124)) ([6b6894e](https://github.com/MikeBild/subkit/commit/6b6894ee0918a60014a0aee31a9fcccee718cd11))
* **scheduler:** close two-engine race in `reconcileWorkflowSchedules` with CAS ([#103](https://github.com/MikeBild/subkit/pull/103)) ([7be268e](https://github.com/MikeBild/subkit/commit/7be268efa7f26bbfe8d3bd0b5c3e9365a34afc1d))
* **engine,connectors:** nightly+weekly findings — adaptive thinking, URL probe + template URLs ([#76](https://github.com/MikeBild/subkit/pull/76)) ([ec2bc16](https://github.com/MikeBild/subkit/commit/ec2bc16b8207de2ed7d543ea92535fb90b325ec0))


### Refactoring

* zero out non-null assertions across production source ([#132](https://github.com/MikeBild/subkit/pull/132)) ([4ac8469](https://github.com/MikeBild/subkit/commit/4ac8469078383c56135c2802b237cb2ef86031a3))
* drop stale 'reserved for a future' comments and an unused enum value ([#131](https://github.com/MikeBild/subkit/pull/131)) ([75e8b91](https://github.com/MikeBild/subkit/commit/75e8b910ccc1042bae257364f6b033937ad1f3cb))
* remove three more half-implemented features ([#130](https://github.com/MikeBild/subkit/pull/130)) ([0cd9cde](https://github.com/MikeBild/subkit/commit/0cd9cdedb936c653aeb487d79c2e1b19e9b579b5))
* **chat:** remove unused link-token feature ([#129](https://github.com/MikeBild/subkit/pull/129)) ([255e431](https://github.com/MikeBild/subkit/commit/255e4318185e3bd984c8cb5358b75a8a4512a6be))
* **engine,db:** retire `BOOTSTRAP_*` env vars (now driven by /v1/setup) ([#70](https://github.com/MikeBild/subkit/pull/70)) ([bf37875](https://github.com/MikeBild/subkit/commit/bf37875fc1c9c77d2b3cd8b7051cbc6db1cdc016))
* **http:** split god-file route modules per audit §4.2 — connectors, connector-templates, conversations, executions, notifications, rbac, diagnostics ([#108](https://github.com/MikeBild/subkit/pull/108), [#109](https://github.com/MikeBild/subkit/pull/109), [#115](https://github.com/MikeBild/subkit/pull/115), [#116](https://github.com/MikeBild/subkit/pull/116), [#117](https://github.com/MikeBild/subkit/pull/117), [#118](https://github.com/MikeBild/subkit/pull/118), [#119](https://github.com/MikeBild/subkit/pull/119))
* **conversations:** split `service.ts`, `sdk-wrap.ts`, `authoring-state.ts`, `auto-persist.ts` into per-concern modules ([#112](https://github.com/MikeBild/subkit/pull/112), [#113](https://github.com/MikeBild/subkit/pull/113), [#122](https://github.com/MikeBild/subkit/pull/122), [#123](https://github.com/MikeBild/subkit/pull/123))
* **execution:** split `request.ts` (1804 LOC) per audit §4.2 + extract engine helpers ([#111](https://github.com/MikeBild/subkit/pull/111), [#121](https://github.com/MikeBild/subkit/pull/121))
* **llm:** consolidate token/budget accounting into `llm/accounting/`; split `context-assembler.ts` into formatters/loaders/skill-picker ([#105](https://github.com/MikeBild/subkit/pull/105), [#114](https://github.com/MikeBild/subkit/pull/114))
* **tunnels,pubsub:** bound `TunnelRegistry` + document pubsub restart contract ([#107](https://github.com/MikeBild/subkit/pull/107))

## [3.2.1](https://github.com/MikeBild/subkit/compare/subkit-v3.2.0...subkit-v3.2.1) (2026-04-28)


### Documentation

* drop the orphan German end-to-end sequences doc ([2c3edfe](https://github.com/MikeBild/subkit/commit/2c3edfe69f6f24923447b9303da052c32d0c1ce2))

## [3.2.0](https://github.com/MikeBild/subkit/compare/subkit-v3.1.0...subkit-v3.2.0) (2026-04-28)


### Features

* **http,sk:** /v1/settings routes + sk settings command ([600e33c](https://github.com/MikeBild/subkit/commit/600e33cd2b949768093195b9558a2da3a32537de))


### Bug Fixes

* **execution,sk:** resolve loop-item placeholders, populate request_meta on failure, route free-text approvals ([c35ef1c](https://github.com/MikeBild/subkit/commit/c35ef1c86c97a735f0a5b228d77f48a56fb6912f))
* **hooks:** widen e2e test timeout to 60s ([d9f980a](https://github.com/MikeBild/subkit/commit/d9f980a2e89f296383b3f5c04a7de31168fcf479))

## [3.1.0](https://github.com/MikeBild/subkit/compare/subkit-v3.0.0...subkit-v3.1.0) (2026-04-28)


### Features

* **engine:** seed RBAC essentials on startup ([7329df6](https://github.com/MikeBild/subkit/commit/7329df67fe836c9bb8c9ad21e3cd8f12bac18040))
* **http:** GET /install route serves a sk install script (Tailscale pattern) ([9477535](https://github.com/MikeBild/subkit/commit/947753566dc63209dbac3dfe6ad2999b0c6b3139))
* **sk:** doctor command for first-line operator diagnostic ([6cf911d](https://github.com/MikeBild/subkit/commit/6cf911d020211846ed2fa26516bb7f587a871550))


### Bug Fixes

* **ci:** gate gitleaks + dependency-review for private repos ([cf7f011](https://github.com/MikeBild/subkit/commit/cf7f011655a17352ee32eaead7b3f6393270afb3))
* **tests,hooks:** widen hook-timeout budget under parallel load ([a16bb45](https://github.com/MikeBild/subkit/commit/a16bb45b9b8af82a3943fa924f10bbf2c0f27469))

## [2.8.0](https://github.com/MikeBild/subkit/compare/subkit-v2.7.0...subkit-v2.8.0) (2026-04-27)


### Features

* **connectors,llm,mcp,discovery,events:** close 4 behavioral gaps via reference-project audit ([c5218c5](https://github.com/MikeBild/subkit/commit/c5218c5cb0430f19479abd92dd700a9f7f7e81da))
* **docs,knowledge:** close 8 documentation+knowledge gaps to reach reference parity ([c0b8ddf](https://github.com/MikeBild/subkit/commit/c0b8ddf42c2c0b3fec208fef1b1256913bd1d1c1))


### Bug Fixes

* **conversations:** single-token-entry connector save + loop-item teaching + override warning ([0cbd8f4](https://github.com/MikeBild/subkit/commit/0cbd8f49d382744ed6687c0a7ab4d4336a875047))

## [2.7.0](https://github.com/MikeBild/subkit/compare/subkit-v2.6.0...subkit-v2.7.0) (2026-04-27)


### Features

* **security,execution,discovery,sk:** conversational creation rebuild round 2 — SSRF guard, pagination resume, GraphQL+llms.txt+playwright discovery, multi-driver call_connector, sk CLI ergonomics ([d9125c7](https://github.com/MikeBild/subkit/commit/d9125c7ae214ec02fccf9f96c2288fcb6e8e0459))


### Miscellaneous

* **deps:** sync bun.lock with package.json (graphql, playwright) ([980dcce](https://github.com/MikeBild/subkit/commit/980dcced97ba58be3705c3b6ee4f365985e705f3))

## [2.6.0](https://github.com/MikeBild/subkit/compare/subkit-v2.5.0...subkit-v2.6.0) (2026-04-26)


### Features

* **conversations,connectors,security:** conversational creation rebuild — skill-gated palette, harness auto-persist, secret hygiene, live API discovery ([629bb82](https://github.com/MikeBild/subkit/commit/629bb828058f3f48f90e27cbe140448455fb02b1))
* **conversations,sk:** tool-policy hooks (credentialFields, prerequisites, buildPendingOutput) + setup-validation in /v1/status ([984aeb0](https://github.com/MikeBild/subkit/commit/984aeb04efb6fb6dabebd535f3620d8e01f86779))
* **conversations:** generic update_&lt;resource&gt; tools across all CRUD-shaped resources ([d5cc559](https://github.com/MikeBild/subkit/commit/d5cc559657e027837c574a09eef52846e1b28cd4))
* **output-guard:** chat-first scanner — runtime gate for curl/shell suggestions ([5b9abfd](https://github.com/MikeBild/subkit/commit/5b9abfdc4dc9018131a5df8b59f8dd02a576c442))
* **sk:** shift+enter and backslash-enter for newline (codex parity) ([3413aed](https://github.com/MikeBild/subkit/commit/3413aedc41efd82670e1b7170fbba2c9b6ccd586))


### Bug Fixes

* **connectors:** apply draft-time bearer/header/basic auth from config ([c686133](https://github.com/MikeBild/subkit/commit/c686133fad89b9a69296fd924ab22e846645921d))
* **conversations,sk:** chat-first repair palette, single-confirmation, speaker labels, paste UX ([5ddd22e](https://github.com/MikeBild/subkit/commit/5ddd22e4acf0241c3ad35a988cc8a09455416d3b))
* **conversations,sk:** permission_mode=auto skips ask_user_confirm; bare 'approve' resolves open elicits ([f0e9116](https://github.com/MikeBild/subkit/commit/f0e9116429e56256ae8c4eba61f3f83afb83ef13))
* **conversations,workflows:** kill the parallel-run_workflow loop + add update_workflow ([e4f342c](https://github.com/MikeBild/subkit/commit/e4f342c27027728f3d1bfac73f87c47e4a1498b5))
* **conversations:** cleanup tools always reachable + auto-mode skips commit_draft confirm ([71fe903](https://github.com/MikeBild/subkit/commit/71fe903cbcd82f94deddba17a65eef12be767a99))
* **conversations:** drop silent slug-adopt; require explicit target_workflow_id ([1a518d6](https://github.com/MikeBild/subkit/commit/1a518d632159778e72b493bea80405847a5df955))
* **sk:** elicitation owns input focus while open; revert keyword-match hack ([729247d](https://github.com/MikeBild/subkit/commit/729247d38ba800c2a9c064ca9eb65d10dfa2517a))
* **sk:** reserve spinner row when idle so the composer stops jumping ([f395fe0](https://github.com/MikeBild/subkit/commit/f395fe028732fc9e0e73a2b927d020c04d5f7f15))
* **test:** AC2 reads pending elicitation from resume_summary.pending_approval ([9a46130](https://github.com/MikeBild/subkit/commit/9a46130a3a68caa13d1bf2bcbb47d2685d1be6a3))
* **test:** poll AC2 elicit-resume frame instead of fixed-tick wait ([cbb0166](https://github.com/MikeBild/subkit/commit/cbb01666cfb88c888c7ba498801f8f91dfe152dd))
* **tests:** drop pre-rebuild ask_user_confirm in cannedListUsersPlan, harden audit-provenance beforeAll ([7008603](https://github.com/MikeBild/subkit/commit/7008603e82acf4e4a9b6c54d0655c5c6b5f24e81))
* **tests:** land fixture follow-ups for the conversational creation rebuild ([9878342](https://github.com/MikeBild/subkit/commit/98783427bc4f8bb47db394b994c60fcc24082689))
* **tests:** pass the determinism lint gate ([90168ca](https://github.com/MikeBild/subkit/commit/90168ca0ac2236ee609a95cbb1e8c98554873f17))
* **tests:** use skipIf+env flag instead of test.skip (determinism gate) ([4b0ff08](https://github.com/MikeBild/subkit/commit/4b0ff0875cd577c68e1ac23011fc98641c348ad8))


### Refactoring

* **conversations,llm:** agent-registry + skill-driven prompts ([5446d43](https://github.com/MikeBild/subkit/commit/5446d43b6f78c69f8542a6ed2ef1ac7f5f3d1109))

## [2.5.0](https://github.com/MikeBild/subkit/compare/subkit-v2.4.0...subkit-v2.5.0) (2026-04-25)


### Features

* **conversations,llm:** tenant-snapshot converse pipeline + connector-template binding ([5beeeaa](https://github.com/MikeBild/subkit/commit/5beeeaab8ceea6543de7210cb27e5d26672a5385))

## [2.4.0](https://github.com/MikeBild/subkit/compare/subkit-v2.3.1...subkit-v2.4.0) (2026-04-24)


### Features

* close end-to-end prompting/eval/context/execution/verification gaps ([85c9400](https://github.com/MikeBild/subkit/commit/85c9400311da8ab546e9baaa2487f94cd12d3e4b))


### Bug Fixes

* align authoring, eval, and sk surface contracts ([22a1eb6](https://github.com/MikeBild/subkit/commit/22a1eb6157071c305fbabb77766ebd9e39c8bc72))
* **ci:** invoke terminology gate with bash, not sh (dash lacks pipefail) ([7073c08](https://github.com/MikeBild/subkit/commit/7073c0893cc28f72bd262d48ddd955bdabb2655a))


### Documentation

* cleanup ([4b41b3f](https://github.com/MikeBild/subkit/commit/4b41b3f438c9c376d97d96219a128dfa065d912e))

## [2.3.1](https://github.com/MikeBild/subkit/compare/subkit-v2.3.0...subkit-v2.3.1) (2026-04-24)


### Bug Fixes

* **sandboxes:** embed sk-stdlib.js into compiled engine binary ([2c02125](https://github.com/MikeBild/subkit/commit/2c021255551704182c53dcb2f9b163521b2b17b0))

## [2.3.0](https://github.com/MikeBild/subkit/compare/subkit-v2.2.2...subkit-v2.3.0) (2026-04-24)


### Features

* add direct automation workflow surface ([caa4449](https://github.com/MikeBild/subkit/commit/caa4449bd7b3926645667cded669c79e8bc4c2ec))
* **connectors:** enrich template model with URL matching, smart probes, OAuth2 details, and spec import ([78742ba](https://github.com/MikeBild/subkit/commit/78742ba3e45eaaefabf46866e553f753f10d70ab))
* **conversations:** add match_connector_template_by_url and import_connector_from_spec tools ([47e8600](https://github.com/MikeBild/subkit/commit/47e8600c5e7d41328126e77729f6895ee5d2020d))
* **execution:** surface request_meta and connector_resolutions in run result ([5aa1708](https://github.com/MikeBild/subkit/commit/5aa170886859dc2297b5e018d134384d0fd5c83d))
* **http,mcp,self-healing:** expose URL match and spec import, rate-limit classifier, inline_schema indexer ([693c2ea](https://github.com/MikeBild/subkit/commit/693c2eae1dab9a48186b6cd0e87960b54422721b))
* **sandbox:** sk-stdlib with version tracking and drift detection ([2d5fe5f](https://github.com/MikeBild/subkit/commit/2d5fe5f5449fcdffce6f2cd5bb0c40bcc7beaba3))


### Bug Fixes

* **rbac,cli:** resource-scoped execution RBAC, portal-token deny reason, slash MCP label drift ([2f348e4](https://github.com/MikeBild/subkit/commit/2f348e44e4c09d5ca6c75c3aba8eab0a52c67d89))


### Documentation

* align terminology — 'automation' → 'workflow', 'integration' → 'connector' ([039b384](https://github.com/MikeBild/subkit/commit/039b384f187bf7a004b545f94792ec9fad0517a8))

## [2.2.2](https://github.com/MikeBild/subkit/compare/subkit-v2.2.1...subkit-v2.2.2) (2026-04-24)


### Bug Fixes

* **testing:** stabilize tty-sensitive release gate ([bc1a342](https://github.com/MikeBild/subkit/commit/bc1a342ea1469f5594e8becd00d19c4576fc6378))

## [2.2.1](https://github.com/MikeBild/subkit/compare/subkit-v2.2.0...subkit-v2.2.1) (2026-04-24)


### Bug Fixes

* **authoring:** harden seeded skills and graphql drafts ([75b0b8a](https://github.com/MikeBild/subkit/commit/75b0b8a0e26c8347b6a4e42530a1eb067f8f42d8))

## [2.2.0](https://github.com/MikeBild/subkit/compare/subkit-v2.1.0...subkit-v2.2.0) (2026-04-23)


### Features

* **sk:** enrich transcript and session surfaces ([049dc60](https://github.com/MikeBild/subkit/commit/049dc60c809d6cfcdbdb54fddc0e5a21795ed9ed))


### Bug Fixes

* **engine:** restore build_workflow response contract ([1e8fa1e](https://github.com/MikeBild/subkit/commit/1e8fa1e9b6962c10e8bdfb820d752ff454af2bdf))

## [2.1.0](https://github.com/MikeBild/subkit/compare/subkit-v2.0.0...subkit-v2.1.0) (2026-04-23)


### Features

* **authoring:** harden guided state, palette, and prompt flow ([6e5eed1](https://github.com/MikeBild/subkit/commit/6e5eed14c717a2d9a67b895f18d02304679bad54))
* **sk:** add full debug trace logging ([236d978](https://github.com/MikeBild/subkit/commit/236d978c13d90f7aaf2b2ad8f268b4a81abd4b9e))

## [2.0.0](https://github.com/MikeBild/subkit/compare/subkit-v1.18.1...subkit-v2.0.0) (2026-04-23)


### ⚠ BREAKING CHANGES

* **execution:** runExecution() accepts a discriminated `source` union instead of a bare workflow_id. All three kinds (saved, draft, step) flow through the same runtime pipeline; only the origin differs.

### Features

* **execution:** definition-driven run model with saved/draft/step sources ([40131f8](https://github.com/MikeBild/subkit/commit/40131f874406d8d0e580e8ebdcf506355ebc0162))
* **mcp:** mode-split tool catalog with native authenticate tool ([868dd1d](https://github.com/MikeBild/subkit/commit/868dd1dea22bfc570bda4fce27d67097cca51132))
* **sk:** run command supports saved/draft/step sources, new sk auth ([6775c0f](https://github.com/MikeBild/subkit/commit/6775c0f4c301aa9727f3bf5d3265402c13ecd1f8))


### Bug Fixes

* **conversations:** steer toolChoice from explicit user run intent ([af8f94c](https://github.com/MikeBild/subkit/commit/af8f94c2f1a3d9f1470c66e15a2baad871dcfcd7))


### Miscellaneous

* **release:** subkit 1.19.0 ([fcfedbe](https://github.com/MikeBild/subkit/commit/fcfedbef12dae757f4c4fc488d7c0f0a3c35ba39))

## [1.18.0](https://github.com/MikeBild/subkit/compare/subkit-v1.17.1...subkit-v1.18.0) (2026-04-23)


### Features

* add cleanup conversation write tools ([6d73d6a](https://github.com/MikeBild/subkit/commit/6d73d6a5653a1ee8b0484ddd815917886ad23d39))
* align runtime with documented envelope + surface drift feedback ([d3775b1](https://github.com/MikeBild/subkit/commit/d3775b193435942c93d8fefb598b3b815a60653a))
* **authoring:** close remaining FOLLOWUP gaps — preview parity, credentials, structured panes, richer snapshot ([d9b53e0](https://github.com/MikeBild/subkit/commit/d9b53e05fc8c38f796a570e9b9ba36b36a913cda))
* **authoring:** masked secrets + 3 more cards + route-doc parity gate ([af1ca67](https://github.com/MikeBild/subkit/commit/af1ca673d32acc857684c052c3e017fea47b1db6))
* CLI commands, MCP resources, scheduler, edge case + journey tests ([a944ba8](https://github.com/MikeBild/subkit/commit/a944ba88f2cc5cbf933dff32d422f2e8ddd942e6))
* **cli-core:** generated engine API client from OpenAPI (B1) ([5b937e6](https://github.com/MikeBild/subkit/commit/5b937e686c70709e314b72fefdb75bc5f12d5af0))
* **cli:** skills delete, --show-source, scaffolders, persona docs ([aa7a0a4](https://github.com/MikeBild/subkit/commit/aa7a0a44c6b324f05bac3129fee10b645127a61a))
* complete guided authoring and operator verification ([41ad42e](https://github.com/MikeBild/subkit/commit/41ad42ee9f058940a1e1fd2f710bff716c9afcfe))
* **connectors:** add redis, mssql, ftp, sftp, smb drivers ([50f416e](https://github.com/MikeBild/subkit/commit/50f416e34f260add631228ce612dff3c4d5a2f03))
* **conversations,http:** file-attachment system + [@attachment](https://github.com/attachment):&lt;slug&gt; resolver ([80f0fdd](https://github.com/MikeBild/subkit/commit/80f0fdd55139890db21e45b026cd44ca7f460284))
* **conversations,sk:** draft checkpoints + skill autoload + sk session commands ([085578b](https://github.com/MikeBild/subkit/commit/085578b7df973b901c5dd1eb8a42fb68c72d3c15))
* **conversations,sk:** guided authoring — real preview, probe/commit gates, resume summary, context block ([0e2178e](https://github.com/MikeBild/subkit/commit/0e2178ec07dbc219228b3a71dc46098bc3718272))
* **conversations,workflows:** build_workflow one-shot + sampleToSchema ([6a0fdff](https://github.com/MikeBild/subkit/commit/6a0fdff207092e988fe2f75dcf4e7e2a1801993f))
* **conversations:** anchor tool calls + elicitations to parent message ([baadbbb](https://github.com/MikeBild/subkit/commit/baadbbbd932ea70786e91ef650e485422a7135cb))
* **conversations:** discovery artifact tools — list / get / approve ([a932cfb](https://github.com/MikeBild/subkit/commit/a932cfb780a78a6aec4abe53c9078f9c5c1b41c4))
* **conversations:** dry_run_transform — jsonata/jsonpath/template probe ([49689d9](https://github.com/MikeBild/subkit/commit/49689d94ca93446545184ce77b68a0aed0722565))
* **conversations:** probe_connector tool — authenticated one-shot HTTP probe ([bef2f2a](https://github.com/MikeBild/subkit/commit/bef2f2a5beb07ca12a42f6ddc9463fbd0b25bef5))
* **conversations:** SDK tool-calling loop with streamText + fallback (A5) ([a2670a2](https://github.com/MikeBild/subkit/commit/a2670a27e5a20a73b50e91b0f3a76fd8f0d29a8b))
* **conversations:** static verifier + onboarding hint ([a4adc9c](https://github.com/MikeBild/subkit/commit/a4adc9c735e663b55f39bd1295ad9cedbd7e879d))
* **conversations:** wire interaction_log events through elicitation flow ([8fbd6a3](https://github.com/MikeBild/subkit/commit/8fbd6a3474df2376b2364ee803e3ad4aeb1315a9))
* **db:** migration 0028 convo-quality — skills seed, attachments, DLP, drafts ([7d3cf97](https://github.com/MikeBild/subkit/commit/7d3cf9703bdd0a7ad8f6a3ab2041a4c5edd7f342))
* **deploy:** consolidate local + CI deploy into one versioned pipeline ([f18e76b](https://github.com/MikeBild/subkit/commit/f18e76bf930758412b917bfe1bf4838f541deb13))
* **discovery:** codebase archive upload + extractor ([b6c4a0a](https://github.com/MikeBild/subkit/commit/b6c4a0af7f2f90f414d23d32158dd325f1020c67))
* **docs-ingestion:** knowledge-ingress cascade orchestrator ([e95c018](https://github.com/MikeBild/subkit/commit/e95c018763906d32c778ad9c0219a6cd79a74435))
* **e2e+engine:** real-LLM E2E suite + diagnostics endpoint + provider routing fix ([83f6b09](https://github.com/MikeBild/subkit/commit/83f6b09722f64a3bcb6a05a4a3bfa4c523d3987b))
* **engine:** add structured runtime logs and enterprise compliance audit trails ([97f4ae7](https://github.com/MikeBild/subkit/commit/97f4ae7a493ef60ece18523a18af93671b96962e))
* **engine:** answer-before-action, vendor-recipe lookup, visible approvals, output-guard repair ([0798405](https://github.com/MikeBild/subkit/commit/079840588e6b7f1ac82c6382dea71adbce4aa9e3))
* **engine:** grounded-output guard, runtime context, abstention + transcript-closing slice ([079ee9f](https://github.com/MikeBild/subkit/commit/079ee9fd290e46abf94c51b64fcea2a8a175598a))
* **engine:** implement Approach 2 pre-analyzed multi-step workflows ([f793e52](https://github.com/MikeBild/subkit/commit/f793e52724a75bc0f04c9d303871272cd1f97e31))
* **engine:** shared schema spine + observability + audit coverage ([603c7ec](https://github.com/MikeBild/subkit/commit/603c7ecdeb2a02c4f2a84170c90e469500e82fcf))
* **eval:** aggregate metrics + integration fixtures ([8ca6759](https://github.com/MikeBild/subkit/commit/8ca675957f8cd54ee640516e9d93e95a6b0018b7))
* **eval:** conversation-quality fixtures + validators ([0208e5a](https://github.com/MikeBild/subkit/commit/0208e5ad5f8705cfd2b0b9d3979c15ab088b9058))
* **execution:** per-step retry overrides + response-filter scopes ([be6181f](https://github.com/MikeBild/subkit/commit/be6181f0449364df8995daf6c8be758a23f6a879))
* **execution:** S3-backed large-payload offload ([f1d6fae](https://github.com/MikeBild/subkit/commit/f1d6faed060adade199e78e0118d8876ecb16830))
* **execution:** tenant DLP layer — response-filters with defaults ([4ce6c1f](https://github.com/MikeBild/subkit/commit/4ce6c1f3b24ea65e4499d3050282c95a046a01d8))
* expand connector template catalog to 89 production-quality templates ([ae257d5](https://github.com/MikeBild/subkit/commit/ae257d5bf7155e87328cefba5165cffc3c93661f))
* H2 Knowledge Sources, H2.5 Discovery, H3 Self-Improving Skills ([249320c](https://github.com/MikeBild/subkit/commit/249320c8a2566fcd309987dc06fbcf687ba4de17))
* initial commit — subkit workflow engine ([befda15](https://github.com/MikeBild/subkit/commit/befda15e261f74bf0efe64e069522c9c89912182))
* **llm+conversation:** parity wiring — core, tools, policies, confirmation, streaming, eval ([6fa9794](https://github.com/MikeBild/subkit/commit/6fa9794107432cb1098faa5bd9b8ad5583bbeead))
* **llm:** extended converse prompt + five pseudo-message builders ([68ef177](https://github.com/MikeBild/subkit/commit/68ef17792c19fc3648eab47a00957bf00aacb8d4))
* **llm:** generateObject + prompt caching + provider registry ([b8928cb](https://github.com/MikeBild/subkit/commit/b8928cbb86f04db481b5ea790e093b22f4256dcf))
* **llm:** per-flow env provider/model overrides ([a8b143c](https://github.com/MikeBild/subkit/commit/a8b143c4d614b91e7f1e9e12602984d23884c861))
* **llm:** per-tenant vendor-recipe overrides ([057ff88](https://github.com/MikeBild/subkit/commit/057ff881d875feab787445195dec38c3297ba6a6))
* **llm:** placeholder substitution system — parser + resolver + get_connector ([b7edbb3](https://github.com/MikeBild/subkit/commit/b7edbb36e44ecd9baab49dfa4b79a4e97259539f))
* **mcp:** destructive-action gate, synthesized input schemas, transform warnings ([7301007](https://github.com/MikeBild/subkit/commit/7301007e4700ac2066dbb0a36f893489faec9e17))
* **observability:** langfuse tool spans + defense-in-depth redaction ([f0cf866](https://github.com/MikeBild/subkit/commit/f0cf866f8ab51950d39fae98d0b217a92fbc028c))
* **observability:** OpenTelemetry tracer bootstrap with Langfuse (A6) ([c7e53d5](https://github.com/MikeBild/subkit/commit/c7e53d5790f97a32bd31cf85741a4353607dc76d))
* **onboarding:** demo-seed workflows + expertise tone hint ([db86d77](https://github.com/MikeBild/subkit/commit/db86d77228417e2da7eead43c73865a805004bfa))
* OTA auto-update system for all binaries with comprehensive tests ([a019f26](https://github.com/MikeBild/subkit/commit/a019f2605767c78a18a8c93956e486ce9f02f67d))
* P11 elicitations and Claude Code UX for sk ([1e7e89c](https://github.com/MikeBild/subkit/commit/1e7e89cb0a12139401d5fdfcf0f3fe59d6cd4861))
* **release/version.sh:** current_version = max(manifest, package.json) ([51c2f15](https://github.com/MikeBild/subkit/commit/51c2f153f60290e8a9844fd98857c76511b261fc))
* **sk:** add setup diagnostics UX ([5ba0c73](https://github.com/MikeBild/subkit/commit/5ba0c7308f611efc39a9f2baabb9176959cefc68))
* **sk:** consolidate subkit admin CLI into unified sk binary ([13f38cc](https://github.com/MikeBild/subkit/commit/13f38cc0f93f42a9d499f8420682b37396221dde))
* **skills,tools:** 10 Markdown skills + seed loader + description compiler ([0bb0f27](https://github.com/MikeBild/subkit/commit/0bb0f2741ec2215ae79989aba30242c7672ec485))
* **tunnels:** add TCP passthrough for multi-protocol routing ([3d0db26](https://github.com/MikeBild/subkit/commit/3d0db2651d71988897d34d8d1ffe71e0f3887d88))
* **webhooks:** failure classification, dead-letter, payload-reconstructing replay ([aa31f7b](https://github.com/MikeBild/subkit/commit/aa31f7ba274aac9e2332e65b89c3333045eb8481))


### Bug Fixes

* address code review findings — discovery routes, validation, budgets ([3a74d5c](https://github.com/MikeBild/subkit/commit/3a74d5c89126a5010417def91d28760297fdcb58))
* **audit:** emit full {items,next_cursor} envelope in JSON mode; broaden auth error regex ([5e18177](https://github.com/MikeBild/subkit/commit/5e18177346b0b997319140093731c44dda2cd5f0))
* **build:** commit bun.lock so Docker build + frozen-lockfile work ([6218a3a](https://github.com/MikeBild/subkit/commit/6218a3a08f1f9ee66efaf4d9060be8a6c5e7462f))
* **chat-ui/elicit:** finish TextPrompt single-owner input rewrite ([24fad4f](https://github.com/MikeBild/subkit/commit/24fad4f8352748701565da19077018035310ea5d))
* **chat:** avoid double rate-limit on notifications dispatch path ([9eb5dae](https://github.com/MikeBild/subkit/commit/9eb5dae57fdc00702858cd9ed1e2d82ded0e0ee3))
* **ci/release:** grant actions:read so publish-release can gh run download ([870604a](https://github.com/MikeBild/subkit/commit/870604aa76efb7cebbbeafb993c3f7abda55762b))
* **ci:** cross-compile darwin-x64 from macos-14 to escape macos-13 queue ([45684dc](https://github.com/MikeBild/subkit/commit/45684dcfc7851e692a981f7c3b2c74aba97e571d))
* **ci:** deploy health check via Docker HEALTHCHECK, not host port ([d878635](https://github.com/MikeBild/subkit/commit/d878635fc17b36327358e2d0d24e75d9e5211d70))
* **ci:** drop release:published trigger to prevent dual-fire ([a0dcc6d](https://github.com/MikeBild/subkit/commit/a0dcc6da1904fb5a6206f4b0a4b833a16df45184))
* **ci:** gate Docker + deploy jobs on DEPLOY_ENABLED repo variable ([858a756](https://github.com/MikeBild/subkit/commit/858a7563b0d625202dcda15d806e245bce6e455e))
* **ci:** gate publish/deploy jobs on tag ref ([a0a90b6](https://github.com/MikeBild/subkit/commit/a0a90b63f2f7f86271cb04b21dcca479db6ac4fe))
* **ci:** matrix build ships all 20 binaries, not just 4 windows ([c4a0458](https://github.com/MikeBild/subkit/commit/c4a0458ee44b84c6e3c3b77a7f3f8726137ebb7b))
* **ci:** pin Bun to 1.3.12 so release binaries sign cleanly on darwin-arm64 ([a620c50](https://github.com/MikeBild/subkit/commit/a620c50c06e2463c140ca269fe01355f61c8751c))
* **ci:** publish-release — per-artifact retry via gh run download ([024aeb0](https://github.com/MikeBild/subkit/commit/024aeb08842f73f5ab51fb6dc02a5fb38e4c7dff))
* **ci:** release workflow — trigger on `release: published` + manual dispatch ([397f339](https://github.com/MikeBild/subkit/commit/397f33927c1659cb1fd29dff889ce73f075028cc))
* **ci:** wire inputs.tag end-to-end for dispatch-from-main recovery ([ffba285](https://github.com/MikeBild/subkit/commit/ffba2855c5a25eda90d8cdbe78bca578a68d6b32))
* **conversations,cli:** honor permission_mode + update-in-place commit_draft + selection-safe transcript ([c80a47c](https://github.com/MikeBild/subkit/commit/c80a47c6dfd159528f90290c1fe67abf8141f934))
* **conversations:** canned list-users plan force-commits past probe gate ([070741f](https://github.com/MikeBild/subkit/commit/070741ff40d46904d6a18673bac350ac953feb6f))
* **db:** idempotent migrations + hash-first runner ([22bdc44](https://github.com/MikeBild/subkit/commit/22bdc4461c731c21955aa83995f2e86d0fa2273d))
* **deploy.sh:** portable mkdir-based lock (flock absent on macOS) ([3944c1e](https://github.com/MikeBild/subkit/commit/3944c1e3c660713f8d202f81ce32d26688038348))
* **docker:** copy scripts/ before bun install so postinstall runs ([fac4318](https://github.com/MikeBild/subkit/commit/fac43185d9b65fb3f8c210d3e4efef63ceae3e19))
* **e2e:** align weather/sk-user-story/deep-surface with paused-stop behavior ([809e999](https://github.com/MikeBild/subkit/commit/809e999018d9cdfbc262aa1d54b6a558910431a5))
* **e2e:** drop dag wrapper from mcp-surface delete-workflow fixture ([c2735a1](https://github.com/MikeBild/subkit/commit/c2735a1ed78d3245d6c4770187a621433141dc97))
* **e2e:** tier-1 real-LLM suite skips cleanly when LLM_PROVIDER=mock ([9f8d0f1](https://github.com/MikeBild/subkit/commit/9f8d0f18fa00cf96237a2f8d7d622d40642b1d53))
* **engine:** /v1/status version from OPENAPI_INFO, not env ([1a231c0](https://github.com/MikeBild/subkit/commit/1a231c010cdf8459575973c9cbb668a471ed2f4c))
* **engine:** close Approach 2 wiring gaps + 3 journey-test regressions ([b7148e7](https://github.com/MikeBild/subkit/commit/b7148e7db931f471eecb4537f3ab7bc4d9c7d266))
* **firebase:** extract inline CSS/JS to external files ([ba36089](https://github.com/MikeBild/subkit/commit/ba360898a7895df6b718670269df1cf18038e20d))
* harden install.sh — function wrap, retry, validation ([9d01385](https://github.com/MikeBild/subkit/commit/9d013855684cec17fae6fb48b4d1c828a2730010))
* **hooks:** remove stale build:cli from pre-push gate ([950e555](https://github.com/MikeBild/subkit/commit/950e555b705e39d517ff82158b62ba3c202083cc))
* **llm:** collapse to Vercel AI Gateway — root cause of v1.10.0 prod 500 cluster ([0a00705](https://github.com/MikeBild/subkit/commit/0a0070557f4129aa7330bebf10fab880a6521f51))
* **llm:** model-init tests tolerate @ai-sdk/anthropic not hoisted on CI ([82885bc](https://github.com/MikeBild/subkit/commit/82885bcaaa03a6721f13853ab5f275901c204d17))
* make URL reachability tests opt-in (CHECK_URLS=1) ([e1b2747](https://github.com/MikeBild/subkit/commit/e1b2747bc1073e826c9d6b0290a1b3d865b72562))
* **mcp:** await audit.policy_denied write before returning MCP deny ([f5dfeff](https://github.com/MikeBild/subkit/commit/f5dfeff67749fdcdead9d3f16a29c2de30f164a8))
* migration 0022 — incremental ALTER TABLE only ([255a9b4](https://github.com/MikeBild/subkit/commit/255a9b4e4a8832c828db57a0336212b24e5c6745))
* profile slash handler uses injected config path in tests ([2af5ab2](https://github.com/MikeBild/subkit/commit/2af5ab296703579b11b12434307800f906926604))
* register knowledge.ingest and skill-candidate.analyze queues ([e49d1ab](https://github.com/MikeBild/subkit/commit/e49d1ab9b77538d999463249efbda12ed3e0e1de))
* release workflow runs unit+integration tests only (matches CI) ([7c86754](https://github.com/MikeBild/subkit/commit/7c86754c6ea2d42e074a80a79418cdef65489980))
* release workflow tag pattern matches subkit-v* prefix ([cb66e12](https://github.com/MikeBild/subkit/commit/cb66e12d9e1731157205df53940bba861e382efb))
* **release/version.sh:** use prefixed vars to avoid clobbering caller's _SCRIPT_DIR ([cb69502](https://github.com/MikeBild/subkit/commit/cb6950212719328ed9627fe6c4276f566c7f47fc))
* **release:** retry transient registry auth during deploy ([2458c79](https://github.com/MikeBild/subkit/commit/2458c793ff3deda43e1b0d155a6fd18b7d90f50d))
* resolve all remaining medium + low severity review findings ([3396170](https://github.com/MikeBild/subkit/commit/33961706400956b369a6f934c46e07bf5e7c330b))
* resolve CI lint failures and enable GitHub Actions PR permissions ([a9a1ee6](https://github.com/MikeBild/subkit/commit/a9a1ee6769c84bacef470ac2bc691f1dad5046e3))
* runtime failures + add tests for 0-coverage phases ([28faf45](https://github.com/MikeBild/subkit/commit/28faf45e89eadf5d76a7b66f49948561b35a9cfb))
* **scheduler:** stabilise isCronDue test with fixed clocks ([7ee5070](https://github.com/MikeBild/subkit/commit/7ee5070d2e440d1e15cfb210be878041c365bafd))
* **sk/ink-tests:** poll lastFrame() with deadline to absorb CI scheduler latency ([46bb4eb](https://github.com/MikeBild/subkit/commit/46bb4ebae1c47a5871d05715024a86b7942ff9d2))
* **sk:** align command interfaces with test expectations ([8fd350d](https://github.com/MikeBild/subkit/commit/8fd350dbc0827bdc65ce697842ad5e28fe8a443a))
* **skills:** skip confirm prompt when stdin is not a TTY ([191350f](https://github.com/MikeBild/subkit/commit/191350ff022856dbbd217dab6c70c0feb7fb9ff6))
* **sk:** remove unused emitList import in health command ([eb12a61](https://github.com/MikeBild/subkit/commit/eb12a616abc16bf5925d51f78576460bded662d6))
* **sk:** simplify transcript and approval flow ([d07cad7](https://github.com/MikeBild/subkit/commit/d07cad706fbb9a1c05cc838bf5df277b19f9b98c))
* **sk:** strengthen chat guidance and routing ([#18](https://github.com/MikeBild/subkit/issues/18)) ([5fd133b](https://github.com/MikeBild/subkit/commit/5fd133b036340a0784d4f11bbf401c95b71c7afb))
* **sk:** surface pending_elicitation in headless JSON output ([18d457f](https://github.com/MikeBild/subkit/commit/18d457f41a0812e8d2c061a8250fef6708dbf871))
* split CI tests — run unit/integration before build, e2e after ([1a53ef0](https://github.com/MikeBild/subkit/commit/1a53ef0f4f22809b67f058fc4efdcf623e1ce68b))
* **tests:** journey 13 AC4 renames nested workflow draft too ([4733136](https://github.com/MikeBild/subkit/commit/4733136940aad06792c4440cbad28a991230c657))
* **tests:** pre-pull alpine image and disable update-check in e2e CLI env ([d66638c](https://github.com/MikeBild/subkit/commit/d66638cb8cc7b1a0ccd931d8fb044705b3fe04ac))


### Documentation

* add agent-facing guidance for Claude Code ([55bd3cd](https://github.com/MikeBild/subkit/commit/55bd3cdb02382911a77f0a9b2c347901994c8de2))
* **deployment:** document bun run release + scripts/release/* pipeline ([a2f38fc](https://github.com/MikeBild/subkit/commit/a2f38fc3ae821bd91ed0b16b84dcf6e5a6ca6bb8))
* **followup:** record 1.10.0 landings (masked secrets, 3 cards, route-doc parity gate) ([f6c806e](https://github.com/MikeBild/subkit/commit/f6c806e7942b1c712f4c4e2e8d2ff1dbae446a01))
* **followup:** record second-pass landings (preview parity, credentials, structured panes, richer snapshot, draft-dedup) ([e388453](https://github.com/MikeBild/subkit/commit/e388453c08acbb94dd5de341bae09b610776dba8))
* full documentation overhaul — problem-led README, mermaid-first format, missing features ([dfdc0c1](https://github.com/MikeBild/subkit/commit/dfdc0c16c6755472c935a2d932e18b763c3539e4))


### Miscellaneous

* **gitignore:** ignore .claude/scheduled_tasks.lock runtime artifact ([7fc79f7](https://github.com/MikeBild/subkit/commit/7fc79f79de1c5f8d45f3fd929dcdd34b7811fd14))
* ignore .env.deploy (laptop deploy overrides) ([9543bf3](https://github.com/MikeBild/subkit/commit/9543bf3889769c0b5c7ef99708d59397b1480d71))
* **main:** release subkit 1.0.0 ([#1](https://github.com/MikeBild/subkit/issues/1)) ([62ca88c](https://github.com/MikeBild/subkit/commit/62ca88ca647ba4446e9cb983e541561c687b4377))
* **main:** release subkit 1.1.0 ([#2](https://github.com/MikeBild/subkit/issues/2)) ([f5c3d90](https://github.com/MikeBild/subkit/commit/f5c3d900f6046f47e8911406bb4448425a515bbe))
* **main:** release subkit 1.1.1 ([#3](https://github.com/MikeBild/subkit/issues/3)) ([6cc6c69](https://github.com/MikeBild/subkit/commit/6cc6c6946f6f686972b12d4ae0ac98d88b0fd417))
* **main:** release subkit 1.10.0 ([#14](https://github.com/MikeBild/subkit/issues/14)) ([2b08f7e](https://github.com/MikeBild/subkit/commit/2b08f7e4feaf37525988e2f192a739b2bdf51923))
* **main:** release subkit 1.10.1 ([#15](https://github.com/MikeBild/subkit/issues/15)) ([47d7239](https://github.com/MikeBild/subkit/commit/47d7239b492ed9251c828ae2b37d8496f4cd5854))
* **main:** release subkit 1.10.10 ([#19](https://github.com/MikeBild/subkit/issues/19)) ([b8a2784](https://github.com/MikeBild/subkit/commit/b8a27849c664ffb0940f869d0f3eb1624b4f5493))
* **main:** release subkit 1.10.2 ([#16](https://github.com/MikeBild/subkit/issues/16)) ([525f3c8](https://github.com/MikeBild/subkit/commit/525f3c8036d7ee5636c840ffb7b885c49e1509fd))
* **main:** release subkit 1.10.8 ([#17](https://github.com/MikeBild/subkit/issues/17)) ([187bf28](https://github.com/MikeBild/subkit/commit/187bf282e32e466b302329bee9f4b793d2fb3e04))
* **main:** release subkit 1.11.0 ([#20](https://github.com/MikeBild/subkit/issues/20)) ([5a4431a](https://github.com/MikeBild/subkit/commit/5a4431af8eb106537b68bf8d11c73aa428d9883a))
* **main:** release subkit 1.12.0 ([#21](https://github.com/MikeBild/subkit/issues/21)) ([d6ea21c](https://github.com/MikeBild/subkit/commit/d6ea21caa36d84c198a2f7fd9bfcf32a78d8ae68))
* **main:** release subkit 1.13.0 ([#22](https://github.com/MikeBild/subkit/issues/22)) ([220c43a](https://github.com/MikeBild/subkit/commit/220c43aab2927ff35e55424c68dfd3fffd31e74c))
* **main:** release subkit 1.13.1 ([#23](https://github.com/MikeBild/subkit/issues/23)) ([a95da77](https://github.com/MikeBild/subkit/commit/a95da774264f851f47e9519c066b416b2d71ce69))
* **main:** release subkit 1.14.0 ([#25](https://github.com/MikeBild/subkit/issues/25)) ([6ffad18](https://github.com/MikeBild/subkit/commit/6ffad18b350c2bd3c21db4e94fbcc31b8fd32b0c))
* **main:** release subkit 1.15.0 ([#26](https://github.com/MikeBild/subkit/issues/26)) ([859e522](https://github.com/MikeBild/subkit/commit/859e5226f8fec7cb4ab4de7fb2b56a52f0bf1044))
* **main:** release subkit 1.16.0 ([#27](https://github.com/MikeBild/subkit/issues/27)) ([271d6d9](https://github.com/MikeBild/subkit/commit/271d6d92769cc7c04458f69cabe1f3980a2f6124))
* **main:** release subkit 1.17.0 ([#28](https://github.com/MikeBild/subkit/issues/28)) ([03f038d](https://github.com/MikeBild/subkit/commit/03f038d1806758e9d000803b5b2826f487645bbe))
* **main:** release subkit 1.2.0 ([#4](https://github.com/MikeBild/subkit/issues/4)) ([cd1d75b](https://github.com/MikeBild/subkit/commit/cd1d75bff2f6b9f9796bfdded1eb5d0932b61079))
* **main:** release subkit 1.3.0 ([#5](https://github.com/MikeBild/subkit/issues/5)) ([d526534](https://github.com/MikeBild/subkit/commit/d5265349655a2e721c9d569b0a30a88a2638001e))
* **main:** release subkit 1.4.0 ([#6](https://github.com/MikeBild/subkit/issues/6)) ([70f4a3c](https://github.com/MikeBild/subkit/commit/70f4a3c463454a8e8a0dc043f237978b00c0f45f))
* **main:** release subkit 1.5.0 ([#7](https://github.com/MikeBild/subkit/issues/7)) ([999e0df](https://github.com/MikeBild/subkit/commit/999e0df9d9758cb6954a53d2a75c17606e167c1c))
* **main:** release subkit 1.6.0 ([#8](https://github.com/MikeBild/subkit/issues/8)) ([da9d821](https://github.com/MikeBild/subkit/commit/da9d8210d1588ec5213cd07b0b8ab0ede2ea9429))
* **main:** release subkit 1.6.1 ([#9](https://github.com/MikeBild/subkit/issues/9)) ([62f32bf](https://github.com/MikeBild/subkit/commit/62f32bffadb81146f4eded40700836e7c44438fe))
* **main:** release subkit 1.6.4 ([#10](https://github.com/MikeBild/subkit/issues/10)) ([f19f859](https://github.com/MikeBild/subkit/commit/f19f859db89032a3ff507489db6093a0b21eb89c))
* **main:** release subkit 1.7.0 ([#11](https://github.com/MikeBild/subkit/issues/11)) ([69362e8](https://github.com/MikeBild/subkit/commit/69362e8df2af2b53717347278ce480feb5c385b8))
* **main:** release subkit 1.8.0 ([#12](https://github.com/MikeBild/subkit/issues/12)) ([5c51a64](https://github.com/MikeBild/subkit/commit/5c51a644c52d96cce0147a1678c27db1795f8ab9))
* **main:** release subkit 1.9.0 ([#13](https://github.com/MikeBild/subkit/issues/13)) ([147d318](https://github.com/MikeBild/subkit/commit/147d3185ebabe07c24a5cc259d97a152d0c154af))
* **release:** subkit 1.10.3 ([1603a7f](https://github.com/MikeBild/subkit/commit/1603a7f17ec3b4d7d7917ca20009e0b403ddd755))
* **release:** subkit 1.10.4 ([df9cafb](https://github.com/MikeBild/subkit/commit/df9cafbdc69095cff02714b3bd6eee4e789c3b4e))
* **release:** subkit 1.10.5 ([4bbcfd8](https://github.com/MikeBild/subkit/commit/4bbcfd81e0c43d227791c52ecd5cb767371b28e1))
* **release:** subkit 1.10.6 ([9a34515](https://github.com/MikeBild/subkit/commit/9a345154b11c354146cfde420fdfd5ee5142abf0))
* **release:** subkit 1.10.7 ([305454b](https://github.com/MikeBild/subkit/commit/305454b5147ea50dd047fd45a52c34b8a7ca0f39))
* **release:** subkit 1.10.9 ([2826b7f](https://github.com/MikeBild/subkit/commit/2826b7f7da90b56166899d521aa1b839abb8ac59))
* **release:** subkit 1.17.1 ([d6fb802](https://github.com/MikeBild/subkit/commit/d6fb8029934241875b50e603c89f56609106dcc4))
* **release:** subkit 1.6.2 ([08d7f9d](https://github.com/MikeBild/subkit/commit/08d7f9dbd04c68ba9c4408c1288704d1408dfdd1))
* **release:** subkit 1.6.3 ([c2fb3be](https://github.com/MikeBild/subkit/commit/c2fb3be9cdaef47c67705b2c0016440e29dbb720))
* remove unused skillEffectiveness import ([b138ea2](https://github.com/MikeBild/subkit/commit/b138ea2fd87c1a5a57b346fd653260059fd05e44))
* resolve all biome lint warnings ([97d6865](https://github.com/MikeBild/subkit/commit/97d6865ad1d3401d374827775ee6f19b2f352a18))

## [1.17.0](https://github.com/MikeBild/subkit/compare/subkit-v1.16.0...subkit-v1.17.0) (2026-04-23)


### Features

* align runtime with documented envelope + surface drift feedback ([d3775b1](https://github.com/MikeBild/subkit/commit/d3775b193435942c93d8fefb598b3b815a60653a))

## [1.16.0](https://github.com/MikeBild/subkit/compare/subkit-v1.15.0...subkit-v1.16.0) (2026-04-22)


### Features

* **connectors:** add redis, mssql, ftp, sftp, smb drivers ([50f416e](https://github.com/MikeBild/subkit/commit/50f416e34f260add631228ce612dff3c4d5a2f03))
* **conversations:** anchor tool calls + elicitations to parent message ([baadbbb](https://github.com/MikeBild/subkit/commit/baadbbbd932ea70786e91ef650e485422a7135cb))
* **discovery:** codebase archive upload + extractor ([b6c4a0a](https://github.com/MikeBild/subkit/commit/b6c4a0af7f2f90f414d23d32158dd325f1020c67))
* **docs-ingestion:** knowledge-ingress cascade orchestrator ([e95c018](https://github.com/MikeBild/subkit/commit/e95c018763906d32c778ad9c0219a6cd79a74435))
* **eval:** aggregate metrics + integration fixtures ([8ca6759](https://github.com/MikeBild/subkit/commit/8ca675957f8cd54ee640516e9d93e95a6b0018b7))
* **execution:** per-step retry overrides + response-filter scopes ([be6181f](https://github.com/MikeBild/subkit/commit/be6181f0449364df8995daf6c8be758a23f6a879))
* **execution:** S3-backed large-payload offload ([f1d6fae](https://github.com/MikeBild/subkit/commit/f1d6faed060adade199e78e0118d8876ecb16830))
* **llm:** per-flow env provider/model overrides ([a8b143c](https://github.com/MikeBild/subkit/commit/a8b143c4d614b91e7f1e9e12602984d23884c861))
* **llm:** per-tenant vendor-recipe overrides ([057ff88](https://github.com/MikeBild/subkit/commit/057ff881d875feab787445195dec38c3297ba6a6))
* **onboarding:** demo-seed workflows + expertise tone hint ([db86d77](https://github.com/MikeBild/subkit/commit/db86d77228417e2da7eead43c73865a805004bfa))
* **tunnels:** add TCP passthrough for multi-protocol routing ([3d0db26](https://github.com/MikeBild/subkit/commit/3d0db2651d71988897d34d8d1ffe71e0f3887d88))
* **webhooks:** failure classification, dead-letter, payload-reconstructing replay ([aa31f7b](https://github.com/MikeBild/subkit/commit/aa31f7ba274aac9e2332e65b89c3333045eb8481))


### Bug Fixes

* **e2e:** drop dag wrapper from mcp-surface delete-workflow fixture ([c2735a1](https://github.com/MikeBild/subkit/commit/c2735a1ed78d3245d6c4770187a621433141dc97))

## [1.15.0](https://github.com/MikeBild/subkit/compare/subkit-v1.14.0...subkit-v1.15.0) (2026-04-21)


### Features

* **engine:** answer-before-action, vendor-recipe lookup, visible approvals, output-guard repair ([0798405](https://github.com/MikeBild/subkit/commit/079840588e6b7f1ac82c6382dea71adbce4aa9e3))
* **mcp:** destructive-action gate, synthesized input schemas, transform warnings ([7301007](https://github.com/MikeBild/subkit/commit/7301007e4700ac2066dbb0a36f893489faec9e17))


### Bug Fixes

* **ci:** pin Bun to 1.3.12 so release binaries sign cleanly on darwin-arm64 ([a620c50](https://github.com/MikeBild/subkit/commit/a620c50c06e2463c140ca269fe01355f61c8751c))

## [1.14.0](https://github.com/MikeBild/subkit/compare/subkit-v1.13.1...subkit-v1.14.0) (2026-04-20)


### Features

* **engine:** grounded-output guard, runtime context, abstention + transcript-closing slice ([079ee9f](https://github.com/MikeBild/subkit/commit/079ee9fd290e46abf94c51b64fcea2a8a175598a))

## [1.13.1](https://github.com/MikeBild/subkit/compare/subkit-v1.13.0...subkit-v1.13.1) (2026-04-20)


### Bug Fixes

* **engine:** close Approach 2 wiring gaps + 3 journey-test regressions ([b7148e7](https://github.com/MikeBild/subkit/commit/b7148e7db931f471eecb4537f3ab7bc4d9c7d266))

## [1.13.0](https://github.com/MikeBild/subkit/compare/subkit-v1.12.0...subkit-v1.13.0) (2026-04-20)


### Features

* **engine:** implement Approach 2 pre-analyzed multi-step workflows ([f793e52](https://github.com/MikeBild/subkit/commit/f793e52724a75bc0f04c9d303871272cd1f97e31))

## [1.12.0](https://github.com/MikeBild/subkit/compare/subkit-v1.11.0...subkit-v1.12.0) (2026-04-20)


### Features

* **engine:** add structured runtime logs and enterprise compliance audit trails ([97f4ae7](https://github.com/MikeBild/subkit/commit/97f4ae7a493ef60ece18523a18af93671b96962e))

## [1.11.0](https://github.com/MikeBild/subkit/compare/subkit-v1.10.10...subkit-v1.11.0) (2026-04-20)


### Features

* **sk:** consolidate subkit admin CLI into unified sk binary ([13f38cc](https://github.com/MikeBild/subkit/commit/13f38cc0f93f42a9d499f8420682b37396221dde))


### Bug Fixes

* **audit:** emit full {items,next_cursor} envelope in JSON mode; broaden auth error regex ([5e18177](https://github.com/MikeBild/subkit/commit/5e18177346b0b997319140093731c44dda2cd5f0))
* **hooks:** remove stale build:cli from pre-push gate ([950e555](https://github.com/MikeBild/subkit/commit/950e555b705e39d517ff82158b62ba3c202083cc))
* **sk:** align command interfaces with test expectations ([8fd350d](https://github.com/MikeBild/subkit/commit/8fd350dbc0827bdc65ce697842ad5e28fe8a443a))
* **skills:** skip confirm prompt when stdin is not a TTY ([191350f](https://github.com/MikeBild/subkit/commit/191350ff022856dbbd217dab6c70c0feb7fb9ff6))
* **sk:** remove unused emitList import in health command ([eb12a61](https://github.com/MikeBild/subkit/commit/eb12a616abc16bf5925d51f78576460bded662d6))

## [1.10.10](https://github.com/MikeBild/subkit/compare/subkit-v1.10.9...subkit-v1.10.10) (2026-04-19)


### Bug Fixes

* **sk:** strengthen chat guidance and routing ([#18](https://github.com/MikeBild/subkit/issues/18)) ([5fd133b](https://github.com/MikeBild/subkit/commit/5fd133b036340a0784d4f11bbf401c95b71c7afb))

## [1.10.8](https://github.com/MikeBild/subkit/compare/subkit-v1.10.7...subkit-v1.10.8) (2026-04-19)


### Bug Fixes

* **sk:** simplify transcript and approval flow ([d07cad7](https://github.com/MikeBild/subkit/commit/d07cad706fbb9a1c05cc838bf5df277b19f9b98c))

## [1.10.2](https://github.com/MikeBild/subkit/compare/subkit-v1.10.1...subkit-v1.10.2) (2026-04-19)


### Bug Fixes

* **llm:** collapse to Vercel AI Gateway — root cause of v1.10.0 prod 500 cluster ([0a00705](https://github.com/MikeBild/subkit/commit/0a0070557f4129aa7330bebf10fab880a6521f51))

## [1.10.1](https://github.com/MikeBild/subkit/compare/subkit-v1.10.0...subkit-v1.10.1) (2026-04-19)


### Documentation

* **followup:** record 1.10.0 landings (masked secrets, 3 cards, route-doc parity gate) ([f6c806e](https://github.com/MikeBild/subkit/commit/f6c806e7942b1c712f4c4e2e8d2ff1dbae446a01))

## [1.10.0](https://github.com/MikeBild/subkit/compare/subkit-v1.9.0...subkit-v1.10.0) (2026-04-19)


### Features

* **authoring:** masked secrets + 3 more cards + route-doc parity gate ([af1ca67](https://github.com/MikeBild/subkit/commit/af1ca673d32acc857684c052c3e017fea47b1db6))

## [1.9.0](https://github.com/MikeBild/subkit/compare/subkit-v1.8.0...subkit-v1.9.0) (2026-04-19)


### Features

* **authoring:** close remaining FOLLOWUP gaps — preview parity, credentials, structured panes, richer snapshot ([d9b53e0](https://github.com/MikeBild/subkit/commit/d9b53e05fc8c38f796a570e9b9ba36b36a913cda))


### Documentation

* **followup:** record second-pass landings (preview parity, credentials, structured panes, richer snapshot, draft-dedup) ([e388453](https://github.com/MikeBild/subkit/commit/e388453c08acbb94dd5de341bae09b610776dba8))

## [1.8.0](https://github.com/MikeBild/subkit/compare/subkit-v1.7.0...subkit-v1.8.0) (2026-04-19)


### Features

* **conversations,sk:** guided authoring — real preview, probe/commit gates, resume summary, context block ([0e2178e](https://github.com/MikeBild/subkit/commit/0e2178ec07dbc219228b3a71dc46098bc3718272))


### Bug Fixes

* **conversations:** canned list-users plan force-commits past probe gate ([070741f](https://github.com/MikeBild/subkit/commit/070741ff40d46904d6a18673bac350ac953feb6f))
* **docker:** copy scripts/ before bun install so postinstall runs ([fac4318](https://github.com/MikeBild/subkit/commit/fac43185d9b65fb3f8c210d3e4efef63ceae3e19))
* **e2e:** align weather/sk-user-story/deep-surface with paused-stop behavior ([809e999](https://github.com/MikeBild/subkit/commit/809e999018d9cdfbc262aa1d54b6a558910431a5))
* **tests:** journey 13 AC4 renames nested workflow draft too ([4733136](https://github.com/MikeBild/subkit/commit/4733136940aad06792c4440cbad28a991230c657))

## [1.7.0](https://github.com/MikeBild/subkit/compare/subkit-v1.6.4...subkit-v1.7.0) (2026-04-19)


### Features

* **conversations,http:** file-attachment system + [@attachment](https://github.com/attachment):&lt;slug&gt; resolver ([80f0fdd](https://github.com/MikeBild/subkit/commit/80f0fdd55139890db21e45b026cd44ca7f460284))
* **conversations,sk:** draft checkpoints + skill autoload + sk session commands ([085578b](https://github.com/MikeBild/subkit/commit/085578b7df973b901c5dd1eb8a42fb68c72d3c15))
* **conversations,workflows:** build_workflow one-shot + sampleToSchema ([6a0fdff](https://github.com/MikeBild/subkit/commit/6a0fdff207092e988fe2f75dcf4e7e2a1801993f))
* **conversations:** discovery artifact tools — list / get / approve ([a932cfb](https://github.com/MikeBild/subkit/commit/a932cfb780a78a6aec4abe53c9078f9c5c1b41c4))
* **conversations:** dry_run_transform — jsonata/jsonpath/template probe ([49689d9](https://github.com/MikeBild/subkit/commit/49689d94ca93446545184ce77b68a0aed0722565))
* **conversations:** probe_connector tool — authenticated one-shot HTTP probe ([bef2f2a](https://github.com/MikeBild/subkit/commit/bef2f2a5beb07ca12a42f6ddc9463fbd0b25bef5))
* **conversations:** static verifier + onboarding hint ([a4adc9c](https://github.com/MikeBild/subkit/commit/a4adc9c735e663b55f39bd1295ad9cedbd7e879d))
* **conversations:** wire interaction_log events through elicitation flow ([8fbd6a3](https://github.com/MikeBild/subkit/commit/8fbd6a3474df2376b2364ee803e3ad4aeb1315a9))
* **db:** migration 0028 convo-quality — skills seed, attachments, DLP, drafts ([7d3cf97](https://github.com/MikeBild/subkit/commit/7d3cf9703bdd0a7ad8f6a3ab2041a4c5edd7f342))
* **e2e+engine:** real-LLM E2E suite + diagnostics endpoint + provider routing fix ([83f6b09](https://github.com/MikeBild/subkit/commit/83f6b09722f64a3bcb6a05a4a3bfa4c523d3987b))
* **eval:** conversation-quality fixtures + validators ([0208e5a](https://github.com/MikeBild/subkit/commit/0208e5ad5f8705cfd2b0b9d3979c15ab088b9058))
* **execution:** tenant DLP layer — response-filters with defaults ([4ce6c1f](https://github.com/MikeBild/subkit/commit/4ce6c1f3b24ea65e4499d3050282c95a046a01d8))
* **llm:** extended converse prompt + five pseudo-message builders ([68ef177](https://github.com/MikeBild/subkit/commit/68ef17792c19fc3648eab47a00957bf00aacb8d4))
* **llm:** placeholder substitution system — parser + resolver + get_connector ([b7edbb3](https://github.com/MikeBild/subkit/commit/b7edbb36e44ecd9baab49dfa4b79a4e97259539f))
* **observability:** langfuse tool spans + defense-in-depth redaction ([f0cf866](https://github.com/MikeBild/subkit/commit/f0cf866f8ab51950d39fae98d0b217a92fbc028c))
* **skills,tools:** 10 Markdown skills + seed loader + description compiler ([0bb0f27](https://github.com/MikeBild/subkit/commit/0bb0f2741ec2215ae79989aba30242c7672ec485))


### Bug Fixes

* **e2e:** tier-1 real-LLM suite skips cleanly when LLM_PROVIDER=mock ([9f8d0f1](https://github.com/MikeBild/subkit/commit/9f8d0f18fa00cf96237a2f8d7d622d40642b1d53))
* **firebase:** extract inline CSS/JS to external files ([ba36089](https://github.com/MikeBild/subkit/commit/ba360898a7895df6b718670269df1cf18038e20d))
* **llm:** model-init tests tolerate @ai-sdk/anthropic not hoisted on CI ([82885bc](https://github.com/MikeBild/subkit/commit/82885bcaaa03a6721f13853ab5f275901c204d17))

## [1.6.4](https://github.com/MikeBild/subkit/compare/subkit-v1.6.3...subkit-v1.6.4) (2026-04-19)


### Bug Fixes

* **ci/release:** grant actions:read so publish-release can gh run download ([870604a](https://github.com/MikeBild/subkit/commit/870604aa76efb7cebbbeafb993c3f7abda55762b))
* **mcp:** await audit.policy_denied write before returning MCP deny ([f5dfeff](https://github.com/MikeBild/subkit/commit/f5dfeff67749fdcdead9d3f16a29c2de30f164a8))
* **sk/ink-tests:** poll lastFrame() with deadline to absorb CI scheduler latency ([46bb4eb](https://github.com/MikeBild/subkit/commit/46bb4ebae1c47a5871d05715024a86b7942ff9d2))

## [1.6.1](https://github.com/MikeBild/subkit/compare/subkit-v1.6.0...subkit-v1.6.1) (2026-04-18)


### Bug Fixes

* **engine:** /v1/status version from OPENAPI_INFO, not env ([1a231c0](https://github.com/MikeBild/subkit/commit/1a231c010cdf8459575973c9cbb668a471ed2f4c))

## [1.6.0](https://github.com/MikeBild/subkit/compare/subkit-v1.5.0...subkit-v1.6.0) (2026-04-17)


### Features

* P11 elicitations and Claude Code UX for sk ([1e7e89c](https://github.com/MikeBild/subkit/commit/1e7e89cb0a12139401d5fdfcf0f3fe59d6cd4861))


### Bug Fixes

* **ci:** deploy health check via Docker HEALTHCHECK, not host port ([d878635](https://github.com/MikeBild/subkit/commit/d878635fc17b36327358e2d0d24e75d9e5211d70))
* **ci:** drop release:published trigger to prevent dual-fire ([a0dcc6d](https://github.com/MikeBild/subkit/commit/a0dcc6da1904fb5a6206f4b0a4b833a16df45184))
* **ci:** publish-release — per-artifact retry via gh run download ([024aeb0](https://github.com/MikeBild/subkit/commit/024aeb08842f73f5ab51fb6dc02a5fb38e4c7dff))
* **sk:** surface pending_elicitation in headless JSON output ([18d457f](https://github.com/MikeBild/subkit/commit/18d457f41a0812e8d2c061a8250fef6708dbf871))
* **tests:** pre-pull alpine image and disable update-check in e2e CLI env ([d66638c](https://github.com/MikeBild/subkit/commit/d66638cb8cc7b1a0ccd931d8fb044705b3fe04ac))

## [1.5.0](https://github.com/MikeBild/subkit/compare/subkit-v1.4.0...subkit-v1.5.0) (2026-04-17)


### Features

* **conversations:** SDK tool-calling loop with streamText + fallback (A5) ([a2670a2](https://github.com/MikeBild/subkit/commit/a2670a27e5a20a73b50e91b0f3a76fd8f0d29a8b))


### Bug Fixes

* **build:** commit bun.lock so Docker build + frozen-lockfile work ([6218a3a](https://github.com/MikeBild/subkit/commit/6218a3a08f1f9ee66efaf4d9060be8a6c5e7462f))
* **ci:** wire inputs.tag end-to-end for dispatch-from-main recovery ([ffba285](https://github.com/MikeBild/subkit/commit/ffba2855c5a25eda90d8cdbe78bca578a68d6b32))


### Miscellaneous

* **gitignore:** ignore .claude/scheduled_tasks.lock runtime artifact ([7fc79f7](https://github.com/MikeBild/subkit/commit/7fc79f79de1c5f8d45f3fd929dcdd34b7811fd14))

## [1.4.0](https://github.com/MikeBild/subkit/compare/subkit-v1.3.0...subkit-v1.4.0) (2026-04-17)


### Features

* **cli-core:** generated engine API client from OpenAPI (B1) ([5b937e6](https://github.com/MikeBild/subkit/commit/5b937e686c70709e314b72fefdb75bc5f12d5af0))
* **llm:** generateObject + prompt caching + provider registry ([b8928cb](https://github.com/MikeBild/subkit/commit/b8928cbb86f04db481b5ea790e093b22f4256dcf))
* **observability:** OpenTelemetry tracer bootstrap with Langfuse (A6) ([c7e53d5](https://github.com/MikeBild/subkit/commit/c7e53d5790f97a32bd31cf85741a4353607dc76d))


### Bug Fixes

* **ci:** cross-compile darwin-x64 from macos-14 to escape macos-13 queue ([45684dc](https://github.com/MikeBild/subkit/commit/45684dcfc7851e692a981f7c3b2c74aba97e571d))
* **ci:** gate publish/deploy jobs on tag ref ([a0a90b6](https://github.com/MikeBild/subkit/commit/a0a90b63f2f7f86271cb04b21dcca479db6ac4fe))

## [1.3.0](https://github.com/MikeBild/subkit/compare/subkit-v1.2.0...subkit-v1.3.0) (2026-04-17)


### Features

* CLI commands, MCP resources, scheduler, edge case + journey tests ([a944ba8](https://github.com/MikeBild/subkit/commit/a944ba88f2cc5cbf933dff32d422f2e8ddd942e6))
* **cli:** skills delete, --show-source, scaffolders, persona docs ([aa7a0a4](https://github.com/MikeBild/subkit/commit/aa7a0a44c6b324f05bac3129fee10b645127a61a))
* **engine:** shared schema spine + observability + audit coverage ([603c7ec](https://github.com/MikeBild/subkit/commit/603c7ecdeb2a02c4f2a84170c90e469500e82fcf))
* expand connector template catalog to 89 production-quality templates ([ae257d5](https://github.com/MikeBild/subkit/commit/ae257d5bf7155e87328cefba5165cffc3c93661f))
* H2 Knowledge Sources, H2.5 Discovery, H3 Self-Improving Skills ([249320c](https://github.com/MikeBild/subkit/commit/249320c8a2566fcd309987dc06fbcf687ba4de17))
* initial commit — subkit workflow engine ([befda15](https://github.com/MikeBild/subkit/commit/befda15e261f74bf0efe64e069522c9c89912182))
* OTA auto-update system for all binaries with comprehensive tests ([a019f26](https://github.com/MikeBild/subkit/commit/a019f2605767c78a18a8c93956e486ce9f02f67d))


### Bug Fixes

* address code review findings — discovery routes, validation, budgets ([3a74d5c](https://github.com/MikeBild/subkit/commit/3a74d5c89126a5010417def91d28760297fdcb58))
* **chat:** avoid double rate-limit on notifications dispatch path ([9eb5dae](https://github.com/MikeBild/subkit/commit/9eb5dae57fdc00702858cd9ed1e2d82ded0e0ee3))
* **ci:** gate Docker + deploy jobs on DEPLOY_ENABLED repo variable ([858a756](https://github.com/MikeBild/subkit/commit/858a7563b0d625202dcda15d806e245bce6e455e))
* **ci:** release workflow — trigger on `release: published` + manual dispatch ([397f339](https://github.com/MikeBild/subkit/commit/397f33927c1659cb1fd29dff889ce73f075028cc))
* **db:** idempotent migrations + hash-first runner ([22bdc44](https://github.com/MikeBild/subkit/commit/22bdc4461c731c21955aa83995f2e86d0fa2273d))
* harden install.sh — function wrap, retry, validation ([9d01385](https://github.com/MikeBild/subkit/commit/9d013855684cec17fae6fb48b4d1c828a2730010))
* make URL reachability tests opt-in (CHECK_URLS=1) ([e1b2747](https://github.com/MikeBild/subkit/commit/e1b2747bc1073e826c9d6b0290a1b3d865b72562))
* migration 0022 — incremental ALTER TABLE only ([255a9b4](https://github.com/MikeBild/subkit/commit/255a9b4e4a8832c828db57a0336212b24e5c6745))
* profile slash handler uses injected config path in tests ([2af5ab2](https://github.com/MikeBild/subkit/commit/2af5ab296703579b11b12434307800f906926604))
* register knowledge.ingest and skill-candidate.analyze queues ([e49d1ab](https://github.com/MikeBild/subkit/commit/e49d1ab9b77538d999463249efbda12ed3e0e1de))
* release workflow runs unit+integration tests only (matches CI) ([7c86754](https://github.com/MikeBild/subkit/commit/7c86754c6ea2d42e074a80a79418cdef65489980))
* release workflow tag pattern matches subkit-v* prefix ([cb66e12](https://github.com/MikeBild/subkit/commit/cb66e12d9e1731157205df53940bba861e382efb))
* resolve all remaining medium + low severity review findings ([3396170](https://github.com/MikeBild/subkit/commit/33961706400956b369a6f934c46e07bf5e7c330b))
* resolve CI lint failures and enable GitHub Actions PR permissions ([a9a1ee6](https://github.com/MikeBild/subkit/commit/a9a1ee6769c84bacef470ac2bc691f1dad5046e3))
* runtime failures + add tests for 0-coverage phases ([28faf45](https://github.com/MikeBild/subkit/commit/28faf45e89eadf5d76a7b66f49948561b35a9cfb))
* split CI tests — run unit/integration before build, e2e after ([1a53ef0](https://github.com/MikeBild/subkit/commit/1a53ef0f4f22809b67f058fc4efdcf623e1ce68b))


### Documentation

* add agent-facing guidance for Claude Code ([55bd3cd](https://github.com/MikeBild/subkit/commit/55bd3cdb02382911a77f0a9b2c347901994c8de2))
* full documentation overhaul — problem-led README, mermaid-first format, missing features ([dfdc0c1](https://github.com/MikeBild/subkit/commit/dfdc0c16c6755472c935a2d932e18b763c3539e4))


### Miscellaneous

* **main:** release subkit 1.0.0 ([#1](https://github.com/MikeBild/subkit/issues/1)) ([62ca88c](https://github.com/MikeBild/subkit/commit/62ca88ca647ba4446e9cb983e541561c687b4377))
* **main:** release subkit 1.1.0 ([#2](https://github.com/MikeBild/subkit/issues/2)) ([f5c3d90](https://github.com/MikeBild/subkit/commit/f5c3d900f6046f47e8911406bb4448425a515bbe))
* **main:** release subkit 1.1.1 ([#3](https://github.com/MikeBild/subkit/issues/3)) ([6cc6c69](https://github.com/MikeBild/subkit/commit/6cc6c6946f6f686972b12d4ae0ac98d88b0fd417))
* **main:** release subkit 1.2.0 ([#4](https://github.com/MikeBild/subkit/issues/4)) ([cd1d75b](https://github.com/MikeBild/subkit/commit/cd1d75bff2f6b9f9796bfdded1eb5d0932b61079))
* remove unused skillEffectiveness import ([b138ea2](https://github.com/MikeBild/subkit/commit/b138ea2fd87c1a5a57b346fd653260059fd05e44))
* resolve all biome lint warnings ([97d6865](https://github.com/MikeBild/subkit/commit/97d6865ad1d3401d374827775ee6f19b2f352a18))

## [1.2.0](https://github.com/MikeBild/subkit/compare/subkit-v1.1.1...subkit-v1.2.0) (2026-04-17)


### Features

* **cli:** skills delete, --show-source, scaffolders, persona docs ([aa7a0a4](https://github.com/MikeBild/subkit/commit/aa7a0a44c6b324f05bac3129fee10b645127a61a))
* **engine:** shared schema spine + observability + audit coverage ([603c7ec](https://github.com/MikeBild/subkit/commit/603c7ecdeb2a02c4f2a84170c90e469500e82fcf))


### Bug Fixes

* **chat:** avoid double rate-limit on notifications dispatch path ([9eb5dae](https://github.com/MikeBild/subkit/commit/9eb5dae57fdc00702858cd9ed1e2d82ded0e0ee3))
* **db:** idempotent migrations + hash-first runner ([22bdc44](https://github.com/MikeBild/subkit/commit/22bdc4461c731c21955aa83995f2e86d0fa2273d))


### Documentation

* add agent-facing guidance for Claude Code ([55bd3cd](https://github.com/MikeBild/subkit/commit/55bd3cdb02382911a77f0a9b2c347901994c8de2))


### Miscellaneous

* resolve all biome lint warnings ([97d6865](https://github.com/MikeBild/subkit/commit/97d6865ad1d3401d374827775ee6f19b2f352a18))

## [1.1.1](https://github.com/MikeBild/subkit/compare/subkit-v1.1.0...subkit-v1.1.1) (2026-04-16)


### Bug Fixes

* register knowledge.ingest and skill-candidate.analyze queues ([e49d1ab](https://github.com/MikeBild/subkit/commit/e49d1ab9b77538d999463249efbda12ed3e0e1de))


### Documentation

* full documentation overhaul — problem-led README, mermaid-first format, missing features ([dfdc0c1](https://github.com/MikeBild/subkit/commit/dfdc0c16c6755472c935a2d932e18b763c3539e4))

## [1.1.0](https://github.com/MikeBild/subkit/compare/subkit-v1.0.0...subkit-v1.1.0) (2026-04-16)


### Features

* CLI commands, MCP resources, scheduler, edge case + journey tests ([a944ba8](https://github.com/MikeBild/subkit/commit/a944ba88f2cc5cbf933dff32d422f2e8ddd942e6))
* expand connector template catalog to 89 production-quality templates ([ae257d5](https://github.com/MikeBild/subkit/commit/ae257d5bf7155e87328cefba5165cffc3c93661f))
* H2 Knowledge Sources, H2.5 Discovery, H3 Self-Improving Skills ([249320c](https://github.com/MikeBild/subkit/commit/249320c8a2566fcd309987dc06fbcf687ba4de17))


### Bug Fixes

* address code review findings — discovery routes, validation, budgets ([3a74d5c](https://github.com/MikeBild/subkit/commit/3a74d5c89126a5010417def91d28760297fdcb58))
* make URL reachability tests opt-in (CHECK_URLS=1) ([e1b2747](https://github.com/MikeBild/subkit/commit/e1b2747bc1073e826c9d6b0290a1b3d865b72562))
* migration 0022 — incremental ALTER TABLE only ([255a9b4](https://github.com/MikeBild/subkit/commit/255a9b4e4a8832c828db57a0336212b24e5c6745))
* resolve all remaining medium + low severity review findings ([3396170](https://github.com/MikeBild/subkit/commit/33961706400956b369a6f934c46e07bf5e7c330b))
* runtime failures + add tests for 0-coverage phases ([28faf45](https://github.com/MikeBild/subkit/commit/28faf45e89eadf5d76a7b66f49948561b35a9cfb))


### Miscellaneous

* remove unused skillEffectiveness import ([b138ea2](https://github.com/MikeBild/subkit/commit/b138ea2fd87c1a5a57b346fd653260059fd05e44))

## 1.0.0 (2026-04-16)


### Features

* initial commit — subkit workflow engine ([befda15](https://github.com/MikeBild/subkit/commit/befda15e261f74bf0efe64e069522c9c89912182))
* OTA auto-update system for all binaries with comprehensive tests ([a019f26](https://github.com/MikeBild/subkit/commit/a019f2605767c78a18a8c93956e486ce9f02f67d))


### Bug Fixes

* harden install.sh — function wrap, retry, validation ([9d01385](https://github.com/MikeBild/subkit/commit/9d013855684cec17fae6fb48b4d1c828a2730010))
* profile slash handler uses injected config path in tests ([2af5ab2](https://github.com/MikeBild/subkit/commit/2af5ab296703579b11b12434307800f906926604))
* resolve CI lint failures and enable GitHub Actions PR permissions ([a9a1ee6](https://github.com/MikeBild/subkit/commit/a9a1ee6769c84bacef470ac2bc691f1dad5046e3))
* split CI tests — run unit/integration before build, e2e after ([1a53ef0](https://github.com/MikeBild/subkit/commit/1a53ef0f4f22809b67f058fc4efdcf623e1ce68b))
