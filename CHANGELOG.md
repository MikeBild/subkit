# Changelog

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
