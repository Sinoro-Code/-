# VisionPOS Edge V3 — 極速視覺辨識庫存管理、即時產品資訊與 POS 結帳系統

專為 **Xiaomi 15 (Android 15 / HyperOS)**、各型智慧手機、平板、筆電、電腦與監控/IP 攝影機打造的零延遲拍照建檔、即時視覺 + 條碼雙模掃描辨識、即時庫存管理與購物車結帳系統。

## V3 核心特色

- **📱 原生簽章 Android APK (`VisionPOS-Xiaomi15.apk`)**：內建虛擬安全來源 (`https://visionpos.local`)，100% 離線亦支援 WebRTC 即時鏡頭預覽、補光燈 (`Torch`)、Xiaomi 15 徠卡原生相機拍照回傳、硬體條碼引擎 (`BarcodeDetector`)、`IndexedDB` 無上限商品庫與原生檔案匯出分享。
- **🧠 `CCVD-144 v3` 抗色溫與前景顯著性演算法**：內建飽和度阻尼 **Von Kries 灰世界自動白平衡**（克服 `2700K` 暖黃光至 `8500K` 冷白光色偏）與 **邊框對比前景顯著性權重**，並具備相似雙胞胎商品邊際門檻 (`Margin Gate >= 0.020`) 與 3 幀時間遲滯防抖。
- **⚡ 萬級商品極速檢索 + 條碼/掃描槍混合加速**：連續平坦質心矩陣 (`Float32Array(N * 144)`) 於 `5,000` 筆商品下僅需 **`~7–10 ms`** 完成比對；同時支援相機 `EAN-13 / QR / Code-128` 條碼與外接藍牙/USB 掃描槍 (`< 0.3 ms` 100% 精準鎖定)。
- **🛍️ 精準客戶掃描介面 & Kiosk 顧客自助鎖定**：客戶端掃描命中時僅純淨顯示 **產品名稱、產品價格、產品介紹、加入購物車** 四項資訊；未命中立即顯示 **`未建檔`**；支援一鍵切換「顧客自助模式」（PIN `1234` 解鎖店長後台）。
- **🌱 極致省電與小檔案縮圖**：`128×128` WebP (`0.60`) 超輕量縮圖 (`~1.8–3.2 KB`)、`16×16` 動態偵測智慧休眠 (`2.5 FPS`)、背景閒置 **`10 秒`** 自動釋放相機感光元件並在返回前景時自動喚醒。
- **💾 斷網不丟單與企業級帳本**：購物車持久化 (`localStorage`)、`IndexedDB` 鏡像、離線 Outbox 佇列自動補傳、伺服器原子化寫入鎖、每日 `JSONL` 訂單帳本、冪等防重複扣庫存、CSV/JSON 批次匯出入與熱感應電子收據列印。

## 快速啟動與封裝指令

```bash
# 啟動本地/區網低延遲伺服器 (Brotli + ETag + SSE 即時同步)
node server.js

# 重新封裝單檔行動版 HTML (VisionPOS-Xiaomi15.html)
node build-standalone.js

# 重新編譯並執行 V2+V3 簽章 Android 安裝檔 (VisionPOS-Xiaomi15.apk)
bash build-apk.sh

# 一鍵同步 HTML + APK 至 Google 雲端硬碟 (原地覆寫並清理舊檔) 與 GitHub
bash sync.sh
```
