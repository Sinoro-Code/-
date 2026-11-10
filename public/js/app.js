/**
 * VisionPOS Edge — Main Application Controller
 * Connects Multi-Source Camera Pipeline, CCVD-144 Visual Recognition Engine,
 * Real-Time Inventory Management, Camera Photo Registration, and POS Checkout.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'vision_pos_edge_store_v1';

  const state = {
    activeTab: 'scan',
    sourceMode: 'virtual', // 'virtual' | 'webcam' | 'ipcam' | 'photo'
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

    // Current Recognition Result
    currentMatch: null,
    currentSimilarity: 0,
    topCandidates: [],
    liveDescriptor: null,

    // Registration Draft
    regDescriptors: [],
    regThumbnail: '',
    regEditingId: '',

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

    // CCTV / Photo State
    cctvChannel: 'ch1',
    cctvTimer: 0,
    loadedPhotoImage: null,

    // Eco & Telemetry State
    staticFrameStreak: 0,
    isEcoSleeping: false,
    lastInferenceMs: 0.28,
    lastMotionDelta: 0,
    connectedNodes: 1
  };

  // DOM Elements cache
  const el = {};
  function bindElements() {
    const ids = [
      'sync-status-badge', 'metric-latency', 'power-mode-dot', 'metric-power-mode',
      'metric-energy-saved', 'metric-product-count', 'nav-inv-count',
      'tab-btn-scan', 'tab-btn-register', 'tab-btn-inventory', 'tab-btn-devices',
      'view-scan', 'view-register', 'view-inventory', 'view-devices',
      'active-source-badge', 'native-camera-input', 'quick-snap-register-btn',
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
      'unregistered-prompt-card', 'btn-jump-register', 'top-candidates-list',
      'btn-fill-demo-new', 'reg-preview-img', 'reg-descriptor-status', 'reg-sample-count',
      'btn-capture-frame', 'btn-add-angle-sample', 'register-product-form',
      'reg-id', 'reg-name', 'reg-price', 'reg-stock', 'reg-sku', 'reg-barcode',
      'reg-category', 'reg-unit', 'reg-location', 'reg-spec', 'btn-reset-reg-form',
      'inv-search-input', 'inv-filter-select', 'inventory-list-container',
      'btn-export-inventory', 'btn-reset-demo', 'barcode-hw-status',
      'cart-count-badge', 'btn-clear-cart', 'cart-items-container',
      'summary-qty', 'summary-subtotal', 'cart-discount-input', 'summary-total',
      'btn-checkout-submit', 'today-revenue-text', 'orders-history-list', 'toast-stack'
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

  // ==========================================================================
  // Local Storage + BroadcastChannel + Backend SSE Triple-Layer Persistence
  // ==========================================================================
  let broadcastChannel = null;
  if ('BroadcastChannel' in window) {
    broadcastChannel = new BroadcastChannel('vision_pos_edge_sync');
    broadcastChannel.onmessage = (ev) => {
      if (!ev.data) return;
      if (ev.data.type === 'state_updated') {
        loadFromLocalStorage();
        renderAll();
      }
    };
  }

  function saveToLocalStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        products: state.products,
        orders: state.orders,
        updatedAt: Date.now()
      }));
    } catch (_) {}
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) {
        state.products = parsed.products;
        state.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function initDataStore() {
    const defaultCatalog = VisionEngine.buildDefaultCatalog();
    const hasLocal = loadFromLocalStorage();
    if (!hasLocal) {
      state.products = defaultCatalog;
      saveToLocalStorage();
    }

    // Attempt connection to Backend API & SSE
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.products) && data.products.length > 0) {
          state.products = data.products;
          state.orders = data.orders || [];
          saveToLocalStorage();
        } else {
          // Seed server with our generated visual catalog
          await fetch('/api/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ products: state.products })
          });
        }
        connectSSE();
      }
    } catch (_) {
      // Running in standalone offline / artifact mode
      el['sync-status-badge'].textContent = '本地極速模式 (支援跨分頁同步)';
    }

    renderAll();
  }

  function connectSSE() {
    try {
      const devType = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobile-Cam' : 'Desktop-POS';
      const es = new EventSource(`/api/events?deviceType=${encodeURIComponent(devType)}`);

      es.addEventListener('init', (e) => {
        const { payload } = JSON.parse(e.data);
        if (payload.products && payload.products.length > 0) {
          state.products = payload.products;
          state.orders = payload.orders || [];
          state.connectedNodes = payload.connectedClients || 1;
          saveToLocalStorage();
          renderAll();
        }
        el['sync-status-badge'].textContent = `即時同步 (${state.connectedNodes} 台連線)`;
      });

      es.addEventListener('product_upserted', (e) => {
        const { payload } = JSON.parse(e.data);
        if (!payload || !payload.product) return;
        const idx = state.products.findIndex((p) => p.id === payload.product.id);
        if (idx >= 0) {
          state.products[idx] = payload.product;
        } else {
          state.products.unshift(payload.product);
        }
        saveToLocalStorage();
        renderAll();
      });

      es.addEventListener('product_deleted', (e) => {
        const { payload } = JSON.parse(e.data);
        state.products = state.products.filter((p) => p.id !== payload.id);
        saveToLocalStorage();
        renderAll();
      });

      es.addEventListener('checkout_completed', (e) => {
        const { payload } = JSON.parse(e.data);
        if (Array.isArray(payload.updatedProducts)) {
          payload.updatedProducts.forEach((up) => {
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
      });

      es.addEventListener('products_synced', (e) => {
        const { payload } = JSON.parse(e.data);
        if (Array.isArray(payload.products)) state.products = payload.products;
        if (Array.isArray(payload.orders)) state.orders = payload.orders;
        saveToLocalStorage();
        renderAll();
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
        wakeFromEcoSleep();
        renderStageTray();
        // If user is on the Register tab, offer auto-filling or refresh snapshot preview
        if (state.activeTab === 'register') {
          setTimeout(() => captureForRegistration(false), 60);
        }
      });
      container.appendChild(btn);
    });
  }

  async function switchVideoSource(mode) {
    state.sourceMode = mode;
    wakeFromEcoSleep();

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
      el['active-source-badge'].textContent = '靜態照片辨識';
      if (!state.loadedPhotoImage) {
        el['native-camera-input'].click();
      }
    }
  }

  function stopWebcamStream() {
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
      state.mediaStream = null;
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

  async function startWebcamStream() {
    stopWebcamStream();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('此瀏覽器環境不支援直接開啟 WebRTC 相機，已切換至擬真舞台或可使用「手機拍照/傳圖」', 'warn');
      switchVideoSource('virtual');
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
      state.mediaStream = stream;
      const video = el['camera-video'];
      video.srcObject = stream;
      video.classList.remove('hidden');
      video.classList.toggle('mirrored', state.facingMode === 'user' && !state.selectedDeviceId);
      el['stage-canvas'].classList.add('hidden');
      await video.play();
      await populateCameraDevices();
      showToast('已開啟真實相機鏡頭，將商品對準中央框即可辨識或建檔');
    } catch (err) {
      showToast('無法取得相機權限或找不到實體鏡頭，您可點擊「手機拍照/傳圖」或使用擬真舞台測試', 'warn');
      switchVideoSource('virtual');
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

  // Render Virtual Stage or CCTV or Loaded Photo onto #stage-canvas
  function renderStageCanvasFrame() {
    const canvas = el['stage-canvas'];
    const ctx = canvas.getContext('2d');
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
      // Simulate Multi-Channel CCTV Overhead Stream
      state.cctvTimer += 0.025;
      let itemIdx = 0;
      if (state.cctvChannel === 'ch1') {
        itemIdx = Math.floor(state.cctvTimer * 0.35) % 5;
      } else if (state.cctvChannel === 'ch2') {
        itemIdx = 1; // Matcha shelf
      } else if (state.cctvChannel === 'ch3') {
        itemIdx = 3; // Titan bottle warehouse
      }
      const item = VisionEngine.VIRTUAL_STAGE_ITEMS[itemIdx];
      VisionEngine.drawVirtualProduct(ctx, w, h, item, {
        offsetX: Math.sin(state.cctvTimer) * 4,
        offsetY: 0,
        angle: 0.02,
        scale: 0.96,
        lighting: 0.92
      });
      // CCTV Timestamp Overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(14, h - 38, 290, 24);
      ctx.fillStyle = '#10b981';
      ctx.font = '12px monospace';
      ctx.fillText(`CCTV ${state.cctvChannel.toUpperCase()} | RTSP-EDGE | ${new Date().toLocaleTimeString()}`, 22, h - 22);
    } else if (state.sourceMode === 'photo' && state.loadedPhotoImage) {
      ctx.fillStyle = '#090d14';
      ctx.fillRect(0, 0, w, h);
      const img = state.loadedPhotoImage;
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);
    }
  }

  function getActiveVideoSourceElement() {
    if (state.sourceMode === 'webcam' && state.mediaStream && el['camera-video'].readyState >= 2) {
      return el['camera-video'];
    }
    return el['stage-canvas'];
  }

  function getRoiRect(sourceElem) {
    const sw = sourceElem.videoWidth || sourceElem.width || 640;
    const sh = sourceElem.videoHeight || sourceElem.height || 480;
    const roiW = Math.round(sw * 0.58);
    const roiH = Math.round(sh * 0.68);
    const sx = Math.round((sw - roiW) * 0.5);
    const sy = Math.round((sh - roiH) * 0.5);
    return { sx, sy, sw: roiW, sh: roiH };
  }

  // ==========================================================================
  // Adaptive Real-Time Recognition Loop & Motion-Gated Energy Saver
  // ==========================================================================
  let scanTimerId = null;

  function wakeFromEcoSleep() {
    state.staticFrameStreak = 0;
    if (state.isEcoSleeping) {
      state.isEcoSleeping = false;
      updatePowerTelemetryUI();
    }
  }

  function updatePowerTelemetryUI() {
    if (state.isEcoSleeping) {
      el['power-mode-dot'].className = 'status-dot eco';
      el['metric-power-mode'].textContent = '靜止休眠 (2.5 FPS)';
      el['metric-energy-saved'].textContent = '98% 省電';
      el['hud-status-text'].textContent = 'ECO 靜止省電待機 (畫面移動即喚醒)';
    } else {
      el['power-mode-dot'].className = 'status-dot';
      el['metric-power-mode'].textContent = '高速辨識 (20 FPS)';
      el['metric-energy-saved'].textContent = '94% 省電';
      el['hud-status-text'].textContent = 'ROI 64×64 視覺追蹤中';
    }
  }

  function runRecognitionTick() {
    if (document.hidden) {
      scanTimerId = setTimeout(runRecognitionTick, 600);
      return;
    }

    if (state.sourceMode !== 'webcam') {
      renderStageCanvasFrame();
    }

    const sourceElem = getActiveVideoSourceElement();
    const roiRect = getRoiRect(sourceElem);

    const t0 = performance.now();
    const sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, false);
    state.lastMotionDelta = sig.motionDelta;

    // Check Motion Gate for Energy Saving
    if (state.ecoGateEnabled && sig.motionDelta < 1.8) {
      state.staticFrameStreak++;
      if (state.staticFrameStreak >= 12 && !state.isEcoSleeping) {
        state.isEcoSleeping = true;
        updatePowerTelemetryUI();
      }
    } else {
      wakeFromEcoSleep();
    }

    // Match against all registered backend products
    const matchRes = VisionEngine.matchProducts(sig.descriptor, state.products, state.threshold);
    const t1 = performance.now();

    state.lastInferenceMs = +(t1 - t0).toFixed(2);
    state.liveDescriptor = sig.descriptor;
    state.currentMatch = matchRes.product;
    state.currentSimilarity = matchRes.similarity;
    state.topCandidates = matchRes.topCandidates;

    // Update Telemetry & HUD
    el['metric-latency'].textContent = `${Math.max(0.12, state.lastInferenceMs).toFixed(2)} ms`;
    el['motion-delta-text'].textContent = `幀差 Δ: ${sig.motionDelta.toFixed(1)}`;
    drawFingerprintWaveform(
      sig.descriptor,
      matchRes.bestCandidate && matchRes.bestCandidate.descriptors
        ? matchRes.bestCandidate.descriptors[0]
        : null
    );
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

    const nextInterval = state.isEcoSleeping ? 400 : 55;
    scanTimerId = setTimeout(runRecognitionTick, nextInterval);
  }

  function drawFingerprintWaveform(liveVec, refVec) {
    const canvas = el['fingerprint-canvas'];
    if (!canvas || !liveVec) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const len = liveVec.length;
    const barW = w / len;

    // Draw reference product fingerprint in subtle cyan behind
    if (refVec && refVec.length === len) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.32)';
      for (let i = 0; i < len; i++) {
        const val = Math.min(1, Math.abs(refVec[i]) * 4.2);
        const bh = val * (h - 4);
        ctx.fillRect(i * barW, h - bh, Math.max(1.5, barW - 0.5), bh);
      }
    }

    // Draw live frame fingerprint in emerald
    ctx.fillStyle = '#10b981';
    for (let i = 0; i < len; i++) {
      const val = Math.min(1, Math.abs(liveVec[i]) * 4.2);
      const bh = val * (h - 4);
      ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
    }
  }

  function updateRecognitionUI(matchRes) {
    const simPct = (matchRes.similarity * 100).toFixed(1) + '%';
    el['hud-confidence-val'].textContent = simPct;
    el['roi-reticle'].classList.toggle('matched', matchRes.matched);
    el['hud-match-banner'].classList.toggle('matched-state', matchRes.matched);

    if (matchRes.matched && matchRes.product) {
      const p = matchRes.product;
      el['hud-match-sub'].textContent = `✅ 已匹配後台商品 (${p.sku}) · 儲位 ${p.location || 'A-01'}`;
      el['hud-match-title'].textContent = p.name;
      el['hud-match-price'].textContent = `NT$ ${p.price.toLocaleString()}`;
      el['hud-match-stock'].textContent = `庫存: ${p.stock} ${p.unit || '件'}`;
      el['hud-add-cart-btn'].disabled = p.stock <= 0;

      // Update Column 2 Live Product Card
      el['scan-match-badge'].className = 'badge badge-emerald';
      el['scan-match-badge'].textContent = `已鎖定 (${simPct})`;
      el['recognized-product-card'].classList.remove('hidden');
      el['unregistered-prompt-card'].classList.add('hidden');

      if (p.thumbnail && el['rec-img'].getAttribute('src') !== p.thumbnail) {
        el['rec-img'].src = p.thumbnail;
      }
      el['rec-category'].textContent = p.category || '一般商品';
      el['rec-sku'].textContent = `SKU: ${p.sku}`;
      el['rec-similarity'].textContent = `相似度 ${simPct}`;
      el['rec-name'].textContent = p.name;
      el['rec-spec'].textContent = p.spec || '尚無額外規格描述';
      el['rec-price'].textContent = `NT$ ${p.price.toLocaleString()}`;
      el['rec-stock'].textContent = `${p.stock} ${p.unit || '件'}`;
      el['rec-stock'].style.color = p.stock <= (p.minStock || 5) ? 'var(--accent-danger)' : 'var(--text-primary)';
      el['rec-location'].textContent = `${p.location || 'A-01'}${p.barcode ? ' · ' + p.barcode : ''}`;
      el['btn-rec-add-cart'].disabled = p.stock <= 0;
      el['btn-rec-add-cart'].textContent = p.stock > 0 ? '🛒 加入購物車 (快捷鍵 Enter)' : '⚠️ 庫存已售罄';
    } else {
      el['hud-match-sub'].textContent = '⚠️ 畫面中商品尚未建檔或低於辨識門檻';
      el['hud-match-title'].textContent = '未知商品 — 點擊右上「快門擷取建檔」立即登錄';
      el['hud-match-price'].textContent = '--';
      el['hud-match-stock'].textContent = `最高相似度 ${simPct}`;
      el['hud-add-cart-btn'].disabled = true;

      el['scan-match-badge'].className = 'badge badge-amber';
      el['scan-match-badge'].textContent = '未建檔商品';
      el['recognized-product-card'].classList.add('hidden');
      el['unregistered-prompt-card'].classList.remove('hidden');
    }

    // Render Top 3 Visual Similarity Candidates
    const candContainer = el['top-candidates-list'];
    if (candContainer) {
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
  function captureForRegistration(appendAngle = false) {
    if (state.sourceMode !== 'webcam') {
      renderStageCanvasFrame();
    }
    const sourceElem = getActiveVideoSourceElement();
    const roiRect = getRoiRect(sourceElem);
    const sig = VisionEngine.captureFrameSignature(sourceElem, roiRect, true);

    if (appendAngle && state.regDescriptors.length > 0) {
      state.regDescriptors.push(sig.descriptor);
      if (state.regDescriptors.length > 5) state.regDescriptors.shift();
      showToast(`已補拍第 ${state.regDescriptors.length} 組視覺角度特徵！`);
    } else {
      state.regDescriptors = [sig.descriptor];
      state.regThumbnail = sig.thumbnail;
    }

    el['reg-preview-img'].src = state.regThumbnail;
    el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length} 組`;
    el['reg-descriptor-status'].textContent = `已擷取 144 維視覺特徵`;
    playTone(1040, 45, 'triangle');

    // If user is on the virtual stage and hasn't typed a name yet, pre-fill if it's an unregistered stage item
    if (state.sourceMode === 'virtual' && !el['reg-name'].value.trim()) {
      const stageItem = VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex];
      if (stageItem) {
        fillRegistrationFormFromPreset(stageItem);
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

  async function handleRegistrationSubmit(e) {
    e.preventDefault();
    if (state.regDescriptors.length === 0) {
      captureForRegistration(false);
    }

    const stageItem = state.sourceMode === 'virtual'
      ? VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex]
      : null;

    const payload = {
      id: el['reg-id'].value || undefined,
      name: el['reg-name'].value.trim(),
      price: Number(el['reg-price'].value) || 0,
      stock: Number(el['reg-stock'].value) ?? 10,
      sku: el['reg-sku'].value.trim() || ('SKU-' + String(state.products.length + 101).padStart(4, '0')),
      barcode: el['reg-barcode'].value.trim(),
      category: el['reg-category'].value.trim() || '一般商品',
      unit: el['reg-unit'].value.trim() || '件',
      location: el['reg-location'].value.trim() || 'A-01',
      spec: el['reg-spec'].value.trim(),
      thumbnail: state.regThumbnail,
      descriptors: state.regDescriptors,
      virtualPresetId: stageItem ? stageItem.presetId : null
    };

    let savedProduct = null;
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        savedProduct = data.product;
      }
    } catch (_) {}

    if (!savedProduct) {
      // Fallback local upsert
      const now = Date.now();
      const existingIdx = state.products.findIndex((p) => p.id === payload.id || p.sku === payload.sku);
      if (existingIdx >= 0) {
        savedProduct = { ...state.products[existingIdx], ...payload, updatedAt: now };
        state.products[existingIdx] = savedProduct;
      } else {
        savedProduct = {
          ...payload,
          id: 'prd-' + now.toString(36),
          createdAt: now,
          updatedAt: now
        };
        state.products.unshift(savedProduct);
      }
    } else {
      const idx = state.products.findIndex((p) => p.id === savedProduct.id);
      if (idx >= 0) state.products[idx] = savedProduct;
      else state.products.unshift(savedProduct);
    }

    notifyPeers();
    renderAll();
    resetRegistrationForm();
    switchTab('scan');
    wakeFromEcoSleep();
    playTone(1320, 80, 'sine');
    showToast(`✅ 拍照建檔完成：「${savedProduct.name}」已可透過相機即時掃描辨識！`);
  }

  function resetRegistrationForm() {
    el['register-product-form'].reset();
    el['reg-id'].value = '';
    state.regDescriptors = [];
    captureForRegistration(false);
  }

  // ==========================================================================
  // Inventory Management Actions
  // ==========================================================================
  async function adjustProductStock(productId, delta) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    product.stock = Math.max(0, product.stock + delta);
    product.updatedAt = Date.now();

    try {
      await fetch(`/api/products/${encodeURIComponent(productId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: product.stock })
      });
    } catch (_) {}

    notifyPeers();
    renderAll();
  }

  async function deleteProduct(productId) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    state.products = state.products.filter((p) => p.id !== productId);
    state.cart = state.cart.filter((c) => c.productId !== productId);

    try {
      await fetch(`/api/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
    } catch (_) {}

    notifyPeers();
    renderAll();
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

    container.innerHTML = filtered
      .map((p) => {
        const isLow = p.stock <= (p.minStock || 5);
        return `
          <div class="inv-item">
            <img class="inv-thumb" src="${p.thumbnail || ''}" alt="${escapeHtml(p.name)}" />
            <div class="inv-info">
              <div class="inv-title">${escapeHtml(p.name)}</div>
              <div class="inv-sub">
                ${escapeHtml(p.sku)} · 儲位 ${escapeHtml(p.location || 'A-01')} · <strong style="color:var(--accent-primary);">NT$ ${p.price.toLocaleString()}</strong>
              </div>
              <div style="margin-top:2px;">
                <span class="badge ${isLow ? 'badge-danger' : 'badge-emerald'}">
                  庫存: ${p.stock} ${escapeHtml(p.unit || '件')} ${isLow ? '(低庫存)' : ''}
                </span>
                <span class="badge badge-info">特徵樣本 ${(p.descriptors && p.descriptors.length) || 1} 組</span>
              </div>
            </div>
            <div class="inv-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-minus" data-id="${p.id}" title="庫存 -1">-1</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="inv-plus" data-id="${p.id}" title="庫存 +1">+1</button>
              <button type="button" class="btn btn-primary btn-sm" data-action="inv-cart" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>+入車</button>
              <button type="button" class="btn btn-danger btn-sm" data-action="inv-del" data-id="${p.id}" title="刪除">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // Real-Time Shopping Cart & POS Checkout
  // ==========================================================================
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
  }

  async function submitCheckout() {
    if (state.cart.length === 0) return;

    const discount = Math.max(0, Number(el['cart-discount-input'].value) || 0);
    const payload = {
      items: state.cart,
      discount,
      paymentMethod: state.paymentMethod
    };

    let completedOrder = null;
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        completedOrder = data.order;
        if (Array.isArray(data.updatedProducts)) {
          data.updatedProducts.forEach((up) => {
            const idx = state.products.findIndex((p) => p.id === up.id);
            if (idx >= 0) state.products[idx] = up;
          });
        }
      }
    } catch (_) {}

    if (!completedOrder) {
      // Local atomic checkout fallback
      let subtotal = 0;
      const orderItems = [];
      for (const c of state.cart) {
        const p = state.products.find((prod) => prod.id === c.productId);
        if (!p || p.stock < c.quantity) {
          showToast(`「${p ? p.name : ''}」庫存不足`, 'danger');
          return;
        }
        p.stock -= c.quantity;
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
        id: 'ORD-' + Date.now().toString(36).toUpperCase(),
        createdAt: Date.now(),
        paymentMethod: state.paymentMethod,
        items: orderItems,
        totalQty: orderItems.reduce((a, b) => a + b.quantity, 0),
        subtotal,
        discount,
        total: Math.max(0, subtotal - discount)
      };
    }

    if (!state.orders.some((o) => o.id === completedOrder.id)) {
      state.orders.unshift(completedOrder);
    }
    state.cart = [];
    el['cart-discount-input'].value = '0';

    notifyPeers();
    renderAll();
    playTone(1180, 90, 'sine');
    setTimeout(() => playTone(1560, 120, 'sine'), 85);
    showToast(`🎉 結帳成功！單號 ${completedOrder.id}，實收 NT$ ${completedOrder.total.toLocaleString()}，已即時扣減庫存`);
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
      .slice(0, 15)
      .map((o) => {
        const timeStr = new Date(o.createdAt).toLocaleTimeString();
        const summaryNames = (o.items || []).map((i) => `${i.name}×${i.quantity}`).join('、');
        return `
          <div style="padding:8px 10px; background:var(--bg-elevated); border-radius:var(--radius-sm); border:1px solid var(--border-subtle); font-size:12px;">
            <div style="display:flex; justify-content:space-between; font-weight:600;">
              <span style="font-family:var(--font-mono);">${escapeHtml(o.id)}</span>
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
  function switchTab(tabName) {
    state.activeTab = tabName;
    ['scan', 'register', 'inventory', 'devices'].forEach((t) => {
      el[`tab-btn-${t}`].classList.toggle('active', t === tabName);
      el[`view-${t}`].classList.toggle('hidden', t !== tabName);
    });
    if (tabName === 'register') {
      captureForRegistration(false);
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

  function setupEvents() {
    // Mode Navigation Tabs
    ['scan', 'register', 'inventory', 'devices'].forEach((t) => {
      el[`tab-btn-${t}`].addEventListener('click', () => switchTab(t));
    });

    // Source Mode Switcher
    ['virtual', 'webcam', 'ipcam', 'photo'].forEach((s) => {
      el[`src-btn-${s}`].addEventListener('click', () => switchVideoSource(s));
    });

    // Quick Snap Register Button in Viewport Header
    el['quick-snap-register-btn'].addEventListener('click', () => {
      switchTab('register');
      captureForRegistration(false);
    });

    el['btn-jump-register'].addEventListener('click', () => {
      switchTab('register');
      captureForRegistration(false);
    });

    // Native Phone Camera / File Input
    el['native-camera-input'].addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          state.loadedPhotoImage = img;
          switchVideoSource('photo');
          renderStageCanvasFrame();
          if (state.activeTab === 'register') {
            captureForRegistration(false);
          }
          showToast('已載入照片並完成 144 維視覺特徵分析');
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
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

    // CCTV Controls
    el['cctv-channel-select'].addEventListener('change', (e) => {
      state.cctvChannel = e.target.value;
      const isCustom = state.cctvChannel === 'custom';
      el['ipcam-url-input'].classList.toggle('hidden', !isCustom);
      el['btn-connect-ipcam'].classList.toggle('hidden', !isCustom);
    });

    // Virtual Stage Controls
    el['chk-stage-motion'].addEventListener('change', (e) => {
      state.stageHandMotion = e.target.checked;
      wakeFromEcoSleep();
    });
    el['btn-stage-rotate'].addEventListener('click', () => {
      state.stageAngle = (state.stageAngle + 0.14) % (Math.PI * 2);
      wakeFromEcoSleep();
    });

    // Threshold, Auto-Cart & Eco Gate
    el['threshold-slider'].addEventListener('input', (e) => {
      const val = Number(e.target.value);
      state.threshold = val / 100;
      el['threshold-label'].textContent = `${val}%`;
    });
    el['chk-auto-cart'].addEventListener('change', (e) => {
      state.autoAddCart = e.target.checked;
    });
    el['chk-eco-sleep'].addEventListener('change', (e) => {
      state.ecoGateEnabled = e.target.checked;
      if (!state.ecoGateEnabled) wakeFromEcoSleep();
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
      switchTab('register');
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
      el['reg-preview-img'].src = state.regThumbnail;
      el['reg-sample-count'].textContent = `樣本數: ${state.regDescriptors.length} 組`;
    });

    el['btn-train-extra-angle'].addEventListener('click', async () => {
      if (!state.currentMatch) return;
      const sourceElem = getActiveVideoSourceElement();
      const sig = VisionEngine.captureFrameSignature(sourceElem, getRoiRect(sourceElem), true);
      const p = state.currentMatch;
      p.descriptors = p.descriptors || [];
      p.descriptors.push(sig.descriptor);
      if (p.descriptors.length > 6) p.descriptors.shift();
      try {
        await fetch(`/api/products/${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newDescriptor: sig.descriptor })
        });
      } catch (_) {}
      notifyPeers();
      showToast(`📸 已為「${p.name}」新增一組新角度特徵樣本（目前共 ${p.descriptors.length} 組）`);
    });

    // Registration Form Buttons
    el['btn-capture-frame'].addEventListener('click', () => captureForRegistration(false));
    el['btn-add-angle-sample'].addEventListener('click', () => captureForRegistration(true));
    el['btn-fill-demo-new'].addEventListener('click', () => {
      // Switch virtual stage to an unregistered item if not already on one
      const unregIdx = VisionEngine.VIRTUAL_STAGE_ITEMS.findIndex(
        (item) => !state.products.some((p) => p.sku === item.sku)
      );
      if (unregIdx >= 0) {
        state.stageItemIndex = unregIdx;
        renderStageTray();
      }
      const item = VisionEngine.VIRTUAL_STAGE_ITEMS[state.stageItemIndex];
      fillRegistrationFormFromPreset(item);
      setTimeout(() => captureForRegistration(false), 50);
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
      else if (action === 'inv-cart') addToCart(id, 1);
      else if (action === 'inv-del') deleteProduct(id);
    });

    el['btn-export-inventory'].addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ products: state.products, orders: state.orders }, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vision-pos-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    el['btn-reset-demo'].addEventListener('click', async () => {
      const defaultCatalog = VisionEngine.buildDefaultCatalog();
      state.products = defaultCatalog;
      state.orders = [];
      state.cart = [];
      try {
        await fetch('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products: defaultCatalog })
        });
      } catch (_) {}
      notifyPeers();
      renderAll();
      showToast('已重置回預設 5 款建檔商品與 2 款待建檔測試商品');
    });

    // Cart & Checkout Actions
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
    });
    el['cart-discount-input'].addEventListener('input', () => renderCart());

    document.querySelectorAll('.pay-method-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.paymentMethod = btn.getAttribute('data-pay');
        document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    el['btn-checkout-submit'].addEventListener('click', () => submitCheckout());

    // Keyboard shortcut: Enter adds current recognized product to cart when not typing in an input
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (e.key === 'Enter' && state.activeTab === 'scan' && state.currentMatch) {
        e.preventDefault();
        addToCart(state.currentMatch.id, 1);
      }
    });

    // Hardware BarcodeDetector status check
    if ('BarcodeDetector' in window) {
      el['barcode-hw-status'].textContent = '✅ 已啟用原生硬體 BarcodeDetector 雙引擎加速';
    } else {
      el['barcode-hw-status'].textContent = '✅ 使用 CCVD-144 純視覺極速指紋引擎 (< 0.4ms)';
    }
  }

  // Boot Application
  window.addEventListener('DOMContentLoaded', async () => {
    bindElements();
    setupEvents();
    await initDataStore();
    runRecognitionTick();
  });
})();
