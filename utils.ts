import type { PerformanceMetrics, SubscriptionInfo } from "./types";

/**
 * Ring buffer with fixed capacity and O(1) push.
 */
export class RingBuffer<T> {
  private readonly buffer: (T | null)[];
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("RingBuffer capacity must be a positive integer.");
    }

    this.buffer = new Array<T | null>(capacity).fill(null);
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

  get(index: number): T | null {
    if (index < 0 || index >= this.count) {
      return null;
    }

    const actual = (this.head + index) % this.capacity;
    return this.buffer[actual];
  }

  getAll(): T[] {
    const result: T[] = [];

    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(this.head + i) % this.capacity];
      if (item !== null) {
        result.push(item);
      }
    }

    return result;
  }

  getLast(n: number): T[] {
    if (n <= 0) {
      return [];
    }

    const take = Math.min(n, this.count);
    const offset = this.count - take;
    const result: T[] = [];

    for (let i = 0; i < take; i++) {
      const item = this.buffer[(this.head + offset + i) % this.capacity];
      if (item !== null) {
        result.push(item);
      }
    }

    return result;
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

export function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts;

  if (diff < 1_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;

  return new Date(ts).toLocaleTimeString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncatePayload(
  payload: unknown,
  maxSize = 1024
): { truncated: string; isTruncated: boolean } {
  try {
    const json = JSON.stringify(payload, null, 2) ?? "null";

    if (json.length <= maxSize) {
      return { truncated: json, isTruncated: false };
    }

    return {
      truncated: `${json.slice(0, maxSize)}\n...`,
      isTruncated: true,
    };
  } catch {
    return {
      truncated: "[Unserializable payload]",
      isTruncated: true,
    };
  }
}

export interface TreeNode {
  name: string;
  children: TreeNode[];
  handlerCount: number;
  fullPath: string;
}

export function topicToTree(subscriptions: SubscriptionInfo[]): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const subscription of subscriptions) {
    const segments = subscription.pattern.split(".").filter(Boolean);
    let currentLevel = roots;
    let path = "";

    for (const segment of segments) {
      path = path ? `${path}.${segment}` : segment;

      let node = currentLevel.find((item) => item.name === segment);
      if (!node) {
        node = {
          name: segment,
          children: [],
          handlerCount: 0,
          fullPath: path,
        };
        currentLevel.push(node);
      }

      if (path === subscription.pattern) {
        node.handlerCount = subscription.handlerCount;
      }

      currentLevel = node.children;
    }
  }

  return roots;
}

/**
 * Incremental metrics tracker for latency percentiles + throughput.
 */
export class MetricsTracker {
  private latencies: number[] = [];
  private latencySum = 0;

  private timestamps: number[] = [];
  private timestampsStart = 0;
  private readonly throughputWindowMs = 10_000;

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

  recordMessage(ts = Date.now()): void {
    this.timestamps.push(ts);
    this.pruneOldTimestamps(ts);
  }

  getMetrics(now = Date.now()): PerformanceMetrics {
    this.pruneOldTimestamps(now);

    const n = this.latencies.length;
    const throughputCount = this.timestamps.length - this.timestampsStart;

    return {
      avgLatency: n > 0 ? this.latencySum / n : 0,
      p95Latency: n > 0 ? this.latencies[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
      p99Latency: n > 0 ? this.latencies[Math.min(n - 1, Math.floor(n * 0.99))] : 0,
      throughput: throughputCount / (this.throughputWindowMs / 1000),
      totalMessages: n,
    };
  }

  reset(): void {
    this.latencies = [];
    this.latencySum = 0;
    this.timestamps = [];
    this.timestampsStart = 0;
  }

  private pruneOldTimestamps(now: number): void {
    const cutoff = now - this.throughputWindowMs;

    while (this.timestampsStart < this.timestamps.length && this.timestamps[this.timestampsStart] < cutoff) {
      this.timestampsStart++;
    }

    // Compact occasionally to prevent unbounded array growth.
    if (this.timestampsStart > 1024 && this.timestampsStart > this.timestamps.length / 2) {
      this.timestamps = this.timestamps.slice(this.timestampsStart);
      this.timestampsStart = 0;
    }
  }
}

/**
 * Fallback one-shot metrics for historical arrays.
 */
export function computeMetrics(diagnostics: Array<Record<string, unknown>>): PerformanceMetrics {
  const latencies = diagnostics
    .filter((event) => event.type === "publish" && typeof event.durationMs === "number")
    .map((event) => event.durationMs as number)
    .sort((a, b) => a - b);

  const n = latencies.length;
  const avgLatency = n > 0 ? latencies.reduce((sum, value) => sum + value, 0) / n : 0;

  return {
    avgLatency,
    p95Latency: n > 0 ? latencies[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
    p99Latency: n > 0 ? latencies[Math.min(n - 1, Math.floor(n * 0.99))] : 0,
    throughput: 0,
    totalMessages: diagnostics.length,
  };
}
