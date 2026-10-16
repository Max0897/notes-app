import {HocuspocusProvider, HocuspocusProviderWebsocket} from '@hocuspocus/provider';
import * as Y from 'yjs';
import type {Note, User} from './api';
import {DraftStore, encodeUpdate, decodeUpdate} from './drafts';
import {EDITOR_CAPABILITY} from '../server/editorVersion.js';

export type Collaborator = User & {name: string; color: string; editing?: boolean};
export type CollaborationState = {
  connected: boolean; synced: boolean; canEdit: boolean; error: string; saved: boolean;
  me: Collaborator; members: Collaborator[]; note?: Omit<Note, 'content' | 'plainText'>;
  recovered?: boolean; draftError?: boolean;
};
export const documentStamp = (doc: Y.Doc) => {
  const bytes = Y.encodeSnapshot(Y.snapshot(doc));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// The same session owns document sync, transient presence and durable save receipts.
export class CollaborationSession {
  readonly document = new Y.Doc();
  readonly provider: HocuspocusProvider;
  readonly socket: HocuspocusProviderWebsocket;
  state: CollaborationState;
  private savedStamp = '';
  private listeners = new Set<() => void>();
  private destroyed = false;
  private localChanges = false;
  private drafts: DraftStore;
  constructor(teamId: string, noteId: string, user: User, url: string, websocketOptions: Record<string, any> = {}, draftStore?: DraftStore) {
    this.state = {connected: false, synced: false, canEdit: false, error: '', saved: false,
      me: {...user, name: user.nickname || user.username, color: '#2563eb'}, members: []};
    this.drafts = draftStore ?? new DraftStore(user.id, teamId, noteId);
    for (const draft of this.drafts.read()) if (draft.yState) {
      try { Y.applyUpdate(this.document, decodeUpdate(draft.yState)); this.localChanges = true; this.state.recovered = true; }
      catch { this.state.draftError = true; }
    }
    this.socket = new HocuspocusProviderWebsocket({url, autoConnect: false, maxDelay: 5000, ...websocketOptions});
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket, name: `team:${teamId}:note:${noteId}`, document: this.document,
      token: EDITOR_CAPABILITY, flushDelay: 50,
      onStatus: ({status}) => { this.state.connected = status === 'connected'; this.publish(); },
      onDisconnect: () => { this.state.connected = false; this.publish(); },
      onSynced: ({state}) => {
        if (state) {
          this.state.synced = true;
          if (!this.state.canEdit && this.localChanges) { this.deny('编辑权限已变化，本地草稿尚未保存，请复制保留或丢弃草稿'); return; }
          this.requestReceipt();
        }
        this.publish();
      },
      onAuthenticated: ({scope}) => { this.state.canEdit = scope === 'read-write'; this.publish(); },
      onAuthenticationFailed: ({reason}) => this.deny(reason === 'permission-denied' ? '登录已失效或没有访问此备忘录的权限' : reason),
      onStateless: ({payload}) => {
        let message: any; try { message = JSON.parse(payload); } catch { return; }
        if (message.type === 'ready') {
          this.state.me = message.user; this.state.canEdit = message.canEdit;
          this.provider.setAwarenessField('user', message.user);
        } else if (message.type === 'permission') {
          this.state.canEdit = message.canEdit;
          if (!message.canEdit) { this.provider.setAwarenessField('editing', false); this.provider.setAwarenessField('cursor', null); }
          if (!message.canEdit && this.localChanges) { this.deny('编辑权限已变化，本地草稿尚未保存，请复制保留或丢弃草稿'); return; }
        } else if (message.type === 'saved') {
          this.savedStamp = message.stamp;
          if (!this.state.note || message.note.version >= this.state.note.version) this.state.note = message.note;
        } else if (message.type === 'denied') { this.deny(message.message); return; }
        this.publish();
      },
      onUnsyncedChanges: () => this.publish(),
      onAwarenessChange: () => this.publish(),
    });
    this.document.on('update', (_update, origin, _doc, transaction) => {
      if (transaction.local && origin !== this.provider) this.localChanges = true;
      if (this.localChanges) this.state.draftError = !this.drafts.write({yState: encodeUpdate(Y.encodeStateAsUpdate(this.document))});
      this.publish();
    });
    this.provider.setAwarenessField('user', this.state.me);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() {
    if (this.destroyed) return;
    const saved = this.savedStamp === documentStamp(this.document) && !this.provider?.hasUnsyncedChanges;
    this.state.saved = this.state.synced && saved;
    if (this.state.saved) { this.localChanges = false; this.drafts.clear(); }
    const users = new Map<string, Collaborator>();
    if (this.state.connected) for (const state of this.provider?.awareness?.getStates().values() ?? []) {
      const user = state.user;
      if (!user?.id || !user.username || !/^#[a-f\d]{6}$/i.test(user.color)) continue;
      const previous = users.get(user.id);
      users.set(user.id, {...user, editing: !!previous?.editing || state.editing === true});
    }
    this.state = {...this.state, members: [...users.values()].sort((a, b) => a.id.localeCompare(b.id))};
    this.listeners.forEach(listener => listener());
  }
  start() { this.provider.attach(); void this.socket.connect().catch(() => {}); }
  private requestReceipt() {
    if (!this.state.connected || this.state.error) return;
    this.provider.flushPendingUpdates();
    this.provider.sendStateless(JSON.stringify({type: 'flush', requestId: String(Date.now())}));
  }
  private deny(message: string) {
    this.state.error = message; this.state.canEdit = false; this.state.connected = false;
    this.socket.disconnect(); this.publish();
  }
  hasChanges() { return this.localChanges; }
  discardDraft() { this.drafts.clear(); this.localChanges = false; }
  async flush(): Promise<boolean> {
    if (this.state.error) return !this.localChanges;
    if (!this.state.connected || !this.state.synced) return !this.localChanges && this.state.synced;
    this.requestReceipt();
    if (this.state.saved) return true;
    return new Promise(resolve => {
      const finish = (value: boolean) => { clearTimeout(timer); unsubscribe(); resolve(value); };
      const unsubscribe = this.subscribe(() => {
        if (this.state.saved) finish(true);
        else if (this.state.error || !this.state.connected) finish(false);
      });
      const timer = setTimeout(() => finish(false), 8000);
    });
  }
  setEditing(editing: boolean) {
    this.provider.setAwarenessField('editing', editing && this.state.canEdit);
  }
  destroy() {
    this.destroyed = true; this.listeners.clear();
    this.provider.destroy(); this.socket.destroy(); this.document.destroy();
  }
}
