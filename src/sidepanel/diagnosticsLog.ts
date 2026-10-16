// Bounded, in-memory event log for the diagnostics section. Callers must not pass image data,
// full URLs or photo ids; `scrub` masks anything URL-shaped as a safety net.

export type LogCategory = 'dom' | 'image' | 'model' | 'scan' | 'ui';

export interface LogEntry {
  t: number;
  category: LogCategory;
  message: string;
}

const MAX_ENTRIES = 300;

export function scrub(message: string): string {
  return message.replace(/https?:\/\/[^\s)"']+/g, (u) => {
    try {
      return `<${new URL(u).host} url>`;
    } catch {
      return '<url>';
    }
  });
}

export class DiagnosticsLog {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();

  add(category: LogCategory, message: string): void {
    this.entries.push({ t: Date.now(), category, message: scrub(message).slice(0, 500) });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.listeners.forEach((l) => l());
  }

  list(): readonly LogEntry[] {
    return this.entries;
  }

  onChange(l: () => void): void {
    this.listeners.add(l);
  }

  clear(): void {
    this.entries = [];
    this.listeners.forEach((l) => l());
  }
}
