#!/usr/bin/env bash
# Fetches the official, unmodified Shizuku release APK (Apache-2.0, RikkaApps) that DSH installs in-app,
# verifies it against the pinned sha256 and Shizuku's signing certificate, and lays it out as an assets dir:
#
#   $OUT/assets/shizuku/shizuku.apk
#   $OUT/assets/shizuku/LICENSE        (Apache-2.0 text from the same tag)
#
# app/build.gradle.kts adds $OUT/assets to the APK assets (override with -Pdsh.thirdPartyOut=...).
# Idempotent: exits immediately when the pinned files are already there. Nothing here is committed.
#
# Usage: tools/fetch-shizuku.sh [OUT]   (default: <repo>/../toolchains/out/third-party, i.e. toolchains/out/third-party)
set -euo pipefail

# ---- pins (bump all together; app/build.gradle.kts reads VERSION / VERSION_CODE from here) --------------
VERSION=13.6.0
VERSION_CODE=1086
TAG=v$VERSION
APK_NAME=shizuku-v13.6.0.r1086.2650830c-release.apk
APK_SHA256=6e273ab0e991c4e79bc8b1bbb9b9dd739ccac1a8712a541a214078886b7b790f
LICENSE_SHA256=58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd
# Signer of every official Shizuku release (CN=Rikka; same cert from v11.3.0 through v13.6.0).
CERT_SHA256=268b5590e868fb08bae7e0ac413564cd1ff88f5ccff74af9dbd0dc918e30db30

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
out="${1:-$repo/toolchains/out/third-party}"
dest="$out/assets/shizuku"

sha() { sha256sum "$1" | cut -d' ' -f1; }

if [[ -f "$dest/shizuku.apk" && -f "$dest/LICENSE" && "$(sha "$dest/shizuku.apk")" == "$APK_SHA256" && "$(sha "$dest/LICENSE")" == "$LICENSE_SHA256" ]]; then
  echo "shizuku $VERSION: up to date ($dest)"; exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "shizuku $VERSION: downloading"
curl -fsSL --retry 3 -o "$tmp/shizuku.apk" "https://github.com/RikkaApps/Shizuku/releases/download/$TAG/$APK_NAME"
curl -fsSL --retry 3 -o "$tmp/LICENSE" "https://raw.githubusercontent.com/RikkaApps/Shizuku/$TAG/LICENSE"

got="$(sha "$tmp/shizuku.apk")"; [[ "$got" == "$APK_SHA256" ]] || { echo "shizuku.apk sha256 mismatch: $got" >&2; exit 1; }
got="$(sha "$tmp/LICENSE")"; [[ "$got" == "$LICENSE_SHA256" ]] || { echo "LICENSE sha256 mismatch: $got" >&2; exit 1; }

# Signing cert check with apksigner (a jar: run it with the JDK so it works on any host arch).
java="${JAVA_HOME:+$JAVA_HOME/bin/}java"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" && -f "$repo/local.properties" ]]; then sdk="$(sed -n 's/^sdk\.dir=//p' "$repo/local.properties")"; fi
signer="$(ls -d "$sdk"/build-tools/*/lib/apksigner.jar 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$signer" ]]; then
  certs="$("$java" -jar "$signer" verify --print-certs "$tmp/shizuku.apk")"
  # "Signer #1 certificate SHA-256 digest: …" (build-tools 36) or "V2 Signer: certificate SHA-256 digest: …" (37).
  digests="$(sed -n 's/^.*[Ss]igner.* certificate SHA-256 digest: //p' <<<"$certs" | sort -u)"
  [[ "$digests" == "$CERT_SHA256" ]] || { echo "unexpected Shizuku signer(s): $digests" >&2; exit 1; }
  echo "shizuku $VERSION: signer OK ($CERT_SHA256)"
else
  echo "shizuku $VERSION: apksigner not found (set ANDROID_HOME); relying on the pinned sha256" >&2
fi

mkdir -p "$dest"
mv "$tmp/shizuku.apk" "$dest/shizuku.apk"
mv "$tmp/LICENSE" "$dest/LICENSE"
echo "shizuku $VERSION: $dest"
