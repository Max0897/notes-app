import {createHash} from 'node:crypto';
import type {Server as HttpServer} from 'node:http';
import {Hocuspocus, type Connection} from '@hocuspocus/server';
import {WebSocketServer} from 'ws';
import * as Y from 'yjs';
import {getSchema} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import {prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON} from 'y-prosemirror';
import * as decoding from 'lib0/decoding';
import type Database from 'better-sqlite3';

type User = {id: string; username: string; nickname: string; avatarStyle: 'cutouts'; avatarSeed: string};
type Identity = {user: User; sessionHash: string; clientId?: number; color?: string; count?: number; until?: number};
type Row = Record<string, any>;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const roomPattern = new RegExp(`^team:(${uuid}):note:(${uuid})$`, 'i');
const colors = ['#2563eb', '#dc2626', '#059669', '#9333ea', '#d97706', '#0891b2', '#db2777', '#4f46e5', '#65a30d', '#c2410c', '#0f766e', '#7c3aed'];
// 与浏览器编辑器使用同一套节点；链接不引入不被 API 接受的 class 属性。
const schema = getSchema([StarterKit.configure({history: false}), TaskList, TaskItem.configure({nested: true}), Link.extend({
  addAttributes() { const {class: _class, ...attrs} = (this.parent?.() ?? {}) as Record<string, any>; return attrs; },
}), Image.extend({addAttributes() { return {...this.parent?.(), imageId: {default: null}, width: {default: null}}; }})]);
const stamp = (doc: Y.Doc) => Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64');

export function createRealtime(db: Database.Database, options: {
  cookieName: string; publicOrigin: string; validateContent: (value: unknown) => Record<string, unknown>;
  validateImages?: (value: unknown, spaceId: string, userId: string, noteId?: string) => void;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_documents (
    note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    state BLOB NOT NULL, updated_at TEXT NOT NULL
  )`);
  // This shadow includes accepted updates whose async Hocuspocus hooks may still be
  // completing. Validation and durable writes are synchronous, including across peers.
  const accepted = new Map<string, Y.Doc>();
  const claims = new Map<string, Map<number, string>>();
  const roomColors = new Map<string, Map<string, string>>();
  const sent = new WeakMap<Connection, string>();
  function denied(message = '备忘录不存在或访问权限已变化'): never { throw {code: 4403, reason: message}; }
  function session(cookie: string | null): Identity {
    const token = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(options.cookieName + '='))?.slice(options.cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) denied('登录已失效，请重新登录');
    const sessionHash = createHash('sha256').update(token).digest('hex');
    const user = db.prepare(`SELECT u.id,u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname,'cutouts' AS avatarStyle,COALESCE(a.seed,u.id) AS avatarSeed
      FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN user_avatars a ON a.user_id=u.id
      WHERE s.token_hash=? AND s.expires_at>?`).get(sessionHash, Date.now()) as User | undefined;
    if (!user) denied('登录已失效，请重新登录');
    return {user, sessionHash};
  }
  function access(name: string, identity: Identity) {
    const match = name.match(roomPattern);
    if (!match) denied();
    const row = db.prepare(`SELECT n.*,m.role,f.access_mode,f.deleted_at AS folder_deleted,
      (SELECT permission FROM folder_access WHERE folder_id=n.folder_id AND user_id=?) AS permission
      FROM notes n JOIN teams t ON t.id=n.space_id JOIN team_members m ON m.team_id=t.id AND m.user_id=?
      LEFT JOIN folders f ON f.id=n.folder_id AND f.space_id=t.id
      WHERE t.id=? AND n.id=? AND t.deleted_at IS NULL AND n.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?)`)
      .get(identity.user.id, identity.user.id, match[1], match[2], identity.sessionHash, identity.user.id, Date.now()) as Row | undefined;
    if (!row || row.folder_deleted) denied();
    const manager = row.role === 'owner' || row.role === 'admin';
    if (!manager && row.access_mode === 'restricted' && !row.permission) denied();
    const canEdit = manager || row.role === 'editor' && (row.access_mode !== 'restricted' || row.permission === 'edit');
    return {row, canEdit, canManage: manager};
  }
  function identityInfo(identity: Identity) {
    return {...identity.user, name: identity.user.nickname || identity.user.username, color: identity.color};
  }
  function chooseColor(name: string, identity: Identity) {
    let reserved = roomColors.get(name);
    if (!reserved) { reserved = new Map(); roomColors.set(name, reserved); }
    if (reserved.has(identity.user.id)) return reserved.get(identity.user.id)!;
    const used = new Set(reserved.values());
    const start = parseInt(createHash('sha256').update(identity.user.id).digest('hex').slice(0, 8), 16) % colors.length;
    for (let i = 0; i < colors.length; i++) if (!used.has(colors[(start + i) % colors.length])) {
      const color = colors[(start + i) % colors.length]; reserved.set(identity.user.id, color); return color;
    }
    let extra = parseInt(createHash('sha256').update(identity.user.id).digest('hex').slice(0, 6), 16);
    while (used.has('#' + extra.toString(16).padStart(6, '0'))) extra = (extra + 123457) % 0x1000000;
    const color = '#' + extra.toString(16).padStart(6, '0'); reserved.set(identity.user.id, color); return color;
  }
  function dto(row: Row, permission: {canEdit: boolean; canManage: boolean}) {
    const author = db.prepare("SELECT COALESCE(NULLIF(nickname,''),username) AS username FROM users WHERE id=?").get(row.updated_by ?? row.user_id) as Row | undefined;
    return {id: row.id, title: row.title,
      folderId: row.folder_id, pinned: !!row.pinned, deletedAt: row.deleted_at, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, modifiedBy: author?.username ?? '团队成员', ...permission};
  }
  function content(doc: Y.Doc) {
    if ([...doc.share.keys()].some(key => key !== 'default' && key !== 'title')) denied('协作文档字段无效');
    const title = doc.getText('title').toString();
    if (title.length > 200) denied('标题不能超过 200 字');
    const json = yDocToProsemirrorJSON(doc, 'default');
    options.validateContent(json);
    const node = schema.nodeFromJSON(json); node.check();
    return {title, json, plainText: node.textBetween(0, node.content.size, '\n\n', '\n')};
  }
  function persist(name: string, doc: Y.Doc, actor?: string) {
    const noteId = name.match(roomPattern)![2];
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    if (state.length > 4 * 1024 * 1024) denied('协作文档过大');
    const value = content(doc), json = JSON.stringify(value.json), now = new Date().toISOString();
    db.transaction(() => {
      const row = db.prepare('SELECT * FROM notes WHERE id=?').get(noteId) as Row | undefined;
      if (!row) denied();
      options.validateImages?.(value.json, row.space_id, actor ?? row.updated_by, noteId);
      db.prepare(`INSERT INTO collaboration_documents VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`).run(noteId, state, now);
      if (row.title !== value.title || row.content !== json) {
        db.prepare('UPDATE notes SET title=?,content=?,plain_text=?,version=version+1,updated_at=?,updated_by=? WHERE id=?')
          .run(value.title, json, value.plainText, now, actor ?? row.updated_by, noteId);
        db.prepare('UPDATE teams SET revision=revision+1 WHERE id=?').run(row.space_id);
      }
    })();
  }
  function sendSaved(connection: Connection<Identity>, requestId?: string) {
    const state = accepted.get(connection.document.name);
    if (!state) return;
    try {
      const permission = access(connection.document.name, connection.context);
      const snapshot = stamp(state), key = snapshot + ':' + permission.row.version;
      if (!requestId && sent.get(connection) === key) return;
      sent.set(connection, key);
      connection.sendStateless(JSON.stringify({type: 'saved', requestId, stamp: snapshot, note: dto(permission.row, {canEdit: permission.canEdit, canManage: permission.canManage})}));
    } catch { revoke(connection); }
  }
  function revoke(connection: Connection<Identity>, message = '访问权限已变化，本地未保存内容仍保留') {
    connection.sendStateless(JSON.stringify({type: 'denied', message}));
    connection.close({code: 4403, reason: message});
  }
  function revalidate() {
    for (const document of instance.documents.values()) for (const connection of document.getConnections() as Connection<Identity>[]) {
      try {
        const permission = access(document.name, connection.context);
        const profile = db.prepare("SELECT u.id,u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname,'cutouts' AS avatarStyle,COALESCE(a.seed,u.id) AS avatarSeed FROM users u LEFT JOIN user_avatars a ON a.user_id=u.id WHERE u.id=?").get(connection.context.user.id) as User;
        if (JSON.stringify(profile) !== JSON.stringify(connection.context.user)) {
          connection.context.user = profile;
          connection.sendStateless(JSON.stringify({type: 'ready', user: identityInfo(connection.context), canEdit: permission.canEdit}));
          const clientId = connection.context.clientId, state = document.awareness.getStates().get(clientId!);
          if (state) {
            state.user = identityInfo(connection.context);
            const meta = document.awareness.meta.get(clientId!); if (meta) meta.clock++;
            document.awareness.emit('update', [{added: [], updated: [clientId], removed: []}, {source: 'local'}]);
          }
        }
        if (connection.readOnly !== !permission.canEdit) {
          connection.readOnly = !permission.canEdit;
          connection.sendStateless(JSON.stringify({type: 'permission', canEdit: permission.canEdit}));
          const clientId = connection.context.clientId;
          const state = clientId === undefined ? undefined : document.awareness.getStates().get(clientId);
          if (state && !permission.canEdit) {
            // Force a fresh server clock so peers immediately lose the editing cursor.
            state.cursor = null; state.editing = false;
            const meta = document.awareness.meta.get(clientId!);
            if (meta) meta.clock++;
            document.awareness.emit('update', [{added: [], updated: [clientId], removed: []}, {source: 'local'}]);
          }
        }
      } catch { revoke(connection); }
    }
  }
  const instance = new Hocuspocus<Identity>({
    quiet: true, timeout: 30000, debounce: 1000, maxDebounce: 3000,
    maxPendingDocuments: 1, maxUnauthenticatedQueueSize: 1024 * 1024, maxUnauthenticatedQueueMessages: 100,
    async onAuthenticate({documentName, requestHeaders, connectionConfig, token}) {
      // Older editors can strip image nodes or their persisted display width.
      // This is a schema capability marker; authentication still uses cookies.
      if (token !== 'notes-images-v2') denied('编辑器已更新，请刷新页面后重新打开');
      const identity = session(requestHeaders.get('cookie'));
      const permission = access(documentName, identity);
      connectionConfig.readOnly = !permission.canEdit;
      identity.color = chooseColor(documentName, identity);
      return identity;
    },
    async onLoadDocument({documentName, document, context}) {
      const {row} = access(documentName, context);
      const stored = db.prepare('SELECT state FROM collaboration_documents WHERE note_id=?').get(row.id) as {state: Buffer} | undefined;
      if (stored) Y.applyUpdate(document, stored.state);
      else {
        const seed = prosemirrorJSONToYDoc(schema, JSON.parse(row.content), 'default');
        seed.getText('title').insert(0, row.title);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seed)); seed.destroy();
        // Seed only on the server, once, before accepting any client edits.
        db.prepare('INSERT INTO collaboration_documents VALUES(?,?,?)').run(row.id, Buffer.from(Y.encodeStateAsUpdate(document)), new Date().toISOString());
      }
      const shadow = new Y.Doc(); Y.applyUpdate(shadow, Y.encodeStateAsUpdate(document));
      accepted.set(documentName, shadow); claims.set(documentName, new Map());
    },
    async connected({connection}) {
      const identity = connection.context;
      connection.sendStateless(JSON.stringify({type: 'ready', user: identityInfo(identity), canEdit: !connection.readOnly}));
      sendSaved(connection);
    },
    async beforeHandleMessage({connection, documentName, update}) {
      revalidate();
      access(documentName, connection.context);
      const context = connection.context, now = Date.now();
      if (!context.until || context.until < now) { context.until = now + 10000; context.count = 0; }
      if (++context.count! > 800 || update.length > 1024 * 1024) denied('操作过于频繁或消息过大');
    },
    async beforeSync({documentName, connection, type, payload}) {
      if (type === 0 || connection.readOnly) return;
      const permission = access(documentName, connection.context);
      if (!permission.canEdit) denied();
      const previous = accepted.get(documentName)!;
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(previous)); Y.applyUpdate(candidate, payload);
        // Validate and commit before Hocuspocus acknowledges/broadcasts the update.
        persist(documentName, candidate, connection.context.user.id);
        accepted.set(documentName, candidate); previous.destroy();
      } catch (error) {
        candidate.destroy();
        connection.sendStateless(JSON.stringify({type: 'denied', message: error instanceof Error ? error.message : (error as Row).reason ?? '协作内容无效，本地内容仍保留'}));
        throw error;
      }
    },
    async afterHandleMessage({document, update}) {
      const decoder = decoding.createDecoder(update); decoding.readVarString(decoder);
      const type = decoding.readVarUint(decoder);
      if (type === 0 || type === 4) for (const connection of document.getConnections() as Connection<Identity>[]) sendSaved(connection);
    },
    async beforeHandleAwareness({documentName, connection, states, removedClients}) {
      if (!connection) return;
      const context = connection.context, owners = claims.get(documentName)!;
      if (states.size > 1 || removedClients.size > 1) denied('在线状态无效');
      for (const clientId of [...states.keys(), ...removedClients]) {
        if (context.clientId !== undefined && context.clientId !== clientId || owners.has(clientId) && owners.get(clientId) !== connection.socketId) denied('不能修改其他成员的在线状态');
        context.clientId = clientId; owners.set(clientId, connection.socketId);
      }
      for (const [clientId, state] of states) {
        const validId = (value: any) => value && typeof value === 'object' && Number.isSafeInteger(value.client) && value.client >= 0 && Number.isSafeInteger(value.clock) && value.clock >= 0;
        const validPosition = (value: any) => value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).every(key => ['type', 'tname', 'item', 'assoc'].includes(key))
          && (validId(value.type) || value.tname === 'default') && (value.item == null || validId(value.item))
          && (value.assoc === undefined || Number.isSafeInteger(value.assoc) && Math.abs(value.assoc) <= 1);
        const cursor = !connection.readOnly && state.cursor && validPosition(state.cursor.anchor) && validPosition(state.cursor.head)
          ? {anchor: state.cursor.anchor, head: state.cursor.head} : null;
        if (JSON.stringify(cursor).length > 2048) denied('光标数据无效');
        states.set(clientId, {user: identityInfo(context), cursor, editing: !connection.readOnly && state.editing === true});
      }
    },
    async onStateless({connection, payload}) {
      if (payload.length > 256) return;
      try { const message = JSON.parse(payload); if (message.type === 'flush' && typeof message.requestId === 'string') sendSaved(connection, message.requestId); } catch { /* Ignore unknown messages. */ }
    },
    async onDisconnect({documentName, context, socketId}) {
      if (context.clientId !== undefined && claims.get(documentName)?.get(context.clientId) === socketId) claims.get(documentName)?.delete(context.clientId);
    },
    async afterUnloadDocument({documentName}) { accepted.get(documentName)?.destroy(); accepted.delete(documentName); claims.delete(documentName); roomColors.delete(documentName); },
  });
  const sockets = new WebSocketServer({noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false});
  function attach(server: HttpServer) {
    server.on('upgrade', (request, socket, head) => {
      try {
        if (request.url?.split('?')[0] !== '/api/collaboration') denied();
        const origin = request.headers.origin, host = request.headers.host;
        if (!origin || !host) denied();
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || (options.publicOrigin ? origin !== options.publicOrigin : url.host.toLowerCase() !== host.toLowerCase())) denied();
        session(request.headers.cookie ?? null);
        if (sockets.clients.size >= 200) denied('协作连接数已达上限，请稍后重试');
        sockets.handleUpgrade(request, socket, head, ws => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
          const peer = instance.handleConnection(ws, new Request('http://' + host + request.url, {headers}));
          ws.on('message', data => peer.handleMessage(new Uint8Array(data as Buffer)));
          ws.on('close', (code, reason) => peer.handleClose({code, reason: reason.toString()}));
          ws.on('pong', () => peer.touch()); ws.on('error', () => ws.terminate());
          sockets.emit('connection', ws, request);
        });
      } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
    });
  }
  const check = setInterval(revalidate, 1000); check.unref();
  function restore(teamId: string, noteId: string, actorId: string, title: string, json: Record<string, unknown>) {
    const name = `team:${teamId}:note:${noteId}`, live = instance.documents.get(name), previous = accepted.get(name);
    const candidate = new Y.Doc();
    try {
      const stored = db.prepare('SELECT state FROM collaboration_documents WHERE note_id=?').get(noteId) as {state: Buffer} | undefined;
      if (previous) Y.applyUpdate(candidate, Y.encodeStateAsUpdate(previous));
      else if (stored) Y.applyUpdate(candidate, stored.state);
      else {
        const row = db.prepare('SELECT title,content FROM notes WHERE id=?').get(noteId) as Row;
        const seed = prosemirrorJSONToYDoc(schema, JSON.parse(row.content), 'default'); seed.getText('title').insert(0, row.title);
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(seed)); seed.destroy();
      }
      candidate.transact(() => {
        const text = candidate.getText('title'); text.delete(0, text.length); text.insert(0, title);
        // Apply a new edit to the existing CRDT, retaining all client clocks.
        prosemirrorJSONToYXmlFragment(schema, json, candidate.getXmlFragment('default'));
      }, 'history-restore');
      persist(name, candidate, actorId);
      const update = Y.encodeStateAsUpdate(candidate);
      return () => {
        if (live && previous) {
          accepted.set(name, candidate); previous.destroy();
          Y.applyUpdate(live, update, 'history-restore');
          for (const connection of live.getConnections() as Connection<Identity>[]) sendSaved(connection);
        } else candidate.destroy();
      };
    } catch (error) { candidate.destroy(); throw error; }
  }
  return {attach, revalidate, restore, async close() {
    clearInterval(check); instance.closeConnections();
    for (const ws of sockets.clients) ws.terminate(); sockets.close();
    await instance.flushPendingStores();
    await Promise.all([...instance.documents.values()].map(document => instance.unloadDocument(document)));
  }};
}
