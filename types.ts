// These interfaces mirror the definitions in src/types.ts.
// They are inlined here so that the extension compiles as a self-contained unit
// (no ../src/ cross-directory imports that would break outDir layout).

export interface BusStats {
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

export interface BusMetadata {
  instanceId: string;
  app: string;
  createdAt: number;
  config: {
    app: string;
    validationMode?: string;
    debug?: boolean;
    enableDevTools?: boolean;
  };
}

export interface SerializableError {
  name: string;
  message: string;
  stack?: string;
}

export interface SubscriptionInfo {
  pattern: string;
  handlerCount: number;
  createdAt: number;
}

export type AdapterType = "local" | "cross-tab" | "iframe" | "history";

export interface DevToolsEvent {
  type:
    | "BUS_DETECTED"
    | "MESSAGE_PUBLISHED"
    | "SUBSCRIPTION_ADDED"
    | "SUBSCRIPTION_REMOVED"
    | "DIAGNOSTIC_EVENT"
    | "BUS_DISPOSED"
    | "STATS_UPDATE";
  busId: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface MessageEvent {
  id: string;
  busId: string;
  topic: string;
  payload: unknown;
  timestamp: number;
  source?: string;
  schemaVersion?: string;
  meta?: Record<string, unknown>;
  adapter?: AdapterType;
}

export interface ErrorEvent {
  id: string;
  busId: string;
  type: "handler-error" | "validation-error";
  topic?: string;
  error: SerializableError;
  timestamp: number;
}

export interface FilterState {
  topic: string;
  source: string;
  adapters: Set<AdapterType>;
}

export interface PerformanceMetrics {
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number;
  totalMessages: number;
}

export interface AdapterInfo {
  type: Exclude<AdapterType, "local">;
  status: "active" | "inactive" | "error";
  config?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

export interface BusState {
  metadata: BusMetadata;
  stats: BusStats;
  subscriptions: SubscriptionInfo[];
  adapters: AdapterInfo[];
}
