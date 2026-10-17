#!/usr/bin/env python3
"""Jade Discord bridge: runs a Discord bot with discord.py and serves it over HTTP as an MCP server, with a bearer
token, so Jade Vault (phone or browser) can be that bot. Runs next to the Jade Vector bridge (own port, own token).

    python3 jade_discord_bridge.py [--port 8788] [--host 0.0.0.0]

First run creates ~/.jade-discord/ with:
    token       the password Jade Vault sends (Config -> Discord -> Bridge token)
    bot_token   your Discord bot's token (made by:  python3 jade_discord_bridge.py --set-token)

Needs:  pip install discord.py        (Python 3.9+; on 3.13 pip also installs audioop-lts)
The bridge itself uses only the standard library besides discord.py.

What it does: keeps the bot online (discord.py handles the Gateway, resume and reconnects), queues the messages the
bot may care about (DMs, and messages in servers; never bots), and exposes tools to send, reply, react, edit, delete, read
history, send and download files, list servers/channels, look people up, and moderate. It never pings @everyone, @here or
roles. Jade Vault decides who gets an answer.
"""
import argparse, asyncio, base64, collections, getpass, hmac, http.server, io, json, os, pathlib, secrets, signal, socketserver, ssl, sys, threading, time

HOME = pathlib.Path(os.environ.get('JADE_DISCORD_HOME', pathlib.Path.home() / '.jade-discord'))
MAX_BODY = 48 * 1024 * 1024
PROTOCOL = '2025-06-18'
MAX_FILE = 25 * 1024 * 1024


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


def read_secret(path, make):
    if path.exists():
        return path.read_text().strip()
    v = make()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(v + '\n')
    os.chmod(path, 0o600)
    return v


def chunks(text, limit=1900):
    """A message of any length, split at line breaks (then spaces) under Discord's 2000-character limit."""
    out = []
    t = (text or '').strip()
    while len(t) > limit:
        i = t.rfind('\n', 0, limit)
        if i < limit // 2:
            i = t.rfind(' ', 0, limit)
        if i < limit // 2:
            i = limit
        out.append(t[:i].strip())
        t = t[i:].strip()
    if t:
        out.append(t)
    return out


# ---------- the bot (discord.py) ----------
class Bridge:
    def __init__(self, bot_token, max_age=600, queue_max=500):
        import discord  # imported here so --help and --set-token work without it
        self.discord = discord
        self.token = bot_token
        self.max_age = max_age
        self.queue = collections.deque(maxlen=queue_max)
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.loop = asyncio.new_event_loop()
        self.client = None
        self.content_intent = True
        self.warn = ''
        self.error = ''
        self.stopping = False
        self.user = None

    # --- lifecycle
    def start(self):
        threading.Thread(target=self._thread, daemon=True).start()

    def _thread(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._main())

    def _make_client(self):
        discord = self.discord
        bridge = self
        intents = discord.Intents.default()          # guilds, guild messages, DMs, reactions, typing...
        intents.message_content = self.content_intent  # privileged: switch it on under Bot -> Privileged Gateway Intents
        intents.typing = False
        intents.presences = False

        class JadeClient(discord.Client):
            async def on_ready(self):
                bridge.user = self.user
                bridge.error = ''
                bridge.ready.set()
                log(f'online as {self.user} ({self.user.id}) in {len(self.guilds)} server(s)')

            async def on_disconnect(self):
                log('disconnected from the Gateway (discord.py reconnects)')

            async def on_message(self, message):
                bridge.enqueue(message)

        return JadeClient(intents=intents, allowed_mentions=discord.AllowedMentions.none(), max_messages=None)

    async def _main(self):
        discord = self.discord
        delay = 3
        while not self.stopping:
            self.client = self._make_client()
            try:
                await self.client.start(self.token)
                delay = 3
            except discord.LoginFailure:
                self.error = 'Discord rejected the bot token. Run: python3 jade_discord_bridge.py --set-token'
                log(self.error)
                return
            except discord.PrivilegedIntentsRequired:
                if self.content_intent:
                    self.content_intent = False
                    self.warn = ('Message Content Intent is off in the Developer Portal: the bot only sees DMs and messages that '
                                 '@mention it. Turn it on under Bot -> Privileged Gateway Intents.')
                    log(self.warn)
                    continue
                self.error = 'Discord refused the connection (privileged intents)'
                log(self.error)
                return
            except Exception as e:  # network down etc.: try again with a fresh client
                self.error = f'{type(e).__name__}: {e}'
                log('bot stopped:', self.error)
            finally:
                self.ready.clear()
                try:
                    await self.client.close()
                except Exception:
                    pass
            if self.stopping:
                return
            await asyncio.sleep(delay)
            delay = min(60, delay * 2)

    def stop(self):
        self.stopping = True
        try:
            if self.client:
                asyncio.run_coroutine_threadsafe(self.client.close(), self.loop).result(10)
        except Exception:
            pass

    # --- incoming
    def enqueue(self, m):
        d = self.discord
        if m.author.bot or (self.user and m.author.id == self.user.id):
            return
        if m.type not in (d.MessageType.default, d.MessageType.reply):
            return
        ref = None
        if m.reference and m.reference.resolved is not None and isinstance(m.reference.resolved, d.Message):
            r = m.reference.resolved
            ref = {'id': str(r.id), 'author_id': str(r.author.id), 'text': r.clean_content[:300]}
        elif m.reference and m.reference.message_id:
            ref = {'id': str(m.reference.message_id), 'author_id': '', 'text': ''}
        is_group = m.guild is not None
        item = {
            'id': str(m.id), 'chat_id': str(m.channel.id), 'guild_id': str(m.guild.id) if is_group else '', 'is_group': is_group,
            'channel': getattr(m.channel, 'name', '') or '', 'guild': m.guild.name if is_group else '',
            'author': {'id': str(m.author.id), 'name': getattr(m.author, 'display_name', None) or m.author.name, 'username': m.author.name},
            'text': m.clean_content, 'content': m.content, 'at': m.created_at.timestamp(),
            'mentions_me': bool(self.user and self.user in m.mentions), 'reply_to': ref,
            'attachments': [{'index': i, 'name': a.filename, 'content_type': a.content_type or '', 'size': a.size} for i, a in enumerate(m.attachments)],
        }
        with self.lock:
            self.queue.append(item)

    def drain(self):
        with self.lock:
            items = list(self.queue)
            self.queue.clear()
        cutoff = time.time() - self.max_age
        fresh = [i for i in items if i['at'] >= cutoff]
        if len(fresh) < len(items):
            log(f'dropped {len(items) - len(fresh)} message(s) older than {self.max_age} s')
        return fresh

    # --- tools (all run on the bot's event loop)
    def call(self, name, args, timeout=60):
        fn = getattr(self, 't_' + name, None)
        if not fn:
            raise ValueError(f'unknown tool {name}')
        if name not in ('status',) and not self.ready.wait(timeout=30):
            raise RuntimeError(self.error or 'the bot is not online yet (still connecting)')
        return asyncio.run_coroutine_threadsafe(fn(args or {}), self.loop).result(timeout)

    async def _user(self, uid):
        uid = int(uid)
        return self.client.get_user(uid) or await self.client.fetch_user(uid)

    async def _channel(self, a):
        if a.get('user_id'):
            return await (await self._user(a['user_id'])).create_dm()
        cid = int(a.get('chat_id') or 0)
        if not cid:
            raise ValueError('chat_id (or user_id) is required')
        return self.client.get_channel(cid) or await self.client.fetch_channel(cid)

    async def _guild(self, a):
        g = self.client.get_guild(int(a.get('guild_id') or 0))
        if not g:
            raise ValueError('unknown server: guild_id (list_guilds shows the servers the bot is in)')
        return g

    async def t_status(self, a):
        u = self.user
        return {'ready': self.ready.is_set(), 'user': {'id': str(u.id), 'username': u.name} if u else None, 'warn': self.warn, 'error': self.error,
                'content_intent': self.content_intent, 'guilds': len(self.client.guilds) if self.client else 0}

    async def t_my_user(self, a):
        return await self.t_status(a)

    async def t_get_new_messages(self, a):
        return self.drain()

    async def t_send_message(self, a):
        d = self.discord
        ch = await self._channel(a)
        parts = chunks(str(a.get('content') or ''))
        if not parts:
            raise ValueError('content is empty')
        last = None
        for i, p in enumerate(parts):
            ref = None
            if i == 0 and a.get('replied_to'):
                ref = d.MessageReference(message_id=int(a['replied_to']), channel_id=ch.id, fail_if_not_exists=False)
            last = await ch.send(p, reference=ref, mention_author=False, allowed_mentions=d.AllowedMentions.none())
        return {'chat_id': str(ch.id), 'message_id': str(last.id), 'parts': len(parts)}

    async def t_send_typing(self, a):
        ch = await self._channel(a)
        await self.client.http.send_typing(ch.id)
        return 'ok'

    async def t_react(self, a):
        ch = await self._channel(a)
        m = await ch.fetch_message(int(a['message_id']))
        await m.add_reaction(str(a.get('emoji') or '👍'))
        return 'ok'

    async def t_edit_message(self, a):
        d = self.discord
        ch = await self._channel(a)
        m = await ch.fetch_message(int(a['message_id']))
        await m.edit(content=str(a.get('content') or '')[:2000], allowed_mentions=d.AllowedMentions.none())
        return 'ok'

    async def t_delete_message(self, a):
        ch = await self._channel(a)
        m = await ch.fetch_message(int(a['message_id']))
        await m.delete()
        return 'ok'

    async def t_get_messages(self, a):
        ch = await self._channel(a)
        out = []
        async for m in ch.history(limit=max(1, min(int(a.get('limit') or 20), 100))):
            out.append({'id': str(m.id), 'at': m.created_at.timestamp(), 'mine': bool(self.user and m.author.id == self.user.id),
                        'author': {'id': str(m.author.id), 'name': getattr(m.author, 'display_name', None) or m.author.name},
                        'text': m.clean_content, 'reply_to': str(m.reference.message_id) if m.reference and m.reference.message_id else '',
                        'attachments': [{'index': i, 'name': x.filename} for i, x in enumerate(m.attachments)],
                        'reactions': [{'emoji': str(r.emoji), 'count': r.count} for r in m.reactions]})
        out.reverse()
        return out

    async def t_send_file_bytes(self, a):
        d = self.discord
        ch = await self._channel(a)
        data = base64.b64decode(a.get('base64') or '')
        if len(data) > MAX_FILE:
            raise ValueError('files over 25 MB are not sent')
        name = os.path.basename(str(a.get('name') or 'file')) or 'file'
        m = await ch.send(str(a.get('content') or '')[:2000] or None, file=d.File(io.BytesIO(data), filename=name), allowed_mentions=d.AllowedMentions.none())
        return {'chat_id': str(ch.id), 'message_id': str(m.id)}

    async def t_download_attachment(self, a):
        ch = await self._channel(a)
        m = await ch.fetch_message(int(a['message_id']))
        i = int(a.get('index') or 0)
        if i < 0 or i >= len(m.attachments):
            raise ValueError('that message has no such attachment')
        att = m.attachments[i]
        if att.size > int(float(a.get('max_mb') or 25) * 1048576):
            raise ValueError(f'the attachment is {att.size // 1024} KB, over the limit')
        data = await att.read()
        return {'name': att.filename, 'size': len(data), 'content_type': att.content_type or '', 'base64': base64.b64encode(data).decode()}

    async def t_get_user(self, a):
        u = await self._user(a['user_id'])
        return {'id': str(u.id), 'username': u.name, 'global_name': getattr(u, 'global_name', None), 'bot': u.bot}

    async def t_list_guilds(self, a):
        return [{'id': str(g.id), 'name': g.name, 'members': g.member_count} for g in self.client.guilds]

    async def t_list_channels(self, a):
        g = await self._guild(a)
        return [{'id': str(c.id), 'name': c.name, 'type': str(c.type)} for c in g.channels if getattr(c, 'send', None) or c.type.name in ('forum',)]

    async def t_list_members(self, a):
        g = await self._guild(a)
        out = []
        try:
            async for m in g.fetch_members(limit=max(1, min(int(a.get('limit') or 50), 200))):
                out.append({'id': str(m.id), 'name': m.display_name, 'bot': m.bot})
        except Exception as e:  # needs the Server Members Intent
            raise RuntimeError(f'cannot list members ({e}). Turn on Server Members Intent in the Developer Portal and in the bridge.')
        return out

    async def t_kick(self, a):
        g = await self._guild(a)
        await g.kick(self.discord.Object(id=int(a['user_id'])), reason=str(a.get('reason') or 'Jade'))
        return 'ok'

    async def t_ban(self, a):
        g = await self._guild(a)
        await g.ban(self.discord.Object(id=int(a['user_id'])), reason=str(a.get('reason') or 'Jade'))
        return 'ok'

    async def t_unban(self, a):
        g = await self._guild(a)
        await g.unban(self.discord.Object(id=int(a['user_id'])), reason=str(a.get('reason') or 'Jade'))
        return 'ok'

    async def t_leave_guild(self, a):
        g = await self._guild(a)
        await g.leave()
        return 'ok'


TOOLS = {
    'status': 'Is the bot online? Returns the bot user, warnings and server count.',
    'my_user': 'The bot account (id, username).',
    'get_new_messages': 'Messages the bot received since the last call (DMs and server messages, never from bots). Each: id, chat_id, guild_id, is_group, text, author, mentions_me, reply_to, attachments.',
    'send_message': 'Send text to chat_id (a channel) or user_id (a DM). content is split under 2000 characters; replied_to makes the first part a reply. Never pings @everyone/@here/roles.',
    'send_typing': 'Show the typing indicator in chat_id / user_id.',
    'react': 'Add an emoji reaction to message_id.',
    'edit_message': "Edit one of the bot's messages.",
    'delete_message': 'Delete message_id (the bot\'s own, or any if it has Manage Messages).',
    'get_messages': 'Recent messages of a chat, oldest first.',
    'send_file_bytes': 'Upload a file (base64) to a chat.',
    'download_attachment': 'Download attachment index of message_id as base64.',
    'get_user': 'Look a user up by id.',
    'list_guilds': 'Servers the bot is in.',
    'list_channels': "A server's channels.",
    'list_members': "A server's members (needs the Server Members Intent).",
    'kick': 'Kick user_id from guild_id.',
    'ban': 'Ban user_id from guild_id.',
    'unban': 'Unban user_id from guild_id.',
    'leave_guild': 'Leave guild_id.',
}
TOOL_DEFS = [{'name': n, 'description': d, 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': True}} for n, d in TOOLS.items()]


# ---------- HTTP (MCP) ----------
def make_handler(bridge, token, origin):
    def ok_token(h):
        got = h.headers.get('Authorization', '')
        return got.startswith('Bearer ') and hmac.compare_digest(got[7:].strip().encode(), token.encode())

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'JadeDiscordBridge/1.0'

        def log_message(self, fmt, *a):
            pass

        def _cors(self):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Headers', 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version')
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS')
            self.send_header('Access-Control-Expose-Headers', 'mcp-session-id')
            self.send_header('Access-Control-Max-Age', '600')

        def _send(self, code, obj=None, extra=None):
            body = b'' if obj is None else json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self._cors()
            if obj is not None:
                self.send_header('Content-Type', 'application/json')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _deny(self):
            time.sleep(0.5)  # slows down guessing; the token itself is 192 random bits
            self._send(401, {'error': 'missing or wrong bridge token'})

        def do_OPTIONS(self):
            self._send(204)

        def do_GET(self):
            p = self.path.split('?')[0]
            if p in ('/', '/health'):
                if not ok_token(self):
                    return self._deny()
                u = bridge.user
                return self._send(200, {'ok': True, 'ready': bridge.ready.is_set(), 'user': u.name if u else None, 'warn': bridge.warn, 'error': bridge.error})
            if p == '/mcp':
                return self._send(405, {'error': 'use POST'}, {'Allow': 'POST, DELETE'})
            self._send(404, {'error': 'not found'})

        def do_DELETE(self):
            n = int(self.headers.get('Content-Length') or 0)
            if 0 < n <= MAX_BODY:
                self.rfile.read(n)
            if not ok_token(self):
                return self._deny()
            self._send(200, {})

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                self.close_connection = True
                return self._send(413, {'error': 'request too large'})
            if self.path.split('?')[0] != '/mcp' or not ok_token(self):
                if n:
                    self.rfile.read(n)
                if self.path.split('?')[0] != '/mcp':
                    return self._send(404, {'error': 'not found'})
                return self._deny()
            try:
                req = json.loads(self.rfile.read(n) or b'null')
            except Exception:
                return self._send(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
            batch = req if isinstance(req, list) else [req]
            out = []
            for m in batch:
                if not isinstance(m, dict):
                    continue
                method, mid = m.get('method'), m.get('id')
                if mid is None:
                    continue  # notifications need no answer
                if method == 'initialize':
                    out.append({'jsonrpc': '2.0', 'id': mid, 'result': {'protocolVersion': PROTOCOL, 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'jade-discord-bridge', 'version': '1.0'},
                                                                         'instructions': 'A Discord bot served by the Jade Discord bridge.'}})
                elif method == 'ping':
                    out.append({'jsonrpc': '2.0', 'id': mid, 'result': {}})
                elif method == 'tools/list':
                    out.append({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': TOOL_DEFS}})
                elif method == 'tools/call':
                    p = m.get('params') or {}
                    try:
                        res = bridge.call(p.get('name'), p.get('arguments') or {}, timeout=240 if p.get('name') in ('send_file_bytes', 'download_attachment') else 60)
                        text = res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)
                        out.append({'jsonrpc': '2.0', 'id': mid, 'result': {'content': [{'type': 'text', 'text': text}]}})
                    except Exception as e:
                        msg = str(e) or type(e).__name__
                        out.append({'jsonrpc': '2.0', 'id': mid, 'result': {'isError': True, 'content': [{'type': 'text', 'text': msg}]}})
                else:
                    out.append({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'method not found: {method}'}})
            if not out:
                return self._send(202)
            self._send(200, out if isinstance(req, list) else out[0], {'Mcp-Session-Id': 'jade-discord'})

    return H


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="Serve a Discord bot (discord.py) to Jade Vault over HTTP.")
    ap.add_argument('--host', default=os.environ.get('JADE_DISCORD_HOST', '0.0.0.0'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('JADE_DISCORD_PORT', '8788')))
    ap.add_argument('--bot-token-file', default=None, help="file holding the bot's token (default ~/.jade-discord/bot_token, or env DISCORD_BOT_TOKEN)")
    ap.add_argument('--set-token', action='store_true', help="ask for the bot's token and store it, then exit")
    ap.add_argument('--max-age', type=int, default=int(os.environ.get('JADE_DISCORD_MAX_AGE', '600')), help='drop queued messages older than this many seconds (default 600)')
    ap.add_argument('--allow-origin', default='*', help='CORS origin for browser use (default *)')
    ap.add_argument('--tls-cert', default=os.environ.get('JADE_DISCORD_TLS_CERT'), help='serve HTTPS with this certificate (PEM); use with --tls-key')
    ap.add_argument('--tls-key', default=os.environ.get('JADE_DISCORD_TLS_KEY'), help='private key (PEM) for --tls-cert')
    ap.add_argument('--print-token', action='store_true', help='print the bridge token and exit')
    ap.add_argument('--new-token', action='store_true', help='make a new bridge token (the old one stops working)')
    args = ap.parse_args()
    import logging
    logging.basicConfig(level=logging.WARNING, format='%(asctime)s %(name)s %(message)s', datefmt='%H:%M:%S')

    HOME.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(HOME, 0o700)
    except OSError:
        pass
    bot_path = pathlib.Path(args.bot_token_file) if args.bot_token_file else HOME / 'bot_token'
    if args.set_token:
        t = getpass.getpass("Paste the bot token (Developer Portal -> your app -> Bot -> Reset Token): ").strip()
        if not t:
            sys.exit('no token entered')
        bot_path.write_text(t + '\n')
        os.chmod(bot_path, 0o600)
        print(f'saved to {bot_path}')
        return
    tok_path = HOME / 'token'
    if args.new_token and tok_path.exists():
        tok_path.unlink()
    token = read_secret(tok_path, lambda: secrets.token_urlsafe(24))
    if args.print_token:
        print(token)
        return
    bot_token = os.environ.get('DISCORD_BOT_TOKEN') or (bot_path.read_text().strip() if bot_path.exists() else '')
    if not bot_token:
        sys.exit(f'No bot token. Run:  python3 {sys.argv[0]} --set-token')
    try:
        import discord  # noqa: F401
    except ImportError:
        sys.exit('discord.py is not installed:  pip install discord.py')
    base = os.environ.get('JADE_DISCORD_TEST_API')  # tests only: point discord.py at a fake Discord
    if base:
        import discord.http
        import discord.gateway, yarl
        discord.http.Route.BASE = base.rstrip('/')
        discord.gateway.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(os.environ.get('JADE_DISCORD_TEST_GATEWAY', base.replace('http', 'ws').rsplit('/api', 1)[0] + '/gateway'))

    bridge = Bridge(bot_token, max_age=args.max_age)
    bridge.start()
    srv = Server((args.host, args.port), make_handler(bridge, token, args.allow_origin))
    scheme = 'http'
    if args.tls_cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(args.tls_cert, args.tls_key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = 'https'
    elif args.host not in ('127.0.0.1', 'localhost', '::1'):
        log('note: plain HTTP. Keep the bridge on a trusted network (home Wi-Fi, Tailscale/WireGuard) or add --tls-cert/--tls-key.')
    log(f'Jade Discord bridge on {scheme}://{args.host}:{args.port}/mcp')
    log(f'Bridge token: {token}   (Jade Vault -> Config -> Discord)')

    def stop(*_):
        bridge.stop()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    srv.serve_forever()


if __name__ == '__main__':
    main()
