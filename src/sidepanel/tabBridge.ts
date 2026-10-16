// Messaging from the side panel to the content script in a specific tab. If the tab was opened
// before the extension was installed/reloaded, the content script is injected on demand
// (requires the "scripting" permission and photos.google.com host access).
import type { ContentRequest, ContentResponse } from '../shared/messages';
import type { DiscoveryPort } from './scanController';

function isMissingReceiver(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

export async function sendToTab<T extends ContentRequest['type']>(
  tabId: number,
  msg: Extract<ContentRequest, { type: T }>,
): Promise<ContentResponse<T>> {
  const send = async () => {
    const res = (await chrome.tabs.sendMessage(tabId, msg)) as ContentResponse<T> | { error: string } | undefined;
    if (res === undefined) throw new Error('no response from page script');
    if (typeof res === 'object' && res && 'error' in res && typeof (res as { error: unknown }).error === 'string') {
      throw new Error((res as { error: string }).error);
    }
    return res as ContentResponse<T>;
  };
  try {
    return await send();
  } catch (err) {
    if (!isMissingReceiver(err)) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return send();
  }
}

export function discoveryPort(tabId: number): DiscoveryPort {
  return {
    start: (albumIdentity) => sendToTab(tabId, { type: 'apf:discoveryStart', albumIdentity }),
    step: (albumIdentity) => sendToTab(tabId, { type: 'apf:discoveryStep', albumIdentity }),
    stop: async (restoreScroll) => {
      await sendToTab(tabId, { type: 'apf:discoveryStop', restoreScroll });
    },
  };
}
