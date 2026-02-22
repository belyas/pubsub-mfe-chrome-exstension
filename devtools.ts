type RuntimePort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
  };
};

type ExtensionPanel = {
  onShown: {
    addListener(listener: (window: Window) => void): void;
  };
  onHidden: {
    addListener(listener: () => void): void;
  };
};

declare const chrome: {
  runtime: {
    connect(connectInfo: { name: string }): RuntimePort;
  };
  devtools: {
    inspectedWindow: {
      tabId: number;
    };
    panels: {
      create(
        title: string,
        iconPath: string | null,
        pagePath: string,
        callback: (panel: ExtensionPanel) => void
      ): void;
    };
  };
};

const PANEL_INIT_EVENT = "__PUBSUB_PANEL_INIT__";
const PANEL_EVENT = "__PUBSUB_PANEL_EVENT__";
const MAX_PENDING_BUFFER = 200;

const PAGE_RESET_TYPE = "__PAGE_RESET__";

let panelWindow: Window | null = null;
let panelPort: RuntimePort | null = null;
const pendingMessages: unknown[] = [];

function sendToPanel(message: unknown): void {
  if (!panelWindow) {
    // Buffer messages until the panel is shown, so we don't lose
    // events (like BUS_DETECTED) that arrive before onShown fires.
    if (pendingMessages.length < MAX_PENDING_BUFFER) {
      pendingMessages.push(message);
    }
    return;
  }

  panelWindow.postMessage(
    {
      type: PANEL_EVENT,
      data: message,
    },
    "*"
  );
}

function flushPendingMessages(): void {
  if (!panelWindow) {
    return;
  }

  while (pendingMessages.length > 0) {
    const message = pendingMessages.shift();
    panelWindow.postMessage(
      {
        type: PANEL_EVENT,
        data: message,
      },
      "*"
    );
  }
}

function connectToBackground(tabId: number): RuntimePort {
  const port = chrome.runtime.connect({ name: String(tabId) });

  port.onMessage.addListener((message) => {
    // On page reset, drop any stale buffered events so we only
    // forward buses that exist on the new page.
    if (
      message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).type === PAGE_RESET_TYPE
    ) {
      pendingMessages.length = 0;
    }

    sendToPanel(message);
  });

  port.onDisconnect.addListener(() => {
    if (panelPort === port) {
      panelPort = null;
    }
  });

  return port;
}

chrome.devtools.panels.create("PubSub", null, "panel.html", (panel) => {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  panelPort = connectToBackground(tabId);

  panel.onShown.addListener((windowRef) => {
    panelWindow = windowRef;

    panelWindow.postMessage(
      {
        type: PANEL_INIT_EVENT,
        tabId,
      },
      "*"
    );

    // Flush any events that arrived before the panel was shown
    // (e.g. BUS_DETECTED events from the background buffer).
    flushPendingMessages();
  });

  panel.onHidden.addListener(() => {
    panelWindow = null;
  });
});

window.addEventListener("beforeunload", () => {
  if (!panelPort) {
    return;
  }

  try {
    panelPort.disconnect();
  } catch {
    // Ignore disconnect failures during teardown.
  }

  panelPort = null;
});

export {};
