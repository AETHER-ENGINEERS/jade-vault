# Prompt: build your own harness for Jade Vault

Paste everything below the line into Claude Code (or any coding agent) opened in the unzipped `jade-vault/` folder.

---

You are working in the Jade Vault repository: a mobile, Obsidian-style markdown vault with an AI agent ("Jade") that runs
in a WebView, packaged as an Android APK. Read `README.md`, `docs/development.md` and `docs/README-docs.md` first.

## What I want
Build my own **agent harness** on top of this project: the loop around the model that gives it tools, verification,
memory and a way to improve. Start from what exists and extend it; do not rewrite it.

Reference designs already in the repo:
- `docs/design-tree-of-thoughts.md`: a verified tree-of-thoughts tool (verifier tiers, scoring, budgets, credit
  assignment, an improvement loop, and a learned-harness plan: problem typing, value model, bandit, PPO controller).
- `app/modules/think_tool.js`: the in-app `think` tool. `app/vault/think_cli.js` + `scripts/build-think-vault.py`: the same
  engine as a vault script that works with no app update (output in `dist/think-vault/`).
- Tools Jade can already use: files, shell, `node`, MicroPython, SQLite, web, MCP, flows, schedules, SSH, Sentry, memory.

## How the project is built (important, it is not a normal bundler app)
- `app/base/pi-netrunner-mobile.html` is the base page. `app/build.py` applies ordered exact-match string replacements
  and injects `app/modules/*.js`. Check `build.py` to see which fragment is actually inserted before editing anything.
  A replacement that does not match fails the build loudly; fix the pattern, never skip it.
- `npm install && npm run build` makes `dist/jade-vault.html` and `android/proj/assets/index.html`.
- `npm run build:apk` makes the APK. No Android SDK is needed (API stubs + dx + apktool). Needs JDK 17+, Node 20+,
  Python 3.9+. Without a release keystore it signs with a debug key (set `JADE_KEYSTORE`, `JADE_KEYSTORE_PASSWORD`,
  `JADE_KEY_ALIAS` for your own). Never commit a keystore.
- Tests: `node tests/run.mjs <suite>` (Playwright Chromium; `npm run test:quick` for a fast pass). A full run takes ~10
  minutes. Do not rebuild `dist` while it runs.

## How to work
1. Say what you will build in a few lines, then ask me ONLY the questions whose answers change the design (which model/endpoint
   I use, what tasks the harness is for, what counts as a correct result).
2. Start with a small vertical slice, with a real check that can say "no" (a test, a script that exits nonzero, a file that
   must exist), then widen. Trust a failed hard check over your own confidence.
3. Prefer features that live in the vault (a script under `/Jade/tools`, a skill under `/Jade/skills/<name>/SKILL.md`) when
   they do not need native code: no APK rebuild, easy to share. Use app modules only when the app itself must change.
4. Every feature gets a test in `tests/` registered in `tests/run.mjs`. Drive approval dialogs through the real
   `[role=alertdialog]` card; do not stub them.
5. Keep secrets out of anything Jade can read back (see `SECRET_KEYS` in `app/build.py`). Verifier tasks and held-out answers
   belong in UI-only settings so the agent cannot edit them.
6. Be honest in your reports: say what ran in the test browser and what has never run on a real phone. Do not commit or
   push unless I ask.

## First tasks
- Run `npm install && npm run build && npm run test:quick` and report the result.
- Read the design doc and tell me which of its phases (P0 to P5) I should do first for my use case, and why.
- Then build that slice end to end.
