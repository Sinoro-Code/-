#!/usr/bin/env bash
# 即庫系統 — 自動封裝並分離同步腳本：
# 1. 打包產物（即庫系統.apk、即庫系統.html）-> 同步覆寫至 Google 雲端硬碟「即庫系統」資料夾
# 2. 專案原始碼（不含打包二進位/單檔產物）-> 同步推送至 GitHub (https://github.com/Sinoro-Code/-.git)
set -euo pipefail

PROJECT_DIR="/home/antigravity/vision-pos"
GDRIVE_FOLDER_ID="1v9enQ0C-naqv4HCX1zn_p4Wt7NPiOJnd"
GDRIVE_HTML_ID="1y4hkJb9nrZS9nlV6l8wELAlIIUpYiLPV"
GDRIVE_APK_ID="1dZmFn4sKbfw6mg4GbXYtR08YvyjuFIU5"
STANDALONE_HTML="$PROJECT_DIR/即庫系統.html"
APK_FILE="$PROJECT_DIR/即庫系統.apk"

cd "$PROJECT_DIR"

echo "[1/4] 正在封裝全安卓通用單檔版 即庫系統.html 與編譯簽章 即庫系統.apk ..."
node "$PROJECT_DIR/build-standalone.js"
bash "$PROJECT_DIR/build-apk.sh"

echo "[2/4] 正在將打包檔案 (即庫系統.apk / 即庫系統.html) 同步至 Google 雲端硬碟「即庫系統」資料夾 (ID: $GDRIVE_FOLDER_ID)..."
gdrive mutate rename "$GDRIVE_HTML_ID" "即庫系統.html" >/dev/null 2>&1 || true
gdrive mutate mv "$GDRIVE_HTML_ID" "$GDRIVE_FOLDER_ID" >/dev/null 2>&1 || true
gdrive mutate update "$GDRIVE_HTML_ID" "$STANDALONE_HTML" --mime-type "text/html"

if gdrive mutate update "$GDRIVE_APK_ID" "$APK_FILE" --mime-type "application/vnd.android.package-archive" 2>/dev/null; then
  PRIMARY_APK_ID="$GDRIVE_APK_ID"
  gdrive mutate rename "$PRIMARY_APK_ID" "即庫系統.apk" >/dev/null 2>&1 || true
  gdrive mutate mv "$PRIMARY_APK_ID" "$GDRIVE_FOLDER_ID" >/dev/null 2>&1 || true
  echo "  -> 已原地覆寫並歸檔至雲端資料夾「即庫系統」: 即庫系統.apk (ID: $PRIMARY_APK_ID)"
else
  echo "  -> 原 APK ID 不存在，正在上傳 即庫系統.apk 至雲端資料夾「即庫系統」..."
  gdrive mutate upload "$APK_FILE" --mime-type "application/vnd.android.package-archive" --parent "$GDRIVE_FOLDER_ID"
  PRIMARY_APK_ID=$(gdrive readonly search --parent-id "$GDRIVE_FOLDER_ID" --name-contains "即庫系統.apk" | awk '{print $1}' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9_-]{20,}$' | head -n 1 || true)
fi

DUP_IDS=$(gdrive readonly search --name-contains "VisionPOS-" | awk '{print $1}' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9_-]{20,}$' | grep -v -E "^(${GDRIVE_HTML_ID}|${PRIMARY_APK_ID})$" || true)
for old_id in $DUP_IDS; do
  echo "  -> 移除雲端硬碟舊版殘留檔案 ID: $old_id"
  gdrive mutate trash "$old_id" || true
done

echo "  -> 雲端資料夾連結: $(gdrive readonly url "$GDRIVE_FOLDER_ID")"
echo "  -> 即庫系統.apk 連結: $(gdrive readonly url "$PRIMARY_APK_ID")"
echo "  -> 即庫系統.html 連結: $(gdrive readonly url "$GDRIVE_HTML_ID")"

echo "[3/4] 正在將專案原始碼同步推送至 GitHub (Sinoro-Code/-) ..."
git rm --cached --ignore-unmatch "即庫系統.apk" "即庫系統.html" "VisionPOS-Android.apk" "VisionPOS-Android.html" >/dev/null 2>&1 || true
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore(repo): sync source code only to GitHub & packaged builds to Google Drive folder"
fi

gh auth status >/dev/null 2>&1 || true
if git push -u origin main; then
  echo "  -> 原始碼已成功推送至 https://github.com/Sinoro-Code/-.git (main)"
else
  echo "  -> ⚠️ 本地原始碼已提交至 main ($(git rev-parse --short HEAD))；遠端沙盒需將 Sinoro-Code/- 掛載至 Antigravity Project Resources 方可放行 git push 寫入權限。"
fi

echo "[4/4] 同步流程執行完畢！"
