# Changelog

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
