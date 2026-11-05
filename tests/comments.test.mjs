import assert from 'node:assert/strict';
import test from 'node:test';
import {relativeTime} from '../src/relativeTime.ts';

// 使用本地时区构造时间，避免测试结果依赖运行环境的时区。
const at = (year, month, day, hour = 0, minute = 0, second = 0) => new Date(year, month - 1, day, hour, minute, second);
const now = at(2026, 11, 5, 14, 30).getTime();
const label = date => relativeTime(date.toISOString(), now);

test('评论相对时间：刚刚、分钟、小时、昨天、同年与跨年', () => {
  assert.equal(label(at(2026, 11, 5, 14, 29, 30)), '刚刚');
  assert.equal(label(at(2026, 11, 5, 14, 30, 5)), '刚刚', '时钟略有偏差时不应出现负数');
  assert.equal(label(at(2026, 11, 5, 14, 25)), '5 分钟前');
  assert.equal(label(at(2026, 11, 5, 13, 31)), '59 分钟前');
  assert.equal(label(at(2026, 11, 5, 9, 15)), '5 小时前');
  assert.equal(label(at(2026, 11, 4, 23, 50)), '昨天 23:50', '不足 24 小时但已跨天按昨天显示');
  assert.equal(label(at(2026, 11, 4, 9, 5)), '昨天 09:05');
  assert.equal(label(at(2026, 11, 1, 8, 0)), '11月1日 08:00');
  assert.equal(label(at(2025, 12, 31, 20, 0)), '2025年12月31日');
  assert.equal(relativeTime('not a date', now), '刚刚');
});
