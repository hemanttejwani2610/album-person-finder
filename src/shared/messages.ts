// Message contracts between the side panel and the content script.
import type { AlbumRef } from '../adapter/googlePhotosUrls';
import type { DiscoveredPhoto } from '../adapter/googlePhotosDom';

export interface PageInfo {
  /** Content script build marker, used to detect stale scripts after an extension reload. */
  contentVersion: string;
  album: AlbumRef | null;
  /** Non-null when the tab shows a single photo rather than the album grid. */
  photoId: string | null;
  title: string | null;
  visible: boolean;
  tilesInDom: number;
}

export interface StepOk {
  ok: true;
  /** Photos that are new, or that gained a thumbnail URL since they were last reported. */
  photos: DiscoveredPhoto[];
  scrolled: boolean;
  atEnd: boolean;
  visible: boolean;
  tilesInDom: number;
  anchorsSeen: number;
  otherAlbumLinks: number;
  withoutThumbnail: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type StepFailureReason = 'album-changed' | 'photo-view' | 'no-session';

export interface StepFailed {
  ok: false;
  reason: StepFailureReason;
}

export type StepResult = StepOk | StepFailed;

export interface DomDiagnostics {
  url: { isAlbum: boolean; kind: string | null; isPhotoView: boolean };
  title: string | null;
  anchorsTotal: number;
  photoLinksThisAlbum: number;
  photoLinksOtherAlbums: number;
  tilesWithImageUrl: number;
  tilesWithoutImageUrl: number;
  imageHosts: Record<string, number>;
  /** Image URLs reduced to scheme+host+path shape, with long tokens masked. */
  sampleImageUrlShapes: string[];
  /** Whether image URLs end with a size suffix like "=w123-h456…" (observed, not assumed). */
  sizeSuffixObserved: number;
  tileDisplaySizes: { minW: number; maxW: number; medianW: number; medianH: number } | null;
  devicePixelRatio: number;
  scroll: {
    container: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    isDocumentScroller: boolean;
  };
  sampleTiles: Array<{ index: number; hasImage: boolean; w: number; h: number }>;
}

export type ContentRequest =
  | { type: 'apf:getPageInfo' }
  | { type: 'apf:discoveryStart'; albumIdentity: string }
  | { type: 'apf:discoveryStep'; albumIdentity: string }
  | { type: 'apf:discoveryStop'; restoreScroll: boolean }
  | { type: 'apf:diagnoseDom' }
  | { type: 'apf:scrollProbe' }
  /** Raw image URLs of a few rendered tiles, used in memory by the image-access probes only. */
  | { type: 'apf:sampleImageUrls'; max: number };

export interface ScrollProbeResult {
  container: string;
  before: { scrollTop: number; tiles: number; keys: number };
  after: { scrollTop: number; tiles: number; keys: number };
  newKeysAfterScroll: number;
  keysThatLeftDom: number;
  restored: boolean;
}

export type ContentResponse<T extends ContentRequest['type']> = T extends 'apf:getPageInfo'
  ? PageInfo
  : T extends 'apf:discoveryStart'
    ? StepResult
    : T extends 'apf:discoveryStep'
      ? StepResult
      : T extends 'apf:discoveryStop'
        ? { ok: true }
        : T extends 'apf:diagnoseDom'
          ? DomDiagnostics
          : T extends 'apf:scrollProbe'
            ? ScrollProbeResult
            : T extends 'apf:sampleImageUrls'
              ? string[]
              : never;

export const CONTENT_VERSION = '0.1.0';
