// Content script for photos.google.com. It only reads the DOM and scrolls the album grid; it never
// clicks controls, so it cannot delete, share or edit anything.
import { readAlbumTitle, collectAlbumPhotos } from '../adapter/googlePhotosDom';
import { albumIdentity, parseAlbumLocation } from '../adapter/googlePhotosUrls';
import { CONTENT_VERSION, ContentRequest, PageInfo, StepResult } from '../shared/messages';
import { DiscoverySession, defaultEnv } from './discoverySession';
import { diagnoseDom, scrollProbe } from './domDiagnostics';

declare global {
  interface Window {
    /** Set by a live copy of this script; returns false once that copy's extension context is gone. */
    __albumPersonFinderAlive?: () => boolean;
  }
}

function pageInfo(): PageInfo {
  const loc = parseAlbumLocation(location.href);
  return {
    contentVersion: CONTENT_VERSION,
    album: loc?.album ?? null,
    photoId: loc?.photoId ?? null,
    title: loc ? readAlbumTitle(document) : null,
    visible: document.visibilityState !== 'hidden',
    tilesInDom: loc ? collectAlbumPhotos(document, loc.album, location.href).photos.length : 0,
  };
}

let session: DiscoverySession | null = null;

async function handle(msg: ContentRequest): Promise<unknown> {
  switch (msg.type) {
    case 'apf:getPageInfo':
      return pageInfo();
    case 'apf:discoveryStart': {
      session?.stop(false);
      session = null;
      const loc = parseAlbumLocation(location.href);
      if (!loc || albumIdentity(loc.album) !== msg.albumIdentity) {
        return { ok: false, reason: 'album-changed' } satisfies StepResult;
      }
      session = new DiscoverySession(loc.album, defaultEnv());
      return session.start();
    }
    case 'apf:discoveryStep': {
      if (!session || albumIdentity(session.album) !== msg.albumIdentity) {
        return { ok: false, reason: 'no-session' } satisfies StepResult;
      }
      return session.step();
    }
    case 'apf:discoveryStop':
      session?.stop(msg.restoreScroll);
      session = null;
      return { ok: true };
    case 'apf:diagnoseDom':
      return diagnoseDom(document, location.href, window.devicePixelRatio);
    case 'apf:scrollProbe':
      return scrollProbe(document, location.href);
    case 'apf:sampleImageUrls': {
      const loc = parseAlbumLocation(location.href);
      if (!loc) return [];
      const photos = collectAlbumPhotos(document, loc.album, location.href).photos;
      return photos.flatMap((p) => (p.thumbnailUrl ? [p.thumbnailUrl] : [])).slice(0, Math.min(10, msg.max));
    }
  }
}

// Guard against double registration when the side panel injects this script into a tab that
// already has a live copy. A copy orphaned by an extension reload reports itself as not alive.
if (!window.__albumPersonFinderAlive?.()) {
  window.__albumPersonFinderAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string' || !msg.type.startsWith('apf:')) return;
    handle(msg).then(sendResponse, (err: unknown) => sendResponse({ error: String(err) }));
    return true;
  });
}
