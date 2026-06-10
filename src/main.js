const REPORT_WINDOW = 256;
const REALTIME_WINDOW_MS = 50;
const LOG_LIMIT = 80;
const STALE_AFTER_MS = 700;

let tauriInvoke = null;
let tauriListen = null;

const state = {
  mode: "move",
  device: null,
  nativeAvailable: false,
  nativeRunning: false,
  hidReadable: false,
  pointerFallback: false,
  pointerEventName: "onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove",
  rawPointerSeenAt: 0,
  running: false,
  startedAt: 0,
  lastReportAt: 0,
  lastPointerAt: 0,
  lastUiAt: 0,
  lastReportId: null,
  intervals: new Float64Array(REPORT_WINDOW),
  intervalTimes: new Float64Array(REPORT_WINDOW),
  intervalIndex: 0,
  intervalCount: 0,
  samples: 0,
  distance: 0,
  minInterval: Infinity,
  maxInterval: 0,
  sumInterval: 0,
  logs: [],
};

const $ = (id) => document.getElementById(id);

const els = {
  sourceBadge: $("sourceBadge"),
  supportBadge: $("supportBadge"),
  secureBadge: $("secureBadge"),
  connectButton: $("connectButton"),
  startButton: $("startButton"),
  stopButton: $("stopButton"),
  resetButton: $("resetButton"),
  clearLogButton: $("clearLogButton"),
  moveModeButton: $("moveModeButton"),
  idleModeButton: $("idleModeButton"),
  hzValue: $("hzValue"),
  statusText: $("statusText"),
  modeTitle: $("modeTitle"),
  modeDescription: $("modeDescription"),
  avgInterval: $("avgInterval"),
  rangeInterval: $("rangeInterval"),
  sampleCount: $("sampleCount"),
  motionCount: $("motionCount"),
  windowHz: $("windowHz"),
  deviceName: $("deviceName"),
  vendorId: $("vendorId"),
  productId: $("productId"),
  reportId: $("reportId"),
  lastReport: $("lastReport"),
  notice: $("notice"),
  logBody: $("logBody"),
  canvas: $("intervalCanvas"),
  collectionList: $("collectionList"),
};

const ctx = els.canvas.getContext("2d", { alpha: false });

function supportsWebHid() {
  return "hid" in navigator;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} ms` : "0.00 ms";
}

function formatHz(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.round(1000 / intervalMs);
}

function hex(value) {
  if (typeof value !== "number") return "-";
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  state.logs.unshift({ time, type, message });
  if (state.logs.length > LOG_LIMIT) state.logs.pop();
  renderLog();
}

function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__);
}

function setSourceBadge(source, tone = "ok") {
  els.sourceBadge.textContent = `采样源: ${source}`;
  els.sourceBadge.className = `badge ${tone}`;
}

function isProtectedCollection(collection) {
  return (
    collection.usagePage === 0x01 &&
    (collection.usage === 0x01 || collection.usage === 0x02 || collection.usage === 0x06)
  );
}

function renderCollections(device) {
  const collections = device?.collections || [];
  if (collections.length === 0) {
    els.collectionList.textContent = "无 collection 信息";
    return;
  }

  els.collectionList.innerHTML = collections
    .map((collection) => {
      const protectedUsage = isProtectedCollection(collection);
      const label = protectedUsage ? "protected" : "readable?";
      return `<div class="collection-item ${protectedUsage ? "protected" : ""}">usagePage=${hex(
        collection.usagePage,
      )} usage=${hex(collection.usage)} ${label}</div>`;
    })
    .join("");
}

function updateStartState() {
  if (state.running) return;
  const canUsePointerFallback = state.mode === "move";
  els.startButton.disabled = !(state.nativeAvailable || state.hidReadable || canUsePointerFallback);
}

function renderLog() {
  els.logBody.innerHTML = state.logs
    .map(
      (row) =>
        `<tr><td>${row.time}</td><td>${row.type}</td><td>${row.message}</td></tr>`,
    )
    .join("");
}

function setMode(mode) {
  state.mode = mode;
  const isMove = mode === "move";
  els.moveModeButton.classList.toggle("active", isMove);
  els.idleModeButton.classList.toggle("active", !isMove);
  els.moveModeButton.setAttribute("aria-selected", String(isMove));
  els.idleModeButton.setAttribute("aria-selected", String(!isMove));
  els.modeTitle.textContent = isMove ? "移动鼠标以采样" : "保持鼠标静置";
  if (state.nativeAvailable) {
    els.modeDescription.textContent = isMove
      ? "点击开始后持续移动鼠标。桌面模式使用 Rust 原生输入采样；macOS 优先使用 IOHID report。"
      : "点击开始后保持鼠标静置。只有设备在静置时仍输出原始输入报告，才可能测得静置回报率。";
  } else {
    els.modeDescription.textContent = isMove
      ? "点击开始后持续移动鼠标。浏览器模式优先尝试 WebHID；不可读时使用指针事件备用采样。"
      : "连接后点击开始，不移动鼠标。浏览器静置测试需要可读取的 WebHID report。";
  }
  updateStartState();
  addLog("模式", isMove ? "切换到移动测试" : "切换到静置测试");
}

function resetStats() {
  state.startedAt = performance.now();
  state.lastReportAt = 0;
  state.lastPointerAt = 0;
  state.lastUiAt = 0;
  state.lastReportId = null;
  state.intervalIndex = 0;
  state.intervalCount = 0;
  state.samples = 0;
  state.distance = 0;
  state.minInterval = Infinity;
  state.maxInterval = 0;
  state.sumInterval = 0;
  state.intervals.fill(0);
  state.intervalTimes.fill(0);
  renderStats();
  drawChart();
}

function startTest() {
  if (state.nativeAvailable) {
    startNativeTest();
    return;
  }

  const canUsePointerFallback = state.mode === "move";
  if (!state.hidReadable && !canUsePointerFallback) {
    addLog("错误", "静置测试需要可读取的 HID report；标准鼠标 collection 通常被浏览器保护");
    return;
  }
  resetStats();
  state.pointerFallback = !state.hidReadable && canUsePointerFallback;
  state.running = true;
  els.startButton.disabled = true;
  els.stopButton.disabled = false;
  if (state.pointerFallback) {
    setSourceBadge("pointer", "warn");
    els.statusText.textContent =
      "正在使用浏览器指针事件备用采样；这不是 HID 级回报率";
    addLog("测试", "移动测试已开始，当前使用浏览器指针事件备用路径");
  } else {
    setSourceBadge("webhid", "ok");
    els.statusText.textContent =
      state.mode === "move" ? "正在采样 HID report，持续移动鼠标" : "正在采样 HID report，保持鼠标静止";
    addLog("测试", state.mode === "move" ? "移动测试已开始" : "静置测试已开始");
  }
}

function stopTest() {
  if (state.nativeRunning) {
    stopNativeTest();
    return;
  }

  state.running = false;
  state.pointerFallback = false;
  els.startButton.disabled = !state.device;
  updateStartState();
  els.stopButton.disabled = true;
  els.statusText.textContent = "测试已停止";
  setSourceBadge(state.nativeAvailable ? "native" : "browser", state.nativeAvailable ? "ok" : "warn");
  addLog("测试", "测试已停止");
}

function pushInterval(interval, observedAt = performance.now()) {
  state.intervals[state.intervalIndex] = interval;
  state.intervalTimes[state.intervalIndex] = observedAt;
  state.intervalIndex = (state.intervalIndex + 1) % REPORT_WINDOW;
  state.intervalCount = Math.min(REPORT_WINDOW, state.intervalCount + 1);
  state.samples += 1;
  state.sumInterval += interval;
  state.minInterval = Math.min(state.minInterval, interval);
  state.maxInterval = Math.max(state.maxInterval, interval);
}

function signedByte(value) {
  return value > 127 ? value - 256 : value;
}

function estimateMovement(dataView) {
  if (dataView.byteLength < 3) return 0;
  const x = signedByte(dataView.getUint8(1));
  const y = signedByte(dataView.getUint8(2));
  return Math.abs(x) + Math.abs(y);
}

function handleInputReport(event) {
  if (event.device !== state.device) return;
  const now = performance.now();
  state.lastReportId = event.reportId;
  els.reportId.textContent = String(event.reportId);
  els.lastReport.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  if (!state.running) return;

  if (state.lastReportAt > 0) {
    const interval = now - state.lastReportAt;
    if (interval > 0 && interval < 1000) {
      pushInterval(interval);
    }
  }

  state.distance += estimateMovement(event.data);
  state.lastReportAt = now;
  if (state.samples > 0) {
    els.statusText.textContent = "正在采样 HID report";
  }

  if (now - state.lastUiAt >= 80) {
    state.lastUiAt = now;
    renderStats();
  }
}

function handleNativeSample(payload) {
  if (!state.running || !state.nativeRunning) return;
  if (payload.source) {
    setSourceBadge(payload.source, payload.source.includes("fallback") ? "warn" : "ok");
  }
  const interval = Number(payload.interval_ms);
  if (interval > 0 && interval < 1000) {
    pushInterval(interval);
  }
  state.distance += Number(payload.movement || 0);
  state.lastReportAt = performance.now();
  els.lastReport.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  if (state.samples > 0) {
    els.statusText.textContent = `正在采样 ${payload.source || "Rust native"} 事件`;
  }

  const now = performance.now();
  if (now - state.lastUiAt >= 80) {
    state.lastUiAt = now;
    renderStats();
  }
}

function handlePointerSample(event) {
  if (!state.running || !state.pointerFallback || state.mode !== "move") return;
  if (event.type === "pointerrawupdate") {
    state.rawPointerSeenAt = performance.now();
    state.pointerEventName = "pointerrawupdate";
  } else if (performance.now() - state.rawPointerSeenAt < 250) {
    return;
  } else {
    state.pointerEventName = "pointermove";
  }

  const events =
    typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
  for (const sample of events.length > 0 ? events : [event]) {
    const now = sample.timeStamp || performance.now();
    if (state.lastPointerAt > 0) {
      const interval = now - state.lastPointerAt;
      if (interval > 0 && interval < 1000) {
        pushInterval(interval);
      }
    }
    state.distance += Math.abs(sample.movementX || 0) + Math.abs(sample.movementY || 0);
    state.lastPointerAt = now;
    state.lastReportAt = now;
  }

  if (state.samples > 0) {
    els.statusText.textContent = `正在使用 ${state.pointerEventName} 备用采样`;
  }

  const now = performance.now();
  if (now - state.lastUiAt >= 80) {
    state.lastUiAt = now;
    renderStats();
  }
}

function getRecentIntervals(windowMs = Infinity) {
  const out = [];
  const count = state.intervalCount;
  const cutoff = Number.isFinite(windowMs) ? performance.now() - windowMs : -Infinity;
  for (let i = 0; i < count; i += 1) {
    const index = (state.intervalIndex - count + i + REPORT_WINDOW) % REPORT_WINDOW;
    const value = state.intervals[index];
    const observedAt = state.intervalTimes[index];
    if (value > 0 && observedAt >= cutoff) out.push(value);
  }
  return out;
}

function renderStats() {
  const avg = state.samples > 0 ? state.sumInterval / state.samples : 0;
  const recent = getRecentIntervals(REALTIME_WINDOW_MS);
  const recentAvg =
    recent.length > 0 ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
  const stale = state.running && performance.now() - state.lastReportAt > STALE_AFTER_MS;

  els.hzValue.textContent = String(formatHz(recentAvg || avg));
  els.avgInterval.textContent = formatMs(avg);
  els.rangeInterval.textContent = `${formatMs(state.minInterval)} / ${formatMs(state.maxInterval)}`;
  els.sampleCount.textContent = String(state.samples);
  els.motionCount.textContent = String(Math.round(state.distance));
  els.windowHz.textContent = `${REALTIME_WINDOW_MS}ms 窗口 ${formatHz(recentAvg || avg)} Hz`;

  if (state.running && state.samples === 0) {
    if (state.pointerFallback) {
      els.statusText.textContent = "等待指针事件，移动鼠标开始备用采样";
    } else {
      els.statusText.textContent =
        state.mode === "move" ? "等待 HID 报告，移动鼠标开始采样" : "等待静置 HID 报告";
    }
  } else if (stale) {
    if (state.pointerFallback) {
      els.statusText.textContent = "指针事件暂停，继续移动鼠标";
    } else {
      els.statusText.textContent =
        state.mode === "move" ? "报告暂停，继续移动鼠标" : "静置时未收到报告，设备可能只在移动时上报";
    }
  }
}

function drawChart() {
  const { width, height } = els.canvas;
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#dce3ea";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const values = getRecentIntervals();
  if (values.length < 2) {
    ctx.fillStyle = "#637083";
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText("等待 HID 输入报告", 22, 34);
    return;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 16;
  const max = Math.max(2, Math.min(32, p95 * 1.35));
  const step = width / (REPORT_WINDOW - 1);

  ctx.fillStyle = "rgba(8, 145, 178, 0.08)";
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = width - (values.length - i) * step;
    const y = height - Math.min(value / max, 1) * (height - 32) - 16;
    if (i === 0) ctx.moveTo(x, height - 16);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(width, height - 16);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#0891b2";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = width - (values.length - i) * step;
    const y = height - Math.min(value / max, 1) * (height - 32) - 16;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#637083";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`${max.toFixed(1)} ms`, 16, 22);
  ctx.fillText("0 ms", 16, height - 18);
}

function animationLoop() {
  renderStats();
  drawChart();
  window.setTimeout(animationLoop, 120);
}

async function openDevice(device) {
  if (!device.opened) await device.open();
  state.device = device;
  state.hidReadable = (device.collections || []).some((collection) => !isProtectedCollection(collection));
  device.addEventListener("inputreport", handleInputReport);
  els.deviceName.textContent = device.productName || "HID Mouse";
  els.vendorId.textContent = hex(device.vendorId);
  els.productId.textContent = hex(device.productId);
  renderCollections(device);
  updateStartState();
  els.connectButton.textContent = "更换设备";
  els.statusText.textContent = state.hidReadable
    ? "设备已连接，存在非保护 HID collection，可以尝试 HID report 采样"
    : "设备已连接，但标准鼠标 HID collection 受浏览器保护；移动测试将使用浏览器事件备用路径";
  els.notice.textContent = state.hidReadable
    ? "当前设备存在非保护 HID collection。是否会输出鼠标运动 report 取决于设备厂商的 HID 描述符。"
    : "Chrome 会保护 generic mouse / keyboard 等顶层 HID collection，网页无法直接读取标准鼠标 report。";
  addLog("连接", `已连接 ${device.productName || "HID 设备"}`);
  if (!state.hidReadable) {
    addLog("诊断", "未发现可读取的非保护 HID collection；标准鼠标 WebHID report 会被浏览器屏蔽");
  }
}

async function setupNativeSampler() {
  if (!isTauriRuntime()) {
    setSourceBadge("browser", "warn");
    return;
  }

  try {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    tauriInvoke = core.invoke;
    tauriListen = event.listen;

    const info = await tauriInvoke("native_sampler_info");
    state.nativeAvailable = true;
    els.supportBadge.textContent = "Native 可用";
    els.supportBadge.className = "badge ok";
    els.secureBadge.textContent = "Tauri";
    els.secureBadge.className = "badge ok";
    els.connectButton.disabled = true;
    els.connectButton.textContent = "桌面采样";
    els.notice.textContent =
      "当前运行在 Tauri 桌面模式。测试使用 Rust 原生输入采样；macOS 优先使用 IOHID report，WebHID 仅用于浏览器模式。";
    setSourceBadge(info.source || "native", "ok");
    setMode(state.mode);
    updateStartState();
    addLog("Native", info.message || "Rust native sampler 可用");

    await tauriListen("native-sample", (event) => handleNativeSample(event.payload));
    await tauriListen("native-status", (event) => {
      addLog("Native", event.payload?.message || "native status changed");
    });
  } catch (error) {
    state.nativeAvailable = false;
    setSourceBadge("browser", "warn");
    addLog("Native", error.message || "Rust native sampler 初始化失败");
  }
}

async function startNativeTest() {
  if (!tauriInvoke) {
    addLog("Native", "Tauri invoke 未就绪");
    return;
  }

  resetStats();
  state.running = true;
  state.nativeRunning = true;
  state.pointerFallback = false;
  els.startButton.disabled = true;
  els.stopButton.disabled = false;
  setSourceBadge("native", "ok");
  els.statusText.textContent = "正在等待 Rust 原生鼠标事件";

  try {
    const status = await tauriInvoke("start_native_sampling");
    addLog("Native", status.message || "Rust native sampler started");
  } catch (error) {
    state.running = false;
    state.nativeRunning = false;
    updateStartState();
    els.stopButton.disabled = true;
    setSourceBadge("native error", "warn");
    els.statusText.textContent = "Rust 原生采样启动失败";
    addLog("错误", error.message || String(error));
  }
}

async function stopNativeTest() {
  state.running = false;
  state.nativeRunning = false;
  els.stopButton.disabled = true;
  updateStartState();
  setSourceBadge("native", "ok");
  els.statusText.textContent = "Rust 原生采样已停止";

  try {
    const status = await tauriInvoke("stop_native_sampling");
    addLog("Native", status.message || "Rust native sampler stopped");
  } catch (error) {
    addLog("错误", error.message || String(error));
  }
}

async function connectDevice() {
  if (!supportsWebHid()) {
    addLog("错误", "当前浏览器不支持 WebHID");
    return;
  }

  try {
    const devices = await navigator.hid.requestDevice({
      filters: [{ usagePage: 0x01, usage: 0x02 }],
    });
    if (devices.length === 0) {
      addLog("连接", "用户取消了设备选择");
      return;
    }
    if (state.device) {
      state.device.removeEventListener("inputreport", handleInputReport);
    }
    await openDevice(devices[0]);
  } catch (error) {
    addLog("错误", error.message || "连接 HID 设备失败");
  }
}

async function restoreAuthorizedDevice() {
  if (!supportsWebHid()) return;
  const devices = await navigator.hid.getDevices();
  const mouse = devices.find((device) =>
    device.collections?.some((collection) => collection.usagePage === 0x01 && collection.usage === 0x02),
  );
  if (mouse) await openDevice(mouse);
}

function updateSupport() {
  const hid = supportsWebHid();
  const secure = window.isSecureContext;

  els.supportBadge.textContent = hid ? "WebHID 可用" : "WebHID 不可用";
  els.supportBadge.className = `badge ${hid ? "ok" : "warn"}`;
  els.secureBadge.textContent = secure ? "安全上下文" : "非安全上下文";
  els.secureBadge.className = `badge ${secure ? "ok" : "warn"}`;
  els.connectButton.disabled = !hid || !secure;

  if (!hid) {
    els.notice.textContent = "当前浏览器不支持 WebHID。请使用桌面版 Chrome、Edge 或其他 Chromium 浏览器。";
  } else if (!secure) {
    els.notice.textContent = "WebHID 需要 HTTPS 或 localhost。请通过本地开发服务器访问本页面。";
  }
}

function bindEvents() {
  els.connectButton.addEventListener("click", connectDevice);
  els.startButton.addEventListener("click", startTest);
  els.stopButton.addEventListener("click", stopTest);
  els.resetButton.addEventListener("click", () => {
    resetStats();
    addLog("测试", "统计数据已重置");
  });
  els.clearLogButton.addEventListener("click", () => {
    state.logs = [];
    renderLog();
  });
  els.moveModeButton.addEventListener("click", () => setMode("move"));
  els.idleModeButton.addEventListener("click", () => setMode("idle"));

  if (supportsWebHid()) {
    navigator.hid.addEventListener("disconnect", (event) => {
      if (event.device === state.device) {
        stopTest();
        state.device = null;
        state.hidReadable = false;
        els.startButton.disabled = true;
        els.deviceName.textContent = "未连接";
        els.collectionList.textContent = "未连接";
        els.statusText.textContent = "设备已断开";
        addLog("连接", "设备已断开");
      }
    });
  }

  window.addEventListener("pointerrawupdate", handlePointerSample, { passive: true });
  window.addEventListener("pointermove", handlePointerSample, { passive: true });
}

async function init() {
  updateSupport();
  bindEvents();
  setMode("move");
  addLog("系统", "页面已就绪");
  await setupNativeSampler();
  await restoreAuthorizedDevice();
  animationLoop();
}

init();
