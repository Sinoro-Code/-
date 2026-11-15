#!/usr/bin/env bash
# VisionPOS Edge — Universal Android APK Builder (Supports All Android Phones: Android 5.0 API 21 -> Android 15/16+)
# Compiles universal Android Java wrapper + VisionPOS-Android.html into a 4-byte aligned,
# V1 (JAR) + V2 + V3 triple-signed universal APK: VisionPOS-Android.apk
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$PROJECT_DIR/android"
CANDIDATE_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/tmp/android-sdk}}"
if [[ -x "$CANDIDATE_SDK/build-tools/34.0.0/aapt2" && -f "$CANDIDATE_SDK/platforms/android-34/android.jar" ]]; then
  SDK_DIR="$CANDIDATE_SDK"
else
  SDK_DIR="/tmp/android-sdk"
fi
BUILD_TOOLS="$SDK_DIR/build-tools/34.0.0"
PLATFORM_JAR="$SDK_DIR/platforms/android-34/android.jar"
OUT_APK="$PROJECT_DIR/即庫系統.apk"
LEGACY_APK="$PROJECT_DIR/VisionPOS-Android.apk"
WORK_DIR="/tmp/visionpos-apk-build"
KEYSTORE="$ANDROID_DIR/visionpos-release.jks"

# Auto-bootstrap lightweight Android Build-Tools 34.0.0 + Platform 34 into /tmp/android-sdk if absent
if [[ ! -x "$BUILD_TOOLS/aapt2" || ! -f "$PLATFORM_JAR" ]]; then
  echo "  -> 正在自動初始化 Android SDK 編譯工具鏈 (/tmp/android-sdk)..."
  mkdir -p "$SDK_DIR/build-tools" "$SDK_DIR/platforms" /tmp/sdk-dl
  if [[ ! -x "$BUILD_TOOLS/aapt2" ]]; then
    curl -fsSL "https://dl.google.com/android/repository/build-tools_r34-linux.zip" -o /tmp/sdk-dl/bt.zip
    unzip -q -o /tmp/sdk-dl/bt.zip -d /tmp/sdk-dl/bt
    rm -rf "$BUILD_TOOLS"
    mv /tmp/sdk-dl/bt/android-* "$BUILD_TOOLS"
  fi
  if [[ ! -f "$PLATFORM_JAR" ]]; then
    curl -fsSL "https://dl.google.com/android/repository/platform-34-ext7_r02.zip" -o /tmp/sdk-dl/plat.zip
    unzip -q -o /tmp/sdk-dl/plat.zip -d /tmp/sdk-dl/plat
    mkdir -p "$SDK_DIR/platforms/android-34"
    cp /tmp/sdk-dl/plat/android-*/android.jar "$PLATFORM_JAR"
  fi
  rm -rf /tmp/sdk-dl
fi

echo "[APK 1/6] 確保最新全安卓通用單檔引擎 即庫系統.html 已封裝..."
node "$PROJECT_DIR/build-standalone.js"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/compiled_res" "$WORK_DIR/gen" "$WORK_DIR/classes" "$WORK_DIR/dex" "$WORK_DIR/pkg/assets"

echo "[APK 2/6] 使用 aapt2 編譯與連結全安卓相容資源與 Manifest (minSdk=21, targetSdk=34)..."
"$BUILD_TOOLS/aapt2" compile --dir "$ANDROID_DIR/res" -o "$WORK_DIR/compiled_res/res.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$WORK_DIR/unaligned.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --java "$WORK_DIR/gen" \
  "$WORK_DIR/compiled_res/res.zip"

echo "[APK 3/6] 使用 OpenJDK javac 編譯全安卓相容 MainActivity 與 CaptureFileProvider..."
javac --release 11 -encoding UTF-8 \
  -classpath "$PLATFORM_JAR" \
  -d "$WORK_DIR/classes" \
  "$WORK_DIR/gen/com/visionpos/edge/R.java" \
  "$ANDROID_DIR/src/com/visionpos/edge/CaptureFileProvider.java" \
  "$ANDROID_DIR/src/com/visionpos/edge/MainActivity.java"

echo "[APK 4/6] 使用 d8 轉換通用 DEX (min-api 21, 支援 ARM64 / ARMv7 / x86 全架構)..."
CLASS_FILES=$(find "$WORK_DIR/classes" -name "*.class")
"$BUILD_TOOLS/d8" --lib "$PLATFORM_JAR" --min-api 21 --output "$WORK_DIR/dex" $CLASS_FILES

cp "$WORK_DIR/dex/classes.dex" "$WORK_DIR/pkg/classes.dex"
cp "$PROJECT_DIR/即庫系統.html" "$WORK_DIR/pkg/assets/app-bundle.html"

(
  cd "$WORK_DIR/pkg"
  zip -q -r "$WORK_DIR/unaligned.apk" classes.dex assets/app-bundle.html
)

echo "[APK 5/6] 執行 4-byte zipalign 對齊 (相容 Android 5.0 至 Android 15+ 強制規範)..."
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

rm -f "$LEGACY_APK"

echo "[APK 6/6] 執行 APK Signature Scheme v1 + v2 + v3 全世代三重數位簽章並驗證..."
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias visionpos \
  --ks-pass pass:visionpos2026 \
  --key-pass pass:visionpos2026 \
  --min-sdk-version 21 \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$OUT_APK" \
  "$WORK_DIR/aligned.apk"

"$BUILD_TOOLS/apksigner" verify --min-sdk-version 21 --verbose "$OUT_APK" | grep -E "Verified using"
ls -lh "$OUT_APK"
