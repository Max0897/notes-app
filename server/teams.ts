import {randomUUID, randomBytes, createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import type {AppContext, AppEnv, JsonObject} from './index.js';
import {invitationLinkTokens} from './invitationLinks.js';
import {EDITOR_CAPABILITY, needsCurrentEditor} from './editorVersion.js';

const retention = 30 * 86400000;
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type Row = Record<string, any>;
type Dependencies = {
  dataDir: string;
  readBody: (c: AppContext, keys: readonly string[]) => Promise<JsonObject>;
  requireAuth: any;
  requireLiveSession: (c: AppContext) => void;
  verifyCurrentPassword: (c: AppContext, value: unknown) => Promise<string>;
  validateContent: (value: unknown) => JsonObject;
  validateImages: (value: unknown, spaceId: string, userId: string, noteId?: string) => void;
  folderName: (value: unknown) => string;
  ApiError: new (status: 400 | 401 | 403 | 404 | 409 | 429, message: string) => Error;
};

export function initCollaboration(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT 'users',
      owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('personal','team')),
      user_id TEXT UNIQUE REFERENCES users(id), team_id TEXT UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
      CHECK((kind='personal' AND user_id IS NOT NULL AND team_id IS NULL) OR (kind='team' AND team_id IS NOT NULL AND user_id IS NULL))
    );
    INSERT OR IGNORE INTO spaces(id,kind,user_id) SELECT id,'personal',id FROM users;
    CREATE TRIGGER IF NOT EXISTS users_personal_space AFTER INSERT ON users BEGIN INSERT INTO spaces(id,kind,user_id) VALUES(new.id,'personal',new.id); END;
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')), joined_at TEXT NOT NULL, PRIMARY KEY(team_id,user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS team_one_owner ON team_members(team_id) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS team_invitations (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id), target_id TEXT REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
      token_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL,
      accepted_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
    );
    DROP TABLE IF EXISTS team_transfers;
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, object_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_logs_team ON activity_logs(team_id,id DESC);
    CREATE TABLE IF NOT EXISTS team_presence (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
      note_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(team_id,user_id)
    );
  `);
  const add = (table: string, column: string, definition: string) => {
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  db.transaction(() => {
    add('team_invitations', 'link_token', 'TEXT');
    // 旧版为每次生成新建记录；升级后每位邀请人在每个团队仅保留最新的一项。
    db.exec(`DELETE FROM team_invitations WHERE target_id IS NULL AND id IN (
      SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY team_id,created_by ORDER BY created_at DESC,rowid DESC) AS n
        FROM team_invitations WHERE target_id IS NULL) WHERE n>1);
      CREATE UNIQUE INDEX IF NOT EXISTS team_one_invitation_link ON team_invitations(team_id,created_by) WHERE target_id IS NULL;`);
    add('folders', 'space_id', 'TEXT REFERENCES spaces(id)');
    add('folders', 'access_mode', "TEXT NOT NULL DEFAULT 'team'");
    add('folders', 'deleted_at', 'TEXT');
    add('notes', 'space_id', 'TEXT REFERENCES spaces(id)');
    add('notes', 'updated_by', 'TEXT REFERENCES users(id)');
    add('notes', 'folder_trash_batch', 'TEXT');
    db.exec(`UPDATE folders SET space_id=user_id WHERE space_id IS NULL; UPDATE notes SET space_id=user_id WHERE space_id IS NULL;
      UPDATE notes SET updated_by=user_id WHERE updated_by IS NULL;
      CREATE INDEX IF NOT EXISTS folders_space ON folders(space_id);
      CREATE INDEX IF NOT EXISTS notes_space ON notes(space_id,updated_at);
      CREATE TRIGGER IF NOT EXISTS folders_personal_space AFTER INSERT ON folders WHEN new.space_id IS NULL BEGIN UPDATE folders SET space_id=new.user_id WHERE id=new.id; END;
      CREATE TRIGGER IF NOT EXISTS notes_personal_space AFTER INSERT ON notes WHEN new.space_id IS NULL BEGIN UPDATE notes SET space_id=new.user_id,updated_by=new.user_id WHERE id=new.id; END;
      CREATE TABLE IF NOT EXISTS folder_access (
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
        permission TEXT NOT NULL CHECK(permission IN ('view','edit')), PRIMARY KEY(folder_id,user_id)
      );
      `);
  })();
  // 兼容之前的本地预览数据库；仅在团队保留期结束时清理旧表的外键引用。
  // 移除功能本身不会删除历史上传内容，也不再创建文件表或存储目录。
  const hasLegacyFiles = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_files'").get();
  function cleanup() {
    const expired = db.prepare('SELECT id FROM teams WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(new Date(Date.now() - retention).toISOString()) as Row[];
    for (const team of expired) {
      db.transaction(() => {
        db.prepare('DELETE FROM notes WHERE space_id=?').run(team.id);
        if (hasLegacyFiles) db.prepare('DELETE FROM team_files WHERE team_id=?').run(team.id);
        db.prepare('DELETE FROM folders WHERE space_id=?').run(team.id);
        db.prepare('DELETE FROM spaces WHERE id=?').run(team.id);
        db.prepare('DELETE FROM teams WHERE id=?').run(team.id);
      })();
    }
    db.prepare('DELETE FROM team_presence WHERE updated_at<?').run(Date.now() - 60000);
  }
  return {cleanup};
}

export function registerCollaboration(app: Hono<AppEnv>, db: Database.Database, deps: Dependencies) {
  const linkTokens = invitationLinkTokens(deps.dataDir);
  const {readBody, requireAuth, requireLiveSession, verifyCurrentPassword, validateContent, folderName, ApiError} = deps;
  function fail(status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never { throw new ApiError(status, message); }
  const uid = (c: AppContext) => c.get('user')!.id;
  const now = () => new Date().toISOString();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const id = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : fail(400, '资源编号无效');
  const manager = (role: Role) => role === 'owner' || role === 'admin';
  function team(c: AppContext, level: 'view' | 'manage' | 'owner' = 'view', teamId = c.req.param('teamId')): Row & {role: Role} {
    requireLiveSession(c);
    const row = db.prepare('SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.id=? AND m.user_id=? AND t.deleted_at IS NULL').get(id(teamId), uid(c)) as (Row & {role: Role}) | undefined;
    if (!row) fail(404, '团队不存在或你已没有访问权限');
    if (level === 'owner' && row.role !== 'owner' || level === 'manage' && !manager(row.role)) fail(403, '没有管理权限');
    return row;
  }
  function audit(c: AppContext, t: Row, action: string, object: string) {
    db.prepare('INSERT INTO activity_logs(team_id,actor_id,action,object_name,created_at) VALUES(?,?,?,?,?)').run(t.id, uid(c), action, object.slice(0, 240), now());
    db.prepare('UPDATE teams SET revision=revision+1 WHERE id=?').run(t.id);
  }
  const roleLabels: Record<Role, string> = {owner: '所有者', admin: '管理员', editor: '编辑者', viewer: '查看者'};
  function memberLabel(userId: string) {
    const user = db.prepare('SELECT username,nickname FROM users WHERE id=?').get(userId) as Row | undefined;
    if (!user) return '原成员';
    return user.nickname && user.nickname !== user.username ? `${user.nickname}（@${user.username}）` : user.username;
  }
  function folder(t: Row, folderId: string | null, includeDeleted = true): Row | null {
    if (folderId === null) return null;
    const row = db.prepare('SELECT * FROM folders WHERE id=? AND space_id=?').get(id(folderId), t.id) as Row | undefined;
    if (!row || !includeDeleted && row.deleted_at) fail(404, '目标文件夹不存在');
    return row;
  }
  function can(c: AppContext, t: Row & {role: Role}, folderId: string | null, edit = false): boolean {
    const f = folder(t, folderId);
    if (manager(t.role)) return true;
    if (edit && t.role !== 'editor') return false;
    if (!f || f.access_mode === 'team') return true;
    const grant = db.prepare('SELECT permission FROM folder_access WHERE folder_id=? AND user_id=?').get(f.id, uid(c)) as Row | undefined;
    return !!grant && (!edit || grant.permission === 'edit');
  }
  function access(c: AppContext, t: Row & {role: Role}, folderId: string | null, edit = false, active = false) {
    const f = folder(t, folderId, !active);
    if (!can(c, t, folderId)) fail(404, '资料不存在');
    if (edit && !can(c, t, folderId, true)) fail(403, '此位置仅可查看');
    return f;
  }
  const targetFolder = (value: unknown) => value === null ? null : id(value);
  function note(c: AppContext, t: Row & {role: Role}, noteId: string, edit = false): Row {
    const n = db.prepare('SELECT * FROM notes WHERE id=? AND space_id=?').get(id(noteId), t.id) as Row | undefined;
    if (!n) fail(404, '备忘录不存在');
    access(c, t, n.folder_id, edit); return n;
  }
  function noteDto(c: AppContext, t: Row & {role: Role}, n: Row) {
    const user = db.prepare("SELECT COALESCE(NULLIF(nickname,''),username) AS username FROM users WHERE id=?").get(n.updated_by ?? n.user_id) as Row;
    return {id: n.id, title: n.title, content: JSON.parse(n.content), plainText: n.plain_text, folderId: n.folder_id,
      pinned: !!n.pinned, deletedAt: n.deleted_at, version: n.version, createdAt: n.created_at, updatedAt: n.updated_at,
      canEdit: can(c, t, n.folder_id, true) && !folder(t, n.folder_id)?.deleted_at, canManage: manager(t.role), modifiedBy: user?.username ?? '团队成员'};
  }
  function version(value: unknown, row: Row) { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(400, '缺少有效版本'); if (value !== row.version) fail(409, '资料已被更新，请刷新后重试'); }
  // 名称拒绝控制字符，避免在名称及日志中插入不可见内容。
  // oxlint-disable-next-line no-control-regex
  function text(value: unknown, min: number, max: number) { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, `内容长度须为 ${min} 至 ${max} 个字符`); return value.trim(); }
  function teamInfo(row: Row) { return {id: row.id, name: row.name, description: row.description, icon: row.icon, ownerId: row.owner_id, role: row.role, createdAt: row.created_at, deletedAt: row.deleted_at, revision: row.revision}; }
  const limited = new Map<string, {count: number; until: number}>();
  function inviteLimit(c: AppContext) {
    const key = uid(c), entry = limited.get(key);
    if (entry && entry.until > Date.now() && entry.count >= 30) fail(429, '邀请操作过于频繁，请稍后重试');
    if (!entry || entry.until <= Date.now()) limited.set(key, {count: 1, until: Date.now() + 3600000}); else entry.count++;
    for (const [k, v] of limited) if (v.until < Date.now()) limited.delete(k);
  }
  const prefixes = ['/api/teams', '/api/teams/*', '/api/spaces', '/api/invitations', '/api/invitations/*'];
  prefixes.forEach(path => app.use(path, requireAuth));

  app.get('/api/spaces', c => {
    const rows = db.prepare('SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=? AND (t.deleted_at IS NULL OR t.owner_id=?) ORDER BY t.created_at').all(uid(c), uid(c)) as Row[];
    return c.json({teams: rows.map(teamInfo)});
  });
  app.post('/api/teams', async c => {
    const body = await readBody(c, ['name', 'description', 'icon']);
    const name = text(body.name, 2, 40), description = text(body.description ?? '', 0, 200);
    const icon = ['users', 'briefcase', 'book', 'heart'].includes(String(body.icon)) ? String(body.icon) : 'users';
    const teamId = randomUUID();
    db.transaction(() => {
      requireLiveSession(c);
      db.prepare('INSERT INTO teams(id,name,description,icon,owner_id,created_at) VALUES(?,?,?,?,?,?)').run(teamId, name, description, icon, uid(c), now());
      db.prepare("INSERT INTO spaces(id,kind,team_id) VALUES(?,'team',?)").run(teamId, teamId);
      db.prepare("INSERT INTO team_members VALUES(?,?,'owner',?)").run(teamId, uid(c), now());
      audit(c, {id: teamId}, '创建团队', name);
    })();
    return c.json({team: teamInfo(team(c, 'view', teamId))}, 201);
  });
  app.get('/api/teams/:teamId', c => {
    const t = team(c);
    return c.json({team: teamInfo(t)});
  });
  app.patch('/api/teams/:teamId', async c => {
    const body = await readBody(c, ['name', 'description', 'icon']);
    db.transaction(() => {
      const t = team(c, 'manage');
      const name = text(body.name ?? t.name, 2, 40), description = text(body.description ?? t.description, 0, 200);
      const icon = body.icon ?? t.icon;
      if (!['users', 'briefcase', 'book', 'heart'].includes(String(icon))) fail(400, '团队图标无效');
      db.prepare('UPDATE teams SET name=?,description=?,icon=? WHERE id=?').run(name, description, icon, t.id); audit(c, t, '修改团队', name);
    })();
    return c.json({team: teamInfo(team(c))});
  });
  app.post('/api/teams/:teamId/dissolve', async c => {
    const body = await readBody(c, ['name', 'currentPassword']);
    const before = team(c, 'owner');
    if (body.name !== before.name) fail(400, '请输入正确的团队名称');
    await verifyCurrentPassword(c, body.currentPassword);
    db.transaction(() => {
      const t = team(c, 'owner');
      if (body.name !== t.name) fail(409, '团队名称已变化，请重新确认');
      audit(c, t, '解散团队', t.name);
      db.prepare('UPDATE teams SET deleted_at=? WHERE id=?').run(now(), t.id);
      db.prepare("UPDATE team_invitations SET status='revoked' WHERE team_id=? AND status='pending'").run(t.id);
      db.prepare('DELETE FROM team_presence WHERE team_id=?').run(t.id);
    })(); return c.json({ok: true});
  });
  app.post('/api/teams/:teamId/restore', c => {
    requireLiveSession(c);
    const t = db.prepare('SELECT * FROM teams WHERE id=? AND owner_id=? AND deleted_at IS NOT NULL AND deleted_at>?').get(id(c.req.param('teamId')), uid(c), new Date(Date.now() - retention).toISOString()) as Row | undefined;
    if (!t) fail(404, '团队不存在或已超过恢复期限');
    db.transaction(() => { db.prepare('UPDATE teams SET deleted_at=NULL WHERE id=?').run(t.id); audit(c, t, '恢复团队', t.name); })();
    return c.json({ok: true});
  });
  app.get('/api/teams/:teamId/members', c => {
    const t = team(c);
    const members = db.prepare(`SELECT u.id,u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname,'cutouts' AS avatarStyle,COALESCE(a.seed,u.id) AS avatarSeed,m.role,m.joined_at AS joinedAt
      FROM team_members m JOIN users u ON u.id=m.user_id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE m.team_id=? ORDER BY m.joined_at`).all(t.id);
    return c.json({members});
  });
  app.patch('/api/teams/:teamId/members/:memberId', async c => {
    const body = await readBody(c, ['role']);
    db.transaction(() => {
      const t = team(c, 'manage'), target = id(c.req.param('memberId'));
      const m = db.prepare('SELECT * FROM team_members WHERE team_id=? AND user_id=?').get(t.id, target) as Row | undefined;
      if (!m) fail(404, '成员不存在');
      if (m.role === 'owner' || (typeof body.role !== 'string' || !['admin', 'editor', 'viewer'].includes(body.role)) || t.role !== 'owner' && (m.role === 'admin' || body.role === 'admin')) fail(403, '无权修改该成员角色');
      db.prepare('UPDATE team_members SET role=? WHERE team_id=? AND user_id=?').run(body.role, t.id, target);
      db.prepare('DELETE FROM team_presence WHERE team_id=? AND user_id=?').run(t.id, target);
      if (!manager(body.role as Role)) db.prepare("UPDATE team_invitations SET status='revoked' WHERE team_id=? AND created_by=? AND status='pending'").run(t.id, target);
      audit(c, t, '调整成员角色', `${memberLabel(target)}：${roleLabels[m.role as Role]} → ${roleLabels[body.role as Role]}`);
    })(); return c.json({ok: true});
  });
  function removeMember(c: AppContext, t: Row & {role: Role}, target: string) {
    const m = db.prepare('SELECT * FROM team_members WHERE team_id=? AND user_id=?').get(t.id, target) as Row | undefined;
    if (!m) fail(404, '成员不存在');
    if (m.role === 'owner') fail(403, '团队所有者不能退出或被移除');
    if (target !== uid(c) && (!manager(t.role) || t.role !== 'owner' && m.role === 'admin')) fail(403, '无权移除此成员');
    db.prepare('DELETE FROM folder_access WHERE user_id=? AND folder_id IN(SELECT id FROM folders WHERE space_id=?)').run(target, t.id);
    db.prepare('DELETE FROM team_presence WHERE team_id=? AND user_id=?').run(t.id, target);
    db.prepare("UPDATE team_invitations SET status='revoked' WHERE team_id=? AND (created_by=? OR target_id=?) AND status='pending'").run(t.id, target, target);
    db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(t.id, target);
    audit(c, t, target === uid(c) ? '退出团队' : '移除成员', target);
  }
  app.delete('/api/teams/:teamId/members/:memberId', c => { db.transaction(() => removeMember(c, team(c), id(c.req.param('memberId'))))(); return c.json({ok: true}); });
  app.post('/api/teams/:teamId/leave', c => { db.transaction(() => removeMember(c, team(c), uid(c)))(); return c.json({ok: true}); });
  function invitationDto(row: Row) { return {id: row.id, teamId: row.team_id, teamName: row.team_name, inviter: row.inviter, username: row.username, role: row.role, status: row.status === 'pending' && row.expires_at <= Date.now() ? 'expired' : row.status, expiresAt: row.expires_at, createdAt: row.created_at, isLink: !row.target_id}; }
  const inviteQuery = `SELECT i.*,t.name AS team_name,u.username AS inviter,target.username FROM team_invitations i JOIN teams t ON t.id=i.team_id JOIN users u ON u.id=i.created_by LEFT JOIN users target ON target.id=i.target_id`;
  const myLink = (c: AppContext, t: Row) => db.prepare(inviteQuery + ' WHERE i.team_id=? AND i.created_by=? AND i.target_id IS NULL').get(t.id, uid(c)) as Row | undefined;
  function linkDto(row: Row) {
    return {...invitationDto(row), token: row.status === 'pending' && row.expires_at > Date.now() && row.link_token ? linkTokens.decrypt(row.link_token, row.id) : undefined};
  }
  function linkRole(value: unknown) {
    if (typeof value !== 'string' || !['viewer', 'editor'].includes(value)) fail(400, '邀请仅支持查看者或编辑者');
    return value;
  }
  function saveLink(c: AppContext, role: string, regenerate = false) {
    return db.transaction(() => {
      const t = team(c, 'manage'), previous = myLink(c, t);
      if (!regenerate && previous?.status === 'pending' && previous.expires_at > Date.now() && previous.link_token && previous.role === role) return linkDto(previous);
      const invitationId = previous?.id ?? randomUUID(), token = randomBytes(32).toString('base64url');
      if (previous) db.prepare("UPDATE team_invitations SET role=?,token_hash=?,link_token=?,status='pending',expires_at=?,accepted_by=NULL WHERE id=?").run(role, digest(token), linkTokens.encrypt(token, invitationId), Date.now() + 7 * 86400000, invitationId);
      else db.prepare('INSERT INTO team_invitations(id,team_id,created_by,target_id,role,token_hash,link_token,expires_at,created_at) VALUES(?,?,?,NULL,?,?,?,?,?)').run(invitationId, t.id, uid(c), role, digest(token), linkTokens.encrypt(token, invitationId), Date.now() + 7 * 86400000, now());
      audit(c, t, previous ? '重新生成邀请链接' : '开启邀请链接', '邀请链接');
      return linkDto(myLink(c, t)!);
    })();
  }
  app.get('/api/teams/:teamId/invitation-link', c => {
    const row = myLink(c, team(c, 'manage'));
    c.header('Cache-Control', 'no-store');
    return c.json({link: row ? linkDto(row) : null});
  });
  app.put('/api/teams/:teamId/invitation-link', async c => {
    const body = await readBody(c, ['role']); inviteLimit(c);
    const link = saveLink(c, linkRole(body.role ?? 'viewer'), true);
    c.header('Cache-Control', 'no-store'); return c.json({link});
  });
  app.delete('/api/teams/:teamId/invitation-link', c => {
    db.transaction(() => {
      const t = team(c, 'manage'), row = myLink(c, t);
      if (row?.status === 'pending') {
        db.prepare("UPDATE team_invitations SET status='revoked' WHERE id=?").run(row.id);
        audit(c, t, '关闭邀请链接', '邀请链接');
      }
    })(); return c.json({ok: true});
  });
  app.get('/api/invitations', c => {
    const invitations = db.prepare(inviteQuery + " WHERE i.target_id=? AND t.deleted_at IS NULL AND i.status='pending' AND i.expires_at>? ORDER BY i.created_at DESC").all(uid(c), Date.now()) as Row[];
    return c.json({invitations: invitations.map(invitationDto)});
  });
  app.get('/api/invitations/link/:token', c => {
    inviteLimit(c);
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, '邀请链接无效');
    const row = db.prepare(inviteQuery + " WHERE i.token_hash=? AND i.target_id IS NULL AND t.deleted_at IS NULL").get(digest(token)) as Row | undefined;
    if (!row || row.status !== 'pending' || row.expires_at <= Date.now()) fail(404, '邀请链接已关闭、重新生成或过期');
    const inviter = db.prepare('SELECT role FROM team_members WHERE team_id=? AND user_id=?').get(row.team_id, row.created_by) as Row | undefined;
    if (!inviter || !manager(inviter.role)) fail(404, '邀请链接已失效');
    return c.json({invitation: invitationDto(row)});
  });
  app.get('/api/teams/:teamId/invitations', c => { const t = team(c, 'manage'); return c.json({invitations: (db.prepare(inviteQuery + ' WHERE i.team_id=? AND i.target_id IS NOT NULL ORDER BY i.created_at DESC LIMIT 200').all(t.id) as Row[]).map(invitationDto)}); });
  app.post('/api/teams/:teamId/invitations', async c => {
    const body = await readBody(c, ['username', 'role']); inviteLimit(c);
    const role = linkRole(body.role ?? 'viewer');
    // 兼容旧客户端的生成入口；重复获取同一有效链接不会新增记录或轮换令牌。
    if (!('username' in body)) { const link = saveLink(c, role); c.header('Cache-Control', 'no-store'); return c.json({id: link.id, token: link.token}, 201); }
    const target = db.prepare('SELECT id FROM users WHERE username_key=?').get(text(body.username, 3, 32).normalize('NFKC').toLowerCase()) as Row | undefined;
    if (!target) fail(404, '该用户名尚未注册');
    const token = randomBytes(32).toString('base64url'), invitationId = randomUUID();
    db.transaction(() => {
      const t = team(c, 'manage');
      if (db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(t.id, target.id)) fail(409, '该用户已是团队成员');
      if (db.prepare("SELECT 1 FROM team_invitations WHERE team_id=? AND target_id=? AND status='pending' AND expires_at>?").get(t.id, target.id, Date.now())) fail(409, '已有待接受邀请，可在列表重新邀请');
      db.prepare('INSERT INTO team_invitations(id,team_id,created_by,target_id,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(invitationId, t.id, uid(c), target.id, role, digest(token), Date.now() + 7 * 86400000, now());
      audit(c, t, '邀请成员', String(body.username));
    })(); return c.json({id: invitationId}, 201);
  });
  app.post('/api/teams/:teamId/invitations/:invitationId/resend', c => {
    inviteLimit(c); let token = randomBytes(32).toString('base64url'); let link = false;
    db.transaction(() => {
      const t = team(c, 'manage'), inv = db.prepare('SELECT * FROM team_invitations WHERE id=? AND team_id=?').get(id(c.req.param('invitationId')), t.id) as Row | undefined;
      if (!inv) fail(400, '该邀请不可重新发送');
      if (!inv.target_id) {
        if (inv.created_by !== uid(c)) fail(403, '只能管理自己的邀请链接');
        link = true; const renewed = saveLink(c, inv.role, true);
        // 兼容旧入口，响应仍返回新令牌。
        token = renewed.token!; return;
      }
      if (inv.status === 'accepted') fail(400, '该邀请不可重新发送');
      if (inv.target_id && db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(t.id, inv.target_id)) fail(409, '该用户已加入团队');
      db.prepare("UPDATE team_invitations SET status='pending',created_by=?,token_hash=?,expires_at=? WHERE id=?").run(uid(c), digest(token), Date.now() + 7 * 86400000, inv.id); audit(c, t, '重新邀请', inv.target_id);
    })(); c.header('Cache-Control', 'no-store'); return c.json({token: link ? token : undefined});
  });
  app.delete('/api/teams/:teamId/invitations/:invitationId', c => { db.transaction(() => {
    const t = team(c, 'manage'), invitationId = id(c.req.param('invitationId'));
    const inv = db.prepare('SELECT * FROM team_invitations WHERE id=? AND team_id=?').get(invitationId, t.id) as Row | undefined;
    if (inv && !inv.target_id && inv.created_by !== uid(c)) fail(403, '只能管理自己的邀请链接');
    const result = db.prepare("UPDATE team_invitations SET status='revoked' WHERE id=? AND team_id=? AND status='pending'").run(invitationId, t.id);
    if (!result.changes) fail(409, '邀请已失效'); audit(c, t, inv?.target_id ? '撤销邀请' : '关闭邀请链接', invitationId);
  })(); return c.json({ok: true}); });
  app.post('/api/invitations/:invitationId/respond', async c => {
    const body = await readBody(c, ['accept', 'token']); inviteLimit(c);
    if (typeof body.accept !== 'boolean') fail(400, '请选择接受或拒绝');
    db.transaction(() => {
      requireLiveSession(c);
      const inv = db.prepare('SELECT i.*,t.deleted_at FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE i.id=?').get(id(c.req.param('invitationId'))) as Row | undefined;
      if (!inv) fail(404, '邀请不存在');
      if (inv.deleted_at || (inv.target_id ? inv.target_id !== uid(c) : typeof body.token !== 'string' || digest(body.token) !== inv.token_hash)) fail(404, '邀请不存在');
      if (inv.status === 'accepted' && inv.accepted_by === uid(c)) return;
      if (inv.status !== 'pending' || inv.expires_at <= Date.now()) fail(409, '邀请已失效');
      const inviter = db.prepare('SELECT role FROM team_members WHERE team_id=? AND user_id=?').get(inv.team_id, inv.created_by) as Row | undefined;
      if (!inviter || !manager(inviter.role)) fail(409, '邀请人已没有邀请权限');
      if (body.accept) {
        if (db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(inv.team_id, uid(c))) {
          if (!inv.target_id) return;
          fail(409, '你已经是团队成员');
        }
        db.prepare('INSERT OR IGNORE INTO team_members VALUES(?,?,?,?)').run(inv.team_id, uid(c), inv.role, now());
        if (inv.target_id) db.prepare("UPDATE team_invitations SET status='accepted',accepted_by=? WHERE id=?").run(uid(c), inv.id);
      } else if (inv.target_id) db.prepare("UPDATE team_invitations SET status='rejected' WHERE id=?").run(inv.id);
      audit(c, {id: inv.team_id}, body.accept ? '加入团队' : '拒绝邀请', c.get('user')!.username);
    })(); return c.json({ok: true});
  });

  app.get('/api/teams/:teamId/folders', c => {
    const t = team(c), rows = db.prepare('SELECT * FROM folders WHERE space_id=? ORDER BY name').all(t.id) as Row[];
    return c.json({folders: rows.filter(f => can(c, t, f.id)).map(f => ({id: f.id, name: f.name, restricted: f.access_mode === 'restricted', deletedAt: f.deleted_at, canEdit: can(c, t, f.id, true) && !f.deleted_at}))});
  });
  app.post('/api/teams/:teamId/folders', async c => {
    const body = await readBody(c, ['name']); const folderId = randomUUID();
    db.transaction(() => { const t = team(c, 'manage'); const name = folderName(body.name); db.prepare('INSERT INTO folders(id,user_id,name,space_id) VALUES(?,?,?,?)').run(folderId, uid(c), name, t.id); audit(c, t, '创建文件夹', name); })();
    return c.json({folder: {id: folderId, name: body.name}}, 201);
  });
  app.patch('/api/teams/:teamId/folders/:id', async c => {
    const body = await readBody(c, ['name']);
    db.transaction(() => { const t = team(c, 'manage'), f = folder(t, id(c.req.param('id')), false)!; const name = folderName(body.name); db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, f.id); audit(c, t, '重命名文件夹', name); })(); return c.json({ok: true});
  });
  app.delete('/api/teams/:teamId/folders/:id', c => {
    db.transaction(() => {
      const t = team(c, 'manage'), f = folder(t, id(c.req.param('id')), false)!, deleted = now();
      db.prepare('UPDATE folders SET deleted_at=? WHERE id=?').run(deleted, f.id);
      db.prepare('UPDATE notes SET deleted_at=?,folder_trash_batch=?,updated_by=?,version=version+1 WHERE folder_id=? AND space_id=? AND deleted_at IS NULL').run(deleted, f.id, uid(c), f.id, t.id);
      audit(c, t, '删除文件夹及其中资料', f.name);
    })(); return c.json({ok: true});
  });
  app.post('/api/teams/:teamId/folders/:id/restore', c => {
    db.transaction(() => {
      const t = team(c, 'manage'), f = folder(t, id(c.req.param('id')))!;
      if (!f.deleted_at) fail(400, '文件夹尚未删除');
      db.prepare('UPDATE folders SET deleted_at=NULL WHERE id=?').run(f.id);
      db.prepare('UPDATE notes SET deleted_at=NULL,folder_trash_batch=NULL,updated_by=?,version=version+1 WHERE folder_trash_batch=? AND space_id=?').run(uid(c), f.id, t.id);
      audit(c, t, '恢复文件夹及其中资料', f.name);
    })(); return c.json({ok: true});
  });
  app.get('/api/teams/:teamId/folders/:id/access', c => {
    const t = team(c, 'manage'), f = folder(t, id(c.req.param('id')))!;
    const grants = db.prepare('SELECT user_id AS userId,permission FROM folder_access WHERE folder_id=?').all(f.id);
    const affected = (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE folder_id=?').get(f.id) as Row).n;
    return c.json({mode: f.access_mode, grants, affected});
  });
  app.put('/api/teams/:teamId/folders/:id/access', async c => {
    const body = await readBody(c, ['mode', 'grants']);
    if (typeof body.mode !== 'string' || !['team', 'restricted'].includes(body.mode) || !Array.isArray(body.grants) || body.grants.length > 1000) fail(400, '权限配置无效');
    const grants = body.grants as Row[];
    if (grants.some(g => !g || !['view', 'edit'].includes(g.permission)) || new Set(grants.map(g => id(g.userId))).size !== grants.length) fail(400, '授权成员或权限无效');
    db.transaction(() => {
      const t = team(c, 'manage'), f = folder(t, id(c.req.param('id')), false)!;
      for (const g of grants) {
        const m = db.prepare('SELECT role FROM team_members WHERE team_id=? AND user_id=?').get(t.id, g.userId) as Row | undefined;
        if (!m || g.permission === 'edit' && m.role === 'viewer') fail(400, '授权须遵守成员角色上限');
      }
      db.prepare('UPDATE folders SET access_mode=? WHERE id=?').run(body.mode, f.id);
      db.prepare('DELETE FROM folder_access WHERE folder_id=?').run(f.id);
      if (body.mode === 'restricted') for (const g of grants) db.prepare('INSERT INTO folder_access VALUES(?,?,?)').run(f.id, g.userId, g.permission);
      db.prepare('DELETE FROM team_presence WHERE team_id=? AND note_id IN(SELECT id FROM notes WHERE folder_id=?)').run(t.id, f.id);
      audit(c, t, '修改文件夹权限', f.name);
    })(); return c.json({ok: true});
  });

  app.get('/api/teams/:teamId/notes', c => {
    const t = team(c), rows = db.prepare('SELECT * FROM notes WHERE space_id=? ORDER BY updated_at DESC,id').all(t.id) as Row[];
    return c.json({notes: rows.filter(n => can(c, t, n.folder_id)).map(n => noteDto(c, t, n))});
  });
  app.get('/api/teams/:teamId/notes/:id', c => { const t = team(c); return c.json({note: noteDto(c, t, note(c, t, c.req.param('id')))}); });
  app.post('/api/teams/:teamId/notes', async c => {
    const body = await readBody(c, ['folderId']), folderId = targetFolder(body.folderId), noteId = randomUUID();
    const result = db.transaction(() => {
      const t = team(c); access(c, t, folderId, true, true);
      db.prepare('INSERT INTO notes(id,user_id,space_id,title,content,plain_text,folder_id,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(noteId, uid(c), t.id, '新备忘录', JSON.stringify({type: 'doc', content: [{type: 'paragraph'}]}), '', folderId, uid(c), now(), now());
      audit(c, t, '创建备忘录', '新备忘录'); return noteDto(c, t, note(c, t, noteId));
    })(); return c.json({note: result}, 201);
  });
  app.patch('/api/teams/:teamId/notes/:id', async c => {
    const body = await readBody(c, ['version', 'title', 'content', 'plainText', 'folderId', 'pinned', 'deletedAt']);
    const result = db.transaction(() => {
      const t = team(c), n = note(c, t, c.req.param('id'), true);
      if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) fail(400, '版本无效');
      if (body.version !== n.version) return {conflict: true, note: noteDto(c, t, n)};
      if ('content' in body && c.req.header('X-Notes-Editor') !== EDITOR_CAPABILITY && needsCurrentEditor(JSON.parse(n.content))) fail(409, '编辑器已更新，请刷新页面后重新编辑');
      if (['title', 'content', 'plainText'].some(key => key in body) && db.prepare('SELECT 1 FROM collaboration_documents WHERE note_id=?').get(n.id)) fail(409, '此备忘录已启用实时协作，请刷新后通过协作编辑器修改');
      if (folder(t, n.folder_id)?.deleted_at) fail(409, '请先恢复所属文件夹');
      const updates: Row = {};
      if ('title' in body) { if (typeof body.title !== 'string' || body.title.length > 200) fail(400, '标题不能超过 200 字'); updates.title = body.title; }
      if ('content' in body) { updates.content = JSON.stringify(validateContent(body.content)); deps.validateImages(body.content, t.id, uid(c), n.id); }
      if ('plainText' in body) { if (typeof body.plainText !== 'string' || body.plainText.length > 200000) fail(400, '正文过长'); updates.plain_text = body.plainText; }
      if ('pinned' in body) { if (typeof body.pinned !== 'boolean') fail(400, '置顶参数无效'); updates.pinned = Number(body.pinned); }
      if ('folderId' in body) {
        if (n.deleted_at) fail(400, '请先恢复备忘录');
        updates.folder_id = targetFolder(body.folderId); access(c, t, updates.folder_id, true, true);
      }
      if ('deletedAt' in body) {
        if (body.deletedAt !== null && (typeof body.deletedAt !== 'string' || !Number.isFinite(Date.parse(body.deletedAt)))) fail(400, '删除时间无效');
        updates.deleted_at = body.deletedAt === null ? null : now();
      }
      if (!Object.keys(updates).length) fail(400, '没有要更新的字段');
      if (n.deleted_at && Object.keys(updates).some(k => k !== 'deleted_at')) fail(400, '请先恢复备忘录');
      const changed = Object.entries(updates).filter(([k, v]) => n[k] !== v);
      if (changed.length) {
        const edited = changed.some(([k]) => ['title', 'content', 'plain_text'].includes(k));
        db.prepare(`UPDATE notes SET ${changed.map(([k]) => k + '=?').join(',')},version=version+1,updated_by=?,updated_at=? WHERE id=? AND space_id=?`).run(...changed.map(([, v]) => v), uid(c), edited ? now() : n.updated_at, n.id, t.id);
        if (!edited || changed.some(([k]) => ['folder_id', 'deleted_at'].includes(k))) audit(c, t, 'folder_id' in updates ? '移动备忘录' : 'deleted_at' in updates ? updates.deleted_at ? '删除备忘录' : '恢复备忘录' : '更新备忘录', n.title);
        else db.prepare('UPDATE teams SET revision=revision+1 WHERE id=?').run(t.id);
      }
      return {conflict: false, note: noteDto(c, t, note(c, t, n.id))};
    })(); return result.conflict ? c.json({error: '备忘录已被其他成员更新，本地内容仍保留', note: result.note}, 409) : c.json({note: result.note});
  });
  app.post('/api/teams/:teamId/notes/batch', async c => {
    const body = await readBody(c, ['operation', 'notes', 'folderId']);
    if (typeof body.operation !== 'string' || !['move', 'trash', 'restore'].includes(body.operation) || !Array.isArray(body.notes) || !body.notes.length || body.notes.length > 100) fail(400, '批量操作参数无效，最多 100 篇');
    const items = body.notes as Row[];
    if (new Set(items.map(n => id(n?.id))).size !== items.length) fail(400, '不能重复选择同一篇');
    const result = db.transaction(() => {
      const t = team(c), rows = items.map(item => note(c, t, item.id, true));
      rows.forEach((n, i) => { version(items[i].version, n); if (folder(t, n.folder_id)?.deleted_at) fail(409, '请先恢复所属文件夹'); if (body.operation === 'restore' ? !n.deleted_at : !!n.deleted_at) fail(409, '资料删除状态已变化'); });
      if (body.operation === 'move') {
        const destination = targetFolder(body.folderId); access(c, t, destination, true, true);
        rows.forEach(n => { if (n.folder_id !== destination) db.prepare('UPDATE notes SET folder_id=?,version=version+1,updated_by=? WHERE id=? AND space_id=?').run(destination, uid(c), n.id, t.id); });
      } else rows.forEach(n => db.prepare('UPDATE notes SET deleted_at=?,version=version+1,updated_by=? WHERE id=? AND space_id=?').run(body.operation === 'trash' ? now() : null, uid(c), n.id, t.id));
      audit(c, t, body.operation === 'move' ? '批量移动备忘录' : body.operation === 'trash' ? '批量删除备忘录' : '批量恢复备忘录', `${rows.length} 篇`);
      return rows.map(n => noteDto(c, t, note(c, t, n.id)));
    })(); return c.json({notes: result});
  });
  app.delete('/api/teams/:teamId/notes/:id', c => {
    db.transaction(() => { const t = team(c, 'manage'), n = note(c, t, c.req.param('id')); if (!n.deleted_at) fail(400, '只能永久删除最近删除中的资料'); db.prepare('DELETE FROM notes WHERE id=? AND space_id=?').run(n.id, t.id); audit(c, t, '永久删除备忘录', n.title); })(); return c.json({ok: true});
  });
  app.get('/api/teams/:teamId/activity', c => {
    const t = team(c, 'manage'), pageSize = Number(c.req.query('pageSize') ?? 20), requestedPage = Number(c.req.query('page') ?? 1);
    const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(requestedPage) || requestedPage < 1 || !Number.isSafeInteger(before) || before < 1 || c.req.query('before') && c.req.query('page')) fail(400, '分页参数无效');
    const total = (db.prepare('SELECT COUNT(*) AS n FROM activity_logs WHERE team_id=? AND id<?').get(t.id, before) as Row).n as number;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const rows = db.prepare("SELECT a.id,a.action,a.object_name AS objectName,a.created_at AS createdAt,u.username,COALESCE(NULLIF(u.nickname,''),u.username) AS nickname FROM activity_logs a JOIN users u ON u.id=a.actor_id WHERE a.team_id=? AND a.id<? ORDER BY a.id DESC LIMIT ? OFFSET ?").all(t.id, before, pageSize, (page - 1) * pageSize) as Row[];
    for (const row of rows) {
      if (row.action !== '调整成员角色') continue;
      const legacy = /^([0-9a-f-]{36}) → (owner|admin|editor|viewer)$/i.exec(row.objectName);
      if (legacy) row.objectName = `${memberLabel(legacy[1])} → ${roleLabels[legacy[2].toLowerCase() as Role]}`;
    }
    return c.json({activities: rows, total, page, pageSize, next: page * pageSize < total ? rows[rows.length - 1].id : null});
  });
  app.post('/api/teams/:teamId/notes/:id/presence', async c => {
    const body = await readBody(c, ['active']);
    if (typeof body.active !== 'boolean') fail(400, '编辑状态无效');
    const t = team(c), n = note(c, t, c.req.param('id'), true);
    if (body.active === false || n.deleted_at) db.prepare('DELETE FROM team_presence WHERE team_id=? AND user_id=?').run(t.id, uid(c));
    else db.prepare('INSERT INTO team_presence VALUES(?,?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET note_id=excluded.note_id,updated_at=excluded.updated_at').run(t.id, uid(c), n.id, Date.now());
    return c.json({ok: true});
  });
  app.get('/api/teams/:teamId/events', c => {
    team(c);
    return streamSSE(c, async stream => {
      let stopped = false, lastRevision = -1;
      stream.onAbort(() => { stopped = true; });
      while (!stopped) {
        try {
          const t = team(c);
          const rows = db.prepare(`SELECT p.note_id AS noteId,u.username,n.folder_id FROM team_presence p JOIN users u ON u.id=p.user_id JOIN notes n ON n.id=p.note_id JOIN team_members m ON m.team_id=p.team_id AND m.user_id=p.user_id WHERE m.role!='viewer' AND n.deleted_at IS NULL AND p.team_id=? AND p.updated_at>? AND p.user_id!=?`).all(t.id, Date.now() - 45000, uid(c)) as Row[];
          const editors = rows.filter(p => can(c, t, p.folder_id) && !folder(t, p.folder_id)?.deleted_at).map(p => ({noteId: p.noteId, username: p.username}));
          await stream.writeSSE({data: JSON.stringify({revision: t.revision, changed: lastRevision !== t.revision, editors})});
          lastRevision = t.revision;
        } catch { await stream.writeSSE({event: 'revoked', data: '{}'}); break; }
        await stream.sleep(3000);
      }
    });
  });
}
