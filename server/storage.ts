import {statfsSync} from 'node:fs';
import type Database from 'better-sqlite3';

const MiB = 1024 * 1024, DAY = 86400000;
export type StorageLimits = {personal: number; team: number; userDaily: number; teamDaily: number; global: number; minFreeDisk: number};
type ErrorType = new (status: 409 | 503, message: string) => Error;
type Reservation = {userId: string; spaceId: string; team: boolean; day: string; output: number; maxBytes: number; charged: boolean};
// Daily upload budgets reset at midnight in Asia/Shanghai.
export function uploadDay(now: number) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
const dayStart = (day: string) => Date.parse(day + 'T00:00:00+08:00');
export function storageLimits(): StorageLimits {
  const setting = (name: string, fallback: number, zero = false) => {
    const raw = process.env[name] ?? String(fallback), value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || !Number.isSafeInteger(value * MiB)) throw new Error(name + ' 必须为有效的整数 MB');
    return value * MiB;
  };
  return {personal: setting('IMAGE_PERSONAL_LIMIT_MB', 200), team: setting('IMAGE_TEAM_LIMIT_MB', 1024),
    userDaily: setting('IMAGE_USER_DAILY_MB', 100), teamDaily: setting('IMAGE_TEAM_DAILY_MB', 500),
    global: setting('IMAGE_GLOBAL_LIMIT_MB', 20480), minFreeDisk: setting('IMAGE_MIN_FREE_DISK_MB', 10240, true)};
}

export function initStorage(db: Database.Database, dataDir: string, ApiError: ErrorType, options: {
  limits?: StorageLimits; now?: () => number; freeBytes?: () => number;
} = {}) {
  const limits = options.limits ?? storageLimits(), now = options.now ?? Date.now;
  const freeBytes = options.freeBytes ?? (() => { const fs = statfsSync(dataDir); return fs.bavail * fs.bsize; });
  const reservations = new Set<Reservation>();
  db.transaction(() => {
    const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_upload_daily'").get();
    db.exec(`CREATE INDEX IF NOT EXISTS images_space ON images(space_id);
      CREATE TABLE IF NOT EXISTS image_upload_daily (
        kind TEXT NOT NULL CHECK(kind IN ('user','team')), owner_id TEXT NOT NULL, day TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(kind,owner_id,day)
      ); CREATE INDEX IF NOT EXISTS image_upload_daily_day ON image_upload_daily(day);`);
    if (!existed) {
      // Original input sizes are unavailable before this migration; use stored
      // sizes for today's existing uploads, then keep a durable independent ledger.
      const day = uploadDay(now()), start = dayStart(day);
      db.prepare(`INSERT INTO image_upload_daily SELECT 'user',uploaded_by,?,SUM(size) FROM images
        WHERE uploaded_by IS NOT NULL AND created_at>=? AND created_at<? GROUP BY uploaded_by`).run(day, start, start + DAY);
      db.prepare(`INSERT INTO image_upload_daily SELECT 'team',i.space_id,?,SUM(i.size) FROM images i JOIN spaces s ON s.id=i.space_id
        WHERE s.kind='team' AND i.created_at>=? AND i.created_at<? GROUP BY i.space_id`).run(day, start, start + DAY);
    }
  })();
  const used = (spaceId?: string) => (db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM images' + (spaceId ? ' WHERE space_id=?' : '')).get(...(spaceId ? [spaceId] : [])) as {bytes: number; count: number});
  const daily = (kind: string, ownerId: string, day: string) => (db.prepare('SELECT bytes FROM image_upload_daily WHERE kind=? AND owner_id=? AND day=?').get(kind, ownerId, day) as {bytes: number} | undefined)?.bytes ?? 0;
  const reserved = (filter: (reservation: Reservation) => boolean) => [...reservations].filter(filter).reduce((total, reservation) => total + reservation.output, 0);
  function usage(userId: string, spaceId: string, team: boolean) {
    const day = uploadDay(now()), stored = used(spaceId);
    return {spaceId, kind: team ? 'team' : 'personal', usedBytes: stored.bytes, limitBytes: team ? limits.team : limits.personal, imageCount: stored.count,
      today: {usedBytes: daily(team ? 'team' : 'user', team ? spaceId : userId, day), limitBytes: team ? limits.teamDaily : limits.userDaily,
        userUsedBytes: daily('user', userId, day), userLimitBytes: limits.userDaily, resetsAt: new Date(dayStart(day) + DAY).toISOString()}};
  }
  function reserve(userId: string, spaceId: string, team: boolean, maxImageBytes: number) {
    const day = uploadDay(now());
    const userRoom = limits.userDaily - daily('user', userId, day);
    const teamRoom = team ? limits.teamDaily - daily('team', spaceId, day) : Infinity;
    if (userRoom <= 0) throw new ApiError(409, '今日个人上传额度不足，请在明日额度恢复后重试');
    if (teamRoom <= 0) throw new ApiError(409, '今日团队上传额度不足，请在明日额度恢复后重试');
    const spaceRoom = (team ? limits.team : limits.personal) - used(spaceId).bytes - reserved(r => r.spaceId === spaceId);
    if (spaceRoom <= 0) throw new ApiError(409, (team ? '团队' : '个人') + '存储空间不足，请清理图片或稍后重试');
    const allReserved = reserved(() => true);
    const globalRoom = limits.global - used().bytes - allReserved;
    const diskRoom = freeBytes() - limits.minFreeDisk - allReserved;
    if (globalRoom <= 0 || diskRoom <= 0) throw new ApiError(503, '服务器存储空间不足，暂时无法上传图片');
    // Admit bounded requests first; reserve exact bytes once known. Reserving
    // the maximum image size here would reject small concurrent uploads near full.
    const reservation = {userId, spaceId, team, day, output: 0, maxBytes: maxImageBytes, charged: false};
    reservations.add(reservation); return reservation;
  }
  function charge(reservation: Reservation, bytes: number) {
    if (!reservations.has(reservation) || reservation.charged) throw new Error('无效的上传额度预留');
    const add = db.prepare(`INSERT INTO image_upload_daily(kind,owner_id,day,bytes) VALUES(?,?,?,?)
      ON CONFLICT(kind,owner_id,day) DO UPDATE SET bytes=bytes+excluded.bytes`);
    db.transaction(() => {
      const userRoom = limits.userDaily - daily('user', reservation.userId, reservation.day);
      const teamRoom = reservation.team ? limits.teamDaily - daily('team', reservation.spaceId, reservation.day) : Infinity;
      if (bytes > reservation.maxBytes || bytes > userRoom || bytes > teamRoom) throw new ApiError(409, '图片超过今日剩余上传额度，请缩小后重试');
      add.run('user', reservation.userId, reservation.day, bytes);
      if (reservation.team) add.run('team', reservation.spaceId, reservation.day, bytes);
    })();
    reservation.charged = true;
  }
  function checkOutput(reservation: Reservation, bytes: number) {
    if (!reservations.has(reservation) || !reservation.charged) throw new Error('无效的上传额度预留');
    const otherReserved = reserved(r => r !== reservation);
    const spaceReserved = reserved(r => r !== reservation && r.spaceId === reservation.spaceId);
    if (bytes > reservation.maxBytes || used(reservation.spaceId).bytes + bytes + spaceReserved > (reservation.team ? limits.team : limits.personal)) throw new ApiError(409, '图片超过剩余存储容量，请清理空间或缩小图片后重试');
    if (used().bytes + bytes + otherReserved > limits.global || freeBytes() - bytes - otherReserved < limits.minFreeDisk) throw new ApiError(503, '服务器存储空间不足，暂时无法上传图片');
    // The caller writes the file and DB row synchronously before releasing this
    // reservation; no other HTTP task can interleave the check and commit.
    reservation.output = bytes;
  }
  function cleanup(time = now()) { db.prepare('DELETE FROM image_upload_daily WHERE day<?').run(uploadDay(time - 7 * DAY)); }
  return {usage, reserve, charge, checkOutput, release: (reservation: Reservation) => reservations.delete(reservation), cleanup};
}
