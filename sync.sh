#!/usr/bin/env bash
# 即庫系統 — 自動封裝並分離同步腳本（支援永久免重連架構）：
# 1. 本地先驗證封裝 即庫系統.html 與 即庫系統.apk（確保零編譯錯誤）
# 2. 若本地 gdrive 外掛在有效期內，立即原地覆寫至雲端硬碟「即庫系統」資料夾；若已逾時則不阻斷，交由 GitHub Actions 永久憑證自動覆寫
# 3. 將純原始碼提交並推送至 GitHub (Sinoro-Code/-)，自動觸發 .github/workflows/build-and-sync.yml
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDRIVE_FOLDER_ID="1v9enQ0C-naqv4HCX1zn_p4Wt7NPiOJnd"
GDRIVE_HTML_ID="1y4hkJb9nrZS9nlV6l8wELAlIIUpYiLPV"
GDRIVE_APK_ID="1dZmFn4sKbfw6mg4GbXYtR08YvyjuFIU5"
STANDALONE_HTML="$PROJECT_DIR/即庫系統.html"
APK_FILE="$PROJECT_DIR/即庫系統.apk"

cd "$PROJECT_DIR"

echo "[1/3] 正在封裝全安卓通用單檔版 即庫系統.html 與編譯簽章 即庫系統.apk ..."
node "$PROJECT_DIR/build-standalone.js"
bash "$PROJECT_DIR/build-apk.sh"

echo "[2/3] 檢查本地 Google 雲端硬碟直連狀態..."
if command -v gdrive >/dev/null 2>&1 && gdrive auth status 2>/dev/null | grep -q "Logged in"; then
  echo "  -> 本地 gdrive 授權有效，正在直接覆寫至 Google 雲端硬碟「即庫系統」資料夾..."
  gdrive mutate rename "$GDRIVE_HTML_ID" "即庫系統.html" >/dev/null 2>&1 || true
  gdrive mutate mv "$GDRIVE_HTML_ID" "$GDRIVE_FOLDER_ID" >/dev/null 2>&1 || true
  gdrive mutate update "$GDRIVE_HTML_ID" "$STANDALONE_HTML" --mime-type "text/html"
  if gdrive mutate update "$GDRIVE_APK_ID" "$APK_FILE" --mime-type "application/vnd.android.package-archive" 2>/dev/null; then
    gdrive mutate rename "$GDRIVE_APK_ID" "即庫系統.apk" >/dev/null 2>&1 || true
    gdrive mutate mv "$GDRIVE_APK_ID" "$GDRIVE_FOLDER_ID" >/dev/null 2>&1 || true
  else
    gdrive mutate upload "$APK_FILE" --mime-type "application/vnd.android.package-archive" --parent "$GDRIVE_FOLDER_ID"
  fi
  echo "  -> 本地直連同步完成: https://drive.google.com/drive/folders/$GDRIVE_FOLDER_ID"
else
  echo "  -> ℹ️ 本地 gdrive 短期憑證未啟用或已逾時（無須手動重連），推送 GitHub 後將由 GitHub Actions 自動覆寫至雲端硬碟「即庫系統」資料夾。"
fi

echo "[3/3] 正在將專案原始碼同步推送至 GitHub (Sinoro-Code/-) ..."
git rm --cached --ignore-unmatch "即庫系統.apk" "即庫系統.html" "VisionPOS-Android.apk" "VisionPOS-Android.html" >/dev/null 2>&1 || true
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore(repo): sync source code to GitHub & trigger automated Drive build"
fi

gh auth status >/dev/null 2>&1 || true
if git push -u origin main; then
  echo "  -> ✅ 原始碼已推送至 GitHub (main)，GitHub Actions 正自動編譯並同步至 Google 雲端硬碟「即庫系統」資料夾！"
else
  echo "  -> ⚠️ 本地原始碼已提交至 main ($(git rev-parse --short HEAD))；請完成一次性 GitHub Project 綁定後即可自動推送。"
fi
