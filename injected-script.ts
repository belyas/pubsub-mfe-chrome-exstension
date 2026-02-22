const REGISTRY_GLOBAL_KEY = "__PUBSUB_MFE_DEVTOOLS_REGISTRY__";
const REGISTRY_EVENT_NAME = "__pubsub_mfe_devtools__";
const DEVTOOLS_EVENT_NAME = "__pubsub_mfe_devtools_event__";
const OUTBOUND_EVENT_NAME = "__PUBSUB_MFE_DEVTOOLS_EVENT_BATCH__";

const MAX_PAYLOAD_SIZE = 50 * 1024; // 50KB before first postMessage
const BATCH_INTERVAL_MS = 16; // ~1 frame at 60fps
const MAX_BATCH_SIZE = 50;
const STATS_INTERVAL_MS = 1000;

type UnknownRecord = Record<string, unknown>;

type RegistryEvent = {
  type: "BUS_CREATED" | "BUS_DISPOSED";
  metadata?: BusMetadata;
};

type DevToolsEvent = {
  type:
    | "BUS_DETECTED"
    | "MESSAGE_PUBLISHED"
    | "SUBSCRIPTION_ADDED"
    | "SUBSCRIPTION_REMOVED"
    | "DIAGNOSTIC_EVENT"
    | "BUS_DISPOSED"
    | "STATS_UPDATE";
  busId?: string;
  timestamp: number;
  [key: string]: unknown;
};

type BusMetadata = {
  instanceId: string;
  app: string;
  createdAt: number;
  config: UnknownRecord;
};

type PubSubMessage = {
  id: string;
  topic: string;
  ts: number;
  payload: unknown;
  meta?: UnknownRecord;
  schemaVersion?: string;
};

type PubSubBusLike = {
  getHooks?: () => {
    onPublish?: (listener: (message: PubSubMessage) => void) => () => void;
  };
  getStats?: () => UnknownRecord;
};

type DevToolsRegistry = {
  getAll?: () => BusMetadata[];
  getBus?: (instanceId: string) => PubSubBusLike | undefined;
};

declare global {
  interface Window {
    __PUBSUB_MFE_DEVTOOLS_REGISTRY__?: DevToolsRegistry;
  }
}

const publishHookUnsubscribers = new Map<string, () => void>();
let eventBatch: DevToolsEvent[] = [];
let batchTimer: number | null = null;

function postBatchedEvents(events: DevToolsEvent[]): void {
  if (events.length === 0) {
    return;
  }

  window.postMessage(
    {
      source: OUTBOUND_EVENT_NAME,
      events,
    },
    "*"
  );
}

function queueEvent(event: DevToolsEvent): void {
  eventBatch.push(event);

  if (eventBatch.length >= MAX_BATCH_SIZE) {
    flushBatch();
    return;
  }

  if (batchTimer === null) {
    batchTimer = window.setTimeout(() => {
      flushBatch();
    }, BATCH_INTERVAL_MS);
  }
}

function flushBatch(): void {
  if (batchTimer !== null) {
    window.clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (eventBatch.length === 0) {
    return;
  }

  const batch = eventBatch;
  eventBatch = [];
  postBatchedEvents(batch);
}

function createCircularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    if (typeof value === "function") {
      return "[Function]";
    }

    if (typeof value === "symbol") {
      return value.toString();
    }

    return value;
  };
}

function serializeForTransport(value: unknown): string {
  try {
    return JSON.stringify(value, createCircularReplacer());
  } catch {
    return JSON.stringify("[Unserializable]");
  }
}

function truncateValue(value: unknown, maxBytes = MAX_PAYLOAD_SIZE): unknown {
  const serialized = serializeForTransport(value);
  const encoded = new TextEncoder().encode(serialized);

  if (encoded.length <= maxBytes) {
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      return serialized;
    }
  }

  const maxPreview = Math.max(0, maxBytes - 256);
  const preview = serialized.slice(0, maxPreview);

  return {
    __truncated: true,
    byteLength: encoded.length,
    maxBytes,
    preview: `${preview}...[truncated]`,
  };
}

function truncateMessage(message: PubSubMessage): PubSubMessage {
  return {
    ...message,
    payload: truncateValue(message.payload, MAX_PAYLOAD_SIZE),
    meta: message.meta ? (truncateValue(message.meta, MAX_PAYLOAD_SIZE) as UnknownRecord) : undefined,
  };
}

function getRegistry(): DevToolsRegistry | undefined {
  return window[REGISTRY_GLOBAL_KEY as keyof Window] as DevToolsRegistry | undefined;
}

function attachPublishHook(bus: PubSubBusLike | undefined, metadata: BusMetadata): void {
  if (!bus || publishHookUnsubscribers.has(metadata.instanceId)) {
    return;
  }

  try {
    const hooks = bus.getHooks?.();
    const onPublish = hooks?.onPublish;

    if (typeof onPublish !== "function") {
      return;
    }

    const unsubscribe = onPublish((message) => {
      queueEvent({
        type: "MESSAGE_PUBLISHED",
        busId: metadata.instanceId,
        timestamp: Date.now(),
        message: truncateMessage(message),
      });
    });

    publishHookUnsubscribers.set(metadata.instanceId, unsubscribe);
  } catch {
    // Never break app logic due to DevTools instrumentation.
  }
}

function detachPublishHook(instanceId: string): void {
  const unsubscribe = publishHookUnsubscribers.get(instanceId);

  if (!unsubscribe) {
    return;
  }

  try {
    unsubscribe();
  } catch {
    // Ignore unsubscribe errors from app internals.
  }

  publishHookUnsubscribers.delete(instanceId);
}

function emitBusDetected(metadata: BusMetadata): void {
  queueEvent({
    type: "BUS_DETECTED",
    busId: metadata.instanceId,
    timestamp: Date.now(),
    metadata,
  });
}

function handleRegistryEvent(detail: RegistryEvent): void {
  const { type, metadata } = detail;

  if (!metadata) {
    return;
  }

  if (type === "BUS_CREATED") {
    emitBusDetected(metadata);

    const registry = getRegistry();
    attachPublishHook(registry?.getBus?.(metadata.instanceId), metadata);
    return;
  }

  if (type === "BUS_DISPOSED") {
    detachPublishHook(metadata.instanceId);

    queueEvent({
      type: "BUS_DISPOSED",
      busId: metadata.instanceId,
      timestamp: Date.now(),
      metadata,
    });
  }
}

function handleBusDevToolsEvent(detail: UnknownRecord): void {
  const type = detail.type;

  if (typeof type !== "string") {
    return;
  }

  if (type === "MESSAGE_PUBLISHED") {
    // We intentionally use bus hooks for publish events to avoid duplicates.
    return;
  }

  if (type === "DIAGNOSTIC") {
    queueEvent({
      type: "DIAGNOSTIC_EVENT",
      busId: typeof detail.busId === "string" ? detail.busId : undefined,
      timestamp: typeof detail.timestamp === "number" ? detail.timestamp : Date.now(),
      event: truncateValue(detail.event, MAX_PAYLOAD_SIZE),
    });
    return;
  }

  if (type === "SUBSCRIPTION_ADDED" || type === "SUBSCRIPTION_REMOVED") {
    queueEvent({
      type,
      busId: typeof detail.busId === "string" ? detail.busId : undefined,
      timestamp: typeof detail.timestamp === "number" ? detail.timestamp : Date.now(),
      pattern: detail.pattern,
      handlerCount: detail.handlerCount,
    });
  }
}

function detectExistingBuses(): void {
  const registry = getRegistry();

  if (!registry?.getAll) {
    return;
  }

  try {
    for (const metadata of registry.getAll()) {
      emitBusDetected(metadata);
      attachPublishHook(registry.getBus?.(metadata.instanceId), metadata);
    }
  } catch {
    // Ignore registry read errors.
  }
}

function startStatsPolling(): void {
  window.setInterval(() => {
    const registry = getRegistry();

    if (!registry?.getAll) {
      return;
    }

    try {
      for (const metadata of registry.getAll()) {
        const bus = registry.getBus?.(metadata.instanceId);
        const stats = bus?.getStats?.();

        if (!stats) {
          continue;
        }

        queueEvent({
          type: "STATS_UPDATE",
          busId: metadata.instanceId,
          timestamp: Date.now(),
          stats: truncateValue(stats, MAX_PAYLOAD_SIZE),
        });
      }
    } catch {
      // Ignore polling errors.
    }
  }, STATS_INTERVAL_MS);
}

window.addEventListener(REGISTRY_EVENT_NAME, (event: Event) => {
  const customEvent = event as CustomEvent<RegistryEvent>;
  handleRegistryEvent(customEvent.detail);
});

window.addEventListener(DEVTOOLS_EVENT_NAME, (event: Event) => {
  const customEvent = event as CustomEvent<UnknownRecord>;
  handleBusDevToolsEvent(customEvent.detail);
});

detectExistingBuses();
startStatsPolling();

export {};
