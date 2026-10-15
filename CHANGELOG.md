# Changelog

## 2.7.2
- **TensorFlow.js 4.22 in Jade's scripts**: `tf` and `require('@tensorflow/tfjs')` in `node` (shell, flow JavaScript steps,
  Jade's bash). Embedded (no download), unpacked only for scripts that use it. GPU (WebGL) when it works in the WebView's
  worker, otherwise the CPU backend, with TensorFlow's own probing messages kept out of the output. Models persist with
  `indexeddb://`. Not loaded into note scripts.
- node scripts understand `import * as x from '…'`, `import x from '@scope/pkg'` and side-effect imports.

## 2.7.1
- **Reply bar** under each of Jade's replies: **Copy** (everything she said in that turn, as Markdown, without tool
  output), **👍 / 👎** (now always there, not only with the trajectory log on) and **Retry** on the newest reply, which
  runs your last message again and replaces her answer (also after an error).

## 2.7.0
- **Flows**, a small n8n in its own tab: steps of Jade's tools, JavaScript, shell commands, Ollaya decisions, AI answers,
  full Jade chat turns, notes, if / switch / for-each, wait, notify and other flows, with `{{ expressions }}`, retries,
  continue-on-error and a step-by-step run log. Triggers: by hand, schedule, note or folder change. Run them from the
  shell (`flow run`), from scripts (`jade.flow`), from schedules and crontab, over the API (`/v1/flows`, `/v1/flow`), and
  Jade builds and runs them with her new `flow` tool. Kept as JSON in `/Jade/Flows`.
- **Scripting Jade**: `jade.tool()`, `jade.decide()` (structured Ollaya decisions), `jade.ask()`, `jade.agent()`,
  `jade.flow()`, `jade.shell()`, `jade.notify()` and `jade.kv` in the shell's `node`; `jade` and `flow` shell commands.
- **Schedules run shell commands and flows** (Schedule tab, the schedule tool, and a new `crontab` command with crontab
  files and `@daily` macros). They run on their own, log to `/Jade/Logs/cron.log` and notify you on failure.
- **Note scripts & templates** (Obsidian style): live `dataviewjs` / `jade-js` blocks and inline `$=` values with a
  Dataview-like `dv`, and Templater templates (`<% tp.date.now() %>`, `<%* %>`, prompts, includes, cursor) inserted with
  the { } button. Sandboxed: no network, no file changes, tools only if you allow them.
- Fix: a BusyBox command no longer undoes files written while it ran (it replaced the whole vault with its starting copy).
- Fix: notes written and opened at once are already in the link/tag index.
- The bottom bar has seven tabs; settings gain a "Note scripts & templates" section (Tools).

## 2.6.0
- **HTTP API (Android app).** Jade listens on a port you choose and answers GET requests with JSON. A message sent
  to `/v1/chat?message=...` goes through the normal chat: it shows up in the app and she answers there, and the reply
  comes back as JSON (`reply`, `session`, `tool_calls`, `model`, `elapsed_ms`, `error`). Also `/v1/status`, `/v1/history`,
  `/v1/chats` and a public `/v1/health`. Token required on every call (`Authorization: Bearer` or `?token=`); off by
  default; local only unless you allow your Wi-Fi. Input can also be one JSON object (`?json={...}`). Keeps the app
  alive in the background while on. Settings → Connect.
- **Memory retrieval with BM25.** Optional: only the memory lines that match your recent messages go into the system
  prompt (Okapi BM25, top-k adjustable). Off by default.
- **Settings are split into tabs** (Model, Memory, Tools, Connect, App) with a search box, and Save stays in view.
- Python: a corrupt or empty cached MicroPython runtime is detected and downloaded again.
- Browser build for GitHub Pages in `docs/`.

## 2.5.0
- **Jade on Vector messenger.** She runs as a Vector bot through the new Jade Vector bridge (Vector's own
  `vector-agent` plus a token-protected HTTP bridge; macOS, Linux or Docker).
  - Answers DMs and whitelisted channels: always, or only when named or replied to. Trigger words are configurable.
  - Owner / admin / public permission tiers. Each Vector chat gets its own chat in the app.
  - Reactions, typing indicator, threaded replies, files both ways; she sees the images people send.
  - Joins and leaves communities. Invites from you or admins are accepted automatically.
  - Plays Mini Apps shared on Vector, woken by new moves.
  - Secretary: `notify_owner` files messages in `/Jade/Vector Inbox.md`, or tells you at once (DM + notification), per setting.
  - `vector` tool for any task in the app: message, send a file, react, read chats, moderate, run any vector-agent tool.
- Chats save before the app switches between them (a background turn could lose the last message).
- Going back to the chat you were in after a background turn now works for a new, still-empty chat.
- Production repo: reproducible web build, APK build without the Android SDK (hash-pinned tools), test runner, CI, Docker image for the bridge.

## 2.4.0
- **Jade Link**, a built-in webxdc app: messenger plus shared board. Messages addressed to Jade (webxdc `notify`) wake her in the app's own chat; live "thinking" status over the realtime channel.
- Updates delivered to apps carry `sender` and `timestamp`.

## 2.3.0
- `http_request` tool (any method, JSON/form bodies, binary responses saved to the vault) with Config → Secrets (`{{NAME}}`).
- Node gets `fetch`, `https`/`http`, `Buffer`, and `process.env` secrets.
- Images in notes and chat (`![[img.png|300]]`, `![alt](path)`, note embeds, insert/paste with downscaling, full-screen view).
- Webxdc apps: Apps tab, `.xdc` install, sandboxed offline runtime, `apps` tool for Jade (read, send, open, build and install apps).

## 2.2.0
- Timestamps on every message; Jade gets the local date, time zone and each message's send time.
- Trajectory logger: every run, as the model saw it, exportable as JSONL (OpenAI chat with tools, or ShareGPT), filtered by 👍/👎.

## 2.1.0
- Context guard: requests are measured before sending, compacted or trimmed to fit, "prompt is too long" errors are learned and retried; `/context` shows what fills the window.

## 2.0.0
- SQLite 3.53 built in (WebAssembly): `sqlite3` shell, `node:sqlite` / `better-sqlite3` in node, `sqlite3` in Python.

## 1.x
- Jade Vault: Obsidian-style markdown vault (links, backlinks, graph, tags, KaTeX) on the pi-agent harness (Live2D Jade, BusyBox WebAssembly shell, Ollama).
- Long-term memory and journal, SOUL.md / AGENTS.md / SYSTEM.md steering, skills.
- Providers: Ollama, Ollama Cloud, Groq, llama.cpp, OpenAI-compatible, with a fallback chain and a separate compaction model.
- Background mode (Android foreground service), heartbeat (HEARTBEAT.md), schedules, file attachments, MCP (pi-style codemode/deferred/direct), MicroPython, JSON export of everything.
