const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../punch.js');

const at = s => Date.parse(s); // '2026-11-27T09:12:00+09:00'
const E = (date, category, location, s, e, notes = '') =>
  ({ id: 1, date, category, location, startTime: s, endTime: e, breakTime: '01:00', overtime: '00:00', notes });

test('開始報告・記録なし: 出勤で新しく作り、始業は30分切り捨て', () => {
  const r = P.planPunch({ type: 'start', nowMs: at('2026-11-27T09:12:00+09:00'), entries: [], location: '出社', tasks: ['撮影', '打合せ'] });
  assert.equal(r.isNew, true);
  assert.deepEqual(r.entry, { date: '2026-11-27', category: '出勤', startTime: '09:00', endTime: '', breakTime: '01:00',
                              overtime: '00:00', location: '出社', notes: '撮影, 打合せ' });
});

test('開始報告・土曜は休日出勤', () => {
  const r = P.planPunch({ type: 'start', nowMs: at('2026-11-28T10:40:00+09:00'), entries: [], location: 'リモート', tasks: [] });
  assert.equal(r.entry.category, '休日出勤');
  assert.equal(r.entry.startTime, '10:30');
});

test('開始報告・記録あり: 始業・場所・作業内容だけ書き換える', () => {
  const r = P.planPunch({ type: 'start', nowMs: at('2026-11-27T13:05:00+09:00'),
    entries: [E('2026-11-27', '出勤', 'リモート', '09:00', '18:00', '撮影')], location: '混在', tasks: ['動画編集'] });
  assert.equal(r.isNew, false);
  assert.equal(r.entry.startTime, '13:00');
  assert.equal(r.entry.endTime, '18:00');
  assert.equal(r.entry.location, '混在');
  assert.equal(r.entry.notes, '動画編集');
  assert.equal(r.entry.id, 1);
});

test('終了報告・記録あり: 終業だけ変え、作業内容が未選択なら残す', () => {
  const r = P.planPunch({ type: 'end', nowMs: at('2026-11-27T17:55:00+09:00'),
    entries: [E('2026-11-27', '出勤', '出社', '09:00', '', '撮影')], location: 'リモート', tasks: [] });
  assert.equal(r.entry.startTime, '09:00');
  assert.equal(r.entry.endTime, '17:30');
  assert.equal(r.entry.location, '出社');
  assert.equal(r.entry.notes, '撮影');
});

test('終了報告・記録なし: 終業だけの記録を作る', () => {
  const r = P.planPunch({ type: 'end', nowMs: at('2026-11-27T18:10:00+09:00'), entries: [], location: '出社', tasks: [] });
  assert.equal(r.isNew, true);
  assert.equal(r.entry.startTime, '');
  assert.equal(r.entry.endTime, '18:00');
});

test('0:00〜4:59 の終了報告は前日の終業', () => {
  const r = P.planPunch({ type: 'end', nowMs: at('2026-11-28T01:20:00+09:00'),
    entries: [E('2026-11-27', '出勤', 'リモート', '10:00', '')], location: 'リモート', tasks: [] });
  assert.equal(r.date, '2026-11-27');
  assert.equal(r.entry.endTime, '01:00');
  // 5:00 ちょうどは当日
  const r2 = P.planPunch({ type: 'end', nowMs: at('2026-11-28T05:00:00+09:00'), entries: [], location: 'リモート', tasks: [] });
  assert.equal(r2.date, '2026-11-28');
  // 開始報告は深夜でも当日
  const r3 = P.planPunch({ type: 'start', nowMs: at('2026-11-28T01:20:00+09:00'), entries: [], location: 'リモート', tasks: [] });
  assert.equal(r3.date, '2026-11-28');
});

test('年休・欠勤の日は反映しない', () => {
  const r = P.planPunch({ type: 'start', nowMs: at('2026-11-27T09:00:00+09:00'),
    entries: [E('2026-11-27', '年休', '', '', '')], location: 'リモート', tasks: [] });
  assert.equal(r.entry, null);
  assert.match(r.skipped, /年休の記録があるため反映しませんでした/);
});

test('UTC の端末時刻でも日本時間で判定する', () => {
  const r = P.planPunch({ type: 'start', nowMs: at('2026-11-27T00:15:00Z'), entries: [], location: 'リモート', tasks: [] });
  assert.equal(r.date, '2026-11-27');
  assert.equal(r.entry.startTime, '09:00');
});

test('comparePunches: 一致・差分・記録なし・年休・範囲外・到着出発', () => {
  const punches = [
    { date: '2026-11-02', type: 'start', clientTime: '2026-11-02T09:10:00+09:00', receivedAt: '2026-11-02 09:10:03' },
    { date: '2026-11-02', type: 'end',   clientTime: '2026-11-02T18:05:00+09:00', receivedAt: '2026-11-02 18:05:02' },
    // 送り直しで2行: 最初の開始を使う
    { date: '2026-11-04', type: 'start', clientTime: '2026-11-04T09:40:00+09:00' },
    { date: '2026-11-04', type: 'start', clientTime: '2026-11-04T09:50:00+09:00' },
    { date: '2026-11-04', type: 'arrive', clientTime: '', receivedAt: '2026-11-04 09:35:00' },
    { date: '2026-11-05', type: 'end', clientTime: '2026-11-06T01:10:00+09:00' }, // 深夜の終了
    { date: '2026-11-06', type: 'start', clientTime: '2026-11-06T09:00:00+09:00' },
    { date: '2026-11-09', type: 'arrive', receivedAt: '2026-11-09 09:00:00' },     // 到着だけ → 出さない
    { date: '2026-11-26', type: 'start', clientTime: '2026-11-26T09:00:00+09:00' }, // 範囲外
  ];
  const entries = [
    E('2026-11-02', '出勤', '出社', '09:00', '18:00'),
    E('2026-11-04', '出勤', '出社', '09:00', '18:00'),
    E('2026-11-05', '出勤', 'リモート', '10:00', '23:00'),
    E('2026-11-06', '年休', '', '', ''),
  ];
  const rows = P.comparePunches(entries, punches, { from: '2026-10-26', to: '2026-11-25' });
  const by = Object.fromEntries(rows.map(r => [r.date, r]));
  assert.deepEqual(Object.keys(by), ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.equal(by['2026-11-02'].status, 'ok');
  assert.equal(by['2026-11-04'].status, 'diff');
  assert.deepEqual(by['2026-11-04'].suggestion, { startTime: '09:30' });
  assert.equal(by['2026-11-04'].info, '到着 09:35');
  assert.deepEqual(by['2026-11-05'].suggestion, { endTime: '01:00' });
  assert.equal(by['2026-11-06'].status, 'leaveConflict');
  const none = P.comparePunches([], punches, { from: '2026-11-02', to: '2026-11-02' });
  assert.equal(none[0].status, 'suggestNew');
  assert.deepEqual(none[0].suggestion, { category: '出勤', startTime: '09:00', endTime: '18:00' });
});

const arr = (date, type, hm) => ({ date, type, clientTime: '', receivedAt: `${date} ${hm}:00`, source: 'shortcut' });
const R = { from: '2026-10-26', to: '2026-11-25' };

test('planArrivals: 記録なしの日は出勤・出社で作る（土日は休日出勤）', () => {
  const r = P.planArrivals({ entries: [], range: R, marks: {}, punches: [
    arr('2026-11-02', 'arrive', '09:12'), arr('2026-11-02', 'leave', '12:05'),
    arr('2026-11-02', 'arrive', '13:01'), arr('2026-11-02', 'leave', '18:20'),
    arr('2026-11-07', 'arrive', '10:40'),
  ] });
  assert.equal(r.changes.length, 2);
  assert.deepEqual(r.changes[0].entry, { date: '2026-11-02', category: '出勤', startTime: '09:00', endTime: '18:00',
    breakTime: '01:00', overtime: '00:00', location: '出社', notes: '' });
  assert.equal(r.changes[1].entry.category, '休日出勤');
  assert.equal(r.changes[1].entry.endTime, '');
  assert.deepEqual(r.marks['2026-11-02'], { startTime: '09:00', endTime: '18:00' });
});

test('planArrivals: ボタンや手で入れた時刻は変えず、空欄だけ埋める', () => {
  const r = P.planArrivals({ range: R, marks: {},
    entries: [E('2026-11-02', '出勤', '出社', '08:30', '')],
    punches: [arr('2026-11-02', 'arrive', '09:12'), arr('2026-11-02', 'leave', '18:20')] });
  assert.deepEqual(r.changes[0].fields, ['endTime']);
  assert.equal(r.changes[0].entry.startTime, '08:30');
  assert.equal(r.changes[0].entry.endTime, '18:00');
});

test('planArrivals: 昼の外出で入った終業は、最後の出発で更新する。手で直した後は変えない', () => {
  const first = P.planArrivals({ entries: [], range: R, marks: {},
    punches: [arr('2026-11-02', 'arrive', '09:12'), arr('2026-11-02', 'leave', '12:05')] });
  const saved = { ...first.changes[0].entry, id: 1 };
  assert.equal(saved.endTime, '12:00');
  const later = [arr('2026-11-02', 'arrive', '09:12'), arr('2026-11-02', 'leave', '12:05'),
                 arr('2026-11-02', 'arrive', '13:00'), arr('2026-11-02', 'leave', '18:40')];
  const second = P.planArrivals({ entries: [saved], range: R, marks: first.marks, punches: later });
  assert.deepEqual(second.changes[0].fields, ['endTime']);
  assert.equal(second.changes[0].entry.endTime, '18:30');
  // 同じ内容でもう一度: 変化なし
  const again = P.planArrivals({ entries: [second.changes[0].entry], range: R, marks: second.marks, punches: later });
  assert.equal(again.changes.length, 0);
  // 手で 19:00 に直した後は変えない
  const edited = { ...second.changes[0].entry, endTime: '19:00' };
  const after = P.planArrivals({ entries: [edited], range: R, marks: second.marks,
    punches: [...later, arr('2026-11-02', 'leave', '20:10')] });
  assert.equal(after.changes.length, 0);
});

test('planArrivals: 年休の日・範囲外・開始終了の打刻は使わない', () => {
  const r = P.planArrivals({ range: R, marks: {},
    entries: [E('2026-11-02', '年休', '', '', '')],
    punches: [arr('2026-11-02', 'arrive', '09:00'), arr('2026-11-26', 'arrive', '09:00'),
              { date: '2026-11-03', type: 'start', clientTime: '2026-11-03T09:00:00+09:00' }] });
  assert.equal(r.changes.length, 0);
});
