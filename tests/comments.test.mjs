import assert from 'node:assert/strict';
import test from 'node:test';
import {relativeTime} from '../src/relativeTime.ts';
import {checkedAnchor} from '../server/notebook.ts';

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

test('评论引用位置校验：只保留合法的 Yjs 相对位置与引用文字', () => {
  const position = {type: {client: 12345, clock: 7}, assoc: 0};
  const anchor = {from: position, to: {tname: 'default', assoc: -1}, quote: '  选中的\n文字  '};
  assert.deepEqual(checkedAnchor(anchor), {from: position, to: {tname: 'default', assoc: -1}, quote: '选中的 文字'});
  assert.equal(checkedAnchor({...anchor, quote: 'x'.repeat(300)}).quote.length, 200);
  // 多余字段被丢弃，不会写入数据库。
  assert.deepEqual(checkedAnchor({from: {item: {client: 1, clock: 2}, extra: 1}, to: position, quote: 'a'}), null);
  for (const bad of [null, [], 'x', {}, {from: position, to: position}, {from: position, to: position, quote: '  '}, {from: position, to: position, quote: 'a', extra: 1},
    {from: {}, to: position, quote: 'a'}, {from: {type: {client: -1, clock: 0}}, to: position, quote: 'a'}, {from: {type: {client: 1.5, clock: 0}}, to: position, quote: 'a'},
    {from: {item: {client: 1, clock: 2, extra: 3}}, to: position, quote: 'a'}, {from: {tname: 'x'.repeat(101)}, to: position, quote: 'a'}, {from: {tname: 'a', assoc: 5}, to: position, quote: 'a'},
    {from: {type: 'text'}, to: position, quote: 'a'}]) assert.equal(checkedAnchor(bad), null, JSON.stringify(bad)?.slice(0, 60));
});
