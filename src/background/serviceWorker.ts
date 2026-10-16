// MV3 service worker. Deliberately minimal: it only wires the toolbar button to the side panel.
// Scans are coordinated by the side panel page itself, because the service worker can be
// suspended at any time and must not own long-running work.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
    console.warn('[Album Person Finder] could not set side panel behavior', err);
  });
});

// Also apply on browser startup in case the setting was not persisted.
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});
