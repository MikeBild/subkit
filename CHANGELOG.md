# Changelog

## [4.3.0] (unreleased)

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
