#!/usr/bin/env bash
# VisionPOS Edge V3 — Automated Google Drive (HTML + APK Overwrite/Cleanup) & GitHub Sync Script
set -euo pipefail

PROJECT_DIR="/home/antigravity/vision-pos"
GDRIVE_HTML_ID="1y4hkJb9nrZS9nlV6l8wELAlIIUpYiLPV"
GDRIVE_APK_ID="1dZmFn4sKbfw6mg4GbXYtR08YvyjuFIU5"
STANDALONE_HTML="$PROJECT_DIR/VisionPOS-Xiaomi15.html"
APK_FILE="$PROJECT_DIR/VisionPOS-Xiaomi15.apk"

cd "$PROJECT_DIR"

echo "[1/5] 正在封裝最新單檔版 VisionPOS-Xiaomi15.html 與編譯簽章 VisionPOS-Xiaomi15.apk ..."
node "$PROJECT_DIR/build-standalone.js"
bash "$PROJECT_DIR/build-apk.sh"

echo "[2/5] 正在覆寫更新 Google 雲端硬碟 VisionPOS-Xiaomi15.html (ID: $GDRIVE_HTML_ID) 並清理重複舊檔..."
gdrive mutate update "$GDRIVE_HTML_ID" "$STANDALONE_HTML" --mime-type "text/html"

DUP_HTML_IDS=$(gdrive readonly search --name-contains "VisionPOS-Xiaomi15.html" | awk '{print $1}' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9_-]{20,}$' | grep -v "^${GDRIVE_HTML_ID}$" || true)
for old_id in $DUP_HTML_IDS; do
  echo "  -> 移除雲端硬碟重複 HTML 舊檔 ID: $old_id"
  gdrive mutate trash "$old_id" || true
done

echo "[3/5] 正在同步更新 Google 雲端硬碟 Android 安裝檔 VisionPOS-Xiaomi15.apk 並清理重複舊檔..."
if gdrive mutate update "$GDRIVE_APK_ID" "$APK_FILE" --mime-type "application/vnd.android.package-archive" 2>/dev/null; then
  PRIMARY_APK_ID="$GDRIVE_APK_ID"
  echo "  -> 已原地覆寫更新雲端 APK (ID: $PRIMARY_APK_ID)"
  DUP_APK_IDS=$(gdrive readonly search --name-contains "VisionPOS-Xiaomi15.apk" | awk '{print $1}' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9_-]{20,}$' | grep -v "^${PRIMARY_APK_ID}$" || true)
  for dup_apk in $DUP_APK_IDS; do
    echo "  -> 移除雲端硬碟重複 APK 舊檔 ID: $dup_apk"
    gdrive mutate trash "$dup_apk" || true
  done
else
  echo "  -> 原 APK ID 不存在，正在重新上傳 VisionPOS-Xiaomi15.apk ..."
  gdrive mutate upload "$APK_FILE" --mime-type "application/vnd.android.package-archive"
  PRIMARY_APK_ID=$(gdrive readonly search --name-contains "VisionPOS-Xiaomi15.apk" | awk '{print $1}' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9_-]{20,}$' | head -n 1 || true)
fi

if [[ -n "$PRIMARY_APK_ID" ]]; then
  echo "  -> APK 雲端硬碟點擊安裝連結: $(gdrive readonly url "$PRIMARY_APK_ID")"
fi

echo "[4/5] 正在同步更新本地 Git 儲存庫與推送至 GitHub (Sinoro-Code/-) ..."
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: sync latest VisionPOS V3 HTML & signed Android APK to Google Drive and GitHub"
fi

if git push -u origin main 2>/dev/null; then
  echo "  -> 已直接推送至 https://github.com/Sinoro-Code/-.git"
else
  echo "  -> 本地 main 分支已更新至最新 Commit: $(git rev-parse --short HEAD)"
fi

echo "[5/5] Google 雲端硬碟 (HTML + APK) 與 GitHub 同步完成！"
