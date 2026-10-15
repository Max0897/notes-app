import type Database from 'better-sqlite3';
import type {Hono, MiddlewareHandler} from 'hono';
import type {AppContext, AppEnv, JsonObject} from './index.js';

// 通知与业务操作在同一个 SQLite 事务中写入；失败和版本冲突不会产生通知。
export function initNotifications(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
      team_id TEXT, team_name TEXT, note_id TEXT, folder_id TEXT, invitation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id DESC);
    CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(user_id,read_at,id);
    DELETE FROM notifications WHERE kind='team_transfer';
  `);
  for (const deleting of [false, true]) {
    const row = deleting ? 'OLD' : 'NEW';
    const deletionChanged = '(OLD.deleted_at IS NULL) != (NEW.deleted_at IS NULL)';
    const kind = deleting ? "'note_permanently_deleted'" : `CASE WHEN ${deletionChanged} THEN CASE WHEN NEW.deleted_at IS NULL THEN 'note_restored' ELSE 'note_deleted' END ELSE 'note_moved' END`;
    const title = deleting ? "'备忘录已永久删除'" : `CASE WHEN ${deletionChanged} THEN CASE WHEN NEW.deleted_at IS NULL THEN '备忘录已恢复' ELSE '备忘录已删除' END ELSE '备忘录已移动' END`;
    const actor = `COALESCE((SELECT username FROM users WHERE id=${row}.updated_by),'团队成员')`;
    const message = deleting ? `'「' || ${row}.title || '」已永久删除'` : `${actor} || CASE WHEN ${deletionChanged} THEN CASE WHEN NEW.deleted_at IS NULL THEN ' 恢复了「' ELSE ' 删除了「' END ELSE ' 移动了「' END || NEW.title || '」'`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS notifications_note_${deleting ? 'delete' : 'update'}
      AFTER ${deleting ? 'DELETE' : 'UPDATE OF folder_id,deleted_at'} ON notes
      ${deleting ? '' : `WHEN OLD.folder_id IS NOT NEW.folder_id OR ${deletionChanged}`}
      BEGIN
        INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,note_id,folder_id)
        SELECT u.id,${kind},${title},${message},
          CASE WHEN ${row}.space_id=${row}.user_id THEN NULL ELSE ${row}.space_id END,t.name,${row}.id,${row}.folder_id
        FROM users u
        LEFT JOIN teams t ON t.id=${row}.space_id
        LEFT JOIN team_members m ON m.team_id=t.id AND m.user_id=u.id
        LEFT JOIN folders f ON f.id=${row}.folder_id AND f.space_id=${row}.space_id
        WHERE (${row}.space_id=${row}.user_id AND u.id=${row}.user_id)
          OR (t.deleted_at IS NULL AND m.user_id IS NOT NULL AND
            (m.role IN ('owner','admin') OR ${row}.folder_id IS NULL OR f.access_mode='team'
             OR EXISTS(SELECT 1 FROM folder_access a WHERE a.folder_id=f.id AND a.user_id=u.id)));
      END;`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notifications_team_lifecycle AFTER UPDATE OF deleted_at ON teams
    WHEN OLD.deleted_at IS NOT NEW.deleted_at BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name)
      SELECT user_id,CASE WHEN NEW.deleted_at IS NULL THEN 'team_restored' ELSE 'team_dissolved' END,
        CASE WHEN NEW.deleted_at IS NULL THEN '团队已恢复' ELSE '团队已解散' END,
        '「' || NEW.name || CASE WHEN NEW.deleted_at IS NULL THEN '」已恢复，可以继续协作' ELSE '」已解散，团队内容暂时无法访问' END,NEW.id,NEW.name
      FROM team_members WHERE team_id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS notifications_invitation_created AFTER INSERT ON team_invitations
    WHEN NEW.target_id IS NOT NULL BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,invitation_id)
      SELECT NEW.target_id,'team_invitation','收到团队邀请',u.username || ' 邀请你加入「' || t.name || '」',t.id,t.name,NEW.id
      FROM teams t JOIN users u ON u.id=NEW.created_by WHERE t.id=NEW.team_id;
    END;
    CREATE TRIGGER IF NOT EXISTS notifications_invitation_resent AFTER UPDATE OF token_hash ON team_invitations
    WHEN NEW.target_id IS NOT NULL AND NEW.status='pending' AND OLD.token_hash IS NOT NEW.token_hash BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,invitation_id)
      SELECT NEW.target_id,'team_invitation','收到新的团队邀请',u.username || ' 重新邀请你加入「' || t.name || '」',t.id,t.name,NEW.id
      FROM teams t JOIN users u ON u.id=NEW.created_by WHERE t.id=NEW.team_id;
    END;
    CREATE TRIGGER IF NOT EXISTS notifications_invitation_status AFTER UPDATE OF status ON team_invitations
    WHEN OLD.status IS NOT NEW.status AND NEW.status IN ('accepted','rejected','revoked') BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,invitation_id)
      SELECT u.id,'team_invitation_' || NEW.status,
        CASE NEW.status WHEN 'accepted' THEN '团队邀请已接受' WHEN 'rejected' THEN '团队邀请已拒绝' ELSE '团队邀请已撤销' END,
        '「' || t.name || '」的团队邀请' || CASE NEW.status WHEN 'accepted' THEN '已接受' WHEN 'rejected' THEN '已拒绝' ELSE '已撤销' END,t.id,t.name,NEW.id
      FROM users u JOIN teams t ON t.id=NEW.team_id
      WHERE u.id=NEW.created_by OR u.id=COALESCE(NEW.target_id,NEW.accepted_by);
    END;
    CREATE TRIGGER IF NOT EXISTS notifications_member_role AFTER UPDATE OF role ON team_members
    WHEN OLD.role IS NOT NEW.role BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name)
      SELECT NEW.user_id,'team_role_changed','团队角色已调整','你在「' || name || '」中的角色已调整为' ||
        CASE NEW.role WHEN 'owner' THEN '所有者' WHEN 'admin' THEN '管理员' WHEN 'editor' THEN '编辑者' ELSE '查看者' END,id,name
      FROM teams WHERE id=NEW.team_id;
    END;
    CREATE TRIGGER IF NOT EXISTS notifications_member_removed BEFORE DELETE ON team_members
    WHEN EXISTS(SELECT 1 FROM teams WHERE id=OLD.team_id AND deleted_at IS NULL) BEGIN
      INSERT INTO notifications(user_id,kind,title,message,team_id,team_name)
      SELECT OLD.user_id,'team_membership_ended','团队成员资格已结束','你已离开或被移出「' || name || '」，无法继续访问团队内容',id,name
      FROM teams WHERE id=OLD.team_id;
    END;
  `);
  // 已有的待处理站内邀请也能在首次打开通知中心时看到，不复制令牌。
  db.exec(`INSERT INTO notifications(user_id,kind,title,message,team_id,team_name,invitation_id)
    SELECT i.target_id,'team_invitation','收到团队邀请',u.username || ' 邀请你加入「' || t.name || '」',t.id,t.name,i.id
    FROM team_invitations i JOIN teams t ON t.id=i.team_id JOIN users u ON u.id=i.created_by
    WHERE i.target_id IS NOT NULL AND i.status='pending' AND t.deleted_at IS NULL AND i.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
      AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.invitation_id=i.id AND n.kind='team_invitation');`);
}

// 重新校验当前归属及权限；撤权后历史标题、未读计数和标记接口都不能泄露内容。
const visible = `n.user_id=? AND (n.team_id IS NULL OR n.kind NOT LIKE 'note_%' OR EXISTS(
  SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id
  LEFT JOIN notes live ON live.id=n.note_id AND live.space_id=t.id
  LEFT JOIN folders f ON f.id=CASE WHEN live.id IS NULL THEN n.folder_id ELSE live.folder_id END AND f.space_id=t.id
  WHERE m.team_id=n.team_id AND m.user_id=n.user_id AND t.deleted_at IS NULL AND
    (m.role IN ('owner','admin') OR (CASE WHEN live.id IS NULL THEN n.folder_id ELSE live.folder_id END) IS NULL
     OR f.access_mode='team' OR EXISTS(SELECT 1 FROM folder_access a WHERE a.folder_id=f.id AND a.user_id=n.user_id))
))`;

export function registerNotifications(app: Hono<AppEnv>, db: Database.Database, deps: {
  requireAuth: MiddlewareHandler<AppEnv>;
  readBody: (c: AppContext, keys: readonly string[]) => Promise<JsonObject>;
  requireLiveSession: (c: AppContext) => void;
  ApiError: new (status: 400 | 401 | 403 | 404 | 409 | 429, message: string) => Error;
}) {
  const {requireAuth, readBody, requireLiveSession, ApiError} = deps;
  const uid = (c: AppContext) => c.get('user')!.id;
  const unread = (userId: string) => (db.prepare(`SELECT COUNT(*) AS count FROM notifications n WHERE ${visible} AND n.read_at IS NULL`).get(userId) as {count: number}).count;
  function positiveId(value: unknown) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new ApiError(400, '通知编号无效');
    return Number(number);
  }
  app.use('/api/notifications', requireAuth);
  app.use('/api/notifications/*', requireAuth);
  app.get('/api/notifications/unread-count', c => c.json({unreadCount: unread(uid(c))}));
  app.get('/api/notifications', c => {
    const filter = c.req.query('filter') ?? 'all';
    if (!['all', 'unread'].includes(filter)) throw new ApiError(400, '通知筛选条件无效');
    const before = c.req.query('before') === undefined ? Number.MAX_SAFE_INTEGER : positiveId(c.req.query('before'));
    const rows = db.prepare(`SELECT n.id,n.kind,n.title,n.message,n.team_id AS teamId,n.team_name AS teamName,n.note_id AS noteId,n.created_at AS createdAt,n.read_at AS readAt,
      EXISTS(SELECT 1 FROM notes live WHERE live.id=n.note_id AND (n.team_id IS NULL OR live.space_id=n.team_id)) AS canOpen,
      EXISTS(SELECT 1 FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE i.id=n.invitation_id AND i.target_id=n.user_id AND i.status='pending' AND i.expires_at>? AND t.deleted_at IS NULL) AS canRespond
      FROM notifications n WHERE ${visible} AND n.id<? ${filter === 'unread' ? 'AND n.read_at IS NULL' : ''} ORDER BY n.id DESC LIMIT 41`).all(Date.now(), uid(c), before) as Record<string, any>[];
    return c.json({notifications: rows.slice(0, 40).map(n => ({...n, canOpen: !!n.canOpen, canRespond: !!n.canRespond})), next: rows.length > 40 ? rows[39].id : null, unreadCount: unread(uid(c))});
  });
  app.post('/api/notifications/read-all', async c => {
    const body = await readBody(c, ['throughId']);
    const throughId = positiveId(body.throughId);
    requireLiveSession(c);
    db.prepare(`UPDATE notifications SET read_at=? WHERE id IN(SELECT n.id FROM notifications n WHERE ${visible} AND n.read_at IS NULL AND n.id<=?)`).run(new Date().toISOString(), uid(c), throughId);
    return c.json({unreadCount: unread(uid(c))});
  });
  app.post('/api/notifications/:id/read', c => {
    const notificationId = positiveId(c.req.param('id'));
    requireLiveSession(c);
    if (!db.prepare(`SELECT 1 FROM notifications n WHERE ${visible} AND n.id=?`).get(uid(c), notificationId)) throw new ApiError(404, '通知不存在');
    db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?').run(new Date().toISOString(), notificationId, uid(c));
    return c.json({unreadCount: unread(uid(c))});
  });
}
