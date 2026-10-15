import type {Note} from './api';
export type Draft = {title?: string; content?: any; plainText?: string; baseVersion?: number; yState?: string; updatedAt: number};
type Entry = {key: string; raw: string; value: Draft};
// Scope every record by account, workspace, note and tab. Acknowledgements only
// remove the exact records that were recovered, preserving other live tabs.
export class DraftStore {
  private storage?: Storage;
  private prefix: string;
  private key: string;
  private recovered: Entry[] = [];
  constructor(userId: string, teamId: string | null | undefined, noteId: string, storage?: Storage, tabId?: string) {
    this.prefix = `notes:draft:v1:${userId}:${teamId ?? 'personal'}:${noteId}:`;
    const tab = tabId ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
    try {
      this.storage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    } catch { /* Private mode or storage policy can make persistence unavailable. */ }
    this.key = this.prefix + (tab ?? 'memory');
  }
  read(): Draft[] {
    const entries: Entry[] = [];
    try {
      for (let i = 0; i < (this.storage?.length ?? 0); i++) {
        const key = this.storage!.key(i); if (!key?.startsWith(this.prefix)) continue;
        const raw = this.storage!.getItem(key); if (!raw) continue;
        try {
          const value = JSON.parse(raw) as Draft;
          if (Number.isFinite(value.updatedAt) && (value.yState || value.content)) entries.push({key, raw, value});
        } catch { /* Ignore a corrupted record without deleting it. */ }
      }
    } catch { return []; }
    this.recovered = entries;
    return entries.sort((a, b) => b.value.updatedAt - a.value.updatedAt).map(entry => entry.value);
  }
  write(value: Omit<Draft, 'updatedAt'>) {
    try {
      if (!this.storage) return false;
      this.storage.setItem(this.key, JSON.stringify({...value, updatedAt: Date.now()})); return true;
    } catch { return false; }
  }
  clear() {
    try {
      this.storage?.removeItem(this.key);
      for (const entry of this.recovered) if (this.storage?.getItem(entry.key) === entry.raw) this.storage.removeItem(entry.key);
      this.recovered = [];
    } catch { /* Keep a recoverable record if deletion fails. */ }
  }
}
export const noteDraft = (note: Note) => ({title: note.title, content: note.content, plainText: note.plainText, baseVersion: note.version});
export function encodeUpdate(bytes: Uint8Array) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
export function decodeUpdate(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
