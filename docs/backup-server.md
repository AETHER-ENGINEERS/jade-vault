# Scheduled backup to your own server

Jade Vault can upload a backup of the vault on a schedule to a small server you run. The server is `server/jade-backup-server.py` (Python 3.9+, standard library only).

## Set up the server

1. Copy `jade-backup-server.py` to a machine that is always on (a Raspberry Pi, a NAS, a spare PC).
2. `python3 jade-backup-server.py --init` makes `jade-backup.token` (a long random token) and the `backups/` folder.
3. `python3 jade-backup-server.py` serves on port 8787. Options: `--port`, `--dir`, `--keep` (how many backups to keep per kind), `--max-mb`, `--tls-cert` / `--tls-key`.
4. To keep it running, a systemd unit:

```
[Unit]
Description=Jade Vault backup server
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/jade/jade-backup-server.py --dir /var/lib/jade-backups --token-file /etc/jade-backup.token
Restart=on-failure
User=jade

[Install]
WantedBy=multi-user.target
```
(Run `--help` to confirm the option names on your copy.)

## Set up the app

Settings → Backup: server address (`http://host:8787`), the token, how often (hours), what to include, and optionally Encrypt with a passphrase. **Back up now** uploads at once; **Test** checks the connection; the list shows what is on the server, and **Restore** downloads one (it asks before it replaces anything).

- "Full" includes notes, chats, schedules and settings. "Config" is settings and persona files only.
- API keys and other secrets are **left out** unless you switch on "include keys"; that forces encryption, so keys never travel in clear.
- Encrypted backups use AES-GCM with a key from your passphrase (PBKDF2, 210000 rounds). **There is no recovery if you lose the passphrase.**
- If an upload fails the app retries after 15 minutes, doubling up to 6 hours, and shows the reason.
- Jade has a `backup` tool (status, now, list). She cannot restore; only you can.

## Security notes

Plain HTTP sends the token and the (unencrypted) backup in clear text. On a home network that may be acceptable; otherwise use TLS (reverse proxy such as Caddy, or `--tls-cert`) and/or turn on Encrypt. Android may block cleartext HTTP to non-local addresses; this has not been tested on a real phone.

## API

`GET /health` (no token) · `GET /backups` · `PUT /backups/<name>` with `X-Sha256` · `GET /backups/<name>` · `DELETE /backups/<name>`. All but `/health` need `Authorization: Bearer <token>`.
