#!/usr/bin/env bash
# VisionPOS Edge — Automated Google Drive (In-Place Overwrite) & GitHub Sync Script
set -euo pipefail

PROJECT_DIR="/home/antigravity/vision-pos"
GDRIVE_FILE_ID="1y4hkJb9nrZS9nlV6l8wELAlIIUpYiLPV"
STANDALONE_HTML="$PROJECT_DIR/VisionPOS-Xiaomi15.html"

cd "$PROJECT_DIR"

echo "[1/4] 正在重新封裝最新單檔版 VisionPOS-Xiaomi15.html ..."
node -e '
const fs = require("fs");
const path = require("path");
const pub = "/home/antigravity/vision-pos/public";
let html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const css = fs.readFileSync(path.join(pub, "css/styles.css"), "utf8");
const engine = fs.readFileSync(path.join(pub, "js/vision-engine.js"), "utf8");
const app = fs.readFileSync(path.join(pub, "js/app.js"), "utf8");

html = html.replace("<link rel=\"manifest\" href=\"/manifest.json\" />", "");
html = html.replace("<link rel=\"stylesheet\" href=\"/css/styles.css\" />", () => "<style>\n" + css + "\n</style>");
html = html.replace("<script src=\"/js/vision-engine.js\"></script>", () => "<script>\n" + engine + "\n</script>");
html = html.replace("<script src=\"/js/app.js\"></script>", () => "<script>\n" + app + "\n</script>");

fs.writeFileSync("/home/antigravity/vision-pos/VisionPOS-Xiaomi15.html", html, "utf8");
console.log("  -> 已生成最新 VisionPOS-Xiaomi15.html (" + html.length + " bytes)");
'

echo "[2/4] 正在覆寫更新 Google 雲端硬碟檔案 (ID: $GDRIVE_FILE_ID) 並清理重複舊檔..."
gdrive mutate update "$GDRIVE_FILE_ID" "$STANDALONE_HTML"

# 檢查雲端硬碟是否有其他同名舊檔案，若有則移至垃圾桶避免重複
DUP_IDS=$(gdrive readonly search --name-contains "VisionPOS-Xiaomi15.html" | awk '{print $1}' | grep -E '^[a-zA-Z0-9_-]{20,}$' | grep -v "^${GDRIVE_FILE_ID}$" || true)
for old_id in $DUP_IDS; do
  echo "  -> 移除雲端硬碟重複舊檔 ID: $old_id"
  gdrive mutate trash "$old_id" || true
done

echo "[3/4] 正在同步更新本地 Git 儲存庫與推送至 GitHub (Sinoro-Code/-) ..."
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: sync latest VisionPOS updates to Google Drive and GitHub"
fi

if git push -u origin main 2>/dev/null; then
  echo "  -> 已直接推送至 https://github.com/Sinoro-Code/-.git"
else
  echo "  -> 本地 main 分支已更新至最新 Commit: $(git rev-parse --short HEAD)"
fi

echo "[4/4] 同步完成！"
