# Jade Discord bridge

Puts Jade on **Discord** as a bot. The bot itself is a small [discord.py](https://discordpy.readthedocs.io)
program that keeps the Gateway connection (heartbeats, resume, reconnects, rate limits) and serves
the bot over HTTP as an MCP server with a bearer token, so the Jade Vault app (phone or browser) can
reach it. It is the twin of the [Jade Vector bridge](../jade-vector/README.md) and **runs at the same
time**: each has its own port and token, and in the app both share one conversation queue, so Jade
never answers two chats at once.

- `jade_discord_bridge.py`: the bot and the HTTP bridge (discord.py plus the Python standard library).
- `setup.sh` (macOS, Linux), `Dockerfile`, `docker-compose.yml`.
- `test/fake_discord.py`: a fake Discord (REST and Gateway) used by the test suite with the real discord.py.

Jade's brain stays in the app: the bridge only carries messages. Keep the app running (Android:
Config → Background mode) for her to answer; the bridge keeps the bot online and queues what
arrives in between (messages older than 10 minutes are dropped, so she does not answer yesterday's chat).

```
 phone / browser                      computer that stays on
┌──────────────────┐   HTTP + token   ┌──────────────────────────┐   Discord Gateway
│ Jade Vault       │ ───────────────▶ │ jade_discord_bridge.py   │   and REST API
│ (model, tools,   │ ◀─────────────── │   └─ discord.py bot      │ ◀──────────────▶ Discord
│  triggers, roles)│                  └──────────────────────────┘
└──────────────────┘
```

## 1. Make the bot

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
2. **Reset Token** and copy it (you will give it to the bridge, never to the app).
3. Under **Privileged Gateway Intents** switch on **Message Content Intent**. Without it the bot only sees
   DMs and messages that @mention it (the bridge tells the app so, and carries on).
4. Add her to your server: in Jade Vault → Config → Discord, after connecting, **Copy invite link** and open it.

## 2. Install the bridge

### macOS or Linux

```sh
cd jade-discord
./setup.sh
```

It creates a virtualenv in `~/.jade-discord`, installs discord.py, asks for the bot token, and starts
the bridge as a service (launchd on macOS, a systemd user service on Linux). It prints the **Bridge URL**
and the **Bridge token**.

- `./setup.sh --no-service` installs only; run `~/.jade-discord/run.sh` yourself.
- `./setup.sh --uninstall` removes the service and keeps your tokens.

### By hand

```sh
pip install -r requirements.txt            # discord.py (Python 3.9+; 3.13 also needs audioop-lts, listed)
python3 jade_discord_bridge.py --set-token # stores the bot token in ~/.jade-discord/bot_token (mode 600)
python3 jade_discord_bridge.py             # serves http://0.0.0.0:8788/mcp, prints the bridge token
```

### Docker

```sh
cd jade-discord
docker compose run --rm jade-discord --set-token     # once: stores the bot token in the data volume
docker compose up -d --build
docker compose logs | grep "Bridge token"
```

Or skip `--set-token` and set `DISCORD_BOT_TOKEN` in `docker-compose.yml`.

## 3. Connect Jade Vault

Config → **Discord (Jade as a bot)**: paste the **Bridge URL** (for example `http://192.168.1.20:8788/mcp`)
and the **Bridge token**, put your own Discord user id as **Owner** (Developer Mode → right-click yourself →
Copy User ID), switch **Run Jade on Discord** on. Then choose who may DM her, which channels she takes part in
(ids, `#names` or server names), the trigger words, and what happens to messages for you.

You (the owner) get the same Jade as in the app, with every tool. Admins get Discord powers (message people,
kick, ban, leave servers) but never your notes, memory or files. Everyone else can chat and leave you messages.

## Safety

- The bridge's token is 192 random bits; every request needs it (`Authorization: Bearer …`). Wrong tokens get a
  401 after a short delay. `--new-token` replaces it.
- The bridge speaks plain HTTP. Keep it on a trusted network (home Wi-Fi, Tailscale or WireGuard), or serve HTTPS
  with `--tls-cert` and `--tls-key`.
- Every message the bridge sends has empty `allowed_mentions`: Jade can never ping @everyone, @here or roles.
- Bots are never queued, so two bots cannot talk each other into a loop.
- The bot token never leaves the bridge's computer, and the app leaves the bridge token out of backups.

## Tools

`status`, `my_user`, `get_new_messages`, `send_message` (channel or DM, replies, long text split under 2000
characters), `send_typing`, `react`, `edit_message`, `delete_message`, `get_messages`, `send_file_bytes`,
`download_attachment`, `get_user`, `list_guilds`, `list_channels`, `list_members` (needs the Server Members
Intent), `kick`, `ban`, `unban`, `leave_guild`.

## Options

`--port` (8788), `--host` (0.0.0.0), `--max-age` seconds a queued message stays valid (600), `--allow-origin`
(CORS, default `*`), `--tls-cert/--tls-key`, `--print-token`, `--new-token`, `--set-token`,
`--bot-token-file`. Environment: `JADE_DISCORD_HOME`, `JADE_DISCORD_PORT`, `DISCORD_BOT_TOKEN`.

## Tests

`npm test` runs `tests/discord_test.mjs`: the real bridge with the real discord.py against `test/fake_discord.py`,
together with the Vector bridge and a scripted model (roles, scopes, triggers, chunking, resume, the Message
Content fallback, one shared queue). It needs `pip install discord.py`.
