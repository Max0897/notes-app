import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {Hono, MiddlewareHandler} from 'hono';
import type {AppContext, AppEnv, JsonObject} from './index.js';
import {invitationLinkTokens} from './invitationLinks.js';
import {nextRun} from './webhookSchedule.js';
import {resolvePublic, safeFetch, WebhookUrlError} from './safeFetch.js';
import {isContentMode, isRobotType, ROBOTS, type RobotType} from './robotTypes.js';
import {buildNoteMessage, buildRobotRequest, interpretRobotResponse, validateRobotUrl, type RobotMessage} from './robots.js';
import {extractTodos} from './todos.js';

// 企业微信、飞书、钉钉机器人的定时推送：端点管理、定时调度、投递与重试。
type Row = Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WEBHOOKS = 5, MAX_SCHEDULES = 20, MAX_ATTEMPTS = 3;
// 测试进程可缩短最短提前量和重试间隔，以便在几秒内覆盖定时与重试；生产环境（NODE_ENV 不是 test）固定为下面的默认值。
const testTiming = process.env.NODE_ENV === 'test';
const MIN_LEAD = testTiming && process.env.TEST_WEBHOOK_MIN_LEAD_MS ? Number(process.env.TEST_WEBHOOK_MIN_LEAD_MS) : 30_000;
const BACKOFF = testTiming && process.env.TEST_WEBHOOK_BACKOFF_MS ? process.env.TEST_WEBHOOK_BACKOFF_MS.split(',').map(Number) : [60_000, 300_000]; // 第 1、2 次失败后的等待时间
const CATCH_UP = 60 * 60_000;                 // 停机后晚于计划 1 小时以上的推送直接跳过
const LEASE = 2 * 60_000;                     // 认领后的占用时间，进程中途退出时到期会被重新取走
const MAX_PARALLEL = 4, RETENTION = 30 * 24 * 60 * 60_000, IDLE_WAKE = 60_000;
const errorText: Record<string, string> = {ECONNREFUSED: '连接被拒绝', ENOTFOUND: '域名无法解析', ECONNRESET: '连接被重置', ETIMEDOUT: '连接超时', CERT_HAS_EXPIRED: '证书已过期', DEPTH_ZERO_SELF_SIGNED_CERT: '证书不受信任', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书不受信任'};

export function initWebhooks(db: Database.Database, options: {dataDir: string; publicOrigin: string}) {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(column => column.name));
  // 早期版本支持自定义 Webhook（HMAC 签名）。现只支持三家机器人，旧端点无法转换，连同其计划一并清除。
  const legacy = columns('webhooks').size > 0 && !columns('webhooks').has('type');
  if (legacy) db.exec('DROP TABLE IF EXISTS webhook_deliveries; DROP TABLE IF EXISTS webhook_schedules; DROP TABLE IF EXISTS webhooks;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
      secret_cipher TEXT NOT NULL DEFAULT '', keyword TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhooks_user ON webhooks(user_id);
    CREATE TABLE IF NOT EXISTS webhook_schedules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, minute_of_day INTEGER, weekday INTEGER, run_at INTEGER,
      content_mode TEXT NOT NULL DEFAULT 'summary',
      next_run_at INTEGER, last_run_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhook_schedules_due ON webhook_schedules(next_run_at) WHERE enabled=1 AND next_run_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS webhook_schedules_note ON webhook_schedules(note_id, user_id);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      schedule_id TEXT REFERENCES webhook_schedules(id) ON DELETE SET NULL, note_id TEXT, note_title TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
      http_status INTEGER, error TEXT, duration_ms INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, id DESC);
  `);
  if (!columns('webhook_schedules').has('content_mode')) db.exec("ALTER TABLE webhook_schedules ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'summary'");
  const tokens = invitationLinkTokens(options.dataDir);
  const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

  // ---------- 发送 ----------
  type Outcome = {ok: boolean; retryable: boolean; httpStatus: number | null; error: string | null; durationMs: number};
  async function post(hook: Row, message: RobotMessage): Promise<Outcome> {
    const started = Date.now();
    try {
      const secret = hook.secret_cipher ? tokens.decrypt(hook.secret_cipher, hook.id) : '';
      const request = buildRobotRequest(hook.type as RobotType, validateRobotUrl(hook.type, hook.url), message, {secret, keyword: hook.keyword});
      const result = await safeFetch(request.url, {body: request.body, headers: {'Content-Type': 'application/json', 'User-Agent': 'Notes-Webhook/2'}});
      const verdict = interpretRobotResponse(result.status, result.body);
      return {...verdict, httpStatus: result.status, durationMs: Date.now() - started};
    } catch (error) {
      const code = (error as {code?: string}).code;
      const message = error instanceof WebhookUrlError ? error.message : errorText[code ?? ''] ?? (error as Error).message ?? '发送失败';
      return {ok: false, retryable: !(error instanceof WebhookUrlError), httpStatus: null, error: message.slice(0, 200), durationMs: Date.now() - started};
    }
  }

  const finish = db.prepare('UPDATE webhook_deliveries SET status=?, next_attempt_at=NULL, http_status=?, error=?, duration_ms=?, finished_at=? WHERE id=?');
  async function run(id: number) {
    const delivery = db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(id) as Row | undefined;
    if (!delivery) return;
    const skip = (reason: string) => finish.run('skipped', null, reason, null, Date.now(), id);
    const hook = db.prepare('SELECT * FROM webhooks WHERE id=?').get(delivery.webhook_id) as Row | undefined;
    if (!hook || !hook.enabled) return skip('机器人已停用或已删除');
    const schedule = delivery.schedule_id ? db.prepare('SELECT * FROM webhook_schedules WHERE id=?').get(delivery.schedule_id) as Row | undefined : undefined;
    if (!schedule) return skip('推送计划已删除');
    // 推送时刻重新校验：笔记仍属于计划创建者且未删除，否则不发送并停用计划。
    const note = db.prepare('SELECT id,title,plain_text,content FROM notes WHERE id=? AND user_id=? AND space_id=user_id AND deleted_at IS NULL').get(delivery.note_id, schedule.user_id) as Row | undefined;
    if (!note) { db.prepare('UPDATE webhook_schedules SET enabled=0 WHERE id=?').run(schedule.id); return skip('备忘录已删除或不可用，已停用计划'); }
    let todos: ReturnType<typeof extractTodos> = [];
    if (schedule.content_mode !== 'summary') { try { todos = extractTodos(JSON.parse(note.content)); } catch { /* 正文无法解析时按无待办处理 */ } }
    const outcome = await post(hook, buildNoteMessage({id: note.id, title: note.title, plainText: note.plain_text, todos}, schedule.content_mode, options.publicOrigin));
    const now = Date.now();
    if (outcome.ok) finish.run('ok', outcome.httpStatus, null, outcome.durationMs, now, id);
    else if (outcome.retryable && delivery.attempt < MAX_ATTEMPTS) {
      db.prepare("UPDATE webhook_deliveries SET status='pending', next_attempt_at=?, http_status=?, error=?, duration_ms=? WHERE id=?").run(now + BACKOFF[delivery.attempt - 1], outcome.httpStatus, outcome.error, outcome.durationMs, id);
    } else finish.run('failed', outcome.httpStatus, outcome.error, outcome.durationMs, now, id);
  }

  // ---------- 调度 ----------
  let timer: NodeJS.Timeout | undefined, active = 0, ticking = false, stopped = true, lastCleanup = 0;
  function claimSchedules(now: number) {
    const due = db.prepare('SELECT * FROM webhook_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 50').all(now) as Row[];
    for (const schedule of due) db.transaction(() => {
      const following = schedule.kind === 'once' ? null : nextRun(schedule.kind, schedule.minute_of_day, schedule.weekday, now);
      // 条件更新即认领：同一条计划只会被一个调用推进，不会重复生成推送。
      if (db.prepare('UPDATE webhook_schedules SET next_run_at=?, last_run_at=? WHERE id=? AND next_run_at=?').run(following, now, schedule.id, schedule.next_run_at).changes !== 1) return;
      const note = db.prepare('SELECT title FROM notes WHERE id=?').get(schedule.note_id) as Row | undefined;
      const missed = now - schedule.next_run_at > CATCH_UP;
      db.prepare('INSERT INTO webhook_deliveries (webhook_id,schedule_id,note_id,note_title,kind,status,error,created_at,next_attempt_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(schedule.webhook_id, schedule.id, schedule.note_id, note?.title ?? null, 'schedule', missed ? 'skipped' : 'pending', missed ? '服务暂停期间错过，已跳过' : null, now, missed ? null : now, missed ? now : null);
    })();
  }
  function wakeDelay(now: number) {
    const next = Math.min(
      (db.prepare('SELECT MIN(next_run_at) AS t FROM webhook_schedules WHERE enabled=1 AND next_run_at IS NOT NULL').get() as Row).t ?? Infinity,
      (db.prepare("SELECT MIN(next_attempt_at) AS t FROM webhook_deliveries WHERE status='pending'").get() as Row).t ?? Infinity);
    return Math.min(IDLE_WAKE, Math.max(250, next - now));
  }
  // 按最近一次到期时间设定时器；空闲时 60 秒兜底唤醒一次。新增或修改计划后调用，重新瞄准最近时间。
  function arm() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), wakeDelay(Date.now()));
    timer.unref();
  }
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const now = Date.now();
      claimSchedules(now);
      const slots = MAX_PARALLEL - active;
      const pending = slots > 0 ? db.prepare("SELECT id,next_attempt_at FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?").all(now, slots) as Row[] : [];
      for (const item of pending) {
        // 占用：先把下次时间推到租约之后并累加次数，再发送；进程中途退出时租约到期会被重新取走。
        if (db.prepare("UPDATE webhook_deliveries SET attempt=attempt+1, next_attempt_at=? WHERE id=? AND status='pending' AND next_attempt_at=?").run(now + LEASE, item.id, item.next_attempt_at).changes !== 1) continue;
        active++;
        void run(item.id).catch(error => console.error('机器人推送异常', error)).finally(() => { active--; arm(); });
      }
      if (now - lastCleanup > 60 * 60_000) { lastCleanup = now; db.prepare("DELETE FROM webhook_deliveries WHERE status!='pending' AND created_at<?").run(now - RETENTION); }
    } catch (error) { console.error('机器人调度异常', error); }
    finally { ticking = false; arm(); }
  }

  // ---------- 接口 ----------
  function register(app: Hono<AppEnv>, deps: {
    requireAuth: MiddlewareHandler<AppEnv>; requireLiveSession: (c: AppContext) => void;
    readBody: (c: AppContext, keys: readonly string[]) => Promise<JsonObject>;
    ApiError: new (status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string) => Error;
    takeRateLimit: (key: string, maximum: number, windowMs: number) => number;
  }) {
    const {requireAuth, requireLiveSession, readBody, ApiError, takeRateLimit} = deps;
    function fail(status: 400 | 403 | 404 | 409 | 429, message: string): never { throw new ApiError(status, message); }
    const uid = (c: AppContext) => c.get('user')!.id;
    const param = (c: AppContext, name: string) => { const value = c.req.param(name); return value && uuid.test(value) ? value : fail(400, '资源编号无效'); };
    const ownedHook = (c: AppContext, id: string) => (db.prepare('SELECT * FROM webhooks WHERE id=? AND user_id=?').get(id, uid(c)) as Row | undefined) ?? fail(404, '机器人不存在');
    const ownedNote = (c: AppContext, id: string) => (db.prepare('SELECT id,title FROM notes WHERE id=? AND user_id=? AND space_id=user_id AND deleted_at IS NULL').get(id, uid(c)) as Row | undefined) ?? fail(404, '备忘录不存在，或为团队备忘录（暂不支持定时推送）');
    function nameValue(value: unknown) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || Array.from(name).length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) fail(400, '名称须为 1 至 32 个字符');
      return name;
    }
    async function urlValue(type: RobotType, value: unknown) {
      try { const url = validateRobotUrl(type, value); await resolvePublic(url.hostname); return url.href; }
      catch (error) { if (error instanceof WebhookUrlError) fail(400, error.message); throw error; }
    }
    const capabilities = (type: RobotType) => ROBOTS.find(robot => robot.id === type)!;
    function secretValue(type: RobotType, value: unknown) {
      if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f]/u.test(value)) fail(400, '加签密钥无效');
      if (value && !capabilities(type).signing) fail(400, '该机器人不支持加签');
      return value.trim();
    }
    function keywordValue(type: RobotType, value: unknown) {
      if (typeof value !== 'string' || Array.from(value).length > 20 || /[\u0000-\u001f]/u.test(value)) fail(400, '关键词最多 20 个字符');
      if (value && !capabilities(type).keyword) fail(400, '该机器人不支持自定义关键词');
      return value.trim();
    }
    // 机器人地址会完整回显给所有者本人；加签密钥不回显，只标明是否已设置。
    const hookView = (row: Row) => {
      const last = db.prepare('SELECT status,created_at AS at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1').get(row.id) as Row | undefined;
      return {id: row.id, type: row.type, name: row.name, url: row.url, keyword: row.keyword, hasSecret: !!row.secret_cipher, enabled: !!row.enabled, createdAt: row.created_at,
        scheduleCount: (db.prepare('SELECT COUNT(*) AS n FROM webhook_schedules WHERE webhook_id=?').get(row.id) as Row).n,
        lastDelivery: last ? {status: last.status, at: iso(last.at)} : null};
    };
    const scheduleView = (row: Row) => ({
      id: row.id, webhookId: row.webhook_id, webhookName: row.webhook_name ?? '', noteId: row.note_id, kind: row.kind, contentMode: row.content_mode,
      time: row.minute_of_day === null ? null : `${String(Math.floor(row.minute_of_day / 60)).padStart(2, '0')}:${String(row.minute_of_day % 60).padStart(2, '0')}`,
      weekday: row.weekday, runAt: iso(row.run_at), nextRunAt: iso(row.next_run_at), lastRunAt: iso(row.last_run_at), enabled: !!row.enabled,
    });

    app.use('/api/webhooks', requireAuth); app.use('/api/webhooks/*', requireAuth); app.use('/api/webhook-schedules/*', requireAuth);
    app.get('/api/webhooks', c => c.json({webhooks: (db.prepare('SELECT * FROM webhooks WHERE user_id=? ORDER BY created_at, id').all(uid(c)) as Row[]).map(hookView)}));
    app.post('/api/webhooks', async c => {
      const body = await readBody(c, ['type', 'name', 'url', 'secret', 'keyword']);
      requireLiveSession(c);
      const type = isRobotType(body.type) ? body.type : fail(400, '请选择机器人类型');
      if ((db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE user_id=?').get(uid(c)) as Row).n >= MAX_WEBHOOKS) fail(409, `最多添加 ${MAX_WEBHOOKS} 个机器人`);
      const name = nameValue(body.name), url = await urlValue(type, body.url), id = randomUUID();
      const secret = 'secret' in body ? secretValue(type, body.secret) : '', keyword = 'keyword' in body ? keywordValue(type, body.keyword) : '';
      db.prepare('INSERT INTO webhooks (id,user_id,type,name,url,secret_cipher,keyword,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, uid(c), type, name, url, secret ? tokens.encrypt(secret, id) : '', keyword, new Date().toISOString());
      return c.json({webhook: hookView(ownedHook(c, id))}, 201);
    });
    // secret 为空字符串表示清除已保存的加签密钥；不传该字段表示保持不变。类型创建后不可更改。
    app.patch('/api/webhooks/:id', async c => {
      const hook = ownedHook(c, param(c, 'id')), body = await readBody(c, ['name', 'url', 'enabled', 'secret', 'keyword']);
      requireLiveSession(c);
      const type = hook.type as RobotType;
      const name = 'name' in body ? nameValue(body.name) : hook.name;
      const url = 'url' in body ? await urlValue(type, body.url) : hook.url;
      const keyword = 'keyword' in body ? keywordValue(type, body.keyword) : hook.keyword;
      let secretCipher = hook.secret_cipher;
      if ('secret' in body) { const secret = secretValue(type, body.secret); secretCipher = secret ? tokens.encrypt(secret, hook.id) : ''; }
      if ('enabled' in body && typeof body.enabled !== 'boolean') fail(400, '启用状态无效');
      db.prepare('UPDATE webhooks SET name=?, url=?, keyword=?, secret_cipher=?, enabled=? WHERE id=?').run(name, url, keyword, secretCipher, 'enabled' in body ? Number(body.enabled) : hook.enabled, hook.id);
      return c.json({webhook: hookView(ownedHook(c, hook.id))});
    });
    app.delete('/api/webhooks/:id', c => {
      requireLiveSession(c);
      db.prepare('DELETE FROM webhooks WHERE id=? AND user_id=?').run(ownedHook(c, param(c, 'id')).id, uid(c));
      return c.json({ok: true});
    });
    app.post('/api/webhooks/:id/test', async c => {
      const hook = ownedHook(c, param(c, 'id'));
      requireLiveSession(c);
      const retry = takeRateLimit(`webhook-test:${uid(c)}`, 10, 60 * 60_000);
      if (retry) { c.header('Retry-After', String(retry)); fail(429, '测试推送过于频繁，请稍后重试'); }
      const outcome = await post(hook, {title: '📝 测试推送', lines: ['这是一条来自备忘录的测试消息，收到即表示机器人配置正确。']});
      const now = Date.now();
      db.prepare('INSERT INTO webhook_deliveries (webhook_id,note_title,kind,status,attempt,http_status,error,duration_ms,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(hook.id, '测试推送', 'test', outcome.ok ? 'ok' : 'failed', 1, outcome.httpStatus, outcome.error, outcome.durationMs, now, now);
      return c.json({ok: outcome.ok, httpStatus: outcome.httpStatus, error: outcome.error, durationMs: outcome.durationMs});
    });
    app.get('/api/webhooks/:id/deliveries', c => {
      const hook = ownedHook(c, param(c, 'id'));
      const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 30').all(hook.id) as Row[];
      return c.json({deliveries: rows.map(row => ({id: row.id, kind: row.kind, status: row.status, attempt: row.attempt, noteTitle: row.note_title, httpStatus: row.http_status, error: row.error, durationMs: row.duration_ms, createdAt: iso(row.created_at), nextAttemptAt: iso(row.next_attempt_at)}))});
    });

    const scheduleSelect = 'SELECT s.*, w.name AS webhook_name FROM webhook_schedules s JOIN webhooks w ON w.id=s.webhook_id';
    app.get('/api/notes/:noteId/schedules', c => {
      const note = ownedNote(c, param(c, 'noteId'));
      return c.json({schedules: (db.prepare(`${scheduleSelect} WHERE s.note_id=? AND s.user_id=? ORDER BY s.created_at, s.id`).all(note.id, uid(c)) as Row[]).map(scheduleView)});
    });
    app.post('/api/notes/:noteId/schedules', async c => {
      const note = ownedNote(c, param(c, 'noteId')), body = await readBody(c, ['webhookId', 'kind', 'time', 'weekday', 'runAt', 'contentMode']);
      requireLiveSession(c);
      const hook = ownedHook(c, typeof body.webhookId === 'string' && uuid.test(body.webhookId) ? body.webhookId : fail(400, '请选择机器人'));
      const contentMode = 'contentMode' in body ? (isContentMode(body.contentMode) ? body.contentMode : fail(400, '推送内容无效')) : 'summary';
      if ((db.prepare('SELECT COUNT(*) AS n FROM webhook_schedules WHERE user_id=?').get(uid(c)) as Row).n >= MAX_SCHEDULES) fail(409, `最多创建 ${MAX_SCHEDULES} 个推送计划`);
      const now = Date.now(), kind = body.kind;
      let minute: number | null = null, weekday: number | null = null, runAt: number | null = null, next: number;
      if (kind === 'once') {
        runAt = typeof body.runAt === 'string' ? Date.parse(body.runAt) : NaN;
        if (!Number.isFinite(runAt) || runAt < now + MIN_LEAD || runAt > now + 366 * 24 * 60 * 60_000) fail(400, '推送时间须在未来一年内');
        next = runAt;
      } else if (kind === 'daily' || kind === 'weekly') {
        const match = typeof body.time === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(body.time) : null;
        if (!match) fail(400, '推送时间格式应为 HH:MM');
        minute = Number(match![1]) * 60 + Number(match![2]);
        if (kind === 'weekly') {
          if (!Number.isInteger(body.weekday) || (body.weekday as number) < 0 || (body.weekday as number) > 6) fail(400, '请选择星期');
          weekday = body.weekday as number;
        }
        next = nextRun(kind, minute, weekday, now);
      } else return fail(400, '重复方式无效');
      const id = randomUUID();
      db.prepare('INSERT INTO webhook_schedules (id,user_id,webhook_id,note_id,kind,minute_of_day,weekday,run_at,content_mode,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, uid(c), hook.id, note.id, kind, minute, weekday, runAt, contentMode, next, new Date().toISOString());
      arm();
      return c.json({schedule: scheduleView(db.prepare(`${scheduleSelect} WHERE s.id=?`).get(id) as Row)}, 201);
    });
    app.patch('/api/webhook-schedules/:id', async c => {
      const id = param(c, 'id'), schedule = db.prepare('SELECT * FROM webhook_schedules WHERE id=? AND user_id=?').get(id, uid(c)) as Row | undefined ?? fail(404, '推送计划不存在');
      const body = await readBody(c, ['enabled']);
      requireLiveSession(c);
      if (typeof body.enabled !== 'boolean') fail(400, '启用状态无效');
      let next = schedule.next_run_at;
      if (body.enabled) {
        ownedNote(c, schedule.note_id);
        // 重新启用：一次性计划须仍在未来；重复计划从现在起重新计算下一次，不补发停用期间的推送。
        if (schedule.kind === 'once') { if (schedule.run_at < Date.now() + MIN_LEAD) fail(409, '该一次性推送时间已过，请新建计划'); next = schedule.run_at; }
        else next = nextRun(schedule.kind, schedule.minute_of_day, schedule.weekday, Date.now());
      }
      db.prepare('UPDATE webhook_schedules SET enabled=?, next_run_at=? WHERE id=?').run(Number(body.enabled), next, id);
      arm();
      return c.json({schedule: scheduleView(db.prepare(`${scheduleSelect} WHERE s.id=?`).get(id) as Row)});
    });
    app.delete('/api/webhook-schedules/:id', c => {
      requireLiveSession(c);
      const changed = db.prepare('DELETE FROM webhook_schedules WHERE id=? AND user_id=?').run(param(c, 'id'), uid(c)).changes;
      if (!changed) fail(404, '推送计划不存在');
      return c.json({ok: true});
    });
  }

  return {
    register,
    start() { if (!stopped) return; stopped = false; void tick(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
