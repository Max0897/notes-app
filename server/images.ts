import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import sharp, {type OutputInfo} from 'sharp';
import type Database from 'better-sqlite3';
import type {Hono, MiddlewareHandler} from 'hono';
import type {AppContext, AppEnv} from './index.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Row = Record<string, any>;
type ErrorType = new (status: 400 | 401 | 403 | 404 | 409 | 429, message: string) => Error;

export function imageIds(content: unknown): string[] {
  const ids = new Set<string>();
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image' && typeof node.attrs?.imageId === 'string') ids.add(node.attrs.imageId);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(content); return [...ids];
}

// SQLite triggers keep live and historical references in the same transaction as
// REST saves, Yjs writes, history pruning and permanent document deletion.
export function initImages(db: Database.Database, dataDir: string, ApiError: ErrorType) {
  const directory = resolve(dataDir, 'images');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  db.exec(`CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    upload_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    filename TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, orphaned_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS images_orphaned ON images(orphaned_at);
  CREATE TABLE IF NOT EXISTS image_references (
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    source TEXT NOT NULL, PRIMARY KEY(image_id,note_id,source)
  );
  CREATE INDEX IF NOT EXISTS image_references_note ON image_references(note_id,source);
  CREATE TRIGGER IF NOT EXISTS image_reference_added AFTER INSERT ON image_references BEGIN
    UPDATE images SET orphaned_at=NULL WHERE id=NEW.image_id;
  END;
  CREATE TRIGGER IF NOT EXISTS image_reference_removed AFTER DELETE ON image_references BEGIN
    UPDATE images SET orphaned_at=CAST(strftime('%s','now') AS INTEGER)*1000
      WHERE id=OLD.image_id AND NOT EXISTS(SELECT 1 FROM image_references WHERE image_id=OLD.image_id);
  END;`);
  const object = "CASE WHEN j.type='object' THEN j.value ELSE '{}' END";
  const nodeType = `json_extract(${object},'$.type')`, imageId = `json_extract(${object},'$.attrs.imageId')`;
  for (const table of ['notes', 'note_history']) {
    const noteId = table === 'notes' ? 'NEW.id' : 'NEW.note_id';
    const space = table === 'notes' ? 'COALESCE(NEW.space_id,NEW.user_id)' : '(SELECT space_id FROM notes WHERE id=NEW.note_id)';
    const source = table === 'notes' ? "'current'" : "'history:' || NEW.id";
    for (const event of ['INSERT', 'UPDATE OF content']) {
      const suffix = event === 'INSERT' ? 'insert' : 'update';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_images_guard_${suffix} BEFORE ${event} ON ${table}
        WHEN EXISTS(SELECT 1 FROM json_tree(NEW.content) j WHERE ${nodeType}='image'
          AND NOT EXISTS(SELECT 1 FROM images WHERE id=${imageId} AND space_id=${space}))
        BEGIN SELECT RAISE(ABORT,'images_invalid_reference'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_images_${suffix} AFTER ${event} ON ${table} BEGIN
          DELETE FROM image_references WHERE note_id=${noteId} AND source=${source};
          INSERT OR IGNORE INTO image_references(image_id,note_id,source)
            SELECT ${imageId},${noteId},${source} FROM json_tree(NEW.content) j WHERE ${nodeType}='image';
        END;`);
    }
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_images_deleted AFTER DELETE ON note_history BEGIN
    DELETE FROM image_references WHERE note_id=OLD.note_id AND source='history:' || OLD.id;
  END;`);
  function fail(status: 400 | 403 | 404 | 409 | 429, message: string): never { throw new ApiError(status, message); }
  function rights(userId: string, noteId: string): {note: Row; canEdit: boolean} | null {
    const note = db.prepare(`SELECT n.*,f.access_mode,f.deleted_at AS folder_deleted FROM notes n
      LEFT JOIN folders f ON f.id=n.folder_id AND f.space_id=n.space_id WHERE n.id=?`).get(noteId) as Row | undefined;
    if (!note) return null;
    if (note.space_id === userId) return {note, canEdit: !note.deleted_at};
    const member = db.prepare(`SELECT m.role FROM team_members m JOIN teams t ON t.id=m.team_id
      WHERE m.team_id=? AND m.user_id=? AND t.deleted_at IS NULL`).get(note.space_id, userId) as Row | undefined;
    if (!member) return null;
    const manage = ['owner', 'admin'].includes(member.role);
    const grant = note.folder_id ? db.prepare('SELECT permission FROM folder_access WHERE folder_id=? AND user_id=?').get(note.folder_id, userId) as Row | undefined : null;
    if (!manage && note.access_mode === 'restricted' && !grant) return null;
    return {note, canEdit: !note.deleted_at && !note.folder_deleted && (manage || member.role === 'editor' && (note.access_mode !== 'restricted' || grant?.permission === 'edit'))};
  }
  function readable(image: Row, userId: string) {
    const references = db.prepare('SELECT DISTINCT note_id FROM image_references WHERE image_id=?').all(image.id) as Row[];
    if (references.some(ref => rights(userId, ref.note_id))) return true;
    return !references.length && image.orphaned_at !== null && image.orphaned_at > Date.now() - IMAGE_GRACE_MS
      && image.uploaded_by === userId && image.upload_note_id && !!rights(userId, image.upload_note_id);
  }
  function validateReferences(content: unknown, spaceId: string, userId: string, noteId?: string) {
    for (const id of imageIds(content)) {
      const image = db.prepare('SELECT * FROM images WHERE id=? AND space_id=?').get(id, spaceId) as Row | undefined;
      if (!image || !existsSync(resolve(directory, image.filename))) fail(400, '图片不存在或已清理，请重新上传');
      const ownReference = noteId && db.prepare('SELECT 1 FROM image_references WHERE image_id=? AND note_id=?').get(id, noteId);
      if (!ownReference && !readable(image, userId)) fail(404, '图片不存在或无权访问');
    }
  }
  function cleanup(now = Date.now()) {
    // No awaits between the final reference check and unlink: writes cannot race
    // garbage collection in this single-process SQLite deployment.
    const candidates = db.prepare(`SELECT id,filename FROM images WHERE orphaned_at IS NOT NULL AND orphaned_at<=?
      AND NOT EXISTS(SELECT 1 FROM image_references WHERE image_id=images.id) LIMIT 100`).all(now - IMAGE_GRACE_MS) as Row[];
    for (const image of candidates) db.transaction(() => {
      if (db.prepare('SELECT 1 FROM image_references WHERE image_id=?').get(image.id)) return;
      rmSync(resolve(directory, image.filename), {force: true});
      db.prepare('DELETE FROM images WHERE id=?').run(image.id);
    })();
    // Covers an interrupted upload between the filesystem write and DB commit.
    for (const filename of readdirSync(directory)) {
      if (!/^[0-9a-f-]{36}\.webp$/.test(filename) || db.prepare('SELECT 1 FROM images WHERE filename=?').get(filename)) continue;
      const path = resolve(directory, filename);
      if (statSync(path).mtimeMs <= now - IMAGE_GRACE_MS) rmSync(path, {force: true});
    }
  }
  function register(app: Hono<AppEnv>, requireAuth: MiddlewareHandler<AppEnv>, requireLiveSession: (c: AppContext) => void) {
    let uploads = 0;
    for (const prefix of ['/api/notes', '/api/teams/:teamId/notes']) {
      app.post(prefix + '/:id/images', requireAuth, async c => {
        const userId = c.get('user')!.id, noteId = c.req.param('id') ?? '';
        const access = rights(userId, noteId);
        if (!access || access.note.space_id !== (c.req.param('teamId') ?? userId)) fail(404, '备忘录不存在');
        if (!access.canEdit) fail(403, '此备忘录不可上传图片');
        if (uploads >= 2) fail(429, '图片正在处理中，请稍后重试');
        uploads++;
        let path: string | undefined;
        try {
          if (!/^multipart\/form-data(?:;|$)/i.test(c.req.header('content-type') ?? '')) fail(400, '请通过图片上传表单提交');
          let form: FormData;
          try { form = await c.req.formData(); } catch { fail(400, '图片上传表单无效'); }
          const file = form.get('file');
          if (form.getAll('file').length !== 1 || [...form.keys()].some(key => key !== 'file') || !file || typeof file === 'string') fail(400, '每次上传一张图片');
          if (!file.size || file.size > MAX_IMAGE_BYTES) fail(400, '图片大小须在 10 MB 以内');
          let output: {data: Buffer; info: OutputInfo};
          try {
            const bytes = Buffer.from(await file.arrayBuffer());
            const pipeline = sharp(bytes, {limitInputPixels: 40_000_000, failOn: 'warning'});
            const metadata = await pipeline.metadata();
            if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) fail(400, '仅支持 JPG、PNG 和静态 WebP 图片');
            output = await pipeline.rotate().webp({quality: 90, lossless: metadata.format === 'png'}).toBuffer({resolveWithObject: true});
          } catch (error) {
            if (error instanceof ApiError) throw error;
            fail(400, '图片无法解码或超过 4000 万像素，请选择有效的 JPG、PNG、WebP 图片');
          }
          if (output.data.length > MAX_IMAGE_BYTES) fail(400, '处理后的图片超过 10 MB，请缩小后重试');
          requireLiveSession(c);
          const current = rights(userId, noteId);
          if (!current || !current.canEdit || current.note.space_id !== access.note.space_id) fail(403, '备忘录访问权限已变化');
          const id = randomUUID(), filename = id + '.webp', now = Date.now();
          path = resolve(directory, filename);
          writeFileSync(path, output.data, {flag: 'wx', mode: 0o600});
          db.prepare(`INSERT INTO images(id,space_id,uploaded_by,upload_note_id,filename,mime,size,width,height,created_at,orphaned_at)
            VALUES(?,?,?,?,?,'image/webp',?,?,?,?,?)`).run(id, current.note.space_id, userId, noteId, filename, output.data.length, output.info.width, output.info.height, now, now);
          path = undefined;
          return c.json({image: {id, src: '/api/images/' + id, width: output.info.width, height: output.info.height}}, 201);
        } finally { uploads--; if (path) rmSync(path, {force: true}); }
      });
    }
    app.get('/api/images/:imageId', requireAuth, c => {
      c.header('Cache-Control', 'private, no-store');
      const id = c.req.param('imageId');
      if (!uuid.test(id)) fail(404, '图片不存在');
      const image = db.prepare('SELECT * FROM images WHERE id=?').get(id) as Row | undefined;
      if (!image || !readable(image, c.get('user')!.id)) fail(404, '图片不存在或无权访问');
      const path = resolve(directory, image.filename);
      if (!existsSync(path)) fail(404, '图片不存在');
      c.header('Content-Type', 'image/webp');
      c.header('Content-Disposition', `inline; filename="${image.filename}"`);
      return c.body(new Uint8Array(readFileSync(path)));
    });
  }
  return {validateReferences, cleanup, register};
}
