#!/usr/bin/env bash
# Tests the SSH client against a real Dropbear server. Needs Dropbear built from source (https://github.com/mkj/dropbear:
# ./configure --disable-zlib --disable-pam && make PROGRAMS="dropbear dropbearkey dropbearconvert") and a user "jadetest"
# with password "testpass-123". A second Dropbear built with  #define KEX_REKEY_DATA (1<<17)  in localoptions.h tests key re-exchange.
# Dev-only: skips itself if Dropbear is not there.
set -uo pipefail
cd "$(dirname "$0")"
DB=${DROPBEAR_DIR:-/tmp/claude-0/db}; DBR=${DROPBEAR_REKEY_DIR:-/tmp/claude-0/db-rekey}
if [ ! -x "$DB/dropbear" ] || ! id jadetest >/dev/null 2>&1; then echo "ssh tests skipped (no Dropbear at $DB or no jadetest user)"; exit 0; fi
W=/tmp/jv-ssh-test; rm -rf "$W"; mkdir -p "$W/classes" "$W/keys"; K=$W/keys
S=../src/app/netrunner/jade
javac -nowarn -d "$W/classes" $S/SshWire.java $S/SshKeys.java $S/SshClient.java $S/SshHost.java $S/MiniJson.java SshTest.java 2>&1 | grep -v '^Picked' && exit 1
for t in ecdsa rsa ed25519; do
  "$DB/dropbearkey" -t $t -f "$K/hk_$t" > "$K/hk_$t.out" 2>&1
  "$DB/dropbearkey" -t $t -f "$K/uk_$t" > "$K/uk_$t.out" 2>&1
  "$DB/dropbearconvert" dropbear openssh "$K/uk_$t" "$K/uk_$t.pem" >/dev/null 2>&1
  grep -h '^ecdsa-\|^ssh-' "$K/uk_$t.out" | head -1 > "$K/uk_$t.pub"
  grep -h 'ingerprint' "$K/hk_$t.out" >> "$K/hk.fps"
done
python3 - "$K" <<'PY'
import sys
from cryptography.hazmat.primitives import serialization as s
from cryptography.hazmat.primitives.asymmetric import rsa, ec, ed25519
k = sys.argv[1]
def w(name, key, fmt, enc=s.NoEncryption()):
    open(f"{k}/{name}", "wb").write(key.private_bytes(s.Encoding.PEM, fmt, enc))
    open(f"{k}/{name}.pub", "w").write(key.public_key().public_bytes(s.Encoding.OpenSSH, s.PublicFormat.OpenSSH).decode() + "\n")
r = rsa.generate_private_key(65537, 2048); e = ec.generate_private_key(ec.SECP256R1()); d = ed25519.Ed25519PrivateKey.generate()
w("pem_rsa.pem", r, s.PrivateFormat.TraditionalOpenSSL); w("pem_rsa_pkcs8.pem", r, s.PrivateFormat.PKCS8)
w("pem_ec.pem", e, s.PrivateFormat.TraditionalOpenSSL)
w("pem_ed25519_openssh.pem", d, s.PrivateFormat.OpenSSH); w("pem_ec_openssh.pem", e, s.PrivateFormat.OpenSSH); w("pem_rsa_openssh.pem", r, s.PrivateFormat.OpenSSH)
w("uk_enc.pem", r, s.PrivateFormat.TraditionalOpenSSL, s.BestAvailableEncryption(b"secret"))
PY
H=/home/jadetest; mkdir -p $H/.ssh; chown jadetest:jadetest $H/.ssh; chmod 700 $H/.ssh; : > $H/.ssh/authorized_keys; chown jadetest:jadetest $H/.ssh/authorized_keys; chmod 600 $H/.ssh/authorized_keys
"$DB/dropbear" -F -p 127.0.0.1:2222 -r "$K/hk_ecdsa" -r "$K/hk_rsa" -r "$K/hk_ed25519" > "$W/server.log" 2>&1 & P1=$!
P2=; if [ -x "$DBR/dropbear" ]; then "$DBR/dropbear" -F -p 127.0.0.1:2223 -r "$K/hk_ecdsa" -r "$K/hk_rsa" -r "$K/hk_ed25519" > "$W/server2.log" 2>&1 & P2=$!; fi
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
java -cp "$W/classes" SshTest 127.0.0.1 2222 "$K" $H/.ssh/authorized_keys ${P2:+2223}
RC=$?
[ $RC -ne 0 ] && tail -5 "$W/server.log"
exit $RC
