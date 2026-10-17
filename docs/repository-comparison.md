# Documentation verification record: Jade Vault 2.8.0

**Jade Vault 2.8.0** · [Documentation index](README-docs.md)

## Baseline and scope

The full documentation set now targets **2.8.0**, not a 2.7.3 base with a Discord supplement. The reviewed source is commit [`cdf68ef883a3ebef81c4df6e1e9a51ad8248f629`](https://github.com/AETHER-ENGINEERS/jade-vault/tree/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629), which declares app version **2.8.0** and Android version code **22**.

At review time, this session branch's application checkout remained at `1dc8c3f928f5a0ce1c76ad50986ec7811f0c2141` (2.7.3/code 21). Remote `main` contained the reviewed 2.8.0 source. The source was fetched and extracted into an isolated scratch directory for verification; **no source merge or application changes were made in this branch**. Its checked-in `docs/index.html` is still the older generated app, not a newly deployed 2.8.0 page.

Build/install instructions assume a 2.8.0 source checkout or release installation. Documentation edits alone do not add Discord to an older source tree/APK. Relative source links in the guides open files on the current branch; the pinned references below identify the exact source reviewed, including files not yet present in this branch.

The initial source diff affected 24 tracked files. The APK assembly/signing script and web-build orchestration script did not change between the two snapshots, but version metadata, Discord integration, test setup, CI, and release artifacts did.

## Coverage review

All Markdown pages under `docs/` were reviewed for version consistency, wording, examples, and cross-links. The generated application HTML was not edited as documentation.

| Documentation | 2.8.0 review result |
| --- | --- |
| [Main index](README-docs.md) and [browser README](README.md) | Unified baseline, Discord/verification links, clear distinction between docs and hosted app |
| [Getting started](getting-started.md) | 2.8.0 installation prerequisite, optional Discord/Vector setup, local-data/network/background limits |
| [Configuration](configuration.md) | Existing providers/fallbacks retained; separate compaction model and both bridge credentials clarified |
| [Notes](notes.md) | Markdown/link/tag/search/graph/attachment behavior checked; pipe characters escaped in syntax tables |
| [Jade and memory](jade-and-memory.md) | BM25 enablement/defaults/fallback added; reply controls, context inspection, timestamps, SOUL visibility clarified |
| [Scripting](scripting.md) | Bridge APIs and worker limitations checked; Discord tool/role guards and pre-existing-flow requirement documented |
| [Note scripts/templates](note-scripts-and-templates.md) | Actual enablement label, frontmatter subset, permissions, examples, and side-effect warning checked |
| [Automation](automation.md) | Flow fields/limits/triggers checked; explicit save/run instruction and Discord Tool-step integration added |
| [MCP/HTTP](integrations.md) | Transports, exposure, secret syntax and limits checked; internal OPTIONS support distinguished from declared tool schema |
| [Apps](apps.md) | Update protocol, packaging, sandbox and separate storage limitations checked |
| [Vector](vector.md) | Shared scheduling with Discord, separate inboxes/ports, web-search scope and SOUL visibility clarified |
| [Discord](discord.md) | Normal baseline guide: setup, intent fallback, credentials, role/action restrictions, queue expiry, files, Docker and known limitations |
| [Android API](http-api.md) | GET-only routes/parameters/limits checked; no invented Discord route; token/timeout/retry caveats retained |
| [Backups](backup-and-storage.md) | Discord token exclusion, session/inbox/attachment coverage and separate bridge-state backup added; other coverage gaps retained |
| [Security](security-and-privacy.md) | Both bridges, numeric Discord IDs vs Vector npubs, non-owner web search, persona exposure and credential boundaries documented |
| [Troubleshooting](troubleshooting.md) | Discord version/intent/token/queue diagnostics and Python test dependencies added |
| [Development](development.md) | Discord module/bridge map, external virtualenv, 26-suite runner, CI and local-only Discord container publishing clarified |
| [APK builds](android-apk.md) | Version/code/artifact, Python test requirements, UI-vs-hosted-bridge distinction, signing/update instructions checked |
| [Deployment/releases](deployment-and-releases.md) | Discord release kit/checksums, CI requirements, and Vector-only GHCR workflow documented |
| This verification record | Previous gap report replaced by completed review scope and explicit verification limits |

## Important 2.8.0 behavior

- **Both messengers at once:** Vector and Discord use separate queues coordinated by busy checks; they wake one another and serialize agent turns rather than generating parallel conversations.
- **Separate services:** Discord's bridge defaults to 8788; Vector's bridge defaults to 8787. The Android inbound API also defaults to 8787 on the phone but is a different service with a different token/protocol.
- **Notifications:** `notify_owner` from a Discord chat uses the Discord inbox/policy, not Vector's inbox. Connected Discord also participates in Android background-mode decisions.
- **Tests:** the runner lists 26 suites, including `discord_test`. Discord tests require the Python requirements and use a fake Discord service with the real discord.py bridge; no real bot token is needed for that suite.
- **Release assets:** the release workflow adds `jade-discord-<version>.tar.gz` and its checksum. The unchanged GHCR publishing workflow still targets Vector, not Discord.
- **APK:** version 2.8.0/code 22 uses the existing APK build/signing process. Python Discord dependencies run on the bridge/test host; they are not an Android service bundled into the APK.

## Known implementation limits retained in the guides

These are not spelling errors or missing setup steps and should not be “fixed” by promising unsupported behavior:

1. **Discord member listing:** the bridge advertises it but does not enable `intents.members` or provide a corresponding CLI switch. Portal configuration alone may not enable the action.
2. **Backup exclusions:** `dcToken` is excluded with Include keys off, but inbound Android `apiToken` remains outside the known-secret exclusion list. Arbitrary note/config content is not sanitized.
3. **Separate data stores:** ordinary app backup does not dump trajectory, webxdc update-history, or TensorFlow.js model databases, nor separately hosted bridge state.
4. **Scoped prompts:** non-owner messenger tool access is restricted, but SOUL persona text can still appear in those prompts; it is not an owner-only place for private facts. The executable non-owner tool allowlists also include `web_search`.
5. **Background work:** Android foreground mode helps maintain uptime but does not guarantee every schedule/message is processed. Discord's bridge drops stale queued messages after 600 seconds by default.
6. **Script side effects:** live note scripts have direct network/file-write restrictions, but enabling their tool calls permits tools to produce network/file effects.

## Verification performed

- Read the 2.8.0 changelog and source diff, module implementations, native API/build code, bridge setup/requirements/Docker files, test runner, and CI/release workflows.
- Installed the declared npm dependencies and successfully ran **`npm run build` against an isolated copy of the exact 2.8.0 source**. This produced the browser HTML, Tailwind CSS, Jade Link package, and inlined Android page outside the working checkout.
- Checked the generated backup exclusion list, including `vecToken`, `aicKey`, and `dcToken`, and the absence of `apiToken` from that list.
- Validated the documented flow with 2.8.0's `flowValidate` and expression evaluator using synthetic input; its path and content resolve correctly.
- Executed the documented Dataview table and compiled/rendered the daily-note template with 2.8.0's template library and synthetic data/input, including date/title/prompt/cursor behavior.
- Checked all **21 Markdown pages**, **175 local links/anchors**, **35 pinned source links**, **33 table layouts**, and index coverage/whitespace. Syntax checks passed for **7 JSON**, **29 shell**, **6 JavaScript**, **1 Python**, and **1 Dataview JavaScript** code blocks.

**Not performed:** the full Playwright/integration suite, a signed APK build or Android device installation, live Discord/Vector account testing, or a production deployment. Source/example checks are not a claim that all runtime environments have been certified.

## Pinned evidence

- [Changelog](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/CHANGELOG.md), [VERSION](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/VERSION), [Android version code](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/android/VERSION_CODE), [package scripts/dependencies](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/package.json).
- [Build assembly/settings/backup patches](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/build.py), [APK builder](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/android/build-apk.sh), [web-build script](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/scripts/build-web.sh).
- [Memory and BM25](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/memory.js), [reply controls](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/replybar.js), [templates](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/templates.js), [flow engine](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/flows.js), [script bridge](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/bridge.js).
- [Discord connector/permissions](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/discord.js), [Discord bridge](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/jade-discord/jade_discord_bridge.py), [bridge README](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/jade-discord/README.md), [Vector connector](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/vector.js).
- [Android API](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/api.js), [native API server](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/android/src/app/netrunner/jade/ApiServer.java), [backup functions](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/extras.js), [webxdc storage](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/xdc.js), [trajectories](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/app/modules/traj.js).
- [Test runner](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/tests/run.mjs), [Discord tests](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/tests/discord_test.mjs), [CI](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/.github/workflows/ci.yml), [release workflow](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/.github/workflows/release.yml), [GHCR workflow](https://github.com/AETHER-ENGINEERS/jade-vault/blob/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629/.github/workflows/docker.yml).
