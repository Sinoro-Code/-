/**
 * VisionPOS Edge — Merchant Product Scan & Registration Controller
 * Streamlined Store-Facing Edition:
 * 1. Direct Top Optical Viewport (Zero blocks above viewfinder)
 * 2. Two Core Merchant Functions ONLY:
 *    - 掃描 (Scan): Lists full product info if registered; displays "未建檔" if unregistered
 *    - 庫存 (Inventory): 128x128 WebP thumbnail + CCVD-144 v3 descriptors + Barcode/QR registration
 * 3. Universal Android 5.0 (API 21) – Android 15/16+ WebView & Browser Compatibility (ES6-safe)
 * 4. 10-Second Background Camera Sensor Auto-Release & 16x16 Motion-Gated Eco Power Saving
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'vision_pos_edge_store_v1';
  var OUTBOX_STORAGE_KEY = 'vision_pos_outbox_v1';
  var BG_CAMERA_RELEASE_MS = 10000; // 10 seconds background auto-release for camera sensor power saving
  var STATIC_MOTION_DELTA = 2.6; // Unified motion-gate & continuous-AF ISP noise floor threshold
  var LONG_PRESS_MS = 1000; // 1-second long-press duration to open product card context menu (編輯 / 刪除)

  // Clean dark SVG placeholder so broken image icons never render before first capture
  var EMPTY_THUMB_DATA_URI =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
        '<rect width="128" height="128" rx="14" fill="#111827"/>' +
        '<rect x="28" y="34" width="72" height="60" rx="10" fill="none" stroke="#334155" stroke-width="4"/>' +
        '<circle cx="64" cy="64" r="15" fill="none" stroke="#10b981" stroke-width="4"/>' +
      '</svg>'
    );

  var state = {
    activeTab: 'scan', // 'scan' | 'register' | 'form'
    sourceMode: 'webcam', // 'webcam' | 'photo' | 'standby'
    products: [],
    threshold: 0.80,
    ecoGateEnabled: true,

    // Current Recognition Result & 3-Frame Temporal Hysteresis + Barcode
    currentMatch: null,
    currentSimilarity: 0,
    topCandidates: [],
    liveDescriptor: null,
    matchHistory: [],
    pendingHysteresis: false,
    lastDetectedBarcode: '',
    lastBarcodeTime: 0,
    barcodeTickCounter: 0,
    lastVibratedProductId: null,

    // Registration Draft
    regDescriptors: [],
    regThumbnail: '',
    regManualCaptured: false,
    lastLiveRegPreviewTime: 0,

    // Webcam State
    mediaStream: null,
    facingMode: 'environment',
    selectedDeviceId: '',
    resolutionHeight: 480,
    torchOn: false,
    autoPausedWebcamInBg: false,

    // Long-Press Context Menu & Delete Confirmation Modal State
    contextMenuProduct: null,
    pendingDeleteProduct: null,
    pendingDeleteReturnTab: null,
    armedConfirmMap: {},

    // Eco & Telemetry State
    staticFrameStreak: 0,
    lastActiveMotionMs: 0,
    hasEvaluatedFrame: false,
    isActivelyMoving: false,
    isEcoSleeping: false,
    lowBatteryMode: false,
    forceNextEval: true,
    lastInferenceMs: 0.12,
    lastMotionDelta: 0,
    connectedNodes: 1
  };

  // Exact DOM Elements cache matching public/index.html
  var el = {};
  var roiCorners = [];
  function bindElements() {
    var ids = [
      'merchant-workspace', 'viewport-section', 'viewport-container', 'camera-video', 'stage-canvas',
      'hud-overlay', 'hud-scan-dot', 'hud-live-label', 'hud-live-badge', 'btn-toggle-torch',
      'roi-reticle',
      'tab-btn-scan', 'tab-btn-register',
      'view-scan', 'view-register', 'view-form-modal', 'inventory-cards-list',
      'recognized-product-card', 'rec-img',
      'rec-name', 'rec-price', 'rec-stock', 'rec-expiry', 'rec-cost',
      'btn-jump-register',
      'card-context-menu-backdrop', 'card-context-menu', 'btn-ctx-edit', 'btn-ctx-delete',
      'delete-confirm-backdrop', 'delete-confirm-modal', 'delete-confirm-text', 'delete-confirm-prod-name',
      'btn-cancel-delete', 'btn-confirm-delete',
      'reg-preview-img', 'reg-descriptor-status', 'reg-sample-count',
      'btn-capture-frame', 'btn-add-angle-sample',
      'register-product-form', 'reg-id', 'reg-name', 'reg-price', 'reg-stock',
      'reg-expiry', 'reg-cost',
      'reg-sku', 'reg-barcode', 'reg-category', 'reg-unit', 'reg-location',
      'reg-spec', 'btn-submit-reg', 'btn-reset-reg-form', 'btn-modal-delete',
      'toast-stack'
    ];
    for (var i = 0; i < ids.length; i++) {
      el[ids[i]] = document.getElementById(ids[i]);
    }
    roiCorners =
      el['roi-reticle'] && typeof el['roi-reticle'].querySelectorAll === 'function'
        ? el['roi-reticle'].querySelectorAll('.roi-corner')
        : [];
    if (el['rec-img']) el['rec-img'].src = EMPTY_THUMB_DATA_URI;
    if (el['reg-preview-img']) el['reg-preview-img'].src = EMPTY_THUMB_DATA_URI;
  }

  // Subtle WebAudio Feedback + Optional Android Haptic Feedback
  var audioCtx = null;
  function playTone(freq, durationMs, type) {
    try {
      var f = freq || 880;
      var dur = durationMs || 55;
      var wave = type || 'sine';
      if (!audioCtx) {
        var AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(f, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur / 1000);
    } catch (_) {}
  }

  function triggerHaptic(ms) {
    try {
      if (window.VisionPOSAndroid && typeof window.VisionPOSAndroid.vibrate === 'function') {
        window.VisionPOSAndroid.vibrate(ms || 25);
      } else if (navigator && typeof navigator.vibrate === 'function') {
        navigator.vibrate(ms || 25);
      }
    } catch (_) {}
  }

  function showToast(message, type) {
    if (!el['toast-stack']) return;
    var div = document.createElement('div');
    div.className = 'toast';
    if (type === 'warn') div.className += ' warn';
    if (type === 'danger') div.className += ' danger';
    div.textContent = message;
    el['toast-stack'].appendChild(div);
    setTimeout(function () {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, 2600);
  }

  // Filter out legacy synthetic virtual demo items so only genuine merchant items remain
  function isMerchantProduct(p) {
    if (!p || !p.name) return false;
    if (p.virtualPresetId && !p.isCameraRegistered) return false;
    return true;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderInventoryCardsList() {
    var container = el['inventory-cards-list'];
    if (!container) return;
    var htmlParts = [];
    for (var i = 0; i < state.products.length; i++) {
      var p = state.products[i];
      if (!p) continue;
      var thumbSrc = p.thumbnail || EMPTY_THUMB_DATA_URI;
      var priceNum = Number(p.price) || 0;
      var stockNum = Number.isFinite(Number(p.stock)) ? Number(p.stock) : 0;
      var unitStr = p.unit || '件';
      var expiryStr = p.expiryDate && String(p.expiryDate).trim() ? String(p.expiryDate).trim() : '--';
      var costNum = Number(p.cost) || 0;

      htmlParts.push(
        '<div class="panel merchant-card inventory-item-card" data-product-id="' + escapeHtml(p.id) + '">' +
          '<div class="panel-body">' +
            '<div class="product-card-layout">' +
              '<img class="product-card-thumb" src="' + escapeHtml(thumbSrc) + '" alt="商品縮圖" />' +
              '<div class="product-card-details">' +
                '<div class="product-card-row">' +
                  '<span class="product-card-label">品名</span>' +
                  '<strong class="product-card-val name-val">' + escapeHtml(p.name) + '</strong>' +
                '</div>' +
                '<div class="product-card-row">' +
                  '<span class="product-card-label">價格</span>' +
                  '<strong class="product-card-val price-val">NT$ ' + priceNum.toLocaleString() + '</strong>' +
                '</div>' +
                '<div class="product-card-row">' +
                  '<span class="product-card-label">存量</span>' +
                  '<strong class="product-card-val">' + stockNum + ' ' + escapeHtml(unitStr) + '</strong>' +
                '</div>' +
                '<div class="product-card-row">' +
                  '<span class="product-card-label">效期</span>' +
                  '<strong class="product-card-val">' + escapeHtml(expiryStr) + '</strong>' +
                '</div>' +
                '<div class="product-card-row">' +
                  '<span class="product-card-label">成本</span>' +
                  '<strong class="product-card-val mono">NT$ ' + costNum.toLocaleString() + '</strong>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }
    container.innerHTML = htmlParts.join('');
  }

  function updateCatalogBadge() {
    renderInventoryCardsList();
  }

  // ==========================================================================
  // IndexedDB Async Store + LocalStorage + Offline Outbox + SSE Multi-Device Sync
  // ==========================================================================
  var IDBStore = (function () {
    var dbPromise = null;
    function openDB() {
      if (dbPromise) return dbPromise;
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      dbPromise = new Promise(function (resolve) {
        try {
          var req = indexedDB.open('vision_pos_idb_v1', 1);
          req.onupgradeneeded = function (e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains('kv')) {
              db.createObjectStore('kv');
            }
          };
          req.onsuccess = function () {
            resolve(req.result);
          };
          req.onerror = function () {
            resolve(null);
          };
        } catch (_) {
          resolve(null);
        }
      });
      return dbPromise;
    }
    return {
      get: function (key) {
        return openDB().then(function (db) {
          if (!db) return null;
          return new Promise(function (resolve) {
            try {
              var tx = db.transaction('kv', 'readonly');
              var req = tx.objectStore('kv').get(key);
              req.onsuccess = function () {
                resolve(req.result || null);
              };
              req.onerror = function () {
                resolve(null);
              };
            } catch (_) {
              resolve(null);
            }
          });
        });
      },
      set: function (key, val) {
        return openDB().then(function (db) {
          if (!db) return;
          try {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(val, key);
          } catch (_) {}
        });
      }
    };
  })();

  var broadcastChannel = null;
  try {
    if ('BroadcastChannel' in window) {
      broadcastChannel = new BroadcastChannel('vision_pos_edge_sync');
      broadcastChannel.onmessage = function (ev) {
        if (ev.data && ev.data.type === 'state_updated') {
          loadFromLocalStorage();
          updateCatalogBadge();
          invalidateRecognitionUICache();
          scheduleRecognition(true);
        }
      };
    }
  } catch (_) {
    broadcastChannel = null;
  }

  function getOutboxQueue() {
    try {
      var raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
      var list = raw ? JSON.parse(raw) : [];
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
    var list = getOutboxQueue();
    var copy = {};
    for (var k in op) {
      if (Object.prototype.hasOwnProperty.call(op, k)) copy[k] = op[k];
    }
    copy.queuedAt = Date.now();
    list.push(copy);
    saveOutboxQueue(list);
  }

  var isFlushingOutbox = false;
  async function flushOutboxToServer() {
    if (isFlushingOutbox) return;
    var queue = getOutboxQueue();
    if (queue.length === 0) return;
    isFlushingOutbox = true;
    var remaining = [];
    try {
      for (var i = 0; i < queue.length; i++) {
        var item = queue[i];
        try {
          if (item.type === 'upsert_product') {
            var r1 = await fetch('/api/products', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (!r1.ok && r1.status >= 500) remaining.push(item);
          } else if (item.type === 'patch_product') {
            var r2 = await fetch('/api/products/' + encodeURIComponent(item.id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (!r2.ok && r2.status >= 500) remaining.push(item);
          } else if (item.type === 'delete_product') {
            var r3 = await fetch('/api/products/' + encodeURIComponent(item.id), {
              method: 'DELETE'
            });
            if (!r3.ok && r3.status >= 500) remaining.push(item);
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

  function saveToLocalStorage() {
    var snapshot = {
      products: state.products,
      updatedAt: Date.now()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (_) {}
    IDBStore.set('store', snapshot);
  }

  function loadFromLocalStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.products)) {
        state.products = parsed.products
          .filter(isMerchantProduct)
          .map(function (p, idx) {
            if (!p.id) p.id = 'prd-repaired-' + idx + '-' + Date.now().toString(36);
            return p;
          });
        return true;
      }
    } catch (_) {}
    return false;
  }

  function normalizeLoadedProducts() {
    var changed = false;
    state.products = state.products.filter(isMerchantProduct);
    state.products.forEach(function (p) {
      if (Array.isArray(p.descriptors) && p.descriptors.length > 0) {
        if (typeof p.descriptors[0] !== 'string') {
          p.descriptors = VisionEngine.deduplicateDescriptors(p.descriptors, 16);
          p.descriptorVersion = 2;
          changed = true;
        }
        VisionEngine.ensureProductCache(p);
      }
      if (p.thumbnail && p.thumbnail.length > 14000) {
        VisionEngine.extractDescriptorsFromThumbnail(p.thumbnail, function (newDescs, thumb128) {
          if (thumb128 && thumb128.length < p.thumbnail.length) {
            p.thumbnail = thumb128;
            if ((!p.descriptors || p.descriptors.length === 0) && Array.isArray(newDescs)) {
              p.descriptors = newDescs;
              VisionEngine.ensureProductCache(p);
            }
            saveToLocalStorage();
          }
        });
      }
    });
    if (changed) {
      saveToLocalStorage();
    }
    updateCatalogBadge();
  }

  function mergeServerProducts(serverProducts) {
    if (!Array.isArray(serverProducts)) return;
    var byId = new Map();
    for (var i = 0; i < serverProducts.length; i++) {
      var sp = serverProducts[i];
      if (isMerchantProduct(sp) && sp.id) {
        byId.set(sp.id, sp);
      }
    }
    if (getOutboxQueue().length > 0) {
      for (var j = 0; j < state.products.length; j++) {
        var lp = state.products[j];
        if (!isMerchantProduct(lp) || !lp.id) continue;
        var existing = byId.get(lp.id);
        if (!existing || (lp.updatedAt || 0) > (existing.updatedAt || 0)) {
          byId.set(lp.id, lp);
        }
      }
    }
    state.products = Array.from(byId.values());
  }

  async function initDataStore() {
    var hasLocal = loadFromLocalStorage();
    if (!hasLocal) {
      var idbSnap = await IDBStore.get('store');
      if (idbSnap && Array.isArray(idbSnap.products)) {
        state.products = idbSnap.products.filter(isMerchantProduct);
        hasLocal = true;
      }
    }
    normalizeLoadedProducts();

    var isRemoteServerOrigin =
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local';

    if (isRemoteServerOrigin) {
      try {
        await flushOutboxToServer();
        var res = await fetch('/api/state');
        if (res.ok) {
          var data = await res.json();
          if (Array.isArray(data.products)) {
            mergeServerProducts(data.products);
            normalizeLoadedProducts();
            saveToLocalStorage();
          }
          connectSSE();
        }
      } catch (_) {}
    }

    updateCatalogBadge();
    invalidateRecognitionUICache();
    updateRecognitionUI({
      matched: false,
      exactBarcode: false,
      product: null,
      bestCandidate: null,
      similarity: 0,
      margin: 0,
      topCandidates: []
    });
  }

  function connectSSE() {
    try {
      var devType = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Merchant-Mobile' : 'Merchant-Terminal';
      var es = new EventSource('/api/events?deviceType=' + encodeURIComponent(devType));

      es.addEventListener('init', async function (e) {
        await flushOutboxToServer();
        var msg = JSON.parse(e.data);
        var payload = msg.payload || {};
        if (Array.isArray(payload.products)) {
          mergeServerProducts(payload.products);
          normalizeLoadedProducts();
          saveToLocalStorage();
          invalidateRecognitionUICache();
          scheduleRecognition(true);
        }
      });

      es.addEventListener('product_upserted', function (e) {
        var msg = JSON.parse(e.data);
        var prod = msg.payload && msg.payload.product;
        if (!isMerchantProduct(prod)) return;
        VisionEngine.ensureProductCache(prod);
        var idx = state.products.findIndex(function (p) {
          return p.id === prod.id;
        });
        if (idx >= 0) {
          state.products[idx] = prod;
        } else {
          state.products.unshift(prod);
        }
        updateCatalogBadge();
        saveToLocalStorage();
        invalidateRecognitionUICache();
        scheduleRecognition(true);
      });

      es.addEventListener('product_deleted', function (e) {
        var msg = JSON.parse(e.data);
        var delId = msg.payload && msg.payload.id;
        if (!delId) return;
        state.products = state.products.filter(function (p) {
          return p.id !== delId;
        });
        if (state.currentMatch && state.currentMatch.id === delId) {
          state.currentMatch = null;
        }
        updateCatalogBadge();
        saveToLocalStorage();
        invalidateRecognitionUICache();
        scheduleRecognition(true);
      });

      es.addEventListener('products_synced', function (e) {
        var msg = JSON.parse(e.data);
        var payload = msg.payload || {};
        if (Array.isArray(payload.products)) {
          state.products = payload.products.filter(isMerchantProduct);
          normalizeLoadedProducts();
          saveToLocalStorage();
          invalidateRecognitionUICache();
          scheduleRecognition(true);
        }
      });
    } catch (_) {}
  }

  function notifyPeers() {
    saveToLocalStorage();
    updateCatalogBadge();
    if (broadcastChannel) {
      try {
        broadcastChannel.postMessage({ type: 'state_updated', timestamp: Date.now() });
      } catch (_) {}
    }
  }

  // ==========================================================================
  // Optical Camera Pipeline (Live WebRTC Primary 1x Rear Lens + Native Photo)
  // ==========================================================================
  var bgCameraReleaseTimer = null;
  var stageCanvasCtx = null;

  function clearBgCameraReleaseTimer() {
    if (bgCameraReleaseTimer) {
      clearTimeout(bgCameraReleaseTimer);
      bgCameraReleaseTimer = null;
    }
  }

  function stopWebcamStream() {
    cancelVideoFrameSync();
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(function (t) {
        t.stop();
      });
      state.mediaStream = null;
    }
    if (el['camera-video']) {
      el['camera-video'].srcObject = null;
    }
    state.hasEvaluatedFrame = false;
    state.isActivelyMoving = false;
    updateHudCameraStatus();
  }

  async function startWebcamStream(isSilentOrAuto) {
    stopWebcamStream();
    clearBgCameraReleaseTimer();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.sourceMode = 'standby';
      renderStageCanvasFrame();
      updateHudCameraStatus();
      if (!isSilentOrAuto) {
        showToast('⚠️ 此環境不支援即時相機串流', 'warn');
      }
      return;
    }

    var height = state.resolutionHeight || 480;
    var width = Math.round(height * (4 / 3));
    var videoConstraints = {
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
      var stream;
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

      // Multi-Lens Android Flagship Guard (Samsung, Xiaomi, OPPO, vivo, Pixel, Sony):
      // Automatically switch away from ultra-wide/macro/depth auxiliary lenses to the primary 1x rear camera.
      if (state.facingMode === 'environment' && !state.selectedDeviceId && navigator.mediaDevices.enumerateDevices) {
        try {
          var firstTrack = stream.getVideoTracks()[0];
          var label0 = ((firstTrack && firstTrack.label) || '').toLowerCase();
          var caps0 = firstTrack && firstTrack.getCapabilities ? firstTrack.getCapabilities() : {};
          var looksAuxiliary = /ultra|wide-angle|0\.5|0\.6|macro|tele|depth|tof|mono/i.test(label0);
          if (looksAuxiliary || (!caps0.torch && /camera2\s+[2-9]/i.test(label0))) {
            var allDevs = await navigator.mediaDevices.enumerateDevices();
            var backCams = allDevs.filter(function (d) {
              return (
                d.kind === 'videoinput' &&
                /back|rear|environment|後|0/i.test(d.label || '') &&
                !/front|user|前|ultra|macro|tele|depth|tof/i.test(d.label || '')
              );
            });
            var primaryRear =
              backCams.find(function (d) {
                return /camera2\s*0|main|0,\s*facing\s*back/i.test(d.label || '');
              }) || backCams[0];
            var firstDevId =
              firstTrack && firstTrack.getSettings ? firstTrack.getSettings().deviceId : '';
            if (primaryRear && primaryRear.deviceId && primaryRear.deviceId !== firstDevId) {
              var betterStream = await navigator.mediaDevices.getUserMedia({
                video: {
                  deviceId: { exact: primaryRear.deviceId },
                  width: { ideal: width },
                  height: { ideal: height },
                  frameRate: { ideal: 24, max: 30 }
                },
                audio: false
              });
              stream.getTracks().forEach(function (t) {
                t.stop();
              });
              stream = betterStream;
            }
          }
        } catch (_) {}
      }

      // Enable Continuous Autofocus / Exposure / White-Balance on Android Camera2 WebRTC tracks
      try {
        var activeTrack = stream.getVideoTracks()[0];
        if (activeTrack && activeTrack.getCapabilities && activeTrack.applyConstraints) {
          var caps = activeTrack.getCapabilities();
          var adv = {};
          if (Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') !== -1) {
            adv.focusMode = 'continuous';
          }
          if (Array.isArray(caps.exposureMode) && caps.exposureMode.indexOf('continuous') !== -1) {
            adv.exposureMode = 'continuous';
          }
          if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf('continuous') !== -1) {
            adv.whiteBalanceMode = 'continuous';
          }
          if (Object.keys(adv).length > 0) {
            activeTrack.applyConstraints({ advanced: [adv] }).catch(function () {});
          }
        }
      } catch (_) {}

      state.mediaStream = stream;
      state.sourceMode = 'webcam';
      state.autoPausedWebcamInBg = false;
      state.torchOn = false;
      if (el['btn-toggle-torch']) el['btn-toggle-torch'].classList.remove('active');
      state.hasEvaluatedFrame = false;
      state.pendingHysteresis = false;
      state.isActivelyMoving = false;
      state.isEcoSleeping = false;
      state.staticFrameStreak = 0;
      state.lastActiveMotionMs = Date.now();

      var video = el['camera-video'];
      if (video) {
        video.srcObject = stream;
        video.removeAttribute('style');
        video.classList.toggle('mirrored', state.facingMode === 'user');
        video.classList.remove('hidden');
        await video.play();
      }
      if (el['stage-canvas']) el['stage-canvas'].classList.add('hidden');

      VisionEngine.resetMotionGate();
      updateHudCameraStatus();
      scheduleRecognition(true);
      if (!isSilentOrAuto) {
        showToast('✅ 已啟動即時辨識');
      }
    } catch (_) {
      state.sourceMode = 'standby';
      state.hasEvaluatedFrame = false;
      state.pendingHysteresis = false;
      state.isActivelyMoving = false;
      if (el['camera-video']) el['camera-video'].classList.add('hidden');
      if (el['stage-canvas']) el['stage-canvas'].classList.remove('hidden');
      renderStageCanvasFrame();
      updateHudCameraStatus();

      if (!isSilentOrAuto) {
        showToast('⚠️ 無法存取相機鏡頭，請確認已允許相機權限', 'warn');
      }
    }
  }

  async function toggleTorch() {
    if (!state.mediaStream) return;
    var track = state.mediaStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    var caps = track.getCapabilities();
    if (!caps.torch) return;
    var nextTorch = !state.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: nextTorch }] });
      state.torchOn = nextTorch;
      if (el['btn-toggle-torch']) {
        el['btn-toggle-torch'].classList.toggle('active', state.torchOn);
      }
    } catch (_) {
      state.torchOn = false;
      if (el['btn-toggle-torch']) {
        el['btn-toggle-torch'].classList.remove('active');
      }
    }
  }

  function renderStageCanvasFrame() {
    var canvas = el['stage-canvas'];
    var video = el['camera-video'];
    if (!canvas) return;

    if (
      state.sourceMode === 'webcam' &&
      state.mediaStream &&
      video &&
      video.readyState >= 2 &&
      video.videoWidth > 0
    ) {
      video.classList.remove('hidden');
      canvas.classList.add('hidden');
      return;
    }

    if (video) video.classList.add('hidden');
    canvas.classList.remove('hidden');
    if (!stageCanvasCtx) {
      stageCanvasCtx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    var ctx = stageCanvasCtx;
    var w = canvas.width;
    var h = canvas.height;

    // Clean Merchant Camera Standby Canvas (Zero fake demo items)
    var grad = ctx.createRadialGradient(w * 0.5, h * 0.48, 24, w * 0.5, h * 0.5, w * 0.72);
    grad.addColorStop(0, '#131c2b');
    grad.addColorStop(1, '#070b11');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.font = '600 17px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      state.autoPausedWebcamInBg ? '省電待機中（返回畫面即自動恢復辨識）' : '正在啟動相機鏡頭（請確認已允許相機權限）',
      w * 0.5,
      h * 0.5 - 6
    );
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.fillText('將商品或條碼置於中央取景框即可自動比對建檔資料', w * 0.5, h * 0.5 + 20);
  }

  function getActiveVideoSourceElement() {
    if (
      state.sourceMode === 'webcam' &&
      state.mediaStream &&
      el['camera-video'] &&
      el['camera-video'].readyState >= 2 &&
      el['camera-video'].videoWidth > 0
    ) {
      return el['camera-video'];
    }
    return el['stage-canvas'];
  }

  function hasValidOpticalSource() {
    return Boolean(
      state.sourceMode === 'webcam' &&
      state.mediaStream &&
      el['camera-video'] &&
      el['camera-video'].readyState >= 2 &&
      el['camera-video'].videoWidth > 0
    );
  }

  // Exact 4:3 object-fit:cover ROI mapping aligned with .roi-reticle
  function getRoiRect(sourceElem) {
    if (sourceElem === el['camera-video']) {
      var vw = sourceElem.videoWidth || 640;
      var vh = sourceElem.videoHeight || 480;
      var targetAspect = 4 / 3;
      var videoAspect = vw / vh;
      var visX = 0;
      var visY = 0;
      var visW = vw;
      var visH = vh;
      if (videoAspect > targetAspect) {
        visW = vh * targetAspect;
        visX = (vw - visW) * 0.5;
      } else if (videoAspect < targetAspect) {
        visH = vw / targetAspect;
        visY = (vh - visH) * 0.5;
      }
      var roiW = Math.round(visW * 0.58);
      var roiH = Math.round(visH * 0.62);
      var sx = Math.round(visX + (visW - roiW) * 0.5);
      var sy = Math.round(visY + (visH - roiH) * 0.5);
      return { sx: sx, sy: sy, sw: roiW, sh: roiH };
    }

    var sw = (sourceElem && sourceElem.width) || 640;
    var sh = (sourceElem && sourceElem.height) || 480;
    var rw = Math.round(sw * 0.58);
    var rh = Math.round(sh * 0.62);
    return {
      sx: Math.round((sw - rw) * 0.5),
      sy: Math.round((sh - rh) * 0.5),
      sw: rw,
      sh: rh
    };
  }

  // ==========================================================================
  // Event-Driven Scan Loop, 16x16 Motion Gate & 10s Background Auto-Release
  // ==========================================================================
  var scanTimerId = null;
  var videoFrameCallbackId = null;

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
    return state.sourceMode === 'webcam' && Boolean(state.mediaStream);
  }

  var lastHudVisualKey = '';

  function wakeFromEcoSleep() {
    state.staticFrameStreak = 0;
    state.lastActiveMotionMs = Date.now();
    if (state.isEcoSleeping) {
      state.isEcoSleeping = false;
      updateHudCameraStatus();
    }
  }

  function updateHudCameraStatus() {
    var overlay = el['hud-overlay'];
    var dot = el['hud-scan-dot'];
    var label = el['hud-live-label'];
    var liveBadge = el['hud-live-badge'];
    var reticle = el['roi-reticle'];
    var isLiveReady = isContinuousSourceActive() && hasValidOpticalSource();
    var isMatched = Boolean(state.currentMatch);

    // Strict 3-State Indicator Light & 4-Corner Reticle Binding:
    // 1. 'standby'      -> 橘燈 (#f59f1f) + 待機中 + 橘色四角 (相機未就緒 / 背景暫停 / 無匹配靜止 >= 2.5s)
    // 2. 'registered'   -> 綠燈 (#17bf82) + 辨識中 + 綠色四角 (即時掃描判斷為已建檔)
    // 3. 'unregistered' -> 紅燈 (#eb3b52) + 未建檔 + 紅色四角 (即時掃描判斷為未建檔)
    var mode = 'standby';
    if (
      state.autoPausedWebcamInBg ||
      document.hidden ||
      !isLiveReady ||
      !state.hasEvaluatedFrame
    ) {
      mode = 'standby';
    } else if (isMatched) {
      mode = 'registered';
    } else if (state.isEcoSleeping) {
      mode = 'standby';
    } else {
      mode = 'unregistered';
    }

    if (lastHudVisualKey === mode) return;
    lastHudVisualKey = mode;

    var signalHex = '#f59f1f';
    if (mode === 'standby') {
      signalHex = '#f59f1f';
      if (overlay) overlay.className = 'hud-overlay signal-amber';
      if (dot) dot.className = 'status-dot eco';
      if (label) label.textContent = '待機中';
      if (liveBadge) liveBadge.className = 'hud-status-badge state-standby';
      if (reticle) reticle.className = 'roi-reticle state-standby';
    } else if (mode === 'registered') {
      signalHex = '#17bf82';
      if (overlay) overlay.className = 'hud-overlay signal-green';
      if (dot) dot.className = 'status-dot active';
      if (label) label.textContent = '辨識中';
      if (liveBadge) liveBadge.className = 'hud-status-badge state-active';
      if (reticle) reticle.className = 'roi-reticle state-active';
    } else {
      signalHex = '#eb3b52';
      if (overlay) overlay.className = 'hud-overlay signal-red';
      if (dot) dot.className = 'status-dot unregistered';
      if (label) label.textContent = '未建檔';
      if (liveBadge) liveBadge.className = 'hud-status-badge state-unregistered';
      if (reticle) reticle.className = 'roi-reticle state-unregistered';
    }

    // Direct DOM inline color synchronization so the dot and all 4 reticle corners never desync
    if (overlay && overlay.style && typeof overlay.style.setProperty === 'function') {
      overlay.style.setProperty('--hud-signal-color', signalHex);
    }
    if (dot && dot.style) {
      dot.style.backgroundColor = signalHex;
    }
    if (liveBadge && liveBadge.style) {
      liveBadge.style.borderColor = signalHex;
    }
    if (
      (!roiCorners || roiCorners.length === 0) &&
      reticle &&
      typeof reticle.querySelectorAll === 'function'
    ) {
      roiCorners = reticle.querySelectorAll('.roi-corner');
    }
    if (roiCorners && roiCorners.length) {
      for (var c = 0; c < roiCorners.length; c++) {
        if (roiCorners[c] && roiCorners[c].style) {
          roiCorners[c].style.borderColor = signalHex;
        }
      }
    }
  }

  function scheduleRecognition(forceImmediate) {
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
      updateHudCameraStatus();
      return;
    }

    if (scanTimerId !== null || videoFrameCallbackId !== null) return;

    var nextInterval = state.isEcoSleeping ? 400 : (state.lowBatteryMode ? 100 : 55);
    scanTimerId = setTimeout(function () {
      scanTimerId = null;
      var video = el['camera-video'];
      if (
        state.sourceMode === 'webcam' &&
        state.mediaStream &&
        !state.isEcoSleeping &&
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        typeof video.requestVideoFrameCallback === 'function'
      ) {
        videoFrameCallbackId = video.requestVideoFrameCallback(function () {
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
      updateHudCameraStatus();
      return;
    }

    var continuous = isContinuousSourceActive();
    if (!state.forceNextEval && !continuous) {
      updateHudCameraStatus();
      return;
    }

    var forceEval = state.forceNextEval;
    state.forceNextEval = false;

    renderStageCanvasFrame();

    if (!hasValidOpticalSource()) {
      state.hasEvaluatedFrame = false;
      state.pendingHysteresis = false;
      state.isActivelyMoving = false;
      updateHudCameraStatus();
      updateRecognitionUI({
        matched: false,
        exactBarcode: false,
        product: null,
        bestCandidate: null,
        similarity: 0,
        margin: 0,
        topCandidates: []
      });
      // Keep polling while camera stream is warming up (e.g. Android Camera2 readyState < 2 at t=0ms)
      if (continuous) {
        state.forceNextEval = true;
        scheduleRecognition(false);
      }
      return;
    }

    var sourceElem = getActiveVideoSourceElement();
    var roiRect = getRoiRect(sourceElem);

    var t0 = performance.now();
    var sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, false, {
      skipIfStatic:
        state.ecoGateEnabled &&
        !forceEval &&
        continuous &&
        !state.isActivelyMoving &&
        !state.pendingHysteresis,
      staticThreshold: STATIC_MOTION_DELTA
    });
    state.lastMotionDelta = sig.motionDelta;

    if (sig.isStaticSkip) {
      state.isActivelyMoving = false;
      state.staticFrameStreak++;
      if (
        !state.isEcoSleeping &&
        state.staticFrameStreak >= 12 &&
        Date.now() - state.lastActiveMotionMs >= 2500
      ) {
        state.isEcoSleeping = true;
      }
      updateHudCameraStatus();
      scheduleRecognition(false);
      return;
    }

    // Genuine inter-frame camera pan (exclude first-frame reset sentinel 255)
    state.isActivelyMoving = Boolean(continuous && sig.motionDelta >= 10 && sig.motionDelta < 250);

    if (state.ecoGateEnabled && continuous && sig.motionDelta < STATIC_MOTION_DELTA) {
      state.staticFrameStreak++;
      if (
        !state.isEcoSleeping &&
        state.staticFrameStreak >= 12 &&
        Date.now() - state.lastActiveMotionMs >= 2500
      ) {
        state.isEcoSleeping = true;
      }
    } else {
      wakeFromEcoSleep();
    }

    // Live Registration Preview on Registration Form Modal when webcam is active and not manually locked
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (
      state.activeTab === 'form' &&
      state.sourceMode === 'webcam' &&
      !state.regManualCaptured &&
      activeTag !== 'INPUT' &&
      activeTag !== 'TEXTAREA' &&
      activeTag !== 'SELECT'
    ) {
      var nowMs = Date.now();
      if (!state.lastLiveRegPreviewTime || nowMs - state.lastLiveRegPreviewTime > 550) {
        state.lastLiveRegPreviewTime = nowMs;
        var regSig = VisionEngine.captureFrameSignature(sourceElem, roiRect, true);
        state.regDescriptors = regSig.augmentedDescriptors || [regSig.descriptor];
        state.regThumbnail = regSig.thumbnail;
        if (el['reg-preview-img'] && state.regThumbnail) {
          el['reg-preview-img'].src = state.regThumbnail;
        }
        if (el['reg-sample-count']) {
          el['reg-sample-count'].textContent = '樣本: ' + state.regDescriptors.length + ' 組';
        }
        if (el['reg-descriptor-status']) {
          el['reg-descriptor-status'].textContent = '即時取景特徵就緒';
        }
      }
    }

    // Parallel Non-Blocking Hardware BarcodeDetector Probe (every 4th active frame)
    if (state.sourceMode === 'webcam' && typeof VisionEngine.detectBarcode === 'function') {
      state.barcodeTickCounter = (state.barcodeTickCounter + 1) & 3;
      if (state.barcodeTickCounter === 0) {
        VisionEngine.detectBarcode(sourceElem).then(function (codeObj) {
          if (codeObj && codeObj.rawValue) {
            var isNewBarcode = state.lastDetectedBarcode !== codeObj.rawValue;
            state.lastDetectedBarcode = codeObj.rawValue;
            state.lastBarcodeTime = Date.now();
            if (state.activeTab === 'form' && el['reg-barcode'] && !el['reg-barcode'].value.trim()) {
              el['reg-barcode'].value = codeObj.rawValue;
              showToast('⚡ 已自動帶入條碼：' + codeObj.rawValue);
            } else if (isNewBarcode) {
              scheduleRecognition(true);
            }
          }
        });
      }
    }

    var freshBarcode =
      state.lastDetectedBarcode && Date.now() - state.lastBarcodeTime < 1500
        ? state.lastDetectedBarcode
        : '';

    var rawMatchRes = VisionEngine.matchProducts(
      sig.descriptor,
      state.products,
      state.threshold,
      sig.queryDescriptors,
      {
        sourceMode: state.sourceMode === 'photo' ? 'photo' : 'webcam',
        virtualPresetId: null,
        detectedBarcode: freshBarcode
      }
    );

    // 3-Frame Temporal Hysteresis on live webcam stream (instant lock on barcode or >= 93% similarity)
    var matchRes = rawMatchRes;
    if (
      state.sourceMode === 'webcam' &&
      !rawMatchRes.exactBarcode &&
      rawMatchRes.similarity < 0.93
    ) {
      var frameId = rawMatchRes.matched && rawMatchRes.product ? rawMatchRes.product.id : null;
      state.matchHistory.push(frameId);
      if (state.matchHistory.length > 3) state.matchHistory.shift();

      if (state.matchHistory.length >= 2) {
        var consensusId;
        var hasConsensus = false;
        for (var i = 0; i < state.matchHistory.length; i++) {
          var candId = state.matchHistory[i];
          var cnt = 0;
          for (var j = 0; j < state.matchHistory.length; j++) {
            if (state.matchHistory[j] === candId) cnt++;
          }
          if (cnt >= 2) {
            consensusId = candId;
            hasConsensus = true;
            break;
          }
        }
        if (hasConsensus && consensusId !== frameId) {
          if (consensusId === null) {
            matchRes = {
              matched: false,
              exactBarcode: false,
              product: null,
              bestCandidate: rawMatchRes.bestCandidate,
              similarity: rawMatchRes.similarity,
              margin: rawMatchRes.margin,
              topCandidates: rawMatchRes.topCandidates
            };
          } else {
            var heldProd = state.products.find(function (p) {
              return p.id === consensusId;
            });
            if (heldProd) {
              matchRes = {
                matched: true,
                exactBarcode: false,
                product: heldProd,
                bestCandidate: heldProd,
                similarity: rawMatchRes.similarity,
                margin: rawMatchRes.margin,
                topCandidates: rawMatchRes.topCandidates
              };
            }
          }
        }
      }

      // Ensure static-skip never freezes matchHistory while transitioning between states
      var allSame = state.matchHistory.length >= 2;
      for (var hIdx = 0; hIdx < state.matchHistory.length; hIdx++) {
        if (state.matchHistory[hIdx] !== frameId) {
          allSame = false;
          break;
        }
      }
      state.pendingHysteresis = !allSame;
    } else {
      var instantId = rawMatchRes.matched && rawMatchRes.product ? rawMatchRes.product.id : null;
      state.matchHistory = [instantId, instantId];
      state.pendingHysteresis = false;
    }

    state.lastInferenceMs = +(performance.now() - t0).toFixed(2);
    state.liveDescriptor = sig.descriptor;
    state.currentMatch = matchRes.matched ? matchRes.product : null;
    state.currentSimilarity = matchRes.similarity;
    state.topCandidates = matchRes.topCandidates || [];
    state.hasEvaluatedFrame = true;

    if (matchRes.matched && matchRes.product) {
      if (state.lastVibratedProductId !== matchRes.product.id) {
        state.lastVibratedProductId = matchRes.product.id;
        triggerHaptic(22);
      }
    } else {
      state.lastVibratedProductId = null;
    }

    updateRecognitionUI(matchRes, freshBarcode);
    scheduleRecognition(false);
  }

  // State-diffed Merchant Recognition UI Updater
  var lastUIState = {
    matched: null,
    renderKey: ''
  };

  function invalidateRecognitionUICache() {
    lastUIState.renderKey = '';
    lastUIState.matched = null;
    lastHudVisualKey = '';
  }

  function updateRecognitionUI(matchRes) {
    var isMatched = Boolean(matchRes && matchRes.matched && matchRes.product);

    lastUIState.matched = isMatched;
    updateHudCameraStatus();

    if (isMatched) {
      var p = matchRes.product;
      var priceNum = Number(p.price) || 0;
      var stockNum = Number.isFinite(Number(p.stock)) ? Number(p.stock) : 0;
      var unitStr = p.unit || '件';
      var expiryStr = p.expiryDate && String(p.expiryDate).trim() ? String(p.expiryDate).trim() : '--';
      var costNum = Number(p.cost) || 0;

      var pKey = [
        p.id, p.name, priceNum, stockNum, unitStr, expiryStr, costNum, (p.thumbnail || '').length
      ].join('|');

      if (lastUIState.renderKey !== pKey) {
        lastUIState.renderKey = pKey;

        if (el['recognized-product-card']) {
          el['recognized-product-card'].classList.remove('hidden');
          if (typeof el['recognized-product-card'].setAttribute === 'function') {
            el['recognized-product-card'].setAttribute('data-product-id', p.id);
          }
        }

        var thumbSrc = p.thumbnail || EMPTY_THUMB_DATA_URI;
        if (el['rec-img'] && el['rec-img'].getAttribute('src') !== thumbSrc) {
          el['rec-img'].src = thumbSrc;
        }
        if (el['rec-name']) el['rec-name'].textContent = p.name;
        if (el['rec-price']) el['rec-price'].textContent = 'NT$ ' + priceNum.toLocaleString();
        if (el['rec-stock']) el['rec-stock'].textContent = stockNum + ' ' + unitStr;
        if (el['rec-expiry']) el['rec-expiry'].textContent = expiryStr;
        if (el['rec-cost']) el['rec-cost'].textContent = 'NT$ ' + costNum.toLocaleString();

        resetDeleteButtonUI();
      } else if (el['recognized-product-card']) {
        el['recognized-product-card'].classList.remove('hidden');
      }
    } else {
      lastUIState.renderKey = '__UNREG__';
      if (el['recognized-product-card']) {
        el['recognized-product-card'].classList.add('hidden');
      }
    }
  }

  // ==========================================================================
  // Merchant Product Registration & Maintenance Workflow
  // ==========================================================================
  function captureForRegistration(appendAngle, isManual) {
    renderStageCanvasFrame();
    if (!hasValidOpticalSource()) {
      if (el['reg-descriptor-status']) {
        el['reg-descriptor-status'].textContent = '等待即時鏡頭畫面就緒';
      }
      return false;
    }

    var sourceElem = getActiveVideoSourceElement();
    var roiRect = getRoiRect(sourceElem);
    var sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, true);
    if (isManual) {
      state.regManualCaptured = true;
    }

    var extracted = sig.augmentedDescriptors || [sig.descriptor];
    if (appendAngle && state.regDescriptors.length > 0) {
      var combined = state.regDescriptors.concat(extracted);
      state.regDescriptors = VisionEngine.deduplicateDescriptors(combined, 24);
      state.regThumbnail = sig.thumbnail || state.regThumbnail;
      showToast('📸 已補拍新角度！目前共 ' + state.regDescriptors.length + ' 組特徵樣本');
    } else {
      state.regDescriptors = VisionEngine.deduplicateDescriptors(extracted, 12);
      state.regThumbnail = sig.thumbnail;
    }

    if (el['reg-preview-img'] && state.regThumbnail) {
      el['reg-preview-img'].src = state.regThumbnail;
    }
    if (el['reg-sample-count']) {
      el['reg-sample-count'].textContent = '樣本: ' + state.regDescriptors.length + ' 組';
    }
    if (el['reg-descriptor-status']) {
      el['reg-descriptor-status'].textContent = '已鎖定畫面 144 維特徵';
    }

    // Pre-fill detected barcode if barcode input is currently blank
    if (
      el['reg-barcode'] &&
      !el['reg-barcode'].value.trim() &&
      state.lastDetectedBarcode &&
      Date.now() - state.lastBarcodeTime < 8000
    ) {
      el['reg-barcode'].value = state.lastDetectedBarcode;
    }

    playTone(1040, 45, 'triangle');
    return true;
  }

  async function handleRegistrationSubmit(e) {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }

    // Ensure visual signature is captured if an optical source is active and no samples exist yet
    if (state.regDescriptors.length === 0 && hasValidOpticalSource()) {
      captureForRegistration(false, true);
    }

    var editingId = el['reg-id'] ? el['reg-id'].value.trim() : '';
    var rawName = el['reg-name'] ? el['reg-name'].value.trim() : '';
    var prodName = rawName || ('店家商品 #' + (state.products.length + 1));

    var rawPrice = el['reg-price'] ? el['reg-price'].value.trim() : '';
    var prodPrice = rawPrice !== '' ? Math.max(0, Number(rawPrice) || 0) : 0;

    var rawStock = el['reg-stock'] ? el['reg-stock'].value.trim() : '';
    var prodStock = rawStock !== '' ? Math.max(0, Math.floor(Number(rawStock) || 0)) : 10;

    var prodExpiry = el['reg-expiry'] ? el['reg-expiry'].value.trim() : '';
    var rawCost = el['reg-cost'] ? el['reg-cost'].value.trim() : '';
    var prodCost = rawCost !== '' ? Math.max(0, Number(rawCost) || 0) : 0;

    var now = Date.now();
    var rawSku = el['reg-sku'] ? el['reg-sku'].value.trim() : '';
    var prodSku = rawSku || ('SKU-' + String(state.products.length + 101).padStart(4, '0'));
    var prodBarcode = el['reg-barcode'] ? el['reg-barcode'].value.trim() : '';
    var prodCategory = (el['reg-category'] && el['reg-category'].value.trim()) || '一般商品';
    var prodUnit = (el['reg-unit'] && el['reg-unit'].value.trim()) || '件';
    var prodLocation = (el['reg-location'] && el['reg-location'].value.trim()) || 'A-01';
    var prodSpec = el['reg-spec'] ? el['reg-spec'].value.trim() : '';

    var descriptors = VisionEngine.deduplicateDescriptors(state.regDescriptors || [], 24);
    if (descriptors.length === 0 && !prodBarcode) {
      showToast('⚠️ 請先擷取商品畫面或輸入條碼再儲存建檔', 'warn');
      return;
    }

    var payload = {
      name: prodName,
      price: prodPrice,
      cost: prodCost,
      stock: prodStock,
      expiryDate: prodExpiry,
      sku: prodSku,
      barcode: prodBarcode,
      category: prodCategory,
      unit: prodUnit,
      location: prodLocation,
      spec: prodSpec,
      thumbnail: state.regThumbnail || EMPTY_THUMB_DATA_URI,
      descriptors: descriptors,
      descriptorVersion: 2,
      isCameraRegistered: true,
      virtualPresetId: null
    };

    var savedProduct = null;
    var existingIdx = editingId
      ? state.products.findIndex(function (p) {
          return p.id === editingId;
        })
      : -1;

    if (existingIdx >= 0) {
      var existing = state.products[existingIdx];
      savedProduct = {
        id: existing.id,
        name: payload.name,
        price: payload.price,
        cost: payload.cost,
        stock: payload.stock,
        expiryDate: payload.expiryDate,
        sku: payload.sku,
        barcode: payload.barcode,
        category: payload.category,
        unit: payload.unit,
        location: payload.location,
        spec: payload.spec,
        thumbnail: payload.thumbnail || existing.thumbnail,
        descriptors: payload.descriptors.length > 0 ? payload.descriptors : (existing.descriptors || []),
        descriptorVersion: 2,
        isCameraRegistered: true,
        virtualPresetId: null,
        createdAt: existing.createdAt || now,
        updatedAt: now
      };
      state.products[existingIdx] = savedProduct;
    } else {
      savedProduct = {
        id: 'prd-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: payload.name,
        price: payload.price,
        cost: payload.cost,
        stock: payload.stock,
        expiryDate: payload.expiryDate,
        sku: payload.sku,
        barcode: payload.barcode,
        category: payload.category,
        unit: payload.unit,
        location: payload.location,
        spec: payload.spec,
        thumbnail: payload.thumbnail,
        descriptors: payload.descriptors,
        descriptorVersion: 2,
        isCameraRegistered: true,
        virtualPresetId: null,
        createdAt: now,
        updatedAt: now
      };
      state.products.unshift(savedProduct);
    }

    VisionEngine.ensureProductCache(savedProduct);
    notifyPeers();

    // Async persist to server (or Offline Outbox if offline / standalone APK)
    var isRemoteServerOrigin =
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local';

    if (isRemoteServerOrigin) {
      try {
        var res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(savedProduct)
        });
        if (res.ok) {
          var data = await res.json();
          if (data && data.product) {
            VisionEngine.ensureProductCache(data.product);
            var sIdx = state.products.findIndex(function (p) {
              return p.id === savedProduct.id || p.id === data.product.id;
            });
            if (sIdx >= 0) state.products[sIdx] = data.product;
            savedProduct = data.product;
            saveToLocalStorage();
            renderInventoryCardsList();
          }
        } else if (res.status >= 500) {
          enqueueOutbox({ type: 'upsert_product', payload: savedProduct });
        }
      } catch (_) {
        enqueueOutbox({ type: 'upsert_product', payload: savedProduct });
      }
    }

    resetRegistrationForm();
    switchTab('scan', true);

    // Immediately show the newly registered product's complete info on Scan View
    state.currentMatch = savedProduct;
    state.currentSimilarity = 0.998;
    state.matchHistory = [savedProduct.id, savedProduct.id];
    state.pendingHysteresis = false;
    wakeFromEcoSleep();
    state.hasEvaluatedFrame = true;
    state.isActivelyMoving = false;
    invalidateRecognitionUICache();
    updateRecognitionUI({
      matched: true,
      exactBarcode: Boolean(savedProduct.barcode && savedProduct.barcode === state.lastDetectedBarcode),
      product: savedProduct,
      bestCandidate: savedProduct,
      similarity: 0.998,
      margin: 1.0,
      topCandidates: [{ product: savedProduct, similarity: 0.998 }]
    });

    triggerHaptic(35);
    playTone(1320, 75, 'sine');
    showToast('✅ 建檔完成：「' + savedProduct.name + '」已儲存！');
  }

  function resetRegistrationForm() {
    if (el['register-product-form']) el['register-product-form'].reset();
    if (el['reg-id']) el['reg-id'].value = '';
    if (el['reg-name']) el['reg-name'].value = '';
    if (el['reg-price']) el['reg-price'].value = '';
    if (el['reg-stock']) el['reg-stock'].value = '10';
    if (el['reg-expiry']) el['reg-expiry'].value = '';
    if (el['reg-cost']) el['reg-cost'].value = '';
    if (el['reg-sku']) el['reg-sku'].value = '';
    if (el['reg-barcode']) el['reg-barcode'].value = '';
    if (el['reg-category']) el['reg-category'].value = '一般商品';
    if (el['reg-unit']) el['reg-unit'].value = '件';
    if (el['reg-location']) el['reg-location'].value = 'A-01';
    if (el['reg-spec']) el['reg-spec'].value = '';
    if (el['btn-submit-reg']) el['btn-submit-reg'].textContent = '✅ 儲存商品建檔';
    if (el['btn-modal-delete']) {
      el['btn-modal-delete'].classList.add('hidden');
      el['btn-modal-delete'].classList.remove('btn-danger');
      el['btn-modal-delete'].textContent = '🗑️ 刪除';
    }
    if (el['reg-preview-img']) el['reg-preview-img'].src = EMPTY_THUMB_DATA_URI;
    if (el['reg-sample-count']) el['reg-sample-count'].textContent = '樣本: 0 組';
    if (el['reg-descriptor-status']) el['reg-descriptor-status'].textContent = '準備擷取畫面特徵';

    state.regDescriptors = [];
    state.regThumbnail = '';
    state.regManualCaptured = false;
  }

  function openEditForProduct(p) {
    if (!p) return;
    switchTab('form', true);
    if (el['reg-id']) el['reg-id'].value = p.id;
    if (el['reg-name']) el['reg-name'].value = p.name || '';
    if (el['reg-price']) el['reg-price'].value = String(Number(p.price) || 0);
    if (el['reg-stock']) el['reg-stock'].value = String(Number.isFinite(Number(p.stock)) ? Number(p.stock) : 0);
    if (el['reg-expiry']) el['reg-expiry'].value = p.expiryDate || '';
    if (el['reg-cost']) el['reg-cost'].value = p.cost !== undefined && p.cost !== '' ? String(Number(p.cost) || 0) : '';
    if (el['reg-sku']) el['reg-sku'].value = p.sku || '';
    if (el['reg-barcode']) el['reg-barcode'].value = p.barcode || '';
    if (el['reg-category']) el['reg-category'].value = p.category || '一般商品';
    if (el['reg-unit']) el['reg-unit'].value = p.unit || '件';
    if (el['reg-location']) el['reg-location'].value = p.location || 'A-01';
    if (el['reg-spec']) el['reg-spec'].value = p.spec || '';
    if (el['btn-submit-reg']) el['btn-submit-reg'].textContent = '💾 儲存建檔修改';
    if (el['btn-modal-delete']) {
      el['btn-modal-delete'].classList.remove('hidden');
      el['btn-modal-delete'].classList.remove('btn-danger');
      el['btn-modal-delete'].textContent = '🗑️ 刪除';
    }

    state.regDescriptors = Array.isArray(p.descriptors) ? p.descriptors.slice() : [];
    state.regThumbnail = p.thumbnail || EMPTY_THUMB_DATA_URI;
    state.regManualCaptured = true;

    if (el['reg-preview-img']) el['reg-preview-img'].src = state.regThumbnail;
    if (el['reg-sample-count']) {
      el['reg-sample-count'].textContent = '樣本: ' + state.regDescriptors.length + ' 組';
    }
    if (el['reg-descriptor-status']) {
      el['reg-descriptor-status'].textContent = '編輯已建檔商品';
    }
    showToast('✏️ 正在編輯「' + p.name + '」');
  }

  function resetDeleteButtonUI() {
    if (el['btn-modal-delete']) {
      el['btn-modal-delete'].classList.remove('btn-danger');
      el['btn-modal-delete'].textContent = '🗑️ 刪除';
    }
  }

  function openCardContextMenu(product) {
    if (!product) return;
    state.contextMenuProduct = product;
    if (el['card-context-menu-backdrop']) {
      el['card-context-menu-backdrop'].classList.remove('hidden');
    }
    triggerHaptic(35);
    playTone(960, 45, 'sine');
  }

  function closeCardContextMenu() {
    state.contextMenuProduct = null;
    if (el['card-context-menu-backdrop']) {
      el['card-context-menu-backdrop'].classList.add('hidden');
    }
  }

  function openDeleteConfirmModal(product, returnToTab) {
    if (!product) return;
    state.pendingDeleteProduct = product;
    state.pendingDeleteReturnTab = returnToTab || null;
    if (el['delete-confirm-prod-name']) {
      el['delete-confirm-prod-name'].textContent = product.name || '';
    }
    if (el['delete-confirm-backdrop']) {
      el['delete-confirm-backdrop'].classList.remove('hidden');
    }
    triggerHaptic(25);
  }

  function closeDeleteConfirmModal() {
    state.pendingDeleteProduct = null;
    state.pendingDeleteReturnTab = null;
    if (el['delete-confirm-backdrop']) {
      el['delete-confirm-backdrop'].classList.add('hidden');
    }
  }

  async function executeDeleteProduct(product, returnToTab) {
    if (!product) return;
    var deletedId = product.id;
    var deletedName = product.name;

    delete state.armedConfirmMap['del:' + deletedId];
    resetDeleteButtonUI();

    state.products = state.products.filter(function (p) {
      return p.id !== deletedId;
    });
    if (state.currentMatch && state.currentMatch.id === deletedId) {
      state.currentMatch = null;
      state.matchHistory = [null, null];
      state.pendingHysteresis = false;
    }
    wakeFromEcoSleep();
    state.hasEvaluatedFrame = true;
    state.isActivelyMoving = false;
    notifyPeers();
    invalidateRecognitionUICache();

    if (!state.currentMatch) {
      updateRecognitionUI({
        matched: false,
        exactBarcode: false,
        product: null,
        bestCandidate: null,
        similarity: 0,
        margin: 0,
        topCandidates: []
      });
    }

    if (returnToTab) {
      resetRegistrationForm();
      switchTab(returnToTab, true);
    } else if (state.activeTab === 'register') {
      renderInventoryCardsList();
    }

    var isRemoteServerOrigin =
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local';
    if (isRemoteServerOrigin) {
      try {
        var r = await fetch('/api/products/' + encodeURIComponent(deletedId), {
          method: 'DELETE'
        });
        if (!r.ok && r.status >= 500) {
          enqueueOutbox({ type: 'delete_product', id: deletedId });
        }
      } catch (_) {
        enqueueOutbox({ type: 'delete_product', id: deletedId });
      }
    }

    triggerHaptic(35);
    showToast('🗑️ 已刪除「' + deletedName + '」建檔資料', 'warn');
  }

  // Bind 1-second (1000ms) Long-Press Gesture to a Product Card or Card Container
  function bindLongPressCardMenu(containerEl, resolveTargetFn) {
    if (!containerEl) return;
    var longPressTimer = null;
    var activeCardEl = null;
    var startX = 0;
    var startY = 0;

    function clearPressState() {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (activeCardEl && activeCardEl.classList) {
        activeCardEl.classList.remove('pressing');
      }
      activeCardEl = null;
    }

    function getCoords(ev) {
      if (ev && ev.touches && ev.touches.length > 0) {
        return { x: ev.touches[0].clientX || 0, y: ev.touches[0].clientY || 0 };
      }
      return { x: (ev && ev.clientX) || 0, y: (ev && ev.clientY) || 0 };
    }

    function onPressStart(ev) {
      if (ev && ev.type === 'mousedown' && ev.button && ev.button !== 0) return;
      var resolved = resolveTargetFn(ev);
      if (!resolved || !resolved.product) return;

      clearPressState();
      var pt = getCoords(ev);
      startX = pt.x;
      startY = pt.y;
      activeCardEl = resolved.cardEl || containerEl;
      if (activeCardEl && activeCardEl.classList) {
        activeCardEl.classList.add('pressing');
      }

      var targetProd = resolved.product;
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        if (activeCardEl && activeCardEl.classList) {
          activeCardEl.classList.remove('pressing');
        }
        activeCardEl = null;
        openCardContextMenu(targetProd);
      }, LONG_PRESS_MS);
    }

    function onPressMove(ev) {
      if (longPressTimer === null) return;
      var pt = getCoords(ev);
      if (Math.abs(pt.x - startX) > 12 || Math.abs(pt.y - startY) > 12) {
        clearPressState();
      }
    }

    function onPressEnd() {
      clearPressState();
    }

    containerEl.addEventListener('touchstart', onPressStart, { passive: true });
    containerEl.addEventListener('touchmove', onPressMove, { passive: true });
    containerEl.addEventListener('touchend', onPressEnd);
    containerEl.addEventListener('touchcancel', onPressEnd);
    containerEl.addEventListener('mousedown', onPressStart);
    containerEl.addEventListener('mousemove', onPressMove);
    containerEl.addEventListener('mouseup', onPressEnd);
    containerEl.addEventListener('mouseleave', onPressEnd);
    containerEl.addEventListener('contextmenu', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
    });
  }

  // ==========================================================================
  // Tab Switching & Event Bindings
  // ==========================================================================
  function switchTab(tabName, skipAutoCapture) {
    closeCardContextMenu();
    closeDeleteConfirmModal();
    if (tabName === 'form') {
      state.activeTab = 'form';
    } else if (tabName === 'register') {
      state.activeTab = 'register';
    } else {
      state.activeTab = 'scan';
    }

    if (el['tab-btn-scan']) {
      el['tab-btn-scan'].classList.toggle('active', state.activeTab === 'scan');
    }
    if (el['tab-btn-register']) {
      el['tab-btn-register'].classList.toggle('active', state.activeTab === 'register');
    }
    if (el['view-scan']) {
      el['view-scan'].classList.toggle('hidden', state.activeTab !== 'scan');
    }
    if (el['view-register']) {
      el['view-register'].classList.toggle('hidden', state.activeTab !== 'register');
    }
    if (el['view-form-modal']) {
      el['view-form-modal'].classList.toggle('hidden', state.activeTab !== 'form');
    }

    // Hide top optical viewport on the 庫存 (register) product cards list page; show on 掃描 & 拍照建檔 form
    var hideViewport = state.activeTab === 'register';
    if (el['viewport-section']) {
      el['viewport-section'].classList.toggle('hidden', hideViewport);
    }
    if (el['merchant-workspace']) {
      el['merchant-workspace'].classList.toggle('inventory-only', hideViewport);
    }

    if (state.activeTab === 'register') {
      renderInventoryCardsList();
    }

    updateHudCameraStatus();
    if (state.activeTab === 'form' && !skipAutoCapture && hasValidOpticalSource()) {
      captureForRegistration(false, false);
    }
    scheduleRecognition(true);
  }

  function setupEvents() {
    window.__resumeLiveCamera = function () {
      if (!state.mediaStream) {
        startWebcamStream(true);
      }
    };

    // Trigger immediate evaluation the exact millisecond hardware video frame decoding completes
    if (el['camera-video']) {
      var onVideoFrameReady = function () {
        if (isContinuousSourceActive() && !state.hasEvaluatedFrame) {
          scheduleRecognition(true);
        }
      };
      el['camera-video'].addEventListener('loadeddata', onVideoFrameReady);
      el['camera-video'].addEventListener('playing', onVideoFrameReady);
    }

    // 1. Two Merchant Tabs: 掃描 & 庫存
    if (el['tab-btn-scan']) {
      el['tab-btn-scan'].addEventListener('click', function () {
        switchTab('scan', false);
        if (!state.mediaStream) {
          startWebcamStream(true);
        }
      });
    }
    if (el['tab-btn-register']) {
      el['tab-btn-register'].addEventListener('click', function () {
        switchTab('register', true);
      });
    }

    // 2. In-Viewfinder Control (Top-Left 辨識中 is non-clickable; Top-Right is Flash Icon)
    if (el['btn-toggle-torch']) {
      el['btn-toggle-torch'].addEventListener('click', function () {
        toggleTorch();
      });
    }

    // 3. Fixed Bottom Capture Pill -> Open Standalone Registration Form Modal (📸 拍照)
    if (el['btn-jump-register']) {
      el['btn-jump-register'].addEventListener('click', function () {
        if (!state.mediaStream) {
          startWebcamStream(true);
        }
        resetRegistrationForm();
        switchTab('form', true);
        captureForRegistration(false, true);
        if (el['reg-name']) {
          setTimeout(function () {
            el['reg-name'].focus();
          }, 120);
        }
      });
    }

    // 4. Long-Press 1s (1000ms) on Product Cards -> Open Context Menu (由上至下：編輯、刪除)
    bindLongPressCardMenu(el['recognized-product-card'], function () {
      if (!state.currentMatch) return null;
      return {
        cardEl: el['recognized-product-card'],
        product: state.currentMatch
      };
    });

    bindLongPressCardMenu(el['inventory-cards-list'], function (ev) {
      var target = ev ? ev.target : null;
      while (target && target !== el['inventory-cards-list']) {
        if (target.getAttribute && target.getAttribute('data-product-id')) {
          var pid = target.getAttribute('data-product-id');
          var prod = state.products.find(function (p) {
            return p.id === pid;
          });
          if (prod) {
            return { cardEl: target, product: prod };
          }
          return null;
        }
        target = target.parentNode;
      }
      return null;
    });

    if (el['btn-ctx-edit']) {
      el['btn-ctx-edit'].addEventListener('click', function () {
        var prod = state.contextMenuProduct;
        closeCardContextMenu();
        if (prod) {
          openEditForProduct(prod);
        }
      });
    }
    if (el['btn-ctx-delete']) {
      el['btn-ctx-delete'].addEventListener('click', function () {
        var prod = state.contextMenuProduct;
        closeCardContextMenu();
        if (prod) {
          openDeleteConfirmModal(prod, null);
        }
      });
    }
    if (el['card-context-menu-backdrop']) {
      el['card-context-menu-backdrop'].addEventListener('click', function (ev) {
        if (!ev || !ev.target || ev.target === el['card-context-menu-backdrop']) {
          closeCardContextMenu();
        }
      });
    }

    if (el['btn-cancel-delete']) {
      el['btn-cancel-delete'].addEventListener('click', function () {
        closeDeleteConfirmModal();
      });
    }
    if (el['btn-confirm-delete']) {
      el['btn-confirm-delete'].addEventListener('click', function () {
        var prod = state.pendingDeleteProduct;
        var retTab = state.pendingDeleteReturnTab;
        closeDeleteConfirmModal();
        if (prod) {
          executeDeleteProduct(prod, retTab);
        }
      });
    }
    if (el['delete-confirm-backdrop']) {
      el['delete-confirm-backdrop'].addEventListener('click', function (ev) {
        if (!ev || !ev.target || ev.target === el['delete-confirm-backdrop']) {
          closeDeleteConfirmModal();
        }
      });
    }

    if (el['btn-modal-delete']) {
      el['btn-modal-delete'].addEventListener('click', function () {
        var editId = el['reg-id'] ? el['reg-id'].value.trim() : '';
        if (!editId) return;
        var prod = state.products.find(function (p) {
          return p.id === editId;
        });
        if (prod) {
          openDeleteConfirmModal(prod, 'register');
        }
      });
    }

    // 5. Inventory Registration Form Controls
    if (el['btn-capture-frame']) {
      el['btn-capture-frame'].addEventListener('click', function () {
        if (!hasValidOpticalSource()) {
          if (!state.mediaStream) startWebcamStream(true);
          showToast('⚠️ 相機尚未就緒，請確認已允許相機權限', 'warn');
          return;
        }
        if (captureForRegistration(false, true)) {
          showToast('📸 已擷取目前取景框畫面');
        }
      });
    }
    if (el['btn-add-angle-sample']) {
      el['btn-add-angle-sample'].addEventListener('click', function () {
        if (!hasValidOpticalSource()) {
          if (!state.mediaStream) startWebcamStream(true);
          showToast('⚠️ 相機尚未就緒，請確認已允許相機權限', 'warn');
          return;
        }
        captureForRegistration(true, true);
      });
    }
    if (el['btn-reset-reg-form']) {
      el['btn-reset-reg-form'].addEventListener('click', function () {
        resetRegistrationForm();
        if (hasValidOpticalSource()) {
          captureForRegistration(false, false);
        }
      });
    }
    if (el['register-product-form']) {
      el['register-product-form'].addEventListener('submit', handleRegistrationSubmit);
    }

    // 8. USB / Bluetooth HID Barcode Scanner Keyboard Wedge (<55ms keystrokes + Enter)
    var hidBuffer = '';
    var hidLastKeyTime = 0;
    window.addEventListener('keydown', function (e) {
      var activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

      var now = performance.now();
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (now - hidLastKeyTime > 55) {
          hidBuffer = '';
        }
        hidBuffer += e.key;
        hidLastKeyTime = now;
        return;
      }

      if (e.key === 'Enter' && hidBuffer.length >= 4 && now - hidLastKeyTime < 80) {
        e.preventDefault();
        var rawCode = hidBuffer.trim();
        var codeLower = rawCode.toLowerCase();
        hidBuffer = '';
        state.lastDetectedBarcode = rawCode;
        state.lastBarcodeTime = Date.now();

        if (state.activeTab === 'form' && el['reg-barcode']) {
          el['reg-barcode'].value = rawCode;
          showToast('⚡ 已帶入條碼：' + rawCode);
          return;
        }

        var matchedProd = state.products.find(function (p) {
          return (
            (p.barcode && String(p.barcode).trim().toLowerCase() === codeLower) ||
            (p.sku && String(p.sku).trim().toLowerCase() === codeLower)
          );
        });

        switchTab('scan', true);
        wakeFromEcoSleep();
        state.hasEvaluatedFrame = true;
        state.pendingHysteresis = false;
        state.isActivelyMoving = false;
        invalidateRecognitionUICache();
        if (matchedProd) {
          state.currentMatch = matchedProd;
          state.currentSimilarity = 1.0;
          state.matchHistory = [matchedProd.id, matchedProd.id];
          updateRecognitionUI({
            matched: true,
            exactBarcode: true,
            product: matchedProd,
            bestCandidate: matchedProd,
            similarity: 1.0,
            margin: 1.0,
            topCandidates: [{ product: matchedProd, similarity: 1.0 }]
          });
          triggerHaptic(25);
          playTone(1080, 55, 'sine');
        } else {
          state.currentMatch = null;
          state.matchHistory = [null, null];
          updateRecognitionUI(
            {
              matched: false,
              exactBarcode: false,
              product: null,
              bestCandidate: null,
              similarity: 0,
              margin: 0,
              topCandidates: []
            },
            rawCode
          );
          triggerHaptic(45);
          playTone(440, 85, 'sawtooth');
          showToast('⚠️ 條碼「' + rawCode + '」未建檔', 'warn');
        }
      }
    });

    // 9. Automatic Offline Outbox Replay on Network Recovery
    window.addEventListener('online', function () {
      flushOutboxToServer();
    });

    // 10. 10-Second Background Camera Sensor Auto-Release & Seamless Foreground Resume
    document.addEventListener('visibilitychange', async function () {
      if (document.hidden) {
        cancelScheduledRecognition();
        clearBgCameraReleaseTimer();
        updateHudCameraStatus();

        if (state.sourceMode === 'webcam' && state.mediaStream) {
          bgCameraReleaseTimer = setTimeout(function () {
            bgCameraReleaseTimer = null;
            if (document.hidden && state.sourceMode === 'webcam' && state.mediaStream) {
              stopWebcamStream();
              state.autoPausedWebcamInBg = true;
              state.torchOn = false;
              if (el['btn-toggle-torch']) el['btn-toggle-torch'].classList.remove('active');
              renderStageCanvasFrame();
              updateHudCameraStatus();
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

    // 11. Battery Status API Integration (< 20% unplugged -> 10 FPS Battery Saver)
    if (navigator && typeof navigator.getBattery === 'function') {
      navigator
        .getBattery()
        .then(function (battery) {
          var syncBatteryState = function () {
            state.lowBatteryMode = !battery.charging && battery.level <= 0.20;
            updateHudCameraStatus();
          };
          syncBatteryState();
          battery.addEventListener('levelchange', syncBatteryState);
          battery.addEventListener('chargingchange', syncBatteryState);
        })
        .catch(function () {});
    }
  }

  // Boot Merchant Application
  window.addEventListener('DOMContentLoaded', async function () {
    bindElements();
    setupEvents();
    renderStageCanvasFrame();
    await initDataStore();

    // Register Network-First PWA Service Worker & force update check on HTTP/HTTPS server origins
    if (
      'serviceWorker' in navigator &&
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      window.location.hostname !== 'visionpos.local'
    ) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(function (reg) {
          if (reg && typeof reg.update === 'function') {
            reg.update().catch(function () {});
          }
        })
        .catch(function () {});
    }

    // Automatically start live optical camera on launch (gracefully falls back to standby guide if unavailable)
    await startWebcamStream(true);
  });
})();
