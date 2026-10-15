import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// 链接可再次复制；令牌加密保存，密钥随整个数据目录备份，不存入 SQLite。
export function invitationLinkTokens(dataDir: string) {
  const keyPath = resolve(dataDir, 'invitation-link.key');
  let key: Buffer;
  try { key = readFileSync(keyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { writeFileSync(keyPath, randomBytes(32), {flag: 'wx', mode: 0o600}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    key = readFileSync(keyPath);
  }
  if (key.length !== 32) throw new Error('邀请链接密钥无效，请恢复数据目录中的 invitation-link.key');
  return {
    encrypt(token: string, id: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    decrypt(value: string, id: string) {
      const data = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
