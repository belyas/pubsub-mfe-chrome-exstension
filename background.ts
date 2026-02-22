const MAX_BUFFER_SIZE = 100;

type DevToolsEvent = {
  type: string;
  busId: string;
  timestamp: number;
  [key: string]: unknown;
};

type RuntimePort = {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onDisconnect: {
    addListener(listener: () => void): void;
  };
};

declare const chrome: {
  runtime: {
    onConnect: {
      addListener(callback: (port: RuntimePort) => void): void;
    };
    onMessage: {
      addListener(
        callback: (message: unknown, sender: { tab?: { id?: number } }) => void
      ): void;
    };
  };
  tabs: {
    onRemoved: {
      addListener(callback: (tabId: number) => void): void;
    };
  };
};

const connections = new Map<number, RuntimePort>();
const messageBuffers = new Map<number, DevToolsEvent[]>();

function pushToBuffer(tabId: number, message: DevToolsEvent): void {
  const buffer = messageBuffers.get(tabId) ?? [];
  buffer.push(message);

  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }

  messageBuffers.set(tabId, buffer);
}

function isValidDevToolsEvent(message: unknown): message is DevToolsEvent {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<DevToolsEvent>;

  return (
    typeof candidate.type === "string" &&
    typeof candidate.busId === "string" &&
    candidate.busId.length > 0 &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  );
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = Number.parseInt(port.name, 10);

  if (!Number.isInteger(tabId) || tabId < 0) {
    try {
      port.disconnect();
    } catch {
      // Ignore disconnect failures.
    }
    return;
  }

  connections.set(tabId, port);

  const buffered = messageBuffers.get(tabId) ?? [];
  for (const message of buffered) {
    try {
      port.postMessage(message);
    } catch {
      connections.delete(tabId);
      break;
    }
  }

  port.onDisconnect.addListener(() => {
    connections.delete(tabId);
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (typeof tabId !== "number") {
    return;
  }

  // Handle page reset: clear stale buffer and notify the panel.
  if (
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "__PAGE_RESET__"
  ) {
    messageBuffers.delete(tabId);

    const port = connections.get(tabId);
    if (port) {
      try {
        port.postMessage({ type: "__PAGE_RESET__" });
      } catch {
        connections.delete(tabId);
      }
    }

    return;
  }

  if (!isValidDevToolsEvent(message)) {
    return;
  }

  pushToBuffer(tabId, message);

  const port = connections.get(tabId);
  if (!port) {
    return;
  }

  try {
    port.postMessage(message);
  } catch {
    connections.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  connections.delete(tabId);
  messageBuffers.delete(tabId);
});

export {};
