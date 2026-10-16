// Bounded retry with exponential backoff and abort support.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  signal?: AbortSignal;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (attempt: number, err: unknown) => void;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError';
}

/** Network errors, 408, 429 and 5xx are retried; other HTTP errors and aborts are not. */
export function defaultRetryable(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch() network failure
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? defaultRetryable;
  const sleep = opts.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !isRetryable(err) || opts.signal?.aborted) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(opts.baseDelayMs * 2 ** attempt, opts.signal);
    }
  }
}
