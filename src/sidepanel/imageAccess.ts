// Fetching album images from the extension page. host_permissions for *.googleusercontent.com
// let the side panel read the same image URLs the album page renders. Requests first go out
// without cookies; only if the image host refuses (401/403) is the request repeated with the
// browser's normal credentials, exactly as the page's own <img> load would be. Cookies are never
// read or extracted by the extension.
import { isAllowedImageHost, withLongEdge } from '../adapter/googlePhotosImages';
import { HttpError, withRetry } from '../shared/retry';
import { ProcessingError, SkipError } from './scanController';

export type CredentialMode = 'omit' | 'include';

export interface FetchedImage {
  blob: Blob;
  mode: CredentialMode;
  status: number;
}

export interface ImageAccessStats {
  ok: Record<CredentialMode, number>;
  httpErrors: Record<string, number>;
  networkErrors: number;
  retries: number;
}

export const imageAccessStats: ImageAccessStats = { ok: { omit: 0, include: 0 }, httpErrors: {}, networkErrors: 0, retries: 0 };

export function resetImageAccessStats(): void {
  imageAccessStats.ok = { omit: 0, include: 0 };
  imageAccessStats.httpErrors = {};
  imageAccessStats.networkErrors = 0;
  imageAccessStats.retries = 0;
}

const TIMEOUT_MS = 20000;

async function fetchOnce(url: string, mode: CredentialMode, signal: AbortSignal): Promise<FetchedImage> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    credentials: mode,
    signal: AbortSignal.any([signal, timeout]),
    referrerPolicy: 'no-referrer',
    cache: 'default',
  });
  if (!res.ok) {
    imageAccessStats.httpErrors[res.status] = (imageAccessStats.httpErrors[res.status] ?? 0) + 1;
    throw new HttpError(res.status);
  }
  const blob = await res.blob();
  return { blob, mode, status: res.status };
}

/** Fetches an image with bounded retries. Throws SkipError/ProcessingError with a category. */
export async function fetchImage(url: string, signal: AbortSignal, retries = 2): Promise<FetchedImage> {
  if (!isAllowedImageHost(url)) throw new SkipError('unsupported-image-host');
  const attempt = async (): Promise<FetchedImage> => {
    try {
      return await fetchOnce(url, 'omit', signal);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return fetchOnce(url, 'include', signal);
      throw err;
    }
  };
  try {
    const out = await withRetry(attempt, {
      retries,
      baseDelayMs: 600,
      signal,
      onRetry: () => imageAccessStats.retries++,
    });
    imageAccessStats.ok[out.mode]++;
    if (!out.blob.type.startsWith('image/') && out.blob.type !== '') throw new ProcessingError('image-access', `unexpected content type ${out.blob.type}`);
    return out;
  } catch (err) {
    if (err instanceof SkipError || err instanceof ProcessingError) throw err;
    if ((err as { name?: string })?.name === 'AbortError' && signal.aborted) throw err;
    if (err instanceof HttpError) throw new ProcessingError('image-access', `HTTP ${err.status}`);
    imageAccessStats.networkErrors++;
    throw new ProcessingError('image-access', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

export async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    throw new ProcessingError('image-decode', err instanceof Error ? err.message : String(err));
  }
}

export interface ImageProbe {
  index: number;
  ok: boolean;
  mode?: CredentialMode;
  contentType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
}

/** Fetches and decodes a few observed thumbnail URLs. Reports only sizes/status, never content. */
export async function probeImageAccess(urls: string[]): Promise<ImageProbe[]> {
  const out: ImageProbe[] = [];
  for (const [index, url] of urls.entries()) {
    try {
      const img = await fetchImage(url, new AbortController().signal, 0);
      const bmp = await decode(img.blob);
      out.push({ index, ok: true, mode: img.mode, contentType: img.blob.type, bytes: img.blob.size, width: bmp.width, height: bmp.height });
      bmp.close();
    } catch (err) {
      out.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export interface ResolutionProbe {
  tested: number;
  verified: boolean;
  samples: Array<{ index: number; observed?: string; resized?: string; error?: string }>;
}

/**
 * Tests, on the user's own album, whether requesting a larger size suffix really yields a larger
 * image. Only when every sample confirms it may the scan use larger images.
 */
export async function probeLargerImages(urls: string[], longEdge: number): Promise<ResolutionProbe> {
  const samples: ResolutionProbe['samples'] = [];
  let confirmations = 0;
  for (const [index, url] of urls.entries()) {
    const resizedUrl = withLongEdge(url, longEdge);
    if (!resizedUrl) {
      samples.push({ index, error: 'no recognisable size suffix in the observed URL' });
      continue;
    }
    try {
      const a = await decode((await fetchImage(url, new AbortController().signal, 0)).blob);
      const b = await decode((await fetchImage(resizedUrl, new AbortController().signal, 0)).blob);
      const grew = Math.max(b.width, b.height) > Math.max(a.width, a.height) * 1.2;
      if (grew) confirmations++;
      samples.push({ index, observed: `${a.width}×${a.height}`, resized: `${b.width}×${b.height}` });
      a.close();
      b.close();
    } catch (err) {
      samples.push({ index, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tested: urls.length, verified: urls.length > 0 && confirmations === urls.length, samples };
}

export interface UrlChoice {
  url: string;
  resized: boolean;
}

/** Picks the URL to fetch for a photo: the observed one, or a verified larger variant. */
export function chooseImageUrl(observed: string, largerImagesVerified: boolean, longEdge: number): UrlChoice {
  if (largerImagesVerified) {
    const resized = withLongEdge(observed, longEdge);
    if (resized) return { url: resized, resized: true };
  }
  return { url: observed, resized: false };
}
