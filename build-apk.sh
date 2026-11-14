#!/usr/bin/env bash
# VisionPOS Edge — Native Android APK Builder (Xiaomi 15 / Android 15 HyperOS Edition)
# Compiles Android Java wrapper + latest VisionPOS-Xiaomi15.html into a 4-byte aligned,
# V1 + V2 + V3 signed installable APK: VisionPOS-Xiaomi15.apk
set -euo pipefail

PROJECT_DIR="/home/antigravity/vision-pos"
ANDROID_DIR="$PROJECT_DIR/android"
SDK_DIR="${ANDROID_SDK_ROOT:-/tmp/android-sdk}"
BUILD_TOOLS="$SDK_DIR/build-tools/34.0.0"
PLATFORM_JAR="$SDK_DIR/platforms/android-34/android.jar"
OUT_APK="$PROJECT_DIR/VisionPOS-Xiaomi15.apk"
WORK_DIR="/tmp/visionpos-apk-build"
KEYSTORE="$ANDROID_DIR/visionpos-release.jks"

if [[ ! -x "$BUILD_TOOLS/aapt2" || ! -f "$PLATFORM_JAR" ]]; then
  echo "  -> [略過 APK 重新編譯] 未偵測到 Android SDK 工具鏈，保留現有 VisionPOS-Xiaomi15.apk"
  exit 0
fi

echo "[APK 1/6] 確保最新單檔引擎 VisionPOS-Xiaomi15.html 已封裝..."
node "$PROJECT_DIR/build-standalone.js"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/compiled_res" "$WORK_DIR/gen" "$WORK_DIR/classes" "$WORK_DIR/dex" "$WORK_DIR/pkg/assets"

echo "[APK 2/6] 使用 aapt2 編譯與連結 Android 資源與 Manifest (targetSdk=34)..."
"$BUILD_TOOLS/aapt2" compile --dir "$ANDROID_DIR/res" -o "$WORK_DIR/compiled_res/res.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$WORK_DIR/unaligned.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --java "$WORK_DIR/gen" \
  "$WORK_DIR/compiled_res/res.zip"

echo "[APK 3/6] 使用 OpenJDK javac 編譯 MainActivity 與 CaptureFileProvider..."
javac --release 11 -encoding UTF-8 \
  -classpath "$PLATFORM_JAR" \
  -d "$WORK_DIR/classes" \
  "$WORK_DIR/gen/com/visionpos/edge/R.java" \
  "$ANDROID_DIR/src/com/visionpos/edge/CaptureFileProvider.java" \
  "$ANDROID_DIR/src/com/visionpos/edge/MainActivity.java"

echo "[APK 4/6] 使用 d8 轉換 classes.dex 並嵌入離線網頁引擎..."
CLASS_FILES=$(find "$WORK_DIR/classes" -name "*.class")
"$BUILD_TOOLS/d8" --lib "$PLATFORM_JAR" --min-api 24 --output "$WORK_DIR/dex" $CLASS_FILES

cp "$WORK_DIR/dex/classes.dex" "$WORK_DIR/pkg/classes.dex"
cp "$PROJECT_DIR/VisionPOS-Xiaomi15.html" "$WORK_DIR/pkg/assets/VisionPOS-Xiaomi15.html"

(
  cd "$WORK_DIR/pkg"
  zip -q -r "$WORK_DIR/unaligned.apk" classes.dex assets/VisionPOS-Xiaomi15.html
)

echo "[APK 5/6] 執行 4-byte zipalign 對齊 (符合 Android 14/15 強制規範)..."
"$BUILD_TOOLS/zipalign" -p -f 4 "$WORK_DIR/unaligned.apk" "$WORK_DIR/aligned.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias visionpos \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass visionpos2026 \
    -keypass visionpos2026 \
    -dname "CN=VisionPOS Edge, OU=Retail Vision, O=Sinoro, L=Taipei, ST=TW, C=TW" >/dev/null 2>&1
fi

echo "[APK 6/6] 執行 APK Signature Scheme v1 + v2 + v3 數位簽章並驗證..."
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias visionpos \
  --ks-pass pass:visionpos2026 \
  --key-pass pass:visionpos2026 \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$OUT_APK" \
  "$WORK_DIR/aligned.apk"

"$BUILD_TOOLS/apksigner" verify --verbose "$OUT_APK" | grep -E "Verified using"
ls -lh "$OUT_APK"
