type AdapterType = "cross-tab" | "iframe" | "history" | "local";

type DevToolsEventType =
  | "BUS_DETECTED"
  | "MESSAGE_PUBLISHED"
  | "SUBSCRIPTION_ADDED"
  | "SUBSCRIPTION_REMOVED"
  | "DIAGNOSTIC_EVENT"
  | "BUS_DISPOSED"
  | "STATS_UPDATE"
  | "ADAPTER_ATTACHED"
  | "ADAPTER_DETACHED";

interface DevToolsEvent {
  type: DevToolsEventType;
  busId: string;
  timestamp: number;
  [key: string]: unknown;
}

interface BusMetadata {
  instanceId: string;
  app: string;
  createdAt: number;
  config: Record<string, unknown>;
}

interface BusStats {
  instanceId: string;
  app: string;
  handlerCount: number;
  subscriptionPatterns: string[];
  retentionBufferSize: number;
  retentionBufferCapacity: number;
  messageCount: {
    published: number;
    dispatched: number;
  };
  disposed: boolean;
}

interface SubscriptionInfo {
  pattern: string;
  handlerCount: number;
  createdAt: number;
}

interface AdapterInfo {
  type: AdapterType;
  status: "active" | "inactive" | "error";
  stats?: Record<string, unknown>;
}

interface BusMessageEntry {
  id: string;
  busId: string;
  topic: string;
  ts: number;
  payload: unknown;
  schemaVersion?: string;
  source?: string;
  meta?: Record<string, unknown>;
  adapter: AdapterType;
}

interface DiagnosticEntry {
  id: string;
  busId: string;
  type: string;
  topic?: string;
  message: string;
  stack?: string;
  timestamp: number;
}

interface FilterState {
  topic: string;
  source: string;
  adapters: Set<AdapterType>;
}

interface PerformanceMetrics {
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number;
  totalMessages: number;
}

interface BusState {
  metadata: BusMetadata;
  stats: BusStats;
  subscriptions: SubscriptionInfo[];
  adapters: AdapterInfo[];
  metricsTracker: MetricsTracker;
}

interface AppState {
  buses: Map<string, BusState>;
  selectedBusId: string | null;
  filters: FilterState;
  messageBuffer: RingBuffer<BusMessageEntry>;
  errorBuffer: RingBuffer<DiagnosticEntry>;
  isPaused: boolean;
  tabId: number | null;
}

// Message type constants — must stay in sync with devtools.ts
const PANEL_INIT_EVENT = "__PUBSUB_PANEL_INIT__";
const PANEL_EVENT = "__PUBSUB_PANEL_EVENT__";

const MAX_MESSAGES = 1000;
const MAX_ERRORS = 500;
const ROW_HEIGHT = 32;
const OVERSCAN = 5;

class RingBuffer<T> {
  private readonly buffer: (T | null)[];
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity).fill(null);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;

    if (this.count < this.capacity) {
      this.count++;
      return;
    }

    this.head = (this.head + 1) % this.capacity;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.buffer.fill(null);
  }

  getAll(): T[] {
    const result: T[] = [];

    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      const value = this.buffer[idx];
      if (value !== null) {
        result.push(value);
      }
    }

    return result;
  }

  size(): number {
    return this.count;
  }
}

class MetricsTracker {
  private latencies: number[] = [];
  private latencySum = 0;
  // Index-based sliding window: avoids O(n) Array.shift() on prune.
  private timestamps: number[] = [];
  private timestampsStart = 0;
  // Separate all-time counter so totalMessages never decreases.
  private totalMessageCount = 0;
  private readonly throughputWindowMs = 10_000;

  // Throughput history for sparkline: stores [timestamp, value] pairs.
  // Sampled once per second, keeps the last 60 data points (1 minute).
  readonly throughputHistory: Array<{ ts: number; value: number }> = [];
  private readonly maxHistoryPoints = 60;
  private lastSampleTs = 0;

  recordMessage(): void {
    this.totalMessageCount++;
    this.timestamps.push(Date.now());
    this.pruneTimestamps(Date.now());
  }

  addLatency(durationMs: number): void {
    this.latencySum += durationMs;

    let low = 0;
    let high = this.latencies.length;

    while (low < high) {
      const mid = (low + high) >>> 1;

      if (this.latencies[mid] < durationMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.latencies.splice(low, 0, durationMs);
  }

  getMetrics(): PerformanceMetrics {
    const now = Date.now();
    this.pruneTimestamps(now);

    const n = this.latencies.length;
    const windowCount = this.timestamps.length - this.timestampsStart;
    const throughput = windowCount / (this.throughputWindowMs / 1000);

    // Sample throughput once per second for sparkline history.
    if (now - this.lastSampleTs >= 1000) {
      this.lastSampleTs = now;
      this.throughputHistory.push({ ts: now, value: throughput });
      if (this.throughputHistory.length > this.maxHistoryPoints) {
        this.throughputHistory.shift();
      }
    }

    return {
      avgLatency: n > 0 ? this.latencySum / n : 0,
      p95Latency: n > 0 ? this.latencies[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
      p99Latency: n > 0 ? this.latencies[Math.min(n - 1, Math.floor(n * 0.99))] : 0,
      throughput,
      totalMessages: this.totalMessageCount,
    };
  }

  private pruneTimestamps(now: number): void {
    const cutoff = now - this.throughputWindowMs;
    while (
      this.timestampsStart < this.timestamps.length &&
      this.timestamps[this.timestampsStart] < cutoff
    ) {
      this.timestampsStart++;
    }
    // Compact the array periodically to prevent unbounded memory growth.
    if (this.timestampsStart > 1024 && this.timestampsStart > this.timestamps.length / 2) {
      this.timestamps = this.timestamps.slice(this.timestampsStart);
      this.timestampsStart = 0;
    }
  }
}

const state: AppState = {
  buses: new Map(),
  selectedBusId: null,
  filters: {
    topic: "",
    source: "",
    adapters: new Set<AdapterType>(["cross-tab", "iframe", "history", "local"]),
  },
  messageBuffer: new RingBuffer<BusMessageEntry>(MAX_MESSAGES),
  errorBuffer: new RingBuffer<DiagnosticEntry>(MAX_ERRORS),
  isPaused: false,
  tabId: null,
};

let renderScheduled = false;

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; tabId?: number; data?: unknown } | undefined;

  if (data?.type === PANEL_INIT_EVENT) {
    if (typeof data.tabId === "number") {
      state.tabId = data.tabId;
    }
    return;
  }

  if (data?.type !== PANEL_EVENT) {
    return;
  }

  if (state.isPaused) {
    return;
  }

  handleDevToolsEvent(data.data);
});

function handlePageReset(): void {
  state.buses.clear();
  state.selectedBusId = null;
  state.messageBuffer.clear();
  state.errorBuffer.clear();
  scheduleRender();
}

function handleDevToolsEvent(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    return;
  }

  const event = raw as Partial<DevToolsEvent> & { type?: string };

  // Handle page reset before validating busId (reset has no busId).
  if ((event as Record<string, unknown>).type === "__PAGE_RESET__") {
    handlePageReset();
    return;
  }

  if (typeof event.type !== "string" || typeof event.busId !== "string") {
    return;
  }

  switch (event.type as DevToolsEventType) {
    case "BUS_DETECTED":
      handleBusDetected(event as DevToolsEvent);
      break;
    case "MESSAGE_PUBLISHED":
      handleMessagePublished(event as DevToolsEvent);
      break;
    case "SUBSCRIPTION_ADDED":
    case "SUBSCRIPTION_REMOVED":
      handleSubscriptionEvent(event as DevToolsEvent);
      break;
    case "DIAGNOSTIC_EVENT":
      handleDiagnosticEvent(event as DevToolsEvent);
      break;
    case "BUS_DISPOSED":
      handleBusDisposed(event as DevToolsEvent);
      break;
    case "STATS_UPDATE":
      handleStatsUpdate(event as DevToolsEvent);
      break;
    case "ADAPTER_ATTACHED":
      handleAdapterAttached(event as DevToolsEvent);
      break;
    case "ADAPTER_DETACHED":
      handleAdapterDetached(event as DevToolsEvent);
      break;
    default:
      return;
  }

  scheduleRender();
}

function handleBusDetected(event: DevToolsEvent): void {
  const metadata = (event.metadata as BusMetadata | undefined) ?? createFallbackMetadata(event.busId);
  const existing = state.buses.get(event.busId);

  if (!existing) {
    state.buses.set(event.busId, {
      metadata,
      stats: createFallbackStats(event.busId, metadata.app),
      subscriptions: [],
      adapters: [],
      metricsTracker: new MetricsTracker(),
    });
  } else {
    existing.metadata = metadata;
  }

  if (!state.selectedBusId) {
    state.selectedBusId = event.busId;
  }
}

function handleMessagePublished(event: DevToolsEvent): void {
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) {
    return;
  }

  const bus = getOrCreateBusState(event.busId);

  const source = typeof message.meta === "object" && message.meta
    ? ((message.meta as Record<string, unknown>).source as string | undefined)
    : undefined;

  const meta = typeof message.meta === "object" && message.meta
    ? (message.meta as Record<string, unknown>)
    : undefined;

  const adapter = inferAdapterType(source, meta);
  markAdapterActive(bus, adapter);

  const entry: BusMessageEntry = {
    id: String(message.id ?? `${event.busId}-${event.timestamp}`),
    busId: event.busId,
    topic: String(message.topic ?? "unknown"),
    ts: typeof message.ts === "number" ? message.ts : event.timestamp,
    payload: message.payload,
    schemaVersion: typeof message.schemaVersion === "string" ? message.schemaVersion : undefined,
    source,
    meta: (message.meta as Record<string, unknown> | undefined) ?? undefined,
    adapter,
  };

  state.messageBuffer.push(entry);
  bus.metricsTracker.recordMessage();
}

function handleSubscriptionEvent(event: DevToolsEvent): void {
  const bus = getOrCreateBusState(event.busId);
  const pattern = typeof event.pattern === "string" ? event.pattern : "unknown";
  const handlerCount = typeof event.handlerCount === "number" ? event.handlerCount : 0;

  const idx = bus.subscriptions.findIndex((sub) => sub.pattern === pattern);

  if (event.type === "SUBSCRIPTION_REMOVED" && handlerCount <= 0) {
    if (idx >= 0) {
      bus.subscriptions.splice(idx, 1);
    }
    return;
  }

  const next: SubscriptionInfo = {
    pattern,
    handlerCount,
    createdAt: event.timestamp,
  };

  if (idx >= 0) {
    bus.subscriptions[idx] = next;
  } else {
    bus.subscriptions.push(next);
  }
}

function handleDiagnosticEvent(event: DevToolsEvent): void {
  const bus = getOrCreateBusState(event.busId);
  const diagnostic = event.event as Record<string, unknown> | undefined;

  if (!diagnostic || typeof diagnostic.type !== "string") {
    return;
  }

  if (diagnostic.type === "publish" && typeof diagnostic.durationMs === "number") {
    bus.metricsTracker.addLatency(diagnostic.durationMs);
  }

  if (diagnostic.type !== "handler-error" && diagnostic.type !== "validation-error") {
    return;
  }

  const errorObj = diagnostic.error as Record<string, unknown> | undefined;

  state.errorBuffer.push({
    id: `${event.busId}-${event.timestamp}-${diagnostic.type}`,
    busId: event.busId,
    type: diagnostic.type,
    topic: typeof diagnostic.topic === "string" ? diagnostic.topic : undefined,
    message: String(errorObj?.message ?? diagnostic.message ?? diagnostic.type),
    stack: typeof errorObj?.stack === "string" ? errorObj.stack : undefined,
    timestamp: event.timestamp,
  });
}

function handleBusDisposed(event: DevToolsEvent): void {
  state.buses.delete(event.busId);

  if (state.selectedBusId === event.busId) {
    state.selectedBusId = state.buses.keys().next().value ?? null;
  }
}

function handleStatsUpdate(event: DevToolsEvent): void {
  const stats = event.stats as BusStats | undefined;
  if (!stats) {
    return;
  }

  const bus = getOrCreateBusState(event.busId, {
    instanceId: stats.instanceId,
    app: stats.app,
    createdAt: Date.now(),
    config: {},
  });

  bus.stats = stats;
}

function handleAdapterAttached(event: DevToolsEvent): void {
  const adapterType = event.adapterType as AdapterType | undefined;
  if (!adapterType) {
    return;
  }

  const bus = getOrCreateBusState(event.busId);
  markAdapterActive(bus, adapterType);
}

function handleAdapterDetached(event: DevToolsEvent): void {
  const adapterType = event.adapterType as AdapterType | undefined;
  if (!adapterType) {
    return;
  }

  const bus = state.buses.get(event.busId);
  if (!bus) {
    return;
  }

  const existing = bus.adapters.find((entry) => entry.type === adapterType);
  if (existing) {
    existing.status = "inactive";
  }
}

function getOrCreateBusState(busId: string, metadata?: BusMetadata): BusState {
  const existing = state.buses.get(busId);
  if (existing) {
    if (metadata) {
      existing.metadata = metadata;
    }
    return existing;
  }

  const fallback = metadata ?? createFallbackMetadata(busId);
  const next: BusState = {
    metadata: fallback,
    stats: createFallbackStats(busId, fallback.app),
    subscriptions: [],
    adapters: [],
    metricsTracker: new MetricsTracker(),
  };
  state.buses.set(busId, next);

  if (!state.selectedBusId) {
    state.selectedBusId = busId;
  }

  return next;
}

function createFallbackMetadata(busId: string): BusMetadata {
  return {
    instanceId: busId,
    app: "unknown",
    createdAt: Date.now(),
    config: {},
  };
}

function createFallbackStats(busId: string, app: string): BusStats {
  return {
    instanceId: busId,
    app,
    handlerCount: 0,
    subscriptionPatterns: [],
    retentionBufferSize: 0,
    retentionBufferCapacity: 0,
    messageCount: { published: 0, dispatched: 0 },
    disposed: false,
  };
}

function inferAdapterType(source?: string, meta?: Record<string, unknown>): AdapterType {
  // Check cross-tab marker set by CrossTabAdapter
  if (meta && meta._crossTab === true) {
    return "cross-tab";
  }

  if (!source) {
    return "local";
  }

  const lower = source.toLowerCase();
  // Iframe adapter sets source to "iframe:<clientId>"
  if (lower.startsWith("iframe:") || lower.includes("iframe")) {
    return "iframe";
  }
  if (lower.includes("cross-tab") || lower.includes("broadcast") || lower.includes("storage")) {
    return "cross-tab";
  }
  if (lower.includes("history")) {
    return "history";
  }

  return "local";
}

function markAdapterActive(bus: BusState, adapter: AdapterType): void {
  const existing = bus.adapters.find((entry) => entry.type === adapter);
  if (existing) {
    existing.status = "active";
    return;
  }

  bus.adapters.push({ type: adapter, status: "active" });
}

function scheduleRender(): void {
  if (renderScheduled) {
    return;
  }

  renderScheduled = true;
  window.requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render(): void {
  renderBusSelector();
  renderVirtualMessageFeed();
  renderTopicTree();
  renderPerformanceMetrics();
  renderErrors();
  renderAdapterStatus();
  renderBusStats();
}

function getFilteredMessages(): BusMessageEntry[] {
  const topicFilter = state.filters.topic.trim().toLowerCase();
  const sourceFilter = state.filters.source.trim().toLowerCase();

  return state.messageBuffer
    .getAll()
    .filter((message) => !state.selectedBusId || message.busId === state.selectedBusId)
    .filter((message) => (topicFilter ? message.topic.toLowerCase().includes(topicFilter) : true))
    .filter((message) => (sourceFilter ? (message.source ?? "").toLowerCase().includes(sourceFilter) : true))
    .filter((message) => state.filters.adapters.has(message.adapter));
}

function renderVirtualMessageFeed(): void {
  const container = document.getElementById("message-feed") as HTMLDivElement | null;
  const tbody = document.getElementById("message-list") as HTMLTableSectionElement | null;
  const spacer = document.getElementById("message-spacer") as HTMLDivElement | null;

  if (!container || !tbody || !spacer) {
    return;
  }

  const messages = getFilteredMessages();
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight || 400;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    messages.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  );

  spacer.style.height = `${messages.length * ROW_HEIGHT}px`;
  tbody.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;

  tbody.innerHTML = "";
  for (let i = startIndex; i < endIndex; i++) {
    tbody.appendChild(createMessageRow(messages[i]));
  }
}

function createMessageRow(message: BusMessageEntry): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const payload = stringifySafe(message.payload, 240);

  tr.innerHTML = `
    <td>${formatTime(message.ts)}</td>
    <td>${escapeHtml(message.topic)}</td>
    <td>${escapeHtml(message.source ?? "-")}</td>
    <td>${escapeHtml(message.adapter)}</td>
    <td><code>${escapeHtml(payload)}</code></td>
  `;

  return tr;
}

function renderBusSelector(): void {
  const selector = document.getElementById("bus-selector") as HTMLSelectElement | null;
  if (!selector) {
    return;
  }

  const currentValue = state.selectedBusId ?? "";
  const options = ["<option value=\"\">Select Bus...</option>"];

  for (const [busId, bus] of state.buses.entries()) {
    const selected = currentValue === busId ? " selected" : "";
    options.push(
      `<option value="${escapeHtml(busId)}"${selected}>${escapeHtml(bus.metadata.app)} (${escapeHtml(busId.slice(0, 8))}...)</option>`
    );
  }

  selector.innerHTML = options.join("");
}

// ── Topic tree helpers ──────────────────────────────────────────────────────

interface TopicTreeNode {
  name: string;
  children: TopicTreeNode[];
  handlerCount: number;
  fullPath: string;
}

function buildTopicTree(subscriptions: SubscriptionInfo[]): TopicTreeNode[] {
  const roots: TopicTreeNode[] = [];

  for (const sub of subscriptions) {
    const segments = sub.pattern.split(".").filter(Boolean);
    let level = roots;
    let path = "";

    for (const segment of segments) {
      path = path ? `${path}.${segment}` : segment;
      let node = level.find((n) => n.name === segment);

      if (!node) {
        node = { name: segment, children: [], handlerCount: 0, fullPath: path };
        level.push(node);
      }

      if (path === sub.pattern) {
        node.handlerCount = sub.handlerCount;
      }

      level = node.children;
    }
  }

  return roots;
}

function renderTreeNodeHtml(node: TopicTreeNode, depth: number): string {
  const badge =
    node.handlerCount > 0
      ? ` <span class="handler-count">(${node.handlerCount})</span>`
      : "";
  const children = node.children
    .map((child) => renderTreeNodeHtml(child, depth + 1))
    .join("");

  return (
    `<div class="tree-node" style="padding-left:${depth * 14}px">` +
    `<span class="tree-segment">${escapeHtml(node.name)}</span>${badge}` +
    `</div>${children}`
  );
}

function renderTopicTree(): void {
  const container = document.getElementById("topic-tree");
  if (!container) {
    return;
  }

  const bus = state.selectedBusId ? state.buses.get(state.selectedBusId) : undefined;
  if (!bus || bus.subscriptions.length === 0) {
    container.textContent = "No active subscriptions";
    return;
  }

  const tree = buildTopicTree(bus.subscriptions);
  container.innerHTML = tree.map((node) => renderTreeNodeHtml(node, 0)).join("");
}

/**
 * Render a throughput-over-time sparkline on the performance canvas.
 * Pure Canvas2D — zero dependencies.
 */
function renderSparklineChart(history: Array<{ ts: number; value: number }>): void {
  const canvas = document.getElementById("performance-chart") as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width * dpr;
  const h = rect.height * dpr;

  // Resize backing store to match CSS size × DPR for crisp rendering.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.scale(dpr, dpr);

  const cssW = rect.width;
  const cssH = rect.height;
  const pad = { top: 10, right: 12, bottom: 24, left: 40 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top - pad.bottom;

  // Resolve CSS custom properties for theming.
  const style = getComputedStyle(canvas);
  const textColor = style.getPropertyValue("--text-secondary").trim() || "#9aa0a6";
  const gridColor = style.getPropertyValue("--border-color").trim() || "#3c3c3c";
  const accentColor = style.getPropertyValue("--accent-color").trim() || "#4fc3f7";

  // Empty state.
  if (history.length < 2) {
    ctx.fillStyle = textColor;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for data\u2026", cssW / 2, cssH / 2);
    ctx.restore();
    return;
  }

  const values = history.map((p) => p.value);
  const maxVal = Math.max(...values, 1); // at least 1 to avoid division by zero
  const niceMax = ceilToNice(maxVal);

  // --- Grid lines & Y-axis labels ---
  const gridSteps = 4;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.fillStyle = textColor;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= gridSteps; i++) {
    const ratio = i / gridSteps;
    const y = pad.top + plotH - ratio * plotH;
    const label = (niceMax * ratio).toFixed(niceMax >= 10 ? 0 : 1);

    // Grid line.
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    // Label.
    ctx.fillText(label, pad.left - 6, y);
  }

  // --- X-axis time labels ---
  const firstTs = history[0].ts;
  const lastTs = history[history.length - 1].ts;
  const spanSec = Math.max((lastTs - firstTs) / 1000, 1);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xLabelCount = Math.min(6, history.length);
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.round((i / (xLabelCount - 1)) * (history.length - 1));
    const x = pad.left + (idx / (history.length - 1)) * plotW;
    const secAgo = Math.round((lastTs - history[idx].ts) / 1000);
    ctx.fillText(secAgo === 0 ? "now" : `-${secAgo}s`, x, pad.top + plotH + 6);
  }

  // --- Area fill + line ---
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = pad.left + (i / (history.length - 1)) * plotW;
    const y = pad.top + plotH - (values[i] / niceMax) * plotH;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  // Stroke the line.
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Fill area under the line.
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = accentColor.replace(")", ", 0.12)").replace("rgb(", "rgba(");
  // Fallback for hex colors.
  if (!ctx.fillStyle.includes("rgba")) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = accentColor;
  }
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- Latest value dot ---
  const lastX = pad.left + plotW;
  const lastY = pad.top + plotH - (values[values.length - 1] / niceMax) * plotH;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = accentColor;
  ctx.fill();

  ctx.restore();
}

/** Round up to a "nice" axis maximum (1, 2, 5, 10, 20, 50, …). */
function ceilToNice(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;

  if (normalized <= 1) {
    return magnitude;
  }
  if (normalized <= 2) {
    return 2 * magnitude;
  }
  if (normalized <= 5) {
    return 5 * magnitude;
  }

  return 10 * magnitude;
}

function renderPerformanceMetrics(): void {
  const bus = state.selectedBusId ? state.buses.get(state.selectedBusId) : undefined;
  const metrics = bus?.metricsTracker.getMetrics();

  setText("metric-latency", metrics ? `${metrics.avgLatency.toFixed(2)} ms` : "-");
  setText("metric-p95", metrics ? `${metrics.p95Latency.toFixed(2)} ms` : "-");
  setText("metric-p99", metrics ? `${metrics.p99Latency.toFixed(2)} ms` : "-");
  setText("metric-throughput", metrics ? `${metrics.throughput.toFixed(1)} msg/s` : "-");
  setText("metric-total", metrics ? String(metrics.totalMessages) : "-");

  renderSparklineChart(bus?.metricsTracker.throughputHistory ?? []);
}

function renderErrors(): void {
  const container = document.getElementById("error-list");
  if (!container) {
    return;
  }

  const errors = state.errorBuffer
    .getAll()
    .filter((entry) => !state.selectedBusId || entry.busId === state.selectedBusId)
    .slice(-100)
    .reverse();

  if (errors.length === 0) {
    container.textContent = "No errors captured";
    return;
  }

  container.innerHTML = errors
    .map(
      (entry) =>
        `<article class="error-item"><h4>${escapeHtml(entry.type)} • ${formatTime(entry.timestamp)}</h4><p>${escapeHtml(entry.message)}</p>${entry.stack ? `<pre>${escapeHtml(entry.stack)}</pre>` : ""}</article>`
    )
    .join("");
}

function renderAdapterStatus(): void {
  const container = document.getElementById("adapter-status");
  if (!container) {
    return;
  }

  const bus = state.selectedBusId ? state.buses.get(state.selectedBusId) : undefined;
  if (!bus || bus.adapters.length === 0) {
    container.textContent = "No adapter activity yet";
    return;
  }

  container.innerHTML = bus.adapters
    .map((adapter) => `<div>${escapeHtml(adapter.type)}: ${escapeHtml(adapter.status)}</div>`)
    .join("");
}

function renderBusStats(): void {
  const container = document.getElementById("bus-stats");
  if (!container) {
    return;
  }

  const bus = state.selectedBusId ? state.buses.get(state.selectedBusId) : undefined;
  if (!bus) {
    container.textContent = "No bus selected";
    return;
  }

  container.innerHTML = `<pre>${escapeHtml(JSON.stringify(bus.stats, null, 2))}</pre>`;
}

function setupControls(): void {
  const pauseButton = document.getElementById("btn-pause") as HTMLButtonElement | null;
  const clearButton = document.getElementById("btn-clear") as HTMLButtonElement | null;
  const exportButton = document.getElementById("btn-export") as HTMLButtonElement | null;
  const busSelector = document.getElementById("bus-selector") as HTMLSelectElement | null;
  const topicFilter = document.getElementById("topic-filter") as HTMLInputElement | null;
  const sourceFilter = document.getElementById("source-filter") as HTMLInputElement | null;
  const feedContainer = document.getElementById("message-feed") as HTMLDivElement | null;

  pauseButton?.addEventListener("click", () => {
    state.isPaused = !state.isPaused;
    pauseButton.textContent = state.isPaused ? "▶" : "⏸";
  });

  clearButton?.addEventListener("click", () => {
    state.messageBuffer.clear();
    state.errorBuffer.clear();
    render();
  });

  exportButton?.addEventListener("click", () => {
    exportToJSON();
  });

  busSelector?.addEventListener("change", () => {
    state.selectedBusId = busSelector.value || null;
    scheduleRender();
  });

  topicFilter?.addEventListener("input", () => {
    state.filters.topic = topicFilter.value;
    scheduleRender();
  });

  sourceFilter?.addEventListener("input", () => {
    state.filters.source = sourceFilter.value;
    scheduleRender();
  });

  document.querySelectorAll<HTMLInputElement>(".adapter-filters input[type='checkbox']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const value = checkbox.value as AdapterType;
      if (checkbox.checked) {
        state.filters.adapters.add(value);
      } else {
        state.filters.adapters.delete(value);
      }
      scheduleRender();
    });
  });

  feedContainer?.addEventListener("scroll", () => {
    scheduleRender();
  }, { passive: true });

  setupTabs();
}

function setupTabs(): void {
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"));
  const tabContents = Array.from(document.querySelectorAll<HTMLElement>(".tab-content"));

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (!tab) {
        return;
      }

      tabButtons.forEach((btn) => btn.classList.remove("active"));
      tabContents.forEach((content) => content.classList.remove("active"));

      button.classList.add("active");
      document.getElementById(`tab-${tab}`)?.classList.add("active");
    });
  });
}

function exportToJSON(): void {
  const exportData = {
    exportedAt: new Date().toISOString(),
    tabId: state.tabId,
    selectedBusId: state.selectedBusId,
    buses: Array.from(state.buses.values()).map((bus) => ({
      metadata: bus.metadata,
      stats: bus.stats,
      subscriptions: bus.subscriptions,
      adapters: bus.adapters,
    })),
    messages: getFilteredMessages(),
    errors: state.errorBuffer.getAll(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pubsub-devtools-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function stringifySafe(value: unknown, maxChars = 200): string {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return "-";
    }

    return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
  } catch {
    return "[unserializable]";
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

setupControls();
render();

export {};
