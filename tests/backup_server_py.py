"""The backup server: auth, upload with checksum, atomic storage, retention, bad names, size limit, CORS."""
import hashlib, http.client, importlib.util, json, os, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('jbs', os.path.join(ROOT, 'server', 'jade-backup-server.py'))
jbs = importlib.util.module_from_spec(spec); spec.loader.exec_module(jbs)

fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

TOKEN = 'x' * 40
tmp = tempfile.mkdtemp()
srv = jbs.make_server('127.0.0.1', 0, os.path.join(tmp, 'b'), TOKEN, keep=3, max_mb=0.01)   # 10 KB limit
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

def req(method, path, body=None, headers=None, token=TOKEN):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    h = dict(headers or {})
    if token is not None: h['Authorization'] = 'Bearer ' + token
    c.request(method, path, body=body, headers=h); r = c.getresponse(); data = r.read(); c.close()
    try: j = json.loads(data)
    except Exception: j = None
    return r.status, j, data, r

sha = lambda b: hashlib.sha256(b).hexdigest()

s, j, _, r = req('GET', '/health', token=None)
ok(s == 200 and j == {'ok': True}, 'health needs no token')
s, j, _, _ = req('GET', '/backups', token=None); ok(s == 401, 'no token is refused')
t0 = time.time(); s, j, _, _ = req('GET', '/backups', token='wrong' * 8); ok(s == 401 and time.time() - t0 >= 0.9, 'a wrong token is refused, after a pause')
s, j, _, _ = req('GET', '/backups'); ok(s == 200 and j['backups'] == [], 'empty list')

body = b'{"app":"jade-vault"}' * 20
name = 'jade-vault-full-2026-10-01T10-00-00Z.json.gz'
s, j, _, _ = req('PUT', '/backups/' + name, body, {'X-Sha256': sha(body), 'Content-Type': 'application/octet-stream'})
ok(s == 201 and j['stored'] == name and j['sha256'] == sha(body) and j['size'] == len(body), 'upload with a correct checksum is stored')
s, j, data, r = req('GET', '/backups/' + name); ok(s == 200 and data == body and r.getheader('X-Sha256') == sha(body), 'download returns the same bytes')
s, j, _, _ = req('GET', '/backups'); ok(len(j['backups']) == 1 and j['backups'][0]['sha256'] == sha(body) and j['total_bytes'] == len(body), 'list shows name, size, checksum')
ok(oct(os.stat(os.path.join(tmp, 'b', name)).st_mode & 0o777) == '0o600', 'stored files are private (mode 600)')

s, j, _, _ = req('PUT', '/backups/jade-vault-full-2026-10-02T10-00-00Z.json.gz', body, {'X-Sha256': '0' * 64})
ok(s == 422 and 'mismatch' in j['error'], 'a wrong checksum is refused')
ok(not os.path.exists(os.path.join(tmp, 'b', 'jade-vault-full-2026-10-02T10-00-00Z.json.gz')) and not [f for f in os.listdir(os.path.join(tmp, 'b')) if f.startswith('.upload-')], 'and nothing (not even a temp file) is left behind')

# a bad upload must not replace a good backup of the same name
s, j, _, _ = req('PUT', '/backups/' + name, b'garbage', {'X-Sha256': '1' * 64})
s2, _, data, _ = req('GET', '/backups/' + name); ok(s == 422 and data == body, 'a refused upload does not overwrite the good backup')

for bad in ['..%2Fescape.json', 'a%2Fb.json', '.hidden.json', 'name.txt', 'x' * 130 + '.json', 'jade%00.json']:
    s, j, _, _ = req('PUT', '/backups/' + bad, b'{}')
    ok(s in (400, 404), 'bad name refused: ' + bad[:30] + f' ({s})')
ok(not os.path.exists(os.path.join(tmp, 'escape.json')), 'nothing was written outside the folder')
s, _, _, _ = req('GET', '/backups/..%2F..%2Fetc%2Fpasswd'); ok(s in (400, 404), 'path traversal on download is refused')

s, j, _, _ = req('PUT', '/backups/big.json', b'x' * 20000); ok(s == 413, 'over the size limit is refused (413)')
s, j, _, _ = req('PUT', '/backups/empty.json', b''); ok(s == 400, 'empty upload refused')

# retention: keep 3 per kind, the other kind is separate
os.utime(os.path.join(tmp, 'b', name), (1_700_000_000, 1_700_000_000))
for i in range(2, 7):
    b = ('{"n":%d}' % i).encode()
    nm = f'jade-vault-full-2026-10-0{i}T10-00-00Z.json.gz'
    s, j, _, _ = req('PUT', '/backups/' + nm, b, {'X-Sha256': sha(b)}); ok(s == 201, 'upload ' + nm)
    os.utime(os.path.join(tmp, 'b', nm), (1_700_000_000 + i * 100, 1_700_000_000 + i * 100))
cfgb = b'{"cfg":1}'
req('PUT', '/backups/jade-vault-config-2026-10-01T10-00-00Z.json.gz', cfgb, {'X-Sha256': sha(cfgb)})
s, j, _, _ = req('GET', '/backups')
names = [b['name'] for b in j['backups']]
full = [n for n in names if '-full-' in n]; cfg = [n for n in names if '-config-' in n]
ok(len(full) == 3 and len(cfg) == 1, f'only the newest 3 of each kind are kept: {len(full)} full, {len(cfg)} config')
ok(name not in names, 'the oldest full backup was the one removed')

s, j, _, _ = req('DELETE', '/backups/' + full[0]); ok(s == 200, 'delete')
s, j, _, _ = req('DELETE', '/backups/' + full[0]); ok(s == 404, 'deleting twice is a 404')
s, j, _, _ = req('DELETE', '/backups/..%2Fx.json'); ok(s in (400, 404), 'delete with a bad name refused')

# CORS preflight for the app
c = http.client.HTTPConnection('127.0.0.1', port, timeout=10); c.request('OPTIONS', '/backups/x.json', headers={'Origin': 'https://appassets.androidplatform.net', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,x-sha256'}); r = c.getresponse(); r.read()
ok(r.status == 204 and 'PUT' in r.getheader('Access-Control-Allow-Methods') and 'X-Sha256' in r.getheader('Access-Control-Allow-Headers') and r.getheader('Access-Control-Allow-Origin') == '*', 'CORS preflight allows PUT, Authorization and X-Sha256')

# a cut-off upload stores nothing
import socket
sk = socket.create_connection(('127.0.0.1', port)); sk.sendall(f'PUT /backups/cut.json HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 1000\r\n\r\nonly-this'.encode()); sk.shutdown(socket.SHUT_WR); time.sleep(0.5); sk.close()
time.sleep(0.3)
ok(not os.path.exists(os.path.join(tmp, 'b', 'cut.json')) and not [f for f in os.listdir(os.path.join(tmp, 'b')) if f.startswith('.upload-')], 'a cut-off upload stores nothing and leaves no temp file')

# the command line: --init makes a private token
import subprocess
d2 = tempfile.mkdtemp(); tf = os.path.join(d2, 'tok')
out = subprocess.run([sys.executable, os.path.join(ROOT, 'server', 'jade-backup-server.py'), '--init', '--token-file', tf, '--dir', os.path.join(d2, 'bk')], capture_output=True, text=True)
ok(out.returncode == 0 and len(open(tf).read().strip()) >= 40 and oct(os.stat(tf).st_mode & 0o777) == '0o600' and open(tf).read().strip() in out.stdout, '--init creates a long private token')
out = subprocess.run([sys.executable, os.path.join(ROOT, 'server', 'jade-backup-server.py'), '--token-file', os.path.join(d2, 'nope'), '--dir', d2], capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != 'JADE_BACKUP_TOKEN'})
ok(out.returncode != 0 and 'token' in out.stderr.lower(), 'it refuses to start without a token')

srv.shutdown()
print('\nALL PASS' if not fails else '\nFAILED: %d' % len(fails))
sys.exit(1 if fails else 0)
