#!/usr/bin/env bash
# Build script para MultiTerminalAI Remote APK en Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BUILD_TOOLS_VER="36.0.0"
PLATFORM_VER="android-35"
BUILD_TOOLS="$SDK/build-tools/$BUILD_TOOLS_VER"
PLATFORM_JAR="$SDK/platforms/$PLATFORM_VER/android.jar"

if [ ! -x "$BUILD_TOOLS/aapt2" ]; then
  echo "ERROR: no encuentro aapt2 en $BUILD_TOOLS" >&2
  exit 1
fi
if [ ! -f "$PLATFORM_JAR" ]; then
  echo "ERROR: no encuentro $PLATFORM_JAR" >&2
  exit 1
fi
if ! command -v javac >/dev/null; then
  echo "ERROR: javac no está instalado" >&2
  exit 1
fi

PKG="com.local.multiterminalai"
PKG_DIR="$OUT/gen/$(echo $PKG | tr . /)"
rm -rf "$OUT"
mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/6] aapt2 compile..."
"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/res" -o "$OUT/compiled/res.zip"

echo "[2/6] aapt2 link..."
"$BUILD_TOOLS/aapt2" link \
  -o "$OUT/unsigned.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ROOT/AndroidManifest.xml" \
  "$OUT/compiled/res.zip" \
  --java "$OUT/gen"

echo "[3/6] javac..."
SOURCES=(
  "$ROOT/src/${PKG//./\/}/MainActivity.java"
  "$PKG_DIR/R.java"
)
javac -source 8 -target 8 -classpath "$PLATFORM_JAR" -d "$OUT/classes" "${SOURCES[@]}"

echo "[4/6] d8 (dex)..."
mapfile -t CLASS_FILES < <(find "$OUT/classes" -type f -name '*.class')
"$BUILD_TOOLS/d8" --lib "$PLATFORM_JAR" --output "$OUT/dex" "${CLASS_FILES[@]}"

echo "[5/6] Inyectar classes.dex en el APK..."
cp "$OUT/unsigned.apk" "$OUT/with-dex.apk"
( cd "$OUT/dex" && jar uf "$OUT/with-dex.apk" classes.dex )
mv "$OUT/with-dex.apk" "$OUT/unsigned.apk"

echo "[6/6] zipalign + firmar (debug keystore)..."
ALIGNED="$OUT/aligned.apk"
FINAL="$OUT/MTAI-Remote.apk"
KEYSTORE="$ROOT/debug.keystore"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$ALIGNED"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass android -alias mtai -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=MultiTerminalAI Remote,O=Local,C=US"
fi

"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$FINAL" "$ALIGNED"

"$BUILD_TOOLS/apksigner" verify --verbose "$FINAL" >/dev/null

echo
echo "=== APK listo ==="
ls -lh "$FINAL"
file "$FINAL"
