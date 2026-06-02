"use strict";

const STORAGE_KEYS = {
  SETTINGS: "pageRestorerSettings",
  SNAPSHOTS: "pageRestorerSnapshots",
  PREVIOUS_URL: "pageRestorerPreviousUrl"
};

const DEFAULT_SETTINGS = {
  enabled: true,
  snapshotTtlMs: 10_000,
  maxSnapshots: 8,
  maxHtmlChars: 1_500_000,
  maxInlineStyleChars: 650_000,
  mutationDebounceMs: 250,
  mutationMaxWaitMs: 750,
  urlPollMs: 100
};

const enabledToggle = document.getElementById("enabledToggle");
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const previousUrlEl = document.getElementById("previousUrl");
const savedAtEl = document.getElementById("savedAt");
const snapshotSizeEl = document.getElementById("snapshotSize");
const messageBox = document.getElementById("messageBox");
const restoreButton = document.getElementById("restoreButton");

let activeTabId = null;

function formatTime(timestamp) {
  if (!timestamp) return "—";

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    year: "numeric",
    month: "short",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function formatBytes(chars) {
  if (!chars || chars <= 0) return "—";

  const bytes = chars * 2;

  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setStatus(type, text) {
  statusPill.className = "status-pill";

  if (type === "good") statusPill.classList.add("good");
  if (type === "bad") statusPill.classList.add("bad");

  statusText.textContent = text;
}

function setMessage(type, text) {
  messageBox.className = "message";

  if (type === "good") messageBox.classList.add("good");
  if (type === "bad") messageBox.classList.add("bad");

  messageBox.textContent = text;
}

async function getSettings() {
  const data = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);

  return {
    ...DEFAULT_SETTINGS,
    ...(data[STORAGE_KEYS.SETTINGS] || {})
  };
}

async function saveSettings(settings) {
  await browser.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: {
      ...DEFAULT_SETTINGS,
      ...settings
    }
  });
}

function pruneSnapshots(snapshots, ttlMs) {
  const currentTime = Date.now();

  return Object.fromEntries(
    Object.entries(snapshots || {}).filter(([, snapshot]) => {
      const timestamp = Number(snapshot?.timestamp || 0);
      return timestamp > 0 && currentTime - timestamp <= ttlMs;
    })
  );
}

async function getStorageStatus() {
  const settings = await getSettings();

  const data = await browser.storage.local.get([
    STORAGE_KEYS.SNAPSHOTS,
    STORAGE_KEYS.PREVIOUS_URL
  ]);

  const snapshots = pruneSnapshots(
    data[STORAGE_KEYS.SNAPSHOTS] || {},
    settings.snapshotTtlMs
  );

  const previousUrl = data[STORAGE_KEYS.PREVIOUS_URL] || null;
  const previousSnapshot = previousUrl ? snapshots[previousUrl] : null;

  await browser.storage.local.set({
    [STORAGE_KEYS.SNAPSHOTS]: snapshots
  });

  return {
    enabled: Boolean(settings.enabled),
    ttlMs: settings.snapshotTtlMs,
    previousUrl,
    hasPreviousSnapshot: Boolean(previousSnapshot),
    timestamp: previousSnapshot?.timestamp || null,
    title: previousSnapshot?.title || "",
    length: previousSnapshot?.length || 0,
    styleCount: previousSnapshot?.styleCount || 0
  };
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0] || null;
}

async function askContentScriptForStatus() {
  if (!activeTabId) {
    throw new Error("No active tab.");
  }

  return browser.tabs.sendMessage(activeTabId, {
    type: "PAGE_RESTORER_GET_STATUS"
  });
}

async function restoreViaContentScript() {
  if (!activeTabId) {
    throw new Error("No active tab.");
  }

  return browser.tabs.sendMessage(activeTabId, {
    type: "PAGE_RESTORER_RESTORE_PREVIOUS"
  });
}

function render(status) {
  enabledToggle.checked = Boolean(status.enabled);

  previousUrlEl.textContent = status.previousUrl || "—";
  savedAtEl.textContent = formatTime(status.timestamp);

  const styleText =
    status.styleCount && status.styleCount > 0
      ? ` · ${status.styleCount} style source(s)`
      : "";

  snapshotSizeEl.textContent = `${formatBytes(status.length)}${styleText}`;

  if (!status.enabled) {
    setStatus("bad", "Disabled");
    setMessage("bad", "Rewind is turned off globally.");
    restoreButton.disabled = true;
    return;
  }

  if (status.hasPreviousSnapshot) {
    setStatus("good", "Styled snapshot ready");
    setMessage(
      "good",
      "A recent previous-page snapshot is available. It includes cached stylesheets and will restore as a native fullscreen overlay."
    );
    restoreButton.disabled = false;
    return;
  }

  setStatus("neutral", "No snapshot");
  setMessage(
    "neutral",
    "No valid previous-page snapshot exists yet, or the short TTL expired."
  );
  restoreButton.disabled = true;
}

async function refreshPopup() {
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;

  let status = await getStorageStatus();

  if (activeTabId) {
    try {
      const liveStatus = await askContentScriptForStatus();
      status = {
        ...status,
        ...liveStatus
      };
    } catch {
      // Content scripts cannot run on about:, addons.mozilla.org, extension pages, etc.
    }
  }

  render(status);
}

enabledToggle.addEventListener("change", async () => {
  const settings = await getSettings();

  await saveSettings({
    ...settings,
    enabled: enabledToggle.checked
  });

  await refreshPopup();
});

restoreButton.addEventListener("click", async () => {
  restoreButton.disabled = true;

  try {
    const response = await restoreViaContentScript();

    if (response?.ok) {
      const styleText =
        response.styleCount && response.styleCount > 0
          ? `${response.styleCount} cached style source(s)`
          : "cached styles";

      const fallbackText =
        response.fallbackCount && response.fallbackCount > 0
          ? `, ${response.fallbackCount} fallback item(s)`
          : "";

      const qualityText =
        typeof response.qualityScore === "number"
          ? `, quality ${response.qualityScore}`
          : "";

      setStatus("good", "Restored");
      setMessage(
        "good",
        `Restored previous state with ${styleText}${fallbackText}${qualityText}. If native SPA HTML fails, the clickable recovery grid will appear automatically.`
      );
    } else {
      setStatus("bad", "Restore failed");
      setMessage("bad", response?.reason || "Could not restore the previous state.");
    }
  } catch {
    setStatus("bad", "Restore failed");
    setMessage(
      "bad",
      "Could not inject the restore overlay into this tab. Try opening a normal http/https page first."
    );
  } finally {
    await refreshPopup();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  refreshPopup().catch((error) => {
    setStatus("bad", "Error");
    setMessage("bad", `Popup failed to initialize: ${String(error)}`);
  });
});