# Changelog

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
