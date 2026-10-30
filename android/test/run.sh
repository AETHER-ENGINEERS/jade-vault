#!/usr/bin/env bash
# Plain-JVM tests of the Android code that has no Android dependencies: the vault folder layer and casting.
set -euo pipefail
cd "$(dirname "$0")"
W=/tmp/jv-java-test; rm -rf "$W" && mkdir -p "$W/classes"
S=../src/app/netrunner/jade
# Disk and SentryEngine are Rust (libjade); build it for this machine and point the JVM at it
(cd ../../rust && cargo build --release -q -p jade-android)
J="-Djade.lib=$(cd ../../rust && pwd)/target/release/libjade.so"
javac -nowarn -d "$W/classes" $S/Native.java $S/Net.java access/app/netrunner/jade/NetAccess.java $S/Disk.java $S/MiniJson.java $S/CastClient.java $S/FileServer.java $S/SentryEngine.java $S/SentrySystems.java DiskTest.java CastTest.java SentryTest.java NetTest.java
java $J -cp "$W/classes" DiskTest
keytool -genkeypair -keystore "$W/tv.jks" -storepass testpass -keypass testpass -alias tv -keyalg RSA -keysize 2048 -validity 2 -dname "CN=Fake Chromecast" >/dev/null 2>&1
java $J -cp "$W/classes" CastTest "$W/tv.jks" "$W/files"
java $J -cp "$W/classes" SentryTest
java $J -cp "$W/classes" NetTest
