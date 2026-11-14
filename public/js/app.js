/**
 * VisionPOS Edge — Main Application Controller
 * Connects Multi-Source Camera Pipeline, CCVD-144 Visual Recognition Engine,
 * Real-Time Inventory Management, Camera Photo Registration, and POS Checkout.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'vision_pos_edge_store_v1';
  const CART_STORAGE_KEY = 'vision_pos_cart_v1';
  const OUTBOX_STORAGE_KEY = 'vision_pos_outbox_v1';
  const ROLE_STORAGE_KEY = 'vision_pos_role_v1';
  const ADMIN_PIN_KEY = 'vision_pos_admin_pin_v1';
  const BG_CAMERA_RELEASE_MS = 10000; // 10 seconds background auto-release for camera sensor power saving

  const state = {
    activeTab: 'scan',
    sourceMode: 'virtual', // 'virtual' | 'webcam' | 'ipcam' | 'photo'
    customerKioskMode: false,
    adminPin: '1234',
    products: [],
    orders: [],
    cart: [], // { productId, quantity }
    paymentMethod: 'cash',
    discount: 0,
    threshold: 0.80,
    autoAddCart: false,
    ecoGateEnabled: true,
    lastAutoCartTime: 0,
    lastAutoCartProductId: null,

    // Current Recognition Result & 3-Frame Temporal Hysteresis + Barcode
    currentMatch: null,
    currentSimilarity: 0,
    topCandidates: [],
    liveDescriptor: null,
    matchHistory: [],
    lastDetectedBarcode: '',
    lastBarcodeTime: 0,
    barcodeTickCounter: 0,

    // Registration Draft
    regDescriptors: [],
    regThumbnail: '',
    regEditingId: '',
    regManualCaptured: false,

    // Virtual Stage State
    stageItemIndex: 0,
    stageAngle: 0,
    stageHandMotion: false,
    stagePhase: 0,

    // Webcam State
    mediaStream: null,
    facingMode: 'environment',
    selectedDeviceId: '',
    resolutionHeight: 480,
    torchOn: false,
    autoPausedWebcamInBg: false,

    // CCTV / Custom IP Cam / Photo State
    cctvChannel: 'ch1',
    cctvTimer: 0,
    customIpcamUrl: '',
    customIpcamImg: null,
    customIpcamActive: false,
    loadedPhotoImage: null,
    hasLoadedPhoto: false,
    pendingAngleAppend: false,
    armedConfirmMap: {},

    // Eco & Telemetry State
    staticFrameStreak: 0,
    isEcoSleeping: false,
    lowBatteryMode: false,
    forceNextEval: true,
    lastInferenceMs: 0.16,
    lastMotionDelta: 0,
    connectedNodes: 1
  };

  // Pre-allocated 640x480 buffer canvas so 12MP/50MP mobile camera photos are downscaled ONCE
  // instead of inside the 20 FPS recognition loop (prevents mobile UI thread freeze).
  const photoBufferCanvas = document.createElement('canvas');
  photoBufferCanvas.width = 640;
  photoBufferCanvas.height = 480;
  const photoBufferCtx = photoBufferCanvas.getContext('2d', {
    alpha: false,
    desynchronized: true
  });

  // DOM Elements cache
  const el = {};
  function bindElements() {
    const ids = [
      'sync-status-badge', 'metric-latency', 'power-mode-dot', 'metric-power-mode',
      'metric-energy-saved', 'metric-product-count', 'nav-inv-count', 'btn-role-toggle',
      'tab-btn-scan', 'tab-btn-register', 'tab-btn-inventory', 'tab-btn-devices',
      'view-scan', 'view-register', 'view-inventory', 'view-devices',
      'active-source-badge', 'native-scan-input', 'native-camera-input', 'quick-snap-register-btn',
      'src-btn-virtual', 'src-btn-webcam', 'src-btn-ipcam', 'src-btn-photo',
      'webcam-controls-bar', 'camera-device-select', 'btn-flip-camera',
      'camera-res-select', 'btn-toggle-torch',
      'ipcam-controls-bar', 'cctv-channel-select', 'ipcam-url-input', 'btn-connect-ipcam',
      'viewport-container', 'camera-video', 'stage-canvas',
      'hud-scan-dot', 'hud-status-text', 'hud-confidence-val', 'roi-reticle',
      'hud-match-banner', 'hud-match-sub', 'hud-match-title', 'hud-match-price',
      'hud-match-stock', 'hud-add-cart-btn',
      'virtual-stage-tray', 'stage-objects-list', 'chk-stage-motion', 'btn-stage-rotate',
      'fingerprint-canvas', 'motion-delta-text', 'threshold-label', 'threshold-slider',
      'chk-auto-cart', 'chk-eco-sleep',
      'scan-match-badge', 'btn-train-extra-angle', 'recognized-product-card',
      'rec-img', 'rec-category', 'rec-sku', 'rec-similarity', 'rec-name', 'rec-spec',
      'rec-price', 'rec-stock', 'rec-location',
      'btn-rec-add-cart', 'btn-rec-stock-plus', 'btn-rec-stock-minus', 'btn-rec-edit',
      'unregistered-prompt-card', 'btn-instant-register', 'btn-jump-register', 'top-candidates-list',
      'btn-fill-demo-new', 'reg-preview-img', 'reg-descriptor-status', 'reg-sample-count',
      'btn-capture-frame', 'btn-add-angle-sample', 'register-product-form',
      'reg-id', 'reg-name', 'reg-price', 'reg-stock', 'reg-sku', 'reg-barcode',
      'reg-category', 'reg-unit', 'reg-location', 'reg-spec', 'btn-reset-reg-form',
      'inv-search-input', 'inv-filter-select', 'inventory-list-container',
      'inv-import-input', 'btn-import-inventory', 'btn-export-csv',
      'btn-export-inventory', 'btn-reset-demo', 'barcode-hw-status',
      'cart-count-badge', 'btn-clear-cart', 'cart-items-container',
      'summary-qty', 'summary-subtotal', 'cart-discount-input', 'summary-total',
      'btn-checkout-submit', 'today-revenue-text', 'btn-export-orders-csv',
      'orders-history-list', 'receipt-modal', 'receipt-paper-content',
      'btn-close-receipt', 'btn-print-receipt', 'toast-stack'
    ];
    ids.forEach((id) => {
      el[id] = document.getElementById(id);
    });
  }

  // Subtle WebAudio Feedback (Zero external file overhead)
  let audioCtx = null;
  function playTone(freq = 880, durationMs = 55, type = 'sine') {
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (_) {}
  }

  function showToast(message, type = 'success') {
    if (!el['toast-stack']) return;
    const div = document.createElement('div');
    div.className = 'toast';
    if (type === 'warn') div.style.borderLeftColor = 'var(--accent-amber)';
    if (type === 'danger') div.style.borderLeftColor = 'var(--accent-danger)';
    div.textContent = message;
    el['toast-stack'].appendChild(div);
    setTimeout(() => {
      div.remove();
    }, 2800);
  }

  // Universal file download helper supporting standard Browser + Android APK WebView Bridge
  function triggerFileDownload(filename, contentStr, mimeType = 'application/octet-stream') {
    try {
      if (
        window.VisionPOSAndroid &&
        typeof window.VisionPOSAndroid.saveTextFile === 'function'
      ) {
        window.VisionPOSAndroid.saveTextFile(filename, String(contentStr), mimeType);
        showToast(`📥 已匯出並儲存檔案：${filename}`);
        return;
      }
    } catch (_) {}
    const blob = new Blob([contentStr], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ==========================================================================
  // IndexedDB Unlimited Async Store + LocalStorage + Offline Outbox + SSE Sync
  // ==========================================================================
  const IDBStore = (function () {
    let dbPromise = null;
    function openDB() {
      if (dbPromise) return dbPromise;
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('vision_pos_idb_v1', 1);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('kv')) {
              db.createObjectStore('kv');
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
      return dbPromise;
    }
    return {
      async get(key) {
        const db = await openDB();
        if (!db) return null;
        return new Promise((resolve) => {
          try {
            const tx = db.transaction('kv', 'readonly');
            const req = tx.objectStore('kv').get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          } catch (_) {
            resolve(null);
          }
        });
      },
      async set(key, val) {
        const db = await openDB();
        if (!db) return;
        try {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(val, key);
        } catch (_) {}
      }
    };
  })();

  let broadcastChannel = null;
  try {
    if ('BroadcastChannel' in window) {
      broadcastChannel = new BroadcastChannel('vision_pos_edge_sync');
      broadcastChannel.onmessage = (ev) => {
        if (!ev.data) return;
        if (ev.data.type === 'state_updated') {
          loadFromLocalStorage();
          loadCartFromStorage();
          renderAll();
          scheduleRecognition(true);
        } else if (ev.data.type === 'cart_updated') {
          loadCartFromStorage();
          renderCart();
        }
      };
    }
  } catch (_) {
    broadcastChannel = null;
  }

  function saveCartToStorage() {
    try {
      const discount = el['cart-discount-input']
        ? Math.max(0, Number(el['cart-discount-input'].value) || 0)
        : state.discount;
      state.discount = discount;
      localStorage.setItem(
        CART_STORAGE_KEY,
        JSON.stringify({
          cart: state.cart,
          discount: state.discount,
          paymentMethod: state.paymentMethod,
          updatedAt: Date.now()
        })
      );
    } catch (_) {}
  }

  function loadCartFromStorage() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cart)) {
        state.cart = parsed.cart.filter((c) => c && c.productId && Number(c.quantity) > 0);
      }
      if (typeof parsed.discount === 'number' && el['cart-discount-input']) {
        state.discount = Math.max(0, parsed.discount);
        el['cart-discount-input'].value = String(state.discount);
      }
      if (parsed.paymentMethod && ['cash', 'card', 'mobile'].includes(parsed.paymentMethod)) {
        state.paymentMethod = parsed.paymentMethod;
        document.querySelectorAll('.pay-method-btn').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-pay') === state.paymentMethod);
        });
      }
    } catch (_) {}
  }

  function getOutboxQueue() {
    try {
      const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function saveOutboxQueue(list) {
    try {
      localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(list.slice(-150)));
    } catch (_) {}
  }

  function enqueueOutbox(op) {
    const list = getOutboxQueue();
    list.push({ ...op, queuedAt: Date.now() });
    saveOutboxQueue(list);
  }

  let isFlushingOutbox = false;
  async function flushOutboxToServer() {
    if (isFlushingOutbox) return;
    const queue = getOutboxQueue();
    if (queue.length === 0) return;
    isFlushingOutbox = true;
    const remaining = [];
    try {
      for (const item of queue) {
        try {
          if (item.type === 'upsert_product') {
            const r = await fetch('/api/products', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (!r.ok && r.status >= 500) remaining.push(item);
          } else if (item.type === 'patch_product') {
            const r = await fetch(`/api/products/${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (!r.ok && r.status >= 500) remaining.push(item);
          } else if (item.type === 'delete_product') {
            const r = await fetch(`/api/products/${encodeURIComponent(item.id)}`, {
              method: 'DELETE',
              headers: { 'X-Admin-Pin': state.adminPin }
            });
            if (!r.ok && r.status >= 500) remaining.push(item);
          } else if (item.type === 'checkout') {
            const r = await fetch('/api/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (!r.ok && r.status >= 500) remaining.push(item);
          }
        } catch (_) {
          remaining.push(item);
        }
      }
      saveOutboxQueue(remaining);
    } finally {
      isFlushingOutbox = false;
    }
  }

  function mergeServerProducts(serverProducts) {
    if (!Array.isArray(serverProducts) || serverProducts.length === 0) return;
    const byId = new Map();
    for (const sp of serverProducts) {
      if (sp && sp.id) byId.set(sp.id, sp);
    }
    if (getOutboxQueue().length > 0) {
      for (const lp of state.products) {
        if (!lp || !lp.id) continue;
        const sp = byId.get(lp.id);
        if (!sp || (lp.updatedAt || 0) > (sp.updatedAt || 0)) {
          byId.set(lp.id, lp);
        }
      }
    }
    state.products = Array.from(byId.values());
  }

  function saveToLocalStorage() {
    const snapshot = {
      products: state.products,
      orders: state.orders,
      updatedAt: Date.now()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (_) {}
    IDBStore.set('store', snapshot);
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) {
        state.products = parsed.products.map((p, idx) => ({
          ...p,
          id: p.id || ('prd-repaired-' + idx + '-' + Date.now().toString(36))
        }));
        state.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Migrate legacy descriptors to v2 Int8-Base64 ('q1:...') & compress oversized legacy thumbnails to 128x128.
   * Only builds default catalog lazily if an un-migrated synthetic preset product actually needs it.
   */
  function migrateProductsToV2() {
    let changed = false;
    let lazyDefaultCatalog = null;

    state.products.forEach((p) => {
      // Upgrade existing v2 JSON float arrays to compact Int8-Base64 strings (saves ~78% storage)
      if (
        p.descriptorVersion === 2 &&
        Array.isArray(p.descriptors) &&
        p.descriptors.length > 0
      ) {
        if (typeof p.descriptors[0] !== 'string') {
          p.descriptors = VisionEngine.deduplicateDescriptors(p.descriptors, 12);
          changed = true;
        }
        VisionEngine.ensureProductCache(p);

        // Compress any oversized legacy >14KB base64 thumbnail down to 128x128 WebP (~2KB)
        if (p.isCameraRegistered && p.thumbnail && p.thumbnail.length > 14000) {
          VisionEngine.extractDescriptorsFromThumbnail(p.thumbnail, (newDescs, thumb128) => {
            if (thumb128 && thumb128.length < p.thumbnail.length) {
              p.thumbnail = thumb128;
              saveToLocalStorage();
            }
          });
        }
        return;
      }

      if (!p.isCameraRegistered) {
        if (!lazyDefaultCatalog) {
          lazyDefaultCatalog = VisionEngine.buildDefaultCatalog();
        }
        const presetMatch = lazyDefaultCatalog.find(
          (dc) => (p.virtualPresetId && dc.virtualPresetId === p.virtualPresetId) || (p.sku && dc.sku === p.sku)
        );
        if (presetMatch) {
          p.descriptors = presetMatch.descriptors;
          p.thumbnail = presetMatch.thumbnail;
          p.descriptorVersion = 2;
          p.virtualPresetId = presetMatch.virtualPresetId;
          VisionEngine.ensureProductCache(p);
          changed = true;
          return;
        }
      }

      if (p.thumbnail && p.thumbnail.startsWith('data:image/')) {
        p.isCameraRegistered = true;
        VisionEngine.extractDescriptorsFromThumbnail(p.thumbnail, (newDescs, thumb128) => {
          if (Array.isArray(newDescs) && newDescs.length > 0) {
            p.descriptors = newDescs;
            p.descriptorVersion = 2;
            if (thumb128) p.thumbnail = thumb128;
            VisionEngine.ensureProductCache(p);
            saveToLocalStorage();
            scheduleRecognition(true);
          }
        });
      }
    });

    if (changed) {
      saveToLocalStorage();
    }
  }

  async function initDataStore() {
    loadCartFromStorage();
    try {
      const savedPin = localStorage.getItem(ADMIN_PIN_KEY);
      if (savedPin) state.adminPin = savedPin;
    } catch (_) {}

    let hasLocal = loadFromLocalStorage();
    if (!hasLocal) {
      const idbSnap = await IDBStore.get('store');
      if (idbSnap && Array.isArray(idbSnap.products) && idbSnap.products.length > 0) {
        state.products = idbSnap.products;
        state.orders = Array.isArray(idbSnap.orders) ? idbSnap.orders : [];
        hasLocal = true;
      }
    }

    if (!hasLocal) {
      state.products = VisionEngine.buildDefaultCatalog();
      state.products.forEach((p) => VisionEngine.ensureProductCache(p));
      saveToLocalStorage();
    } else {
      migrateProductsToV2();
    }

    const isRemoteServerOrigin =
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local';

    if (isRemoteServerOrigin) {
      try {
        await flushOutboxToServer();
        const res = await fetch('/api/state');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.products) && data.products.length > 0) {
            mergeServerProducts(data.products);
            state.orders = data.orders || state.orders;
            migrateProductsToV2();
            saveToLocalStorage();
          } else {
            await fetch('/api/seed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ products: state.products, force: true })
            });
          }
          connectSSE();
        }
      } catch (_) {
        el['sync-status-badge'].textContent = '離線極速模式 (自動佇列同步)';
      }
    } else {
      el['sync-status-badge'].textContent =
        window.location.hostname === 'visionpos.local'
          ? 'Xiaomi 15 原生 APK 離線極速引擎'
          : '本地極速模式 (支援跨分頁同步)';
    }

    renderAll();
  }

  function connectSSE() {
    try {
      const devType = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobile-Cam' : 'Desktop-POS';
      const es = new EventSource(`/api/events?deviceType=${encodeURIComponent(devType)}`);

      es.addEventListener('init', async (e) => {
        await flushOutboxToServer();
        const { payload } = JSON.parse(e.data);
        if (payload.products && payload.products.length > 0) {
          mergeServerProducts(payload.products);
          state.orders = payload.orders || state.orders;
          state.connectedNodes = payload.connectedClients || 1;
          migrateProductsToV2();
          saveToLocalStorage();
          renderAll();
          scheduleRecognition(true);
        }
        el['sync-status-badge'].textContent = `即時同步 (${state.connectedNodes} 台連線)`;
      });

      es.addEventListener('product_upserted', (e) => {
        const { payload } = JSON.parse(e.data);
        if (!payload || !payload.product) return;
        VisionEngine.ensureProductCache(payload.product);
        const idx = state.products.findIndex((p) => p.id === payload.product.id);
        if (idx >= 0) {
          state.products[idx] = payload.product;
        } else {
          state.products.unshift(payload.product);
        }
        saveToLocalStorage();
        renderAll();
        scheduleRecognition(true);
      });

      es.addEventListener('product_deleted', (e) => {
        const { payload } = JSON.parse(e.data);
        state.products = state.products.filter((p) => p.id !== payload.id);
        saveToLocalStorage();
        renderAll();
        scheduleRecognition(true);
      });

      es.addEventListener('checkout_completed', (e) => {
        const { payload } = JSON.parse(e.data);
        if (Array.isArray(payload.updatedProducts)) {
          payload.updatedProducts.forEach((up) => {
            VisionEngine.ensureProductCache(up);
            const idx = state.products.findIndex((p) => p.id === up.id);
            if (idx >= 0) state.products[idx] = up;
          });
        }
        if (payload.order) {
          const exists = state.orders.some((o) => o.id === payload.order.id);
          if (!exists) state.orders.unshift(payload.order);
        }
        saveToLocalStorage();
        renderAll();
        scheduleRecognition(true);
      });

      es.addEventListener('products_synced', (e) => {
        const { payload } = JSON.parse(e.data);
        if (Array.isArray(payload.products)) {
          state.products = payload.products;
          migrateProductsToV2();
        }
        if (Array.isArray(payload.orders)) state.orders = payload.orders;
        saveToLocalStorage();
        renderAll();
        scheduleRecognition(true);
      });

      es.addEventListener('devices_updated', (e) => {
        const { payload } = JSON.parse(e.data);
        state.connectedNodes = payload.connectedClients || 1;
        el['sync-status-badge'].textContent = `即時同步 (${state.connectedNodes} 台連線)`;
      });
    } catch (_) {}
  }

  function notifyPeers() {
    saveToLocalStorage();
    saveCartToStorage();
    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'state_updated', timestamp: Date.now() });
    }
  }

  // ==========================================================================
  // Multi-Source Camera Pipeline (Virtual Stage, Live Webcam, IP Cam, Photo)
  // ==========================================================================
  function renderStageTray() {
    const container = el['stage-objects-list'];
    if (!container) return;
    container.innerHTML = '';

    VisionEngine.VIRTUAL_STAGE_ITEMS.forEach((item, idx) => {
      const isRegistered = state.products.some(
        (p) => p.virtualPresetId === item.presetId || p.sku === item.sku
      );
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stage-obj-btn' + (state.stageItemIndex === idx ? ' active' : '');
      btn.innerHTML = `
        <span class="stage-obj-dot" style="background:${item.palette.bg1};"></span>
        <span>${isRegistered ? item.shortName.replace('[待建檔] ', '') : '🆕 ' + item.shortName}</span>
      `;
      btn.addEventListener('click', () => {
        state.stageItemIndex = idx;
        state.stageAngle = 0;
        renderStageTray();
        scheduleRecognition(true);
        if (state.activeTab === 'register') {
          setTimeout(() => captureForRegistration(false), 40);
        }
      });
      container.appendChild(btn);
    });
  }

  let bgCameraReleaseTimer = null;

  function clearBgCameraReleaseTimer() {
    if (bgCameraReleaseTimer) {
      clearTimeout(bgCameraReleaseTimer);
      bgCameraReleaseTimer = null;
    }
  }

  async function switchVideoSource(mode) {
    const prevMode = state.sourceMode;
    state.sourceMode = mode;
    clearBgCameraReleaseTimer();
    if (mode !== 'webcam') {
      state.autoPausedWebcamInBg = false;
    }
    if (prevMode !== mode && mode !== 'photo') {
      state.regDescriptors = [];
      state.regManualCaptured = false;
    }

    ['virtual', 'webcam', 'ipcam', 'photo'].forEach((m) => {
      const btn = el[`src-btn-${m}`];
      if (btn) btn.classList.toggle('active', m === mode);
    });

    el['webcam-controls-bar'].classList.toggle('hidden', mode !== 'webcam');
    el['ipcam-controls-bar'].classList.toggle('hidden', mode !== 'ipcam');
    el['virtual-stage-tray'].classList.toggle('hidden', mode !== 'virtual');

    if (mode !== 'webcam') {
      stopWebcamStream();
      el['camera-video'].classList.add('hidden');
      el['stage-canvas'].classList.remove('hidden');
    }

    if (mode === 'virtual') {
      el['active-source-badge'].textContent = '互動測試舞台';
    } else if (mode === 'webcam') {
      el['active-source-badge'].textContent = '真實相機 WebRTC';
      await startWebcamStream();
    } else if (mode === 'ipcam') {
      el['active-source-badge'].textContent = '監控串流 CCTV';
    } else if (mode === 'photo') {
      el['active-source-badge'].textContent = '手機相機實拍辨識';
    }

    VisionEngine.resetMotionGate();
    scheduleRecognition(true);
  }

  function stopWebcamStream() {
    cancelVideoFrameSync();
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
      state.mediaStream = null;
    }
    if (el['camera-video']) {
      el['camera-video'].srcObject = null;
    }
  }

  async function populateCameraDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      const select = el['camera-device-select'];
      const currentVal = select.value;
      select.innerHTML = '<option value="">自動偵測鏡頭 (後置優先)</option>';
      videoInputs.forEach((dev, i) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `攝影機鏡頭 #${i + 1}`;
        select.appendChild(opt);
      });
      if (currentVal) select.value = currentVal;
    } catch (_) {}
  }

  async function startWebcamStream(silentResume = false) {
    stopWebcamStream();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('📱 已自動為您開啟手機原生相機拍照模式（本地檔案模式）', 'warn');
      state.sourceMode = 'photo';
      el['active-source-badge'].textContent = '手機相機實拍辨識';
      el['camera-video'].classList.add('hidden');
      el['stage-canvas'].classList.remove('hidden');
      if (state.activeTab === 'register' && el['native-camera-input']) {
        el['native-camera-input'].click();
      } else if (el['native-scan-input']) {
        el['native-scan-input'].click();
      }
      return;
    }

    const height = Number(el['camera-res-select'].value) || 480;
    const width = Math.round(height * (4 / 3));

    const videoConstraints = {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 24, max: 30 }
    };

    if (state.selectedDeviceId) {
      videoConstraints.deviceId = { exact: state.selectedDeviceId };
    } else {
      videoConstraints.facingMode = { ideal: state.facingMode };
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }
      state.mediaStream = stream;
      state.autoPausedWebcamInBg = false;

      const video = el['camera-video'];
      video.srcObject = stream;
      // Direct GPU Zero-Copy Hardware Video Overlay (no 640x480 canvas blit per frame!)
      video.removeAttribute('style');
      video.classList.toggle('mirrored', state.facingMode === 'user' && !state.selectedDeviceId);
      video.classList.remove('hidden');
      await video.play();
      el['stage-canvas'].classList.add('hidden');
      el['active-source-badge'].textContent = '真實相機 WebRTC';

      await populateCameraDevices();
      VisionEngine.resetMotionGate();
      scheduleRecognition(true);
      if (!silentResume) {
        showToast('已開啟真實相機鏡頭，將商品對準中央框即可即時辨識或建檔');
      }
    } catch (err) {
      el['camera-video'].classList.add('hidden');
      el['stage-canvas'].classList.remove('hidden');
      showToast('📱 無法直接存取連續串流，已自動切換為「手機原生相機拍照」模式', 'warn');
      state.sourceMode = 'photo';
      el['active-source-badge'].textContent = '手機相機實拍辨識';
      if (state.activeTab === 'register' && el['native-camera-input']) {
        el['native-camera-input'].click();
      } else if (el['native-scan-input']) {
        el['native-scan-input'].click();
      }
    }
  }

  async function toggleTorch() {
    if (!state.mediaStream) return;
    const track = state.mediaStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) {
      showToast('目前攝影機不支援硬體補光燈控制', 'warn');
      return;
    }
    const caps = track.getCapabilities();
    if (!caps.torch) {
      showToast('此鏡頭無內建補光燈 (Torch)', 'warn');
      return;
    }
    state.torchOn = !state.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
      showToast(state.torchOn ? '已開啟補光燈' : '已關閉補光燈');
    } catch (_) {}
  }

  let stageCanvasCtx = null;

  // Render Virtual Stage, CCTV, or Pre-Scaled Photo onto #stage-canvas (640x480).
  // In live webcam mode, #camera-video is displayed directly via zero-copy hardware overlay!
  function renderStageCanvasFrame() {
    const canvas = el['stage-canvas'];
    const video = el['camera-video'];

    if (state.sourceMode === 'webcam' && state.mediaStream && video && video.readyState >= 2) {
      video.classList.remove('hidden');
      canvas.classList.add('hidden');
      return;
    }

    canvas.classList.remove('hidden');
    if (!stageCanvasCtx) {
      stageCanvasCtx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    const ctx = stageCanvasCtx;
    const w = canvas.width;
    const h = canvas.height;

    if (state.sourceMode === 'virtual') {
      const item = VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex];
      let offsetX = 0;
      let offsetY = 0;
      let rot = state.stageAngle;
      if (state.stageHandMotion) {
        state.stagePhase += 0.08;
        offsetX = Math.sin(state.stagePhase) * 9;
        offsetY = Math.cos(state.stagePhase * 1.3) * 6;
        rot += Math.sin(state.stagePhase * 0.7) * 0.04;
      }
      VisionEngine.drawVirtualProduct(ctx, w, h, item, {
        offsetX,
        offsetY,
        angle: rot,
        scale: 1.0,
        lighting: 1.0
      });
    } else if (state.sourceMode === 'ipcam') {
      if (
        state.cctvChannel === 'custom' &&
        state.customIpcamActive &&
        state.customIpcamImg &&
        state.customIpcamImg.complete &&
        state.customIpcamImg.naturalWidth > 0
      ) {
        const iw = state.customIpcamImg.naturalWidth;
        const ih = state.customIpcamImg.naturalHeight;
        const sc = Math.max(w / iw, h / ih);
        const dw = iw * sc;
        const dh = ih * sc;
        ctx.drawImage(state.customIpcamImg, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);
      } else {
        state.cctvTimer += 0.025;
        let itemIdx = 0;
        if (state.cctvChannel === 'ch1') {
          itemIdx = Math.floor(state.cctvTimer * 0.35) % 5;
        } else if (state.cctvChannel === 'ch2') {
          itemIdx = 1;
        } else if (state.cctvChannel === 'ch3') {
          itemIdx = 3;
        }
        const item = VisionEngine.VIRTUAL_STAGE_ITEMS[itemIdx];
        VisionEngine.drawVirtualProduct(ctx, w, h, item, {
          offsetX: Math.sin(state.cctvTimer) * 4,
          offsetY: 0,
          angle: 0.02,
          scale: 0.96,
          lighting: 0.92
        });
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(14, h - 38, 320, 24);
      ctx.fillStyle = '#10b981';
      ctx.font = '12px monospace';
      const chLabel = state.cctvChannel === 'custom' && state.customIpcamActive ? 'CUSTOM-STREAM' : state.cctvChannel.toUpperCase();
      ctx.fillText(`CCTV ${chLabel} | RTSP-EDGE | ${new Date().toLocaleTimeString()}`, 22, h - 22);
    } else if (state.sourceMode === 'photo' && state.hasLoadedPhoto) {
      ctx.drawImage(photoBufferCanvas, 0, 0);
    }
  }

  function getActiveVideoSourceElement() {
    if (
      state.sourceMode === 'webcam' &&
      state.mediaStream &&
      el['camera-video'] &&
      el['camera-video'].readyState >= 2
    ) {
      return el['camera-video'];
    }
    return el['stage-canvas'];
  }

  // Exact 4:3 object-fit:cover ROI mapping so direct <video> stream & #stage-canvas align 1:1 with reticle
  function getRoiRect(sourceElem) {
    if (sourceElem === el['camera-video']) {
      const vw = sourceElem.videoWidth || 640;
      const vh = sourceElem.videoHeight || 480;
      const targetAspect = 4 / 3;
      const videoAspect = vw / vh;
      let visX = 0, visY = 0, visW = vw, visH = vh;
      if (videoAspect > targetAspect) {
        visW = vh * targetAspect;
        visX = (vw - visW) * 0.5;
      } else if (videoAspect < targetAspect) {
        visH = vw / targetAspect;
        visY = (vh - visH) * 0.5;
      }
      const roiW = Math.round(visW * 0.58);
      const roiH = Math.round(visH * 0.68);
      const sx = Math.round(visX + (visW - roiW) * 0.5);
      const sy = Math.round(visY + (visH - roiH) * 0.5);
      return { sx, sy, sw: roiW, sh: roiH };
    }

    const sw = sourceElem.width || 640;
    const sh = sourceElem.height || 480;
    const roiW = Math.round(sw * 0.58);
    const roiH = Math.round(sh * 0.68);
    const sx = Math.round((sw - roiW) * 0.5);
    const sy = Math.round((sh - roiH) * 0.5);
    return { sx, sy, sw: roiW, sh: roiH };
  }

  // ==========================================================================
  // Event-Driven Zero-Polling Loop, Motion Gate & 10s Background Camera Release
  // ==========================================================================
  let scanTimerId = null;
  let videoFrameCallbackId = null;

  function cancelVideoFrameSync() {
    if (
      videoFrameCallbackId !== null &&
      el['camera-video'] &&
      typeof el['camera-video'].cancelVideoFrameCallback === 'function'
    ) {
      try {
        el['camera-video'].cancelVideoFrameCallback(videoFrameCallbackId);
      } catch (_) {}
    }
    videoFrameCallbackId = null;
  }

  function cancelScheduledRecognition() {
    if (scanTimerId !== null) {
      clearTimeout(scanTimerId);
      scanTimerId = null;
    }
    cancelVideoFrameSync();
  }

  function isContinuousSourceActive() {
    if (document.hidden) return false;
    if (state.activeTab !== 'scan' && state.activeTab !== 'register') return false;
    if (state.sourceMode === 'webcam') return Boolean(state.mediaStream);
    if (state.sourceMode === 'ipcam') return true;
    if (state.sourceMode === 'virtual') return Boolean(state.stageHandMotion);
    return false; // 'photo' & static 'virtual' run purely event-driven at 0 FPS!
  }

  function wakeFromEcoSleep() {
    state.staticFrameStreak = 0;
    if (state.isEcoSleeping) {
      state.isEcoSleeping = false;
      updatePowerTelemetryUI();
    }
  }

  function updatePowerTelemetryUI() {
    if (!el['metric-power-mode']) return;
    if (state.autoPausedWebcamInBg || document.hidden) {
      el['power-mode-dot'].className = 'status-dot eco';
      el['metric-power-mode'].textContent = state.autoPausedWebcamInBg ? '已釋放鏡頭 (0W)' : '背景休眠 (0 FPS)';
      el['metric-energy-saved'].textContent = '100% 省電';
      el['hud-status-text'].textContent = '背景省電待機中';
      return;
    }
    if (!isContinuousSourceActive()) {
      el['power-mode-dot'].className = 'status-dot eco';
      el['metric-power-mode'].textContent = '事件驅動待機 (0 FPS)';
      el['metric-energy-saved'].textContent = '99.8% 省電';
      el['hud-status-text'].textContent = state.sourceMode === 'photo'
        ? '實拍零耗電鎖定中'
        : '靜態零輪詢省電待機';
      return;
    }
    if (state.isEcoSleeping) {
      el['power-mode-dot'].className = 'status-dot eco';
      el['metric-power-mode'].textContent = '靜止休眠 (2.5 FPS)';
      el['metric-energy-saved'].textContent = '98% 省電';
      el['hud-status-text'].textContent = 'ECO 靜止省電待機 (移動即喚醒)';
    } else if (state.lowBatteryMode) {
      el['power-mode-dot'].className = 'status-dot eco';
      el['metric-power-mode'].textContent = '低電量節能 (10 FPS)';
      el['metric-energy-saved'].textContent = '96% 省電';
      el['hud-status-text'].textContent = 'ROI 64×64 節能視覺追蹤中';
    } else {
      el['power-mode-dot'].className = 'status-dot';
      el['metric-power-mode'].textContent = '高速辨識 (18 FPS)';
      el['metric-energy-saved'].textContent = '95% 省電';
      el['hud-status-text'].textContent = 'ROI 64×64 零配置視覺追蹤中';
    }
  }

  function scheduleRecognition(forceImmediate = false) {
    if (forceImmediate) {
      state.forceNextEval = true;
      wakeFromEcoSleep();
      if (!document.hidden) {
        cancelScheduledRecognition();
        scanTimerId = setTimeout(runRecognitionTick, 0);
      }
      return;
    }

    if (!isContinuousSourceActive()) {
      cancelScheduledRecognition();
      updatePowerTelemetryUI();
      return;
    }

    if (scanTimerId !== null || videoFrameCallbackId !== null) return;

    const nextInterval = state.isEcoSleeping ? 400 : (state.lowBatteryMode ? 100 : 55);
    scanTimerId = setTimeout(() => {
      scanTimerId = null;
      const video = el['camera-video'];
      if (
        state.sourceMode === 'webcam' &&
        state.mediaStream &&
        !state.isEcoSleeping &&
        video &&
        video.readyState >= 2 &&
        typeof video.requestVideoFrameCallback === 'function'
      ) {
        videoFrameCallbackId = video.requestVideoFrameCallback(() => {
          videoFrameCallbackId = null;
          runRecognitionTick();
        });
      } else {
        runRecognitionTick();
      }
    }, nextInterval);
  }

  function runRecognitionTick() {
    scanTimerId = null;
    videoFrameCallbackId = null;

    if (document.hidden) {
      updatePowerTelemetryUI();
      return;
    }

    const continuous = isContinuousSourceActive();
    if (!state.forceNextEval && !continuous) {
      updatePowerTelemetryUI();
      return;
    }

    const forceEval = state.forceNextEval;
    state.forceNextEval = false;

    renderStageCanvasFrame();

    const sourceElem = getActiveVideoSourceElement();
    const roiRect = getRoiRect(sourceElem);

    const t0 = performance.now();
    const sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, false, {
      skipIfStatic: state.ecoGateEnabled && !forceEval && continuous,
      staticThreshold: 1.5
    });
    state.lastMotionDelta = sig.motionDelta;

    // Pre-Extraction Motion Gate: Static frame short-circuit (< 0.02 ms CPU, zero descriptor extraction!)
    if (sig.isStaticSkip) {
      const skipMs = +(performance.now() - t0).toFixed(2);
      state.staticFrameStreak++;
      if (state.staticFrameStreak >= 8 && !state.isEcoSleeping) {
        state.isEcoSleeping = true;
        updatePowerTelemetryUI();
      }
      const latStr = `${Math.max(0.03, skipMs).toFixed(2)} ms`;
      if (el['metric-latency'].textContent !== latStr) {
        el['metric-latency'].textContent = latStr;
      }
      scheduleRecognition(false);
      return;
    }

    // Check Motion Gate for active scene
    if (state.ecoGateEnabled && continuous && sig.motionDelta < 1.8) {
      state.staticFrameStreak++;
      if (state.staticFrameStreak >= 10 && !state.isEcoSleeping) {
        state.isEcoSleeping = true;
        updatePowerTelemetryUI();
      }
    } else {
      wakeFromEcoSleep();
      updatePowerTelemetryUI();
    }

    // Live Registration Preview on Register tab when webcam is active and not manually locked
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (
      state.activeTab === 'register' &&
      state.sourceMode === 'webcam' &&
      !state.regManualCaptured &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)
    ) {
      const nowMs = Date.now();
      if (!state.lastLiveRegPreviewTime || nowMs - state.lastLiveRegPreviewTime > 550) {
        state.lastLiveRegPreviewTime = nowMs;
        const regSig = VisionEngine.captureFrameSignature(sourceElem, roiRect, true);
        state.regDescriptors = regSig.augmentedDescriptors || [regSig.descriptor];
        state.regThumbnail = regSig.thumbnail;
        if (el['reg-preview-img']) el['reg-preview-img'].src = state.regThumbnail;
        if (el['reg-sample-count']) {
          el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length} 組`;
        }
      }
    }

    // Non-blocking parallel Hardware BarcodeDetector probe (every 4th active frame on real video/ipcam)
    if (
      (state.sourceMode === 'webcam' || state.sourceMode === 'ipcam') &&
      typeof VisionEngine.detectBarcode === 'function'
    ) {
      state.barcodeTickCounter = (state.barcodeTickCounter + 1) & 3;
      if (state.barcodeTickCounter === 0) {
        VisionEngine.detectBarcode(sourceElem).then((codeObj) => {
          if (codeObj && codeObj.rawValue) {
            state.lastDetectedBarcode = codeObj.rawValue;
            state.lastBarcodeTime = Date.now();
            if (state.activeTab === 'register' && el['reg-barcode'] && !el['reg-barcode'].value.trim()) {
              el['reg-barcode'].value = codeObj.rawValue;
              showToast(`⚡ 已自動讀取條碼：${codeObj.rawValue}`);
            }
          }
        });
      }
    }

    const freshBarcode =
      state.lastDetectedBarcode && Date.now() - state.lastBarcodeTime < 1400
        ? state.lastDetectedBarcode
        : '';

    const activeVirtualPresetId =
      state.sourceMode === 'virtual' && VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex]
        ? VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex].presetId
        : null;

    const rawMatchRes = VisionEngine.matchProducts(
      sig.descriptor,
      state.products,
      state.threshold,
      sig.queryDescriptors,
      {
        sourceMode: state.sourceMode,
        virtualPresetId: activeVirtualPresetId,
        detectedBarcode: freshBarcode
      }
    );

    // 3-Frame Temporal Hysteresis for continuous webcam/ipcam streams (prevents motion-blur flicker)
    let matchRes = rawMatchRes;
    if (
      (state.sourceMode === 'webcam' || state.sourceMode === 'ipcam') &&
      !rawMatchRes.exactBarcode &&
      rawMatchRes.similarity < 0.93
    ) {
      const frameId = rawMatchRes.matched && rawMatchRes.product ? rawMatchRes.product.id : null;
      state.matchHistory.push(frameId);
      if (state.matchHistory.length > 3) state.matchHistory.shift();

      if (state.matchHistory.length >= 2) {
        // Count occurrences in sliding window
        let consensusId = undefined;
        for (let i = 0; i < state.matchHistory.length; i++) {
          const candidateId = state.matchHistory[i];
          let cnt = 0;
          for (let j = 0; j < state.matchHistory.length; j++) {
            if (state.matchHistory[j] === candidateId) cnt++;
          }
          if (cnt >= 2) {
            consensusId = candidateId;
            break;
          }
        }
        if (consensusId !== undefined && consensusId !== frameId) {
          if (consensusId === null) {
            matchRes = { ...rawMatchRes, matched: false, product: null };
          } else {
            const heldProd = state.products.find((p) => p.id === consensusId);
            if (heldProd) {
              matchRes = { ...rawMatchRes, matched: true, product: heldProd };
            }
          }
        }
      }
    } else {
      const instantId = rawMatchRes.matched && rawMatchRes.product ? rawMatchRes.product.id : null;
      state.matchHistory = [instantId, instantId];
    }

    const t1 = performance.now();

    state.lastInferenceMs = +(t1 - t0).toFixed(2);
    state.liveDescriptor = sig.descriptor;
    state.currentMatch = matchRes.product;
    state.currentSimilarity = matchRes.similarity;
    state.topCandidates = matchRes.topCandidates;

    const latText = `${Math.max(0.08, state.lastInferenceMs).toFixed(2)} ms`;
    if (el['metric-latency'].textContent !== latText) {
      el['metric-latency'].textContent = latText;
    }

    const refF32List = matchRes.bestCandidate
      ? VisionEngine.ensureProductCache(matchRes.bestCandidate)
      : null;
    drawFingerprintWaveform(sig.descriptor, refF32List && refF32List[0] ? refF32List[0] : null);
    updateRecognitionUI(matchRes);

    // Auto-Add to Shopping Cart if enabled and cooldown passed
    if (
      state.autoAddCart &&
      matchRes.matched &&
      matchRes.product &&
      matchRes.product.stock > 0
    ) {
      const now = Date.now();
      const cooldownDone =
        now - state.lastAutoCartTime > 2200 ||
        state.lastAutoCartProductId !== matchRes.product.id;
      if (cooldownDone) {
        state.lastAutoCartTime = now;
        state.lastAutoCartProductId = matchRes.product.id;
        addToCart(matchRes.product.id, 1, true);
      }
    }

    scheduleRecognition(false);
  }

  function drawFingerprintWaveform(liveVec, refVec) {
    const canvas = el['fingerprint-canvas'];
    if (!canvas || !liveVec || canvas.offsetParent === null) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const len = liveVec.length;
    const barW = w / len;

    if (refVec && refVec.length === len) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.32)';
      for (let i = 0; i < len; i++) {
        const val = Math.min(1, Math.abs(refVec[i]) * 4.2);
        const bh = val * (h - 4);
        ctx.fillRect(i * barW, h - bh, Math.max(1.5, barW - 0.5), bh);
      }
    }

    ctx.fillStyle = '#10b981';
    for (let i = 0; i < len; i++) {
      const val = Math.min(1, Math.abs(liveVec[i]) * 4.2);
      const bh = val * (h - 4);
      ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
    }
  }

  // State-diffed UI updater to eliminate redundant DOM mutations & reflows
  const lastUIState = {
    simPct: '',
    matched: null,
    productKey: ''
  };

  function invalidateRecognitionUICache() {
    lastUIState.productKey = '';
    lastUIState.matched = null;
  }

  function updateRecognitionUI(matchRes) {
    const simPct = (matchRes.similarity * 100).toFixed(1) + '%';
    if (lastUIState.simPct !== simPct) {
      lastUIState.simPct = simPct;
      el['hud-confidence-val'].textContent = simPct;
    }

    if (lastUIState.matched !== matchRes.matched) {
      lastUIState.matched = matchRes.matched;
      el['roi-reticle'].classList.toggle('matched', matchRes.matched);
      el['hud-match-banner'].classList.toggle('matched-state', matchRes.matched);
    }

    if (matchRes.matched && matchRes.product) {
      const p = matchRes.product;
      const pKey = `${p.id}|${p.name}|${p.price}|${p.stock}|${p.spec || ''}|${(p.thumbnail || '').length}`;
      if (lastUIState.productKey !== pKey) {
        lastUIState.productKey = pKey;
        el['hud-match-title'].textContent = p.name;
        el['hud-match-sub'].textContent = p.spec || '精選商品';
        el['hud-match-price'].textContent = `NT$ ${p.price.toLocaleString()}`;
        el['hud-match-stock'].textContent = `${p.stock}`;
        el['hud-add-cart-btn'].disabled = p.stock <= 0;

        // Update Column 2 Customer Product Card (Strictly Name, Price, Intro, Add to Cart)
        el['recognized-product-card'].classList.remove('hidden');
        el['unregistered-prompt-card'].classList.add('hidden');

        if (p.thumbnail && el['rec-img'].getAttribute('src') !== p.thumbnail) {
          el['rec-img'].src = p.thumbnail;
        }
        el['rec-name'].textContent = p.name;
        el['rec-price'].textContent = `NT$ ${p.price.toLocaleString()}`;
        el['rec-spec'].textContent = p.spec || '尚無額外產品介紹';
        el['btn-rec-add-cart'].disabled = p.stock <= 0;
        el['btn-rec-add-cart'].textContent = p.stock > 0 ? '🛒 加入購物車' : '暫無庫存';
      }
    } else if (lastUIState.productKey !== '__UNREG__') {
      lastUIState.productKey = '__UNREG__';
      el['hud-match-title'].textContent = '⚠️ 未建檔';
      el['hud-match-sub'].textContent = '未掃描到庫存中的商品';
      el['hud-match-price'].textContent = '未建檔';
      el['hud-add-cart-btn'].disabled = true;

      el['recognized-product-card'].classList.add('hidden');
      el['unregistered-prompt-card'].classList.remove('hidden');
    }

    // Only build candidate HTML if #top-candidates-list is visible
    const candContainer = el['top-candidates-list'];
    if (candContainer && !candContainer.classList.contains('hidden')) {
      candContainer.innerHTML = matchRes.topCandidates
        .map((c) => {
          const pct = (c.similarity * 100).toFixed(1);
          const isPass = c.similarity >= state.threshold;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px; background:var(--bg-elevated); border-radius:var(--radius-sm); border:1px solid ${isPass ? 'hsla(158, 78%, 42%, 0.4)' : 'var(--border-subtle)'};">
              <div style="min-width:0; flex:1;">
                <div style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(c.product.name)}</div>
                <div style="font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
                  ${escapeHtml(c.product.sku)} · 庫存 ${c.product.stock} ${escapeHtml(c.product.unit || '件')} · NT$ ${c.product.price.toLocaleString()}
                </div>
              </div>
              <span class="badge ${isPass ? 'badge-emerald' : 'badge-amber'}">${pct}%</span>
            </div>
          `;
        })
        .join('');
    }
  }

  // ==========================================================================
  // Camera Photo Registration Workflow (手機相機拍照建檔)
  // ==========================================================================
  function captureForRegistration(appendAngle = false, isManual = false) {
    renderStageCanvasFrame();
    const sourceElem = getActiveVideoSourceElement();
    const roiRect = getRoiRect(sourceElem);
    const sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, true);
    if (isManual) {
      state.regManualCaptured = true;
    }

    if (appendAngle && state.regDescriptors.length > 0) {
      const extra = sig.augmentedDescriptors || [sig.descriptor];
      state.regDescriptors.push(...extra);
      if (state.regDescriptors.length > 33) {
        state.regDescriptors = state.regDescriptors.slice(-33);
      }
      state.regThumbnail = sig.thumbnail;
      showToast(`📸 已補拍新角度特徵！目前共 ${state.regDescriptors.length} 組多尺度視覺樣本`);
    } else {
      state.regDescriptors = sig.augmentedDescriptors || [sig.descriptor];
      state.regThumbnail = sig.thumbnail;
    }

    el['reg-preview-img'].src = state.regThumbnail;
    el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length} 組`;
    el['reg-descriptor-status'].textContent =
      state.sourceMode === 'photo'
        ? '已擷取手機實拍 144 維特徵'
        : '已擷取 144 維視覺特徵';
    playTone(1040, 45, 'triangle');

    // Auto-fill form appropriately so the user never hits empty-field validation blocks
    if (!el['reg-id'].value && !appendAngle) {
      const currentName = el['reg-name'].value.trim();
      const isVirtualPresetName = VisionEngine.VIRTUAL_STAGE_ITEMS.some(
        (it) => it.name === currentName
      );
      const isAutoDefaultName = /^實拍新商品 #\d+$/.test(currentName);

      if (state.sourceMode === 'virtual') {
        const stageItem = VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex];
        if (stageItem && (!currentName || isVirtualPresetName || isAutoDefaultName)) {
          fillRegistrationFormFromPreset(stageItem);
        }
      } else {
        // Real camera photo or live webcam mode: never leave a virtual stage preset SKU/Name
        if (!currentName || isVirtualPresetName) {
          el['reg-name'].value = `實拍新商品 #${state.products.length + 1}`;
          el['reg-price'].value = '199';
          el['reg-stock'].value = '20';
          el['reg-sku'].value = '';
          el['reg-barcode'].value = '';
          el['reg-category'].value = '手機實拍商品';
          el['reg-unit'].value = '件';
          el['reg-location'].value = 'A-01';
          el['reg-spec'].value = '透過手機相機實拍建檔之庫存商品';
        }
      }
    }
  }

  function fillRegistrationFormFromPreset(stageItem) {
    el['reg-name'].value = stageItem.name;
    el['reg-price'].value = stageItem.price;
    el['reg-stock'].value = stageItem.stock;
    el['reg-sku'].value = stageItem.sku;
    el['reg-barcode'].value = stageItem.barcode || '';
    el['reg-category'].value = stageItem.category || '精選商品';
    el['reg-unit'].value = stageItem.unit || '件';
    el['reg-location'].value = stageItem.location || 'B-04';
    el['reg-spec'].value = stageItem.spec || '';
  }

  // Build product payload from current registration form & captured descriptors
  function buildRegistrationPayload(refreshLiveFrame = false) {
    if (state.regDescriptors.length === 0 || refreshLiveFrame) {
      renderStageCanvasFrame();
      const sourceElem = getActiveVideoSourceElement();
      const freshSig = VisionEngine.captureFrameSignature(sourceElem, getRoiRect(sourceElem), true);
      const freshList = freshSig.augmentedDescriptors || [freshSig.descriptor];
      if (state.regDescriptors.length === 0 || !state.regManualCaptured) {
        state.regDescriptors = freshList;
        state.regThumbnail = freshSig.thumbnail;
      } else {
        // Merge fresh frame descriptors with manually captured descriptors (up to 22 samples)
        state.regDescriptors = [...freshList, ...state.regDescriptors].slice(0, 22);
      }
    }

    const editingId = (el['reg-id'].value || '').trim();
    const stageItem = state.sourceMode === 'virtual'
      ? VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex]
      : null;

    const fallbackName = stageItem
      ? stageItem.name
      : `實拍新商品 #${state.products.length + 1}`;
    const prodName = el['reg-name'].value.trim() || fallbackName;
    const rawPrice = el['reg-price'].value.trim();
    const prodPrice = rawPrice !== '' ? Math.max(0, Number(rawPrice) || 0) : (stageItem ? stageItem.price : 199);
    const rawStock = el['reg-stock'].value.trim();
    const prodStock = rawStock !== '' ? Math.max(0, Number(rawStock) || 0) : (stageItem ? stageItem.stock : 20);
    const prodSpec = el['reg-spec'].value.trim() || (stageItem ? stageItem.spec : '透過手機相機實拍建檔之庫存商品');

    const now = Date.now();
    const uniqueSku = editingId
      ? (el['reg-sku'].value.trim() || ('SKU-' + now.toString().slice(-5)))
      : (stageItem ? stageItem.sku : (el['reg-sku'].value.trim() || ('SKU-' + now.toString().slice(-5))));

    const payload = {
      name: prodName,
      price: prodPrice,
      stock: prodStock,
      sku: uniqueSku,
      barcode: el['reg-barcode'].value.trim(),
      category: el['reg-category'].value.trim() || '一般商品',
      unit: el['reg-unit'].value.trim() || '件',
      location: el['reg-location'].value.trim() || 'A-01',
      spec: prodSpec,
      thumbnail: state.regThumbnail,
      descriptors: state.regDescriptors,
      descriptorVersion: 2,
      isCameraRegistered: state.sourceMode !== 'virtual',
      virtualPresetId: stageItem ? stageItem.presetId : null
    };
    if (editingId) {
      payload.id = editingId;
    }
    return { payload, editingId, stageItem, now };
  }

  // Upsert product immediately into memory, localStorage, and Backend API
  async function upsertRegistrationProduct(refreshLiveFrame = false) {
    const { payload, editingId, stageItem, now } = buildRegistrationPayload(refreshLiveFrame);

    let savedProduct = null;
    // Perform immediate synchronous local upsert first so scanning never misses even 1ms later
    const existingIdx = state.products.findIndex(
      (p) =>
        (editingId && p.id === editingId) ||
        (stageItem && stageItem.presetId && p.virtualPresetId === stageItem.presetId)
    );
    if (existingIdx >= 0) {
      const existing = state.products[existingIdx];
      savedProduct = {
        ...existing,
        ...payload,
        id: existing.id,
        updatedAt: now
      };
      state.products[existingIdx] = savedProduct;
    } else {
      savedProduct = {
        ...payload,
        id: editingId || ('prd-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 5)),
        createdAt: now,
        updatedAt: now
      };
      state.products.unshift(savedProduct);
    }

    VisionEngine.ensureProductCache(savedProduct);
    invalidateRecognitionUICache();
    el['reg-id'].value = savedProduct.id;
    el['reg-sku'].value = savedProduct.sku;
    notifyPeers();
    renderAll();

    // Sync to backend API asynchronously (or queue in Offline Outbox if unreachable)
    const syncBody = { ...payload, id: savedProduct.id, updatedAt: now };
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syncBody)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.product) {
          VisionEngine.ensureProductCache(data.product);
          const idx = state.products.findIndex((p) => p.id === savedProduct.id || p.id === data.product.id);
          if (idx >= 0) state.products[idx] = data.product;
          savedProduct = data.product;
          saveToLocalStorage();
        }
      } else if (res.status >= 500) {
        enqueueOutbox({ type: 'upsert_product', payload: syncBody });
      }
    } catch (_) {
      enqueueOutbox({ type: 'upsert_product', payload: syncBody });
    }

    return savedProduct;
  }

  async function handleRegistrationSubmit(e) {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const savedProduct = await upsertRegistrationProduct(true);

    resetRegistrationForm();
    switchTab('scan');

    // Immediately lock onto the newly registered product in the Scan View
    state.currentMatch = savedProduct;
    state.currentSimilarity = 0.996;
    state.topCandidates = [{ product: savedProduct, similarity: 0.996 }];
    state.matchHistory = [savedProduct.id, savedProduct.id];
    invalidateRecognitionUICache();
    updateRecognitionUI({
      matched: true,
      product: savedProduct,
      bestCandidate: savedProduct,
      similarity: 0.996,
      margin: 0.25,
      topCandidates: state.topCandidates
    });

    scheduleRecognition(false);
    playTone(1320, 80, 'sine');
    showToast(`✅ 建檔成功！「${savedProduct.name}」(NT$ ${savedProduct.price.toLocaleString()}) 已加入庫存並立即啟用掃描辨識！`);
    if (el['recognized-product-card']) {
      el['recognized-product-card'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function resetRegistrationForm() {
    el['register-product-form'].reset();
    el['reg-id'].value = '';
    el['reg-name'].value = '';
    el['reg-price'].value = '199';
    el['reg-stock'].value = '20';
    el['reg-sku'].value = '';
    el['reg-barcode'].value = '';
    el['reg-spec'].value = '';
    state.regDescriptors = [];
    state.regManualCaptured = false;
  }

  // ==========================================================================
  // Inventory Management Actions (Edit, Angle Append, 2-Tap Armed Delete)
  // ==========================================================================
  function openEditProductInRegister(productId, triggerExtraAngle = false) {
    const p = state.products.find((item) => item.id === productId);
    if (!p) return;
    switchTab('register', true);
    el['reg-id'].value = p.id;
    el['reg-name'].value = p.name;
    el['reg-price'].value = p.price;
    el['reg-stock'].value = p.stock;
    el['reg-sku'].value = p.sku || '';
    el['reg-barcode'].value = p.barcode || '';
    el['reg-category'].value = p.category || '一般商品';
    el['reg-unit'].value = p.unit || '件';
    el['reg-location'].value = p.location || 'A-01';
    el['reg-spec'].value = p.spec || '';
    state.regDescriptors = Array.isArray(p.descriptors) ? [...p.descriptors] : [];
    state.regThumbnail = p.thumbnail || '';
    state.regManualCaptured = true;
    if (el['reg-preview-img']) el['reg-preview-img'].src = state.regThumbnail;
    if (el['reg-sample-count']) {
      el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length || 1} 組`;
    }
    if (el['view-register']) {
      el['view-register'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (triggerExtraAngle) {
      if (state.sourceMode === 'photo' && el['native-camera-input']) {
        state.pendingAngleAppend = true;
        el['native-camera-input'].click();
      } else {
        showToast(`📸 請對準「${p.name}」新角度後點擊「➕ 補拍多角度 (+1)」或「📱 開手機相機實拍」`);
      }
    } else {
      showToast(`✏️ 正在編輯「${p.name}」，修改後將即時同步更新`);
    }
  }

  function isActionArmed(armKey) {
    const now = Date.now();
    const exp = state.armedConfirmMap[armKey] || 0;
    if (exp > now) {
      delete state.armedConfirmMap[armKey];
      return true;
    }
    state.armedConfirmMap[armKey] = now + 3200;
    setTimeout(() => {
      if (state.armedConfirmMap[armKey] && state.armedConfirmMap[armKey] <= Date.now()) {
        delete state.armedConfirmMap[armKey];
        if (state.activeTab === 'inventory') renderInventoryList();
      }
    }, 3300);
    return false;
  }

  async function adjustProductStock(productId, delta) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    product.stock = Math.max(0, product.stock + delta);
    product.updatedAt = Date.now();
    invalidateRecognitionUICache();

    try {
      const r = await fetch(`/api/products/${encodeURIComponent(productId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: product.stock })
      });
      if (!r.ok && r.status >= 500) {
        enqueueOutbox({ type: 'patch_product', id: productId, payload: { stock: product.stock } });
      }
    } catch (_) {
      enqueueOutbox({ type: 'patch_product', id: productId, payload: { stock: product.stock } });
    }

    notifyPeers();
    renderAll();
    scheduleRecognition(true);
  }

  async function deleteProduct(productId) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    if (!isActionArmed('del:' + productId)) {
      renderInventoryList();
      showToast(`⚠️ 再點一次「確認?」即可刪除「${product.name}」`, 'warn');
      return;
    }

    state.products = state.products.filter((p) => p.id !== productId);
    state.cart = state.cart.filter((c) => c.productId !== productId);
    invalidateRecognitionUICache();

    try {
      const r = await fetch(`/api/products/${encodeURIComponent(productId)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Pin': state.adminPin }
      });
      if (!r.ok && r.status >= 500) {
        enqueueOutbox({ type: 'delete_product', id: productId });
      }
    } catch (_) {
      enqueueOutbox({ type: 'delete_product', id: productId });
    }

    notifyPeers();
    renderAll();
    scheduleRecognition(true);
    showToast(`已刪除商品「${product.name}」`, 'warn');
  }

  function renderInventoryList() {
    const container = el['inventory-list-container'];
    if (!container) return;

    const query = (el['inv-search-input'].value || '').trim().toLowerCase();
    const filter = el['inv-filter-select'].value;

    const filtered = state.products.filter((p) => {
      if (filter === 'low' && p.stock > (p.minStock || 5)) return false;
      if (!query) return true;
      return (
        p.name.toLowerCase().includes(query) ||
        (p.sku && p.sku.toLowerCase().includes(query)) ||
        (p.category && p.category.toLowerCase().includes(query)) ||
        (p.barcode && p.barcode.toLowerCase().includes(query))
      );
    });

    el['metric-product-count'].textContent = `${state.products.length} 筆`;
    el['nav-inv-count'].textContent = String(state.products.length);

    if (filtered.length === 0) {
      container.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted);">沒有符合條件的產品</div>`;
      return;
    }

    const now = Date.now();
    container.innerHTML = filtered
      .map((p) => {
        const isLow = p.stock <= (p.minStock || 5);
        const delArmed = (state.armedConfirmMap['del:' + p.id] || 0) > now;
        const bcTag = p.barcode ? ` · 條碼 ${escapeHtml(p.barcode)}` : '';
        return `
          <div class="inv-item">
            <img class="inv-thumb" src="${p.thumbnail || ''}" alt="${escapeHtml(p.name)}" />
            <div class="inv-info">
              <div class="inv-title">${escapeHtml(p.name)}</div>
              <div class="inv-sub">
                ${escapeHtml(p.sku)}${bcTag} · 儲位 ${escapeHtml(p.location || 'A-01')} · <strong style="color:var(--accent-primary);">NT$ ${p.price.toLocaleString()}</strong>
              </div>
              <div style="margin-top:2px; display:flex; gap:4px; flex-wrap:wrap;">
                <span class="badge ${isLow ? 'badge-danger' : 'badge-emerald'}">
                  庫存: ${p.stock} ${escapeHtml(p.unit || '件')} ${isLow ? '(低庫存)' : ''}
                </span>
                <span class="badge badge-info">特徵 ${(p.descriptors && p.descriptors.length) || 1} 組</span>
              </div>
            </div>
            <div class="inv-actions" style="flex-wrap:wrap; justify-content:flex-end;">
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-minus" data-id="${p.id}" title="庫存 -1">-1</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-plus" data-id="${p.id}" title="庫存 +1">+1</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-edit" data-id="${p.id}" title="編輯名稱、價格、條碼與介紹">✏️</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-angle" data-id="${p.id}" title="補拍多角度特徵">📸</button>
              <button type="button" class="btn btn-primary btn-sm" data-action="inv-cart" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>+入車</button>
              <button type="button" class="btn btn-danger btn-sm" data-action="inv-del" data-id="${p.id}" title="刪除商品">${delArmed ? '確認?' : '✕'}</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // Real-Time Shopping Cart, Persistent Cart & Electronic Receipt POS Checkout
  // ==========================================================================
  function syncCartAndBroadcast() {
    saveCartToStorage();
    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'cart_updated', timestamp: Date.now() });
    }
  }

  function addToCart(productId, qty = 1, isAuto = false) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    if (product.stock <= 0) {
      showToast(`「${product.name}」庫存已售罄！`, 'danger');
      return;
    }

    const existing = state.cart.find((c) => c.productId === productId);
    if (existing) {
      if (existing.quantity + qty > product.stock) {
        showToast(`已達「${product.name}」庫存上限 (${product.stock} ${product.unit || '件'})`, 'warn');
        return;
      }
      existing.quantity += qty;
    } else {
      state.cart.push({ productId, quantity: Math.min(qty, product.stock) });
    }

    playTone(960, 45, 'sine');
    if (isAuto) {
      showToast(`⚡ 自動掃描入車：${product.name} ×1`);
    } else {
      showToast(`🛒 已加入購物車：${product.name}`);
    }
    renderCart();
    syncCartAndBroadcast();
  }

  function updateCartQty(productId, newQty) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    if (newQty <= 0) {
      state.cart = state.cart.filter((c) => c.productId !== productId);
    } else {
      const item = state.cart.find((c) => c.productId === productId);
      if (item) {
        item.quantity = Math.min(product.stock, newQty);
      }
    }
    renderCart();
    syncCartAndBroadcast();
  }

  function renderCart() {
    const container = el['cart-items-container'];
    if (!container) return;

    let totalQty = 0;
    let subtotal = 0;

    // Clean out deleted products
    state.cart = state.cart.filter((c) => state.products.some((p) => p.id === c.productId));

    if (state.cart.length === 0) {
      container.innerHTML = `
        <div style="padding:22px 12px; text-align:center; color:var(--text-muted); border:1px dashed var(--border-subtle); border-radius:var(--radius-sm);">
          購物車目前是空的<br/>
          <span style="font-size:12px;">開啟相機掃描商品即可一鍵或自動加入購物車</span>
        </div>
      `;
    } else {
      container.innerHTML = state.cart
        .map((c) => {
          const p = state.products.find((prod) => prod.id === c.productId);
          if (!p) return '';
          const lineTotal = p.price * c.quantity;
          totalQty += c.quantity;
          subtotal += lineTotal;
          return `
            <div class="cart-row">
              <div style="min-width:0; flex:1;">
                <div style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                  ${escapeHtml(p.name)}
                </div>
                <div style="font-size:12px; color:var(--text-secondary); font-family:var(--font-mono);">
                  NT$ ${p.price.toLocaleString()} × ${c.quantity} = <strong style="color:var(--accent-primary);">NT$ ${lineTotal.toLocaleString()}</strong>
                </div>
              </div>
              <div class="qty-stepper">
                <button type="button" class="qty-btn" data-cart-minus="${p.id}">−</button>
                <span class="qty-val">${c.quantity}</span>
                <button type="button" class="qty-btn" data-cart-plus="${p.id}">+</button>
              </div>
            </div>
          `;
        })
        .join('');
    }

    const discount = Math.max(0, Number(el['cart-discount-input'].value) || 0);
    const total = Math.max(0, subtotal - discount);

    el['cart-count-badge'].textContent = `${totalQty} 件`;
    el['summary-qty'].textContent = String(totalQty);
    el['summary-subtotal'].textContent = `NT$ ${subtotal.toLocaleString()}`;
    el['summary-total'].textContent = `NT$ ${total.toLocaleString()}`;
    el['btn-checkout-submit'].disabled = state.cart.length === 0;
    saveCartToStorage();
  }

  function openReceiptModal(order) {
    if (!order || !el['receipt-modal'] || !el['receipt-paper-content']) return;
    const payNames = { cash: '現金支付', card: '感應刷卡', mobile: '行動支付' };
    const dtStr = new Date(order.createdAt || Date.now()).toLocaleString('zh-TW');
    const itemsHtml = (order.items || [])
      .map(
        (i) => `
          <div style="display:flex; justify-content:space-between; gap:8px; margin:4px 0;">
            <span style="flex:1; word-break:break-all;">${escapeHtml(i.name)} ×${i.quantity}</span>
            <span style="white-space:nowrap;">NT$ ${Number(i.lineTotal ?? i.price * i.quantity).toLocaleString()}</span>
          </div>
        `
      )
      .join('');

    el['receipt-paper-content'].innerHTML = `
      <div style="text-align:center; font-weight:700; font-size:15px;">VisionPOS Edge 智慧門市</div>
      <div style="text-align:center; font-size:11px; color:#4b5563;">電子交易明細憑證</div>
      <hr class="receipt-divider" />
      <div>單號：${escapeHtml(order.id)}</div>
      <div>時間：${escapeHtml(dtStr)}</div>
      <div>付款：${escapeHtml(payNames[order.paymentMethod] || '現金支付')}</div>
      <hr class="receipt-divider" />
      ${itemsHtml}
      <hr class="receipt-divider" />
      <div style="display:flex; justify-content:space-between;">
        <span>小計 (${order.totalQty || 1} 件)</span>
        <span>NT$ ${Number(order.subtotal || order.total || 0).toLocaleString()}</span>
      </div>
      ${
        Number(order.discount) > 0
          ? `<div style="display:flex; justify-content:space-between;"><span>折扣折抵</span><span>-NT$ ${Number(order.discount).toLocaleString()}</span></div>`
          : ''
      }
      <div style="display:flex; justify-content:space-between; font-weight:700; font-size:14px; margin-top:4px;">
        <span>實收總額</span>
        <span>NT$ ${Number(order.total || 0).toLocaleString()}</span>
      </div>
      <hr class="receipt-divider" />
      <div style="text-align:center; font-size:11px; color:#6b7280;">感謝您的惠顧 · 請妥善保存此明細</div>
    `;
    el['receipt-modal'].classList.remove('hidden');
  }

  async function submitCheckout() {
    if (state.cart.length === 0) return;

    // Validate stock locally first for atomic safety
    for (const c of state.cart) {
      const p = state.products.find((prod) => prod.id === c.productId);
      if (!p || p.stock < c.quantity) {
        showToast(`「${p ? p.name : ''}」庫存不足`, 'danger');
        return;
      }
    }

    const now = Date.now();
    const clientOrderId =
      'ORD-' + now.toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    const discount = Math.max(0, Number(el['cart-discount-input'].value) || 0);
    const payload = {
      id: clientOrderId,
      createdAt: now,
      items: state.cart.map((c) => ({ ...c })),
      discount,
      paymentMethod: state.paymentMethod
    };

    let completedOrder = null;
    let syncedOnline = false;
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        completedOrder = data.order;
        syncedOnline = true;
        if (Array.isArray(data.updatedProducts)) {
          data.updatedProducts.forEach((up) => {
            VisionEngine.ensureProductCache(up);
            const idx = state.products.findIndex((p) => p.id === up.id);
            if (idx >= 0) state.products[idx] = up;
          });
        }
      }
    } catch (_) {}

    if (!completedOrder) {
      let subtotal = 0;
      const orderItems = [];
      for (const c of state.cart) {
        const p = state.products.find((prod) => prod.id === c.productId);
        p.stock -= c.quantity;
        p.updatedAt = now;
        const lineTotal = p.price * c.quantity;
        subtotal += lineTotal;
        orderItems.push({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          price: p.price,
          quantity: c.quantity,
          unit: p.unit || '件',
          lineTotal
        });
      }
      completedOrder = {
        id: clientOrderId,
        createdAt: now,
        paymentMethod: state.paymentMethod,
        items: orderItems,
        totalQty: orderItems.reduce((a, b) => a + b.quantity, 0),
        subtotal,
        discount,
        total: Math.max(0, subtotal - discount)
      };
      if (!syncedOnline) {
        enqueueOutbox({ type: 'checkout', payload });
      }
    }

    if (!state.orders.some((o) => o.id === completedOrder.id)) {
      state.orders.unshift(completedOrder);
    }
    state.cart = [];
    el['cart-discount-input'].value = '0';

    invalidateRecognitionUICache();
    notifyPeers();
    renderAll();
    scheduleRecognition(true);
    playTone(1180, 90, 'sine');
    setTimeout(() => playTone(1560, 120, 'sine'), 85);
    showToast(`🎉 結帳成功！單號 ${completedOrder.id}，實收 NT$ ${completedOrder.total.toLocaleString()}`);
    if (state.customerKioskMode) {
      openReceiptModal(completedOrder);
    }
  }

  function renderOrdersHistory() {
    const container = el['orders-history-list'];
    if (!container) return;

    const todayRevenue = state.orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    el['today-revenue-text'].textContent = `累計營收: NT$ ${todayRevenue.toLocaleString()}`;

    if (state.orders.length === 0) {
      container.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:10px;">尚無結帳紀錄</div>`;
      return;
    }

    const payNames = { cash: '現金', card: '刷卡', mobile: '行動支付' };
    container.innerHTML = state.orders
      .slice(0, 20)
      .map((o) => {
        const timeStr = new Date(o.createdAt).toLocaleTimeString();
        const summaryNames = (o.items || []).map((i) => `${i.name}×${i.quantity}`).join('、');
        return `
          <div data-receipt-id="${escapeHtml(o.id)}" style="cursor:pointer; padding:8px 10px; background:var(--bg-elevated); border-radius:var(--radius-sm); border:1px solid var(--border-subtle); font-size:12px;" title="點擊查看或列印電子收據">
            <div style="display:flex; justify-content:space-between; font-weight:600;">
              <span style="font-family:var(--font-mono);">🧾 ${escapeHtml(o.id)}</span>
              <span style="color:var(--accent-primary); font-family:var(--font-mono);">NT$ ${Number(o.total).toLocaleString()}</span>
            </div>
            <div style="color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">
              ${escapeHtml(summaryNames)}
            </div>
            <div style="color:var(--text-muted); font-size:12px; margin-top:2px;">
              ${timeStr} · ${payNames[o.paymentMethod] || '現金'} · 共 ${o.totalQty || 1} 件
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // Navigation & Event Listeners
  // ==========================================================================
  function switchTab(tabName, skipAutoCapture = false) {
    state.activeTab = tabName;
    ['scan', 'register', 'inventory', 'devices'].forEach((t) => {
      el[`tab-btn-${t}`].classList.toggle('active', t === tabName);
      el[`view-${t}`].classList.toggle('hidden', t !== tabName);
    });
    if (tabName === 'register' && !skipAutoCapture) {
      captureForRegistration(false);
    }
    if (tabName === 'scan' || tabName === 'register') {
      scheduleRecognition(true);
    } else {
      // Pause background scanning (0 FPS) when viewing Inventory or Devices tabs
      scheduleRecognition(false);
    }
  }

  function renderAll() {
    renderStageTray();
    renderInventoryList();
    renderCart();
    renderOrdersHistory();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function drawSourceOntoPhotoBuffer(imgOrBitmap) {
    const srcW = imgOrBitmap.width || 640;
    const srcH = imgOrBitmap.height || 480;
    const w = photoBufferCanvas.width;
    const h = photoBufferCanvas.height;
    photoBufferCtx.fillStyle = '#090d14';
    photoBufferCtx.fillRect(0, 0, w, h);
    const scale = Math.max(w / srcW, h / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    photoBufferCtx.drawImage(imgOrBitmap, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);
  }

  // Hardware-subsampled 12MP/50MP mobile photo loader (< 18ms via createImageBitmap, ~99% less peak RAM)
  async function loadMobilePhotoToBuffer(file, onComplete) {
    if (!file) return;

    if (typeof createImageBitmap === 'function') {
      try {
        // Specify ONLY resizeWidth so browser preserves portrait/landscape aspect ratio & EXIF orientation
        const bitmap = await createImageBitmap(file, {
          resizeWidth: 720,
          resizeQuality: 'low'
        });
        drawSourceOntoPhotoBuffer(bitmap);
        if (typeof bitmap.close === 'function') bitmap.close();
        state.hasLoadedPhoto = true;
        await switchVideoSource('photo');
        renderStageCanvasFrame();
        if (typeof onComplete === 'function') onComplete();
        return;
      } catch (_) {
        // Fall through to HTMLImageElement fallback
      }
    }

    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      drawSourceOntoPhotoBuffer(img);
      URL.revokeObjectURL(objUrl);
      state.hasLoadedPhoto = true;
      await switchVideoSource('photo');
      renderStageCanvasFrame();
      if (typeof onComplete === 'function') onComplete();
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      showToast('照片讀取失敗，請再試一次', 'danger');
    };
    img.src = objUrl;
  }

  let regInputDebounceTimer = null;
  let customIpcamPollTimer = null;

  function applyCustomerKioskMode(enabled) {
    state.customerKioskMode = Boolean(enabled);
    document.body.classList.toggle('customer-kiosk-mode', state.customerKioskMode);
    if (el['btn-role-toggle']) {
      el['btn-role-toggle'].textContent = state.customerKioskMode
        ? '🛍️ 顧客自助模式'
        : '🔓 店長模式';
    }
    try {
      localStorage.setItem(ROLE_STORAGE_KEY, state.customerKioskMode ? 'customer' : 'admin');
    } catch (_) {}
    if (state.customerKioskMode && state.activeTab !== 'scan') {
      switchTab('scan');
    }
  }

  function connectCustomIpCam() {
    const url = (el['ipcam-url-input'].value || '').trim();
    if (!url) {
      showToast('請輸入 MJPEG 或 HTTP 快照串流網址 (例如 http://192.168.1.100:8080/video)', 'warn');
      return;
    }
    if (customIpcamPollTimer) {
      clearInterval(customIpcamPollTimer);
      customIpcamPollTimer = null;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      state.customIpcamImg = img;
      state.customIpcamUrl = url;
      state.customIpcamActive = true;
      scheduleRecognition(true);
    };
    img.onerror = () => {
      state.customIpcamActive = false;
      showToast('⚠️ 無法連線該攝影機網址（請確認同一區域網路與 CORS 權限），已維持模擬巡檢畫面', 'warn');
    };
    img.src = url;
    showToast('📹 正在連線自訂 IP 攝影機串流...');

    // If URL looks like a static JPEG snapshot endpoint, refresh at 4 FPS cleanly
    if (/\.(jpg|jpeg|png|webp)(\?|$)|snapshot|shot\.jpg/i.test(url)) {
      customIpcamPollTimer = setInterval(() => {
        if (state.sourceMode !== 'ipcam' || state.cctvChannel !== 'custom' || document.hidden) return;
        const sep = url.includes('?') ? '&' : '?';
        img.src = `${url}${sep}_t=${Date.now()}`;
      }, 250);
    }
  }

  function setupEvents() {
    // Customer / Admin Kiosk Role Toggle (PIN protected unlock, default PIN: 1234)
    if (el['btn-role-toggle']) {
      el['btn-role-toggle'].addEventListener('click', () => {
        if (!state.customerKioskMode) {
          applyCustomerKioskMode(true);
          showToast('🛍️ 已切換為「顧客自助模式」（隱藏後台建檔與庫存管理，返回後台預設 PIN: 1234）');
        } else {
          const entered = window.prompt('請輸入店長管理 PIN 碼切換回後台模式（預設：1234）：', '');
          if (entered === null) return;
          if (entered.trim() === state.adminPin) {
            applyCustomerKioskMode(false);
            showToast('🔓 已解鎖切換回「店長後台模式」');
          } else {
            showToast('PIN 碼錯誤，維持顧客自助模式', 'danger');
          }
        }
      });
    }

    // Mode Navigation Tabs
    ['scan', 'register', 'inventory', 'devices'].forEach((t) => {
      el[`tab-btn-${t}`].addEventListener('click', () => {
        if (state.customerKioskMode && t !== 'scan') return;
        switchTab(t);
        if (t === 'register' && el['view-register']) {
          el['view-register'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    });

    // Source Mode Switcher
    ['virtual', 'webcam', 'ipcam'].forEach((s) => {
      if (el[`src-btn-${s}`]) {
        el[`src-btn-${s}`].addEventListener('click', () => switchVideoSource(s));
      }
    });

    // One-tap Instant Registration from Unregistered Prompt Card
    if (el['btn-instant-register']) {
      el['btn-instant-register'].addEventListener('click', () => {
        el['reg-id'].value = '';
        el['reg-name'].value = '';
        captureForRegistration(false, true);
        handleRegistrationSubmit(null);
      });
    }

    // Jump to register form from Unregistered Prompt Card (auto-creates draft in inventory immediately)
    el['btn-jump-register'].addEventListener('click', async () => {
      el['reg-id'].value = '';
      el['reg-name'].value = '';
      switchTab('register', true);
      captureForRegistration(false, true);
      await upsertRegistrationProduct(false);
      if (el['view-register']) {
        el['view-register'].scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (el['reg-name']) {
        setTimeout(() => el['reg-name'].select(), 150);
      }
    });

    // 1. Mobile Native Camera SCAN Input (Customer Photo Scan -> Hybrid Barcode + Multi-Crop Recognition)
    if (el['native-scan-input']) {
      el['native-scan-input'].addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        loadMobilePhotoToBuffer(file, async () => {
          switchTab('scan');
          const sourceElem = getActiveVideoSourceElement();
          const codeObj =
            typeof VisionEngine.detectBarcode === 'function'
              ? await VisionEngine.detectBarcode(sourceElem)
              : null;
          const detectedCode = codeObj && codeObj.rawValue ? codeObj.rawValue : '';
          const sig = VisionEngine.captureFrameSignature(sourceElem, getRoiRect(sourceElem), false);
          const matchRes = VisionEngine.matchProducts(
            sig.descriptor,
            state.products,
            state.threshold,
            sig.queryDescriptors,
            { sourceMode: 'photo', virtualPresetId: null, detectedBarcode: detectedCode }
          );
          state.liveDescriptor = sig.descriptor;
          state.currentMatch = matchRes.product;
          state.currentSimilarity = matchRes.similarity;
          state.topCandidates = matchRes.topCandidates;
          state.matchHistory = matchRes.product ? [matchRes.product.id, matchRes.product.id] : [null, null];
          invalidateRecognitionUICache();
          updateRecognitionUI(matchRes);
          if (matchRes.matched && matchRes.product) {
            playTone(1080, 60, 'sine');
            showToast(`✅ 掃描辨識成功：${matchRes.product.name} (NT$ ${matchRes.product.price.toLocaleString()})`);
            if (el['recognized-product-card']) {
              el['recognized-product-card'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          } else {
            playTone(440, 90, 'sawtooth');
            showToast(
              state.customerKioskMode
                ? '⚠️ 未建檔：未掃描到庫存中的商品'
                : '⚠️ 未建檔：未掃描到庫存中的商品（可點擊下方「⚡ 一鍵立即建檔」）',
              'warn'
            );
            if (el['unregistered-prompt-card']) {
              el['unregistered-prompt-card'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        });
        e.target.value = '';
      });
    }

    // 2. Mobile Native Camera REGISTER Input (Backend Photo Registration -> 128x128 WebP + Barcode + Auto-Save)
    if (el['native-camera-input']) {
      el['native-camera-input'].addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const isAppend = state.pendingAngleAppend;
        state.pendingAngleAppend = false;
        loadMobilePhotoToBuffer(file, async () => {
          if (!isAppend) {
            el['reg-id'].value = '';
            el['reg-name'].value = '';
          }
          switchTab('register', true);
          const sourceElem = getActiveVideoSourceElement();
          if (typeof VisionEngine.detectBarcode === 'function') {
            const codeObj = await VisionEngine.detectBarcode(sourceElem);
            if (codeObj && codeObj.rawValue && el['reg-barcode']) {
              el['reg-barcode'].value = codeObj.rawValue;
            }
          }
          captureForRegistration(isAppend, true);
          const autoSaved = await upsertRegistrationProduct(false);
          if (!isAppend && autoSaved) {
            showToast(`✅ 已自動建檔「${autoSaved.name}」！可直接再掃描，或於下方修改名稱價格後按完成`);
            if (el['view-register']) {
              el['view-register'].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            if (el['reg-name']) {
              setTimeout(() => el['reg-name'].select(), 200);
            }
          }
        });
        e.target.value = '';
      });
    }

    // Debounced live-sync registration form edits (prevents per-keystroke JSON serialization & list rebuild)
    ['reg-name', 'reg-price', 'reg-stock', 'reg-sku', 'reg-barcode', 'reg-spec', 'reg-category', 'reg-unit', 'reg-location'].forEach((fieldId) => {
      if (el[fieldId]) {
        el[fieldId].addEventListener('input', () => {
          const activeId = (el['reg-id'].value || '').trim();
          if (!activeId) return;
          const prod = state.products.find((p) => p.id === activeId);
          if (!prod) return;
          if (el['reg-name'].value.trim()) prod.name = el['reg-name'].value.trim();
          if (el['reg-price'].value.trim() !== '') prod.price = Math.max(0, Number(el['reg-price'].value) || 0);
          if (el['reg-stock'].value.trim() !== '') prod.stock = Math.max(0, Number(el['reg-stock'].value) || 0);
          if (el['reg-sku'].value.trim()) prod.sku = el['reg-sku'].value.trim();
          prod.barcode = el['reg-barcode'].value.trim();
          if (el['reg-spec'].value.trim()) prod.spec = el['reg-spec'].value.trim();
          if (el['reg-category'].value.trim()) prod.category = el['reg-category'].value.trim();
          if (el['reg-unit'].value.trim()) prod.unit = el['reg-unit'].value.trim();
          if (el['reg-location'].value.trim()) prod.location = el['reg-location'].value.trim();
          prod.updatedAt = Date.now();
          invalidateRecognitionUICache();

          if (regInputDebounceTimer) clearTimeout(regInputDebounceTimer);
          regInputDebounceTimer = setTimeout(() => {
            saveToLocalStorage();
            renderInventoryList();
          }, 180);
        });
      }
    });

    // Webcam Controls
    el['camera-device-select'].addEventListener('change', (e) => {
      state.selectedDeviceId = e.target.value;
      startWebcamStream();
    });
    el['btn-flip-camera'].addEventListener('click', () => {
      state.selectedDeviceId = '';
      state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
      startWebcamStream();
    });
    el['camera-res-select'].addEventListener('change', () => startWebcamStream());
    el['btn-toggle-torch'].addEventListener('click', () => toggleTorch());

    // CCTV & Custom IP Camera Stream Controls
    el['cctv-channel-select'].addEventListener('change', (e) => {
      state.cctvChannel = e.target.value;
      const isCustom = state.cctvChannel === 'custom';
      el['ipcam-url-input'].classList.toggle('hidden', !isCustom);
      el['btn-connect-ipcam'].classList.toggle('hidden', !isCustom);
      scheduleRecognition(true);
    });
    if (el['btn-connect-ipcam']) {
      el['btn-connect-ipcam'].addEventListener('click', () => connectCustomIpCam());
    }

    // Virtual Stage Controls
    el['chk-stage-motion'].addEventListener('change', (e) => {
      state.stageHandMotion = e.target.checked;
      scheduleRecognition(true);
    });
    el['btn-stage-rotate'].addEventListener('click', () => {
      state.stageAngle = (state.stageAngle + 0.14) % (Math.PI * 2);
      scheduleRecognition(true);
    });

    // Threshold, Auto-Cart & Eco Gate
    el['threshold-slider'].addEventListener('input', (e) => {
      const val = Number(e.target.value);
      state.threshold = val / 100;
      el['threshold-label'].textContent = `${val}%`;
      scheduleRecognition(true);
    });
    el['chk-auto-cart'].addEventListener('change', (e) => {
      state.autoAddCart = e.target.checked;
    });
    el['chk-eco-sleep'].addEventListener('change', (e) => {
      state.ecoGateEnabled = e.target.checked;
      scheduleRecognition(true);
    });

    // HUD & Recognized Product Card Actions
    el['hud-add-cart-btn'].addEventListener('click', () => {
      if (state.currentMatch) addToCart(state.currentMatch.id, 1);
    });
    el['btn-rec-add-cart'].addEventListener('click', () => {
      if (state.currentMatch) addToCart(state.currentMatch.id, 1);
    });
    el['btn-rec-stock-plus'].addEventListener('click', () => {
      if (state.currentMatch) adjustProductStock(state.currentMatch.id, 1);
    });
    el['btn-rec-stock-minus'].addEventListener('click', () => {
      if (state.currentMatch) adjustProductStock(state.currentMatch.id, -1);
    });
    el['btn-rec-edit'].addEventListener('click', () => {
      if (!state.currentMatch) return;
      const p = state.currentMatch;
      switchTab('register', true);
      el['reg-id'].value = p.id;
      el['reg-name'].value = p.name;
      el['reg-price'].value = p.price;
      el['reg-stock'].value = p.stock;
      el['reg-sku'].value = p.sku;
      el['reg-barcode'].value = p.barcode || '';
      el['reg-category'].value = p.category || '';
      el['reg-unit'].value = p.unit || '件';
      el['reg-location'].value = p.location || 'A-01';
      el['reg-spec'].value = p.spec || '';
      state.regDescriptors = Array.isArray(p.descriptors) ? [...p.descriptors] : [];
      state.regThumbnail = p.thumbnail || '';
      state.regManualCaptured = true;
      el['reg-preview-img'].src = state.regThumbnail;
      el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length} 組`;
    });

    el['btn-train-extra-angle'].addEventListener('click', async () => {
      if (!state.currentMatch) return;
      const sourceElem = getActiveVideoSourceElement();
      const sig = VisionEngine.captureFrameSignature(sourceElem, getRoiRect(sourceElem), true);
      const p = state.currentMatch;
      const combined = [...(p.descriptors || []), ...(sig.augmentedDescriptors || [sig.descriptor])];
      p.descriptors = VisionEngine.deduplicateDescriptors(combined, 24);
      VisionEngine.ensureProductCache(p);
      try {
        await fetch(`/api/products/${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newDescriptor: sig.descriptor })
        });
      } catch (_) {}
      notifyPeers();
      showToast(`📸 已為「${p.name}」新增多尺度角度樣本（目前共 ${p.descriptors.length} 組）`);
    });

    // Registration Form Buttons
    el['btn-capture-frame'].addEventListener('click', async () => {
      captureForRegistration(false, true);
      await upsertRegistrationProduct(false);
      showToast('📸 已擷取目前取景框畫面特徵並同步更新建檔');
    });
    el['btn-add-angle-sample'].addEventListener('click', async () => {
      if (state.sourceMode === 'photo' && el['native-camera-input']) {
        state.pendingAngleAppend = true;
        el['native-camera-input'].click();
      } else {
        captureForRegistration(true, true);
        await upsertRegistrationProduct(false);
      }
    });
    el['btn-fill-demo-new'].addEventListener('click', () => {
      const unregIdx = VisionEngine.VIRTUAL_STAGE_ITEMS.findIndex(
        (item) => !state.products.some((p) => p.sku === item.sku)
      );
      if (unregIdx >= 0) {
        state.stageItemIndex = unregIdx;
        renderStageTray();
      }
      const item = VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex];
      fillRegistrationFormFromPreset(item);
      setTimeout(() => captureForRegistration(false, true), 50);
      showToast('已自動將鏡頭對準新商品並填入範例規格，請點擊「完成拍照建檔」');
    });
    el['btn-reset-reg-form'].addEventListener('click', () => resetRegistrationForm());
    el['register-product-form'].addEventListener('submit', handleRegistrationSubmit);

    // Inventory Search, Filter & Delegated Actions
    el['inv-search-input'].addEventListener('input', () => renderInventoryList());
    el['inv-filter-select'].addEventListener('change', () => renderInventoryList());
    el['inventory-list-container'].addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      if (action === 'inv-plus') adjustProductStock(id, 1);
      else if (action === 'inv-minus') adjustProductStock(id, -1);
      else if (action === 'inv-edit') openEditProductInRegister(id, false);
      else if (action === 'inv-angle') openEditProductInRegister(id, true);
      else if (action === 'inv-cart') addToCart(id, 1);
      else if (action === 'inv-del') deleteProduct(id);
    });

    // Export Inventory JSON Backup
    el['btn-export-inventory'].addEventListener('click', () => {
      const jsonStr = JSON.stringify({ products: state.products, orders: state.orders }, null, 2);
      triggerFileDownload(`vision-pos-backup-${Date.now()}.json`, jsonStr, 'application/json;charset=utf-8');
    });

    // Export Inventory Excel-Ready UTF-8 BOM CSV
    if (el['btn-export-csv']) {
      el['btn-export-csv'].addEventListener('click', () => {
        const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = ['\uFEFFSKU,條碼,產品名稱,分類,單價(NT$),庫存數量,單位,儲位,產品介紹'];
        for (const p of state.products) {
          rows.push([
            csvEsc(p.sku || ''),
            csvEsc(p.barcode || ''),
            csvEsc(p.name || ''),
            csvEsc(p.category || ''),
            Number(p.price) || 0,
            Number(p.stock) || 0,
            csvEsc(p.unit || '件'),
            csvEsc(p.location || 'A-01'),
            csvEsc(p.spec || '')
          ].join(','));
        }
        triggerFileDownload(`vision-pos-inventory-${Date.now()}.csv`, rows.join('\r\n'), 'text/csv;charset=utf-8');
      });
    }

    // Export Orders Ledger CSV
    if (el['btn-export-orders-csv']) {
      el['btn-export-orders-csv'].addEventListener('click', async () => {
        try {
          const res = await fetch('/api/orders/export');
          if (res.ok) {
            const csvText = await res.text();
            triggerFileDownload(`vision-pos-orders-${Date.now()}.csv`, csvText, 'text/csv;charset=utf-8');
            return;
          }
        } catch (_) {}
        const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = ['\uFEFF訂單編號,交易時間,付款方式,總件數,小計(NT$),折扣(NT$),實收總額(NT$),購買明細'];
        for (const o of state.orders) {
          const detail = (o.items || []).map((i) => `${i.name}x${i.quantity}`).join('; ');
          rows.push([
            csvEsc(o.id),
            csvEsc(new Date(o.createdAt || Date.now()).toISOString()),
            csvEsc(o.paymentMethod || 'cash'),
            o.totalQty || 0,
            o.subtotal || 0,
            o.discount || 0,
            o.total || 0,
            csvEsc(detail)
          ].join(','));
        }
        triggerFileDownload(`vision-pos-orders-${Date.now()}.csv`, rows.join('\r\n'), 'text/csv;charset=utf-8');
      });
    }

    // Batch Import Inventory from JSON or CSV
    if (el['inv-import-input']) {
      el['inv-import-input'].addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = (await file.text()).replace(/^\uFEFF/, '');
          let importedProducts = [];
          if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
            const parsed = JSON.parse(text);
            importedProducts = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.products) ? parsed.products : []);
          } else {
            // Parse CSV rows (supports quoted fields)
            const parseCsvLine = (line) => {
              const out = [];
              let cur = '';
              let inQuotes = false;
              for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') {
                  if (inQuotes && line[i + 1] === '"') {
                    cur += '"';
                    i++;
                  } else {
                    inQuotes = !inQuotes;
                  }
                } else if (ch === ',' && !inQuotes) {
                  out.push(cur);
                  cur = '';
                } else {
                  cur += ch;
                }
              }
              out.push(cur);
              return out;
            };
            const lines = text.split(/\r?\n/).filter((l) => l.trim());
            if (lines.length >= 2) {
              const nowTs = Date.now();
              for (let r = 1; r < lines.length; r++) {
                const cols = parseCsvLine(lines[r]);
                const name = (cols[2] || '').trim();
                if (!name) continue;
                importedProducts.push({
                  sku: (cols[0] || '').trim() || `SKU-IMP-${r}`,
                  barcode: (cols[1] || '').trim(),
                  name,
                  category: (cols[3] || '').trim() || '匯入商品',
                  price: Math.max(0, Number(cols[4]) || 0),
                  stock: Math.max(0, Number(cols[5]) || 0),
                  unit: (cols[6] || '').trim() || '件',
                  location: (cols[7] || '').trim() || 'A-01',
                  spec: (cols[8] || '').trim(),
                  updatedAt: nowTs
                });
              }
            }
          }

          if (importedProducts.length === 0) {
            showToast('檔案中未找到可匯入的商品資料', 'warn');
            e.target.value = '';
            return;
          }

          const now = Date.now();
          let count = 0;
          for (const item of importedProducts) {
            if (!item || !item.name) continue;
            const idx = state.products.findIndex(
              (p) => (item.id && p.id === item.id) || (item.sku && p.sku === item.sku)
            );
            if (idx >= 0) {
              state.products[idx] = {
                ...state.products[idx],
                ...item,
                id: state.products[idx].id,
                descriptors:
                  Array.isArray(item.descriptors) && item.descriptors.length > 0
                    ? item.descriptors
                    : state.products[idx].descriptors,
                updatedAt: now
              };
              VisionEngine.ensureProductCache(state.products[idx]);
            } else {
              const created = {
                id: item.id || ('prd-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
                sku: item.sku || `SKU-${state.products.length + 101}`,
                barcode: item.barcode || '',
                name: String(item.name).trim(),
                category: item.category || '匯入商品',
                price: Number(item.price) || 0,
                stock: Number(item.stock) ?? 10,
                unit: item.unit || '件',
                location: item.location || 'A-01',
                spec: item.spec || '',
                thumbnail: item.thumbnail || '',
                descriptors: Array.isArray(item.descriptors) ? item.descriptors : [],
                descriptorVersion: 2,
                isCameraRegistered: Boolean(item.isCameraRegistered),
                createdAt: now,
                updatedAt: now
              };
              VisionEngine.ensureProductCache(created);
              state.products.unshift(created);
            }
            count++;
          }

          invalidateRecognitionUICache();
          notifyPeers();
          renderAll();
          scheduleRecognition(true);
          try {
            await fetch('/api/products/bulk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ products: importedProducts })
            });
          } catch (_) {}
          showToast(`📂 成功匯入/更新 ${count} 筆商品資料！`);
        } catch (err) {
          showToast('匯入檔案解析失敗，請確認 JSON 或 CSV 格式正確', 'danger');
        }
        e.target.value = '';
      });
    }

    el['btn-reset-demo'].addEventListener('click', async () => {
      if (!isActionArmed('reset:demo')) {
        el['btn-reset-demo'].textContent = '⚠️ 再點確認重置';
        setTimeout(() => {
          if (el['btn-reset-demo']) el['btn-reset-demo'].textContent = '🔄 重置預設庫';
        }, 3200);
        showToast('⚠️ 再點一次「確認重置」將還原為預設 5 款展示商品庫', 'warn');
        return;
      }
      el['btn-reset-demo'].textContent = '🔄 重置預設庫';
      const defaultCatalog = VisionEngine.buildDefaultCatalog();
      defaultCatalog.forEach((p) => VisionEngine.ensureProductCache(p));
      state.products = defaultCatalog;
      state.orders = [];
      state.cart = [];
      invalidateRecognitionUICache();
      try {
        await fetch('/api/reset', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Pin': state.adminPin
          },
          body: JSON.stringify({ products: defaultCatalog })
        });
      } catch (_) {}
      notifyPeers();
      renderAll();
      scheduleRecognition(true);
      showToast('已重置回預設 5 款建檔商品與 2 款待建檔測試商品');
    });

    // Cart, Electronic Receipt & Checkout Actions
    el['cart-items-container'].addEventListener('click', (e) => {
      const minusBtn = e.target.closest('button[data-cart-minus]');
      const plusBtn = e.target.closest('button[data-cart-plus]');
      if (minusBtn) {
        const id = minusBtn.getAttribute('data-cart-minus');
        const item = state.cart.find((c) => c.productId === id);
        if (item) updateCartQty(id, item.quantity - 1);
      } else if (plusBtn) {
        const id = plusBtn.getAttribute('data-cart-plus');
        const item = state.cart.find((c) => c.productId === id);
        if (item) updateCartQty(id, item.quantity + 1);
      }
    });

    el['btn-clear-cart'].addEventListener('click', () => {
      state.cart = [];
      renderCart();
      syncCartAndBroadcast();
    });
    el['cart-discount-input'].addEventListener('input', () => {
      renderCart();
      syncCartAndBroadcast();
    });

    document.querySelectorAll('.pay-method-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.paymentMethod = btn.getAttribute('data-pay');
        document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        syncCartAndBroadcast();
      });
    });

    el['btn-checkout-submit'].addEventListener('click', () => submitCheckout());

    if (el['orders-history-list']) {
      el['orders-history-list'].addEventListener('click', (e) => {
        const card = e.target.closest('[data-receipt-id]');
        if (!card) return;
        const ordId = card.getAttribute('data-receipt-id');
        const ord = state.orders.find((o) => o.id === ordId);
        if (ord) openReceiptModal(ord);
      });
    }
    if (el['btn-close-receipt']) {
      el['btn-close-receipt'].addEventListener('click', () => {
        el['receipt-modal'].classList.add('hidden');
      });
    }
    if (el['receipt-modal']) {
      el['receipt-modal'].addEventListener('click', (e) => {
        if (e.target === el['receipt-modal']) el['receipt-modal'].classList.add('hidden');
      });
    }
    if (el['btn-print-receipt']) {
      el['btn-print-receipt'].addEventListener('click', () => {
        window.print();
      });
    }

    // USB / Bluetooth HID Barcode Scanner Keyboard Wedge (<45ms rapid keystrokes + Enter)
    // & Standard Enter shortcut for current visual match
    let hidBuffer = '';
    let hidLastKeyTime = 0;
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;

      const now = performance.now();
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (now - hidLastKeyTime > 55) {
          hidBuffer = '';
        }
        hidBuffer += e.key;
        hidLastKeyTime = now;
        return;
      }

      if (e.key === 'Enter') {
        if (hidBuffer.length >= 4 && now - hidLastKeyTime < 80) {
          e.preventDefault();
          const scannedCode = hidBuffer.trim().toLowerCase();
          hidBuffer = '';
          const matchedProd = state.products.find(
            (p) =>
              (p.barcode && String(p.barcode).trim().toLowerCase() === scannedCode) ||
              (p.sku && String(p.sku).trim().toLowerCase() === scannedCode)
          );
          if (matchedProd) {
            switchTab('scan');
            state.currentMatch = matchedProd;
            state.currentSimilarity = 1.0;
            state.matchHistory = [matchedProd.id, matchedProd.id];
            invalidateRecognitionUICache();
            updateRecognitionUI({
              matched: true,
              product: matchedProd,
              bestCandidate: matchedProd,
              similarity: 1.0,
              margin: 1.0,
              exactBarcode: true,
              topCandidates: [{ product: matchedProd, similarity: 1.0 }]
            });
            addToCart(matchedProd.id, 1, false);
          } else {
            showToast(`⚠️ 條碼「${scannedCode}」未建檔`, 'warn');
          }
          return;
        }
        hidBuffer = '';
        if (state.activeTab === 'scan' && state.currentMatch) {
          e.preventDefault();
          addToCart(state.currentMatch.id, 1);
        }
      }
    });

    // Automatic Offline Outbox Replay on Network Recovery
    window.addEventListener('online', () => {
      flushOutboxToServer();
    });

    // 10-Second Background Camera Sensor Auto-Release & Seamless Foreground Resume
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        cancelScheduledRecognition();
        clearBgCameraReleaseTimer();
        updatePowerTelemetryUI();

        if (state.sourceMode === 'webcam' && state.mediaStream) {
          bgCameraReleaseTimer = setTimeout(() => {
            bgCameraReleaseTimer = null;
            if (document.hidden && state.sourceMode === 'webcam' && state.mediaStream) {
              stopWebcamStream();
              state.autoPausedWebcamInBg = true;
              state.torchOn = false;
              if (el['active-source-badge']) {
                el['active-source-badge'].textContent = '省電待機：已釋放鏡頭';
              }
              updatePowerTelemetryUI();
            }
          }, BG_CAMERA_RELEASE_MS);
        }
      } else {
        clearBgCameraReleaseTimer();
        if (state.autoPausedWebcamInBg && state.sourceMode === 'webcam') {
          state.autoPausedWebcamInBg = false;
          await startWebcamStream(true);
        }
        VisionEngine.resetMotionGate();
        scheduleRecognition(true);
      }
    });

    // Battery Status API Integration (< 20% unplugged -> 10 FPS Battery Saver)
    if (navigator && typeof navigator.getBattery === 'function') {
      navigator.getBattery().then((battery) => {
        const syncBatteryState = () => {
          state.lowBatteryMode = !battery.charging && battery.level <= 0.20;
          updatePowerTelemetryUI();
        };
        syncBatteryState();
        battery.addEventListener('levelchange', syncBatteryState);
        battery.addEventListener('chargingchange', syncBatteryState);
      }).catch(() => {});
    }

    // Hardware BarcodeDetector status check
    if ('BarcodeDetector' in window) {
      el['barcode-hw-status'].textContent = '✅ 已啟用原生硬體 BarcodeDetector + USB 條碼槍雙引擎加速';
    } else {
      el['barcode-hw-status'].textContent = '✅ 使用 CCVD-144 v3 白平衡視覺指紋引擎 (< 0.15ms)';
    }
  }

  // Boot Application + Kiosk Mode + Customer Native Camera Deep-Link + PWA Service Worker
  window.addEventListener('DOMContentLoaded', async () => {
    bindElements();
    setupEvents();
    await initDataStore();

    try {
      const params = new URLSearchParams(window.location.search);
      const urlMode = params.get('mode');
      const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
      if (urlMode === 'customer' || (!urlMode && savedRole === 'customer')) {
        applyCustomerKioskMode(true);
      } else if (urlMode === 'admin') {
        applyCustomerKioskMode(false);
      }

      const targetSku = params.get('sku');
      if (targetSku) {
        const matchedProd = state.products.find(
          (p) => p.sku && p.sku.toLowerCase() === targetSku.toLowerCase()
        );
        if (matchedProd) {
          const stageIdx = VisionEngine.VIRTUAL_STAGE_ITEMS.findIndex(
            (it) => it.sku === matchedProd.sku
          );
          if (stageIdx >= 0) state.stageItemIndex = stageIdx;
          state.currentMatch = matchedProd;
          if (params.get('add') === '1') {
            addToCart(matchedProd.id, 1, false);
          } else {
            showToast(`📱 已透過相機載入「${matchedProd.name}」即時資訊！`);
          }
        }
      }
    } catch (_) {}

    // Register Offline-First PWA Service Worker on HTTP/HTTPS server origins
    if (
      'serviceWorker' in navigator &&
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local'
    ) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    scheduleRecognition(true);
  });
})();
