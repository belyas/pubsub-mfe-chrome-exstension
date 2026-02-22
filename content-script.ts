const INJECTED_SCRIPT_FILE = "injected-script.js";
const INJECTED_SCRIPT_ID = "pubsub-mfe-devtools-injected";
const CURRENT_BATCH_SOURCE = "__PUBSUB_MFE_DEVTOOLS_EVENT_BATCH__";
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB per validated event

declare const chrome: {
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): void;
  };
};

const ALLOWED_EVENT_TYPES = new Set([
  "BUS_DETECTED",
  "MESSAGE_PUBLISHED",
  "SUBSCRIPTION_ADDED",
  "SUBSCRIPTION_REMOVED",
  "DIAGNOSTIC_EVENT",
  "DIAGNOSTIC",
  "BUS_DISPOSED",
  "STATS_UPDATE",
  "ADAPTER_ATTACHED",
  "ADAPTER_DETACHED",
]);

type DevToolsEvent = {
  type: string;
  busId?: string;
  timestamp?: number;
  [key: string]: unknown;
};

function injectPageScript(): void {
  if (document.getElementById(INJECTED_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = INJECTED_SCRIPT_ID;
  script.src = chrome.runtime.getURL(INJECTED_SCRIPT_FILE);
  // injected-script.ts is compiled as an ES module (export {}),
  // so it must be loaded as type="module" or the browser throws SyntaxError.
  script.type = "module";
  script.async = false;

  script.onload = () => {
    script.remove();
  };

  script.onerror = () => {
    script.remove();
  };

  const parent = document.head || document.documentElement;
  if (!parent) {
    return;
  }

  parent.appendChild(script);
}

function getEventSizeBytes(event: DevToolsEvent): number {
  try {
    const json = JSON.stringify(event);
    if (typeof json !== "string") {
      return Number.POSITIVE_INFINITY;
    }

    return new TextEncoder().encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isValidDevToolsEvent(event: unknown): event is DevToolsEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const candidate = event as DevToolsEvent;

  if (typeof candidate.type !== "string" || !ALLOWED_EVENT_TYPES.has(candidate.type)) {
    return false;
  }

  if (typeof candidate.busId !== "string" || candidate.busId.length === 0 || candidate.busId.length > 128) {
    return false;
  }

  if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp)) {
    return false;
  }

  if (getEventSizeBytes(candidate) > MAX_MESSAGE_SIZE) {
    return false;
  }

  return true;
}

function getBatchFromMessageData(data: unknown): unknown[] | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const envelope = data as Record<string, unknown>;

  if (envelope.source === CURRENT_BATCH_SOURCE && Array.isArray(envelope.events)) {
    return envelope.events;
  }

  return null;
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) {
    return;
  }

  const batch = getBatchFromMessageData(event.data);
  if (!batch) {
    return;
  }

  for (const item of batch) {
    if (!isValidDevToolsEvent(item)) {
      continue;
    }

    try {
      chrome.runtime.sendMessage(item);
    } catch {
      // Extension context may be invalidated (e.g. extension reload).
    }
  }
});

// Signal the background that this page (re)loaded so stale bus entries are cleared.
try {
  chrome.runtime.sendMessage({ type: "__PAGE_RESET__" });
} catch {
  // Extension context may be invalidated.
}

injectPageScript();
