import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {Hono, MiddlewareHandler} from 'hono';
import type {AppContext, AppEnv, JsonObject} from './index.js';
import {markdown, parseDocument, plainText} from './markdown.js';

type Row = Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function initNotebook(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS note_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, plain_text TEXT NOT NULL,
    actor_id TEXT REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(note_id,version)
  );
  CREATE INDEX IF NOT EXISTS note_history_note ON note_history(note_id,id DESC);
  CREATE TABLE IF NOT EXISTS note_comments (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, mentions TEXT NOT NULL,
    mention_ranges TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    thread_id TEXT REFERENCES note_comments(id) ON DELETE CASCADE,
    reply_to_id TEXT REFERENCES note_comments(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS note_comments_note ON note_comments(note_id,created_at);
  CREATE TRIGGER IF NOT EXISTS note_history_before_edit BEFORE UPDATE OF title,content ON notes
  WHEN (OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content) AND NOT EXISTS(
    SELECT 1 FROM note_history WHERE note_id=OLD.id AND actor_id=OLD.updated_by AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')
  ) BEGIN
    INSERT OR IGNORE INTO note_history(note_id,version,title,content,plain_text,actor_id,created_at)
      VALUES(OLD.id,OLD.version,OLD.title,OLD.content,OLD.plain_text,OLD.updated_by,OLD.updated_at);
    DELETE FROM note_history WHERE note_id=OLD.id AND id NOT IN(SELECT id FROM note_history WHERE note_id=OLD.id ORDER BY id DESC LIMIT 100);
  END;`);
  const columns = new Set((db.prepare('PRAGMA table_info(note_comments)').all() as {name: string}[]).map(column => column.name));
  if (!columns.has('mention_ranges')) db.exec("ALTER TABLE note_comments ADD COLUMN mention_ranges TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('thread_id')) db.exec('ALTER TABLE note_comments ADD COLUMN thread_id TEXT REFERENCES note_comments(id) ON DELETE CASCADE');
  if (!columns.has('reply_to_id')) db.exec('ALTER TABLE note_comments ADD COLUMN reply_to_id TEXT REFERENCES note_comments(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS note_comments_thread ON note_comments(note_id,thread_id,created_at,id)');
}

export function registerNotebook(app: Hono<AppEnv>, db: Database.Database, deps: {
  requireAuth: MiddlewareHandler<AppEnv>; requireLiveSession: (c: AppContext) => void;
  readBody: (c: AppContext, keys: readonly string[]) => Promise<JsonObject>;
  validateContent: (value: unknown) => JsonObject;
  validateImages: (value: unknown, spaceId: string, userId: string, noteId?: string) => void;
  ApiError: new (status: 400 | 401 | 403 | 404 | 409 | 429, message: string) => Error;
  restore: (teamId: string, noteId: string, actorId: string, title: string, content: JsonObject) => () => void;
}) {
  const {requireAuth, requireLiveSession, readBody, validateContent, ApiError} = deps;
  function fail(status: 400 | 403 | 404 | 409 | 429, message: string): never { throw new ApiError(status, message); }
  const uid = (c: AppContext) => c.get('user')!.id;
  const id = (value: unknown): string => typeof value === 'string' && uuid.test(value) ? value : fail(400, '资源编号无效');
  const space = (c: AppContext) => c.req.param('teamId') ? id(c.req.param('teamId')) : uid(c);
  function permission(userId: string, spaceId: string, folderId: string | null) {
    if (spaceId === userId) return {canEdit: true, canManage: true};
    const member = db.prepare(`SELECT m.role,f.access_mode,f.deleted_at,(SELECT permission FROM folder_access WHERE folder_id=f.id AND user_id=?) AS grant_mode
      FROM team_members m JOIN teams t ON t.id=m.team_id LEFT JOIN folders f ON f.id=? AND f.space_id=t.id
      WHERE m.team_id=? AND m.user_id=? AND t.deleted_at IS NULL`).get(userId, folderId, spaceId, userId) as Row | undefined;
    if (!member) fail(404, '备忘录不存在或无权访问');
    const canManage = ['owner', 'admin'].includes(member.role);
    if (!canManage && folderId && member.access_mode === 'restricted' && !member.grant_mode) fail(404, '备忘录不存在或无权访问');
    return {canEdit: !member.deleted_at && (canManage || member.role === 'editor' && (member.access_mode !== 'restricted' || member.grant_mode === 'edit')), canManage};
  }
  function note(c: AppContext, edit = false, noteId = c.req.param('id')): Row & {canEdit: boolean; canManage: boolean} {
    const row = db.prepare('SELECT * FROM notes WHERE id=? AND space_id=?').get(id(noteId), space(c)) as Row | undefined;
    if (!row) fail(404, '备忘录不存在');
    const rights = permission(uid(c), row.space_id, row.folder_id);
    if (edit && (!rights.canEdit || row.deleted_at)) fail(403, '此备忘录不可编辑');
    return {...row, ...rights};
  }
  function dto(row: Row) {
    const author = db.prepare("SELECT COALESCE(NULLIF(nickname,''),username) AS name FROM users WHERE id=?").get(row.updated_by ?? row.user_id) as Row;
    return {id: row.id, title: row.title, content: JSON.parse(row.content), plainText: row.plain_text, folderId: row.folder_id,
      pinned: !!row.pinned, deletedAt: row.deleted_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      canEdit: row.canEdit, canManage: row.canManage, modifiedBy: author?.name};
  }
  function checkpoint(row: Row) {
    db.prepare('INSERT OR IGNORE INTO note_history(note_id,version,title,content,plain_text,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.id, row.version, row.title, row.content, row.plain_text, row.updated_by ?? row.user_id, row.updated_at);
  }
  for (const prefix of ['/api/notes', '/api/teams/:teamId/notes']) {
    app.use(prefix + '/*', requireAuth);
    app.get(prefix + '/:id/history', c => {
      const row = note(c);
      const before = c.req.query('before') ? Number(c.req.query('before')) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before) || before < 1) fail(400, '分页编号无效');
      const rows = db.prepare(`SELECT h.id,h.version,h.title,h.created_at AS createdAt,COALESCE(NULLIF(u.nickname,''),u.username,'未知成员') AS author
        FROM note_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.note_id=? AND h.id<? ORDER BY h.id DESC LIMIT 31`).all(row.id, before) as Row[];
      return c.json({versions: rows.slice(0, 30), next: rows.length > 30 ? rows[29].id : null});
    });
    app.get(prefix + '/:id/history/:historyId', c => {
      const row = note(c);
      const h = db.prepare('SELECT * FROM note_history WHERE id=? AND note_id=?').get(c.req.param('historyId'), row.id) as Row | undefined;
      if (!h) fail(404, '历史版本不存在');
      return c.json({snapshot: {id: h.id, title: h.title, content: JSON.parse(h.content), plainText: h.plain_text, version: h.version, createdAt: h.created_at}});
    });
    app.post(prefix + '/:id/history/:historyId/restore', async c => {
      const body = await readBody(c, ['version']);
      let broadcast = () => {};
      const result = db.transaction(() => {
        requireLiveSession(c); const row = note(c, true);
        if (body.version !== row.version) fail(409, '备忘录已更新，请刷新历史记录后重试');
        const h = db.prepare('SELECT * FROM note_history WHERE id=? AND note_id=?').get(c.req.param('historyId'), row.id) as Row | undefined;
        if (!h) fail(404, '历史版本不存在');
        const content = validateContent(JSON.parse(h.content)); deps.validateImages(content, row.space_id, uid(c), row.id); checkpoint(row);
        if (row.space_id !== row.user_id) broadcast = deps.restore(row.space_id, row.id, uid(c), h.title, content);
        else db.prepare('UPDATE notes SET title=?,content=?,plain_text=?,version=version+1,updated_by=?,updated_at=? WHERE id=?')
          .run(h.title, JSON.stringify(content), plainText(content as any), uid(c), new Date().toISOString(), row.id);
        return dto(note(c));
      })(); broadcast(); return c.json({note: result});
    });
    app.get(prefix + '/:id/comment-members', c => {
      const row = note(c);
      if (row.space_id === row.user_id) return c.json({members: []});
      const members = db.prepare("SELECT u.id,u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname,'cutouts' AS avatarStyle,COALESCE(a.seed,u.id) AS avatarSeed FROM team_members m JOIN users u ON u.id=m.user_id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE m.team_id=? ORDER BY u.username").all(row.space_id) as Row[];
      return c.json({members: members.filter(member => { try { permission(member.id, row.space_id, row.folder_id); return true; } catch { return false; } })});
    });
    app.get(prefix + '/:id/comments', c => {
      const row = note(c), threadId = c.req.query('threadId') === undefined ? null : id(c.req.query('threadId'));
      if (threadId && !db.prepare('SELECT 1 FROM note_comments WHERE id=? AND note_id=? AND thread_id IS NULL').get(threadId, row.id)) fail(404, '评论不存在');
      const before = c.req.query('before') ?? '9999-12-31T23:59:59.999Z', [beforeTime, beforeId] = before.split('|');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(beforeTime) || beforeId !== undefined && !uuid.test(beforeId)) fail(400, '评论分页位置无效');
      const rows = db.prepare(`SELECT c.id,c.body,c.mentions,c.mention_ranges AS mentionRanges,c.user_id AS userId,c.created_at AS createdAt,c.thread_id AS threadId,
        u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname,'cutouts' AS avatarStyle,COALESCE(a.seed,u.id) AS avatarSeed,
        r.id AS replyToId,ru.id AS replyToUserId,ru.username AS replyToUsername,COALESCE(NULLIF(ru.nickname,''),ru.username) AS replyToNickname,
        (SELECT COUNT(*) FROM note_comments replies WHERE replies.thread_id=c.id AND replies.note_id=c.note_id) AS replyCount
        FROM note_comments c JOIN users u ON u.id=c.user_id LEFT JOIN user_avatars a ON a.user_id=u.id
        LEFT JOIN note_comments r ON r.id=c.reply_to_id AND r.note_id=c.note_id LEFT JOIN users ru ON ru.id=r.user_id
        WHERE c.note_id=? AND c.thread_id IS ? AND (c.created_at<? OR (c.created_at=? AND c.id<?))
        ORDER BY c.created_at DESC,c.id DESC LIMIT 41`).all(row.id, threadId, beforeTime, beforeTime, beforeId ?? '') as Row[];
      return c.json({comments: rows.slice(0, 40).map(({replyToId, replyToUserId, replyToUsername, replyToNickname, ...row}) => ({...row,
        mentions: JSON.parse(row.mentions), mentionRanges: JSON.parse(row.mentionRanges),
        replyTo: replyToId ? {id: replyToId, userId: replyToUserId, username: replyToUsername, nickname: replyToNickname} : null,
      })), next: rows.length > 40 ? rows[39].createdAt + '|' + rows[39].id : null, supportsMentionRanges: true, supportsReplies: true});
    });
    app.post(prefix + '/:id/comments', async c => {
      const body = await readBody(c, ['body', 'mentions', 'mentionRanges', 'replyToId']);
      if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 2000) fail(400, '评论须为 1 至 2000 字');
      if (!Array.isArray(body.mentions) || body.mentions.length > 20) fail(400, '最多提及 20 位成员');
      const mentions = [...new Set(body.mentions.map(id))];
      const text = (body.body as string).trim();
      const replyToId = body.replyToId === undefined || body.replyToId === null ? null : id(body.replyToId);
      db.transaction(() => {
        requireLiveSession(c); const row = note(c, true);
        if (row.space_id === row.user_id) fail(400, '评论用于团队备忘录');
        const target = replyToId ? db.prepare('SELECT id,thread_id,user_id FROM note_comments WHERE id=? AND note_id=?').get(replyToId, row.id) as Row | undefined : undefined;
        if (replyToId && !target) fail(404, '回复的评论不存在或已删除');
        const threadId = target ? target.thread_id ?? target.id : null;
        if ((db.prepare("SELECT COUNT(*) AS count FROM note_comments WHERE user_id=? AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')").get(uid(c)) as Row).count >= 20) fail(429, '评论过于频繁，请稍后再试');
        for (const userId of mentions) permission(userId, row.space_id, row.folder_id);
        const ranges = body.mentionRanges === undefined ? [] : body.mentionRanges;
        if (!Array.isArray(ranges) || ranges.length > 100) fail(400, '提及标签无效');
        const normalizedRanges: {userId: string; label: string; from: number; to: number}[] = [];
        let previousEnd = 0;
        for (const range of ranges) {
          if (!range || typeof range !== 'object' || Array.isArray(range)) fail(400, '提及标签无效');
          const item = range as Row;
          if (!mentions.includes(item.userId) || typeof item.label !== 'string' || !Number.isInteger(item.from) || !Number.isInteger(item.to) || item.from < previousEnd || item.to <= item.from || item.to > text.length || text.slice(item.from, item.to) !== '@' + item.label) fail(400, '提及标签无效');
          const member = db.prepare("SELECT COALESCE(NULLIF(nickname,''),username) AS name FROM users WHERE id=?").get(item.userId) as Row;
          if (item.label !== member.name) fail(409, '成员昵称已更新，请重新选择提及成员');
          previousEnd = item.to;
          normalizedRanges.push({userId: item.userId, label: item.label, from: item.from, to: item.to});
        }
        const now = new Date().toISOString(), commentId = randomUUID();
        db.prepare('INSERT INTO note_comments(id,note_id,user_id,body,mentions,mention_ranges,created_at,thread_id,reply_to_id) VALUES(?,?,?,?,?,?,?,?,?)').run(commentId, row.id, uid(c), text, JSON.stringify(mentions), JSON.stringify(normalizedRanges), now, threadId, replyToId);
        const t = db.prepare('SELECT name FROM teams WHERE id=?').get(row.space_id) as Row;
        const recipients = new Set(mentions);
        if (target) {
          try { permission(target.user_id, row.space_id, row.folder_id); recipients.add(target.user_id); } catch { /* 不向已失去访问权限的原作者发送通知。 */ }
        }
        for (const userId of recipients) {
          if (userId === uid(c)) continue;
          const reply = target?.user_id === userId;
          db.prepare('INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,note_id,folder_id) VALUES(?,?,?,?,?,?,?,?)')
            .run(userId, reply ? 'note_comment_reply' : 'note_mention', reply ? '有人回复了你的评论' : '有人在评论中提到了你',
              `${c.get('user')!.nickname} 在「${row.title}」中${reply ? '回复了你的评论' : '提到了你'}`, row.space_id, t.name, row.id, row.folder_id);
        }
      })(); return c.json({ok: true}, 201);
    });
    app.delete(prefix + '/:id/comments/:commentId', c => {
      db.transaction(() => {
        requireLiveSession(c); const row = note(c, true);
        const comment = db.prepare('SELECT user_id FROM note_comments WHERE id=? AND note_id=?').get(id(c.req.param('commentId')), row.id) as Row | undefined;
        if (!comment) fail(404, '评论不存在');
        if (comment.user_id !== uid(c) && !row.canManage) fail(403, '只能删除自己的评论');
        db.prepare('DELETE FROM note_comments WHERE id=? AND note_id=?').run(c.req.param('commentId'), row.id);
      })(); return c.json({ok: true});
    });
    app.post(prefix + '/export', async c => {
      const body = await readBody(c, ['ids', 'format']);
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || !['markdown', 'text'].includes(String(body.format))) fail(400, '每次导出 1 至 100 篇备忘录，格式为 Markdown 或纯文本');
      const rows = (body.ids as unknown[]).map(value => note(c, false, id(value)));
      // oxlint-disable-next-line no-control-regex
      const files = rows.map(row => ({name: `${(row.title || '备忘录').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}-${row.id.slice(0, 8)}.${body.format === 'markdown' ? 'md' : 'txt'}`,
        text: body.format === 'markdown' ? '# ' + markdown({type: 'text', text: row.title}) + '\n\n' + markdown(JSON.parse(row.content)) + '\n' : row.title + '\n\n' + plainText(JSON.parse(row.content)) + '\n'}));
      return c.json({files});
    });
    app.post(prefix + '/import', async c => {
      const body = await readBody(c, ['files', 'folderId']);
      if (!Array.isArray(body.files) || !body.files.length || body.files.length > 20) fail(400, '每次导入 1 至 20 个 Markdown 或文本文件');
      const folderId = body.folderId === null ? null : id(body.folderId);
      const parsed = body.files.map(value => {
        const file = value as Row;
        if (!file || typeof file.name !== 'string' || !/\.(md|markdown|txt)$/i.test(file.name) || file.name.length > 240 || typeof file.text !== 'string' || file.text.length > 200000) fail(400, '仅支持不超过 20 万字的 .md、.markdown、.txt 文件');
        let text = file.text.replace(/^\uFEFF/, ''), title = file.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 200);
        const heading = text.match(/^# (.+)\r?\n(?:\r?\n|$)/);
        if (/\.(md|markdown)$/i.test(file.name) && heading) { title = heading[1].slice(0, 200); text = text.slice(heading[0].length); }
        const content = validateContent(parseDocument(text, /\.(md|markdown)$/i.test(file.name)));
        return {title, content, plain: plainText(content as any)};
      });
      const notes = db.transaction(() => {
        requireLiveSession(c); const spaceId = space(c), rights = permission(uid(c), spaceId, folderId);
        if (!rights.canEdit) fail(403, '此位置不可导入');
        if (folderId && !db.prepare('SELECT 1 FROM folders WHERE id=? AND space_id=? AND deleted_at IS NULL').get(folderId, spaceId)) fail(404, '文件夹不存在');
        return parsed.map(file => {
          deps.validateImages(file.content, spaceId, uid(c));
          const noteId = randomUUID(), now = new Date().toISOString();
          db.prepare('INSERT INTO notes(id,user_id,space_id,title,content,plain_text,folder_id,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(noteId, uid(c), spaceId, file.title, JSON.stringify(file.content), file.plain, folderId, uid(c), now, now);
          return dto(note(c, false, noteId));
        });
      })();
      if (space(c) !== uid(c)) db.prepare('UPDATE teams SET revision=revision+1 WHERE id=?').run(space(c));
      return c.json({notes}, 201);
    });
  }
}
