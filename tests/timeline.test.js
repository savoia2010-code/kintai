const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../timeline.js');

const seg = (s, e, pid, lat, lng, extra) => ({
  startTime: s, endTime: e,
  visit: { hierarchyLevel: '0', probability: '0.85', topCandidate: Object.assign({
    placeID: pid, semanticType: 'Unknown', probability: '0.7',
    placeLocation: lat == null ? undefined : `geo:${lat},${lng}` }, extra || {}) }
});
const V = (date, a, b, pid, lat = 10.0, lng = 20.0) => {
  const s = Date.parse(`${date}T${a}:00+09:00`), e = Date.parse(`${date}T${b}:00+09:00`);
  return { start: s, end: e, placeId: pid, lat, lng, probability: 0.8 };
};

test('mixed +09:00 / Z parse to same JST', () => {
  const r = T.parseTimeline([
    seg('2026-10-01T09:05:00.000+09:00', '2026-10-01T12:10:00.000+09:00', 'A', 10.0001, 20.0002),
    seg('2026-10-01T00:05:00.000Z', '2026-10-01T03:10:00.000Z', 'A', 10.0001, 20.0002)
  ]);
  assert.equal(r.visits[0].start, r.visits[1].start);
  assert.equal(T.jstDate(r.visits[1].start), '2026-10-01');
  assert.equal(T.jstMins(r.visits[1].start), 545);
  assert.equal(r.visits[0].lat, 10.0001);
  assert.equal(r.visits[0].probability, 0.7);
});

test('semanticSegments wrapper, bad segments skipped, coveredDates from all types', () => {
  const r = T.parseTimeline({ semanticSegments: [
    { startTime: 'bad', endTime: '2026-10-01T10:00:00+09:00', visit: {} },
    { startTime: '2026-10-01T10:00:00+09:00', endTime: '2026-10-01T10:00:00+09:00', visit: {} },
    null,
    { startTime: '2026-10-02T23:00:00.000+09:00', endTime: '2026-10-03T01:00:00.000+09:00', activity: {} },
    { startTime: '2026-10-05T00:00:00.000Z', endTime: '2026-10-05T01:00:00.000Z', timelinePath: [] },
    { startTime: '2026-10-06T10:00:00+09:00', endTime: '2026-10-06T11:00:00+09:00', visit: {} }
  ] });
  assert.equal(r.visits.length, 1);
  assert.equal(r.visits[0].placeId, '');
  assert.equal(r.visits[0].lat, null);
  assert.equal(r.visits[0].probability, null);
  assert.deepEqual([...r.coveredDates].sort(), ['2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06']);
  assert.equal(T.parseTimeline(null).visits.length, 0);
});

test('splitByDay clips at JST midnight', () => {
  const v = { start: Date.parse('2026-10-01T22:00:00+09:00'), end: Date.parse('2026-10-03T00:00:00+09:00') };
  const p = T.splitByDay(v);
  assert.deepEqual(p.map(x => [x.date, x.startMins, x.endMins]),
    [['2026-10-01', 1320, 1440], ['2026-10-02', 0, 1440]]);
});

test('nested overlapping visits are unioned; lunch outing gives 2 stays and outMins', () => {
  const office = { placeId: 'OFF', lat: 10.0, lng: 20.0 };
  const visits = [
    V('2026-10-01', '09:00', '12:00', 'OFF'),
    V('2026-10-01', '09:30', '11:00', 'OFF'),   // nested
    V('2026-10-01', '13:00', '18:10', 'OFF'),
    V('2026-10-01', '12:10', '12:20', 'OFF'),   // short, dropped
    V('2026-10-01', '14:00', '16:00', 'ZZZ', 11.0, 21.0) // elsewhere
  ];
  const m = T.summarizeOfficeDays(visits, office, { from: '2026-10-01', to: '2026-10-31' });
  const d = m.get('2026-10-01');
  assert.deepEqual(d, { arrive: '09:00', leave: '18:10', inMins: 180 + 310, outMins: 550 - 490, stays: 2 });
  assert.equal(T.summarizeOfficeDays(visits, office, { from: '2026-10-02', to: '2026-10-03' }).size, 0);
});

test('summarize: 24:00 leave for piece ending at midnight', () => {
  const office = { placeId: 'OFF', lat: 10, lng: 20 };
  const v = { start: Date.parse('2026-10-01T20:00:00+09:00'), end: Date.parse('2026-10-02T00:00:00+09:00'),
    placeId: 'OFF', lat: 10, lng: 20 };
  assert.equal(T.summarizeOfficeDays([v], office, { from: '2026-10-01', to: '2026-10-01' }).get('2026-10-01').leave, '24:00');
});

test('office candidates: weekdays only, daytime only, ranked', () => {
  const visits = [];
  // 2026-10-05 is Monday
  ['05', '06', '07'].forEach(d => visits.push(V(`2026-10-${d}`, '09:00', '18:00', 'OFF')));
  visits.push(V('2026-10-03', '09:00', '18:00', 'WKND', 12.0, 22.0)); // Saturday
  visits.push(V('2026-10-04', '09:00', '18:00', 'WKND', 12.0, 22.0)); // Sunday
  ['05', '06', '07', '08'].forEach(d => visits.push(V(`2026-10-${d}`, '21:00', '23:30', 'HOME', 13.0, 23.0)));
  // no-placeId pieces near OFF centroid get absorbed; far ones form a geo place
  visits.push(V('2026-10-08', '10:00', '11:00', '', 10.0005, 20.0005));
  visits.push(V('2026-10-08', '10:00', '11:00', '', 14.0, 24.0));
  visits.push(V('2026-10-09', '10:00', '11:00', '', 14.0001, 24.0001));
  const r = T.findOfficeCandidates(visits);
  assert.equal(r[0].key, 'OFF');
  assert.equal(r[0].days, 4);
  assert.equal(r[0].firstDate, '2026-10-05');
  assert.equal(r[0].lastDate, '2026-10-08');
  assert.equal(r[0].avgMins, Math.round((540 * 3 + 60) / 4));
  assert.match(r[1].key, /^geo:14\.000\d,24\.000\d$/);
  assert.equal(r[1].days, 2);
  assert.ok(!r.some(x => x.key === 'WKND' || x.key === 'HOME'));
  assert.equal(T.findOfficeCandidates(visits, { limit: 1 }).length, 1);
});

test('isOfficeVisit by placeId and by distance', () => {
  const office = { placeId: 'OFF', lat: 10.0, lng: 20.0 };
  assert.ok(T.isOfficeVisit({ placeId: 'OFF', lat: 50, lng: 50 }, office));
  assert.ok(T.isOfficeVisit({ placeId: '', lat: 10.001, lng: 20.0 }, office)); // ~111m
  assert.ok(!T.isOfficeVisit({ placeId: 'X', lat: 10.003, lng: 20.0 }, office)); // ~333m
  assert.ok(!T.isOfficeVisit({ placeId: '', lat: null, lng: null }, office));
  assert.ok(!T.isOfficeVisit({ placeId: '', lat: 10, lng: 20 }, { placeId: '', lat: null, lng: null }));
  assert.ok(Math.abs(T.distanceM(0, 0, 0, 1) - 111195) < 200);
});

test('snapToHalfHour', () => {
  assert.equal(T.snapToHalfHour('09:05'), '09:00');
  assert.equal(T.snapToHalfHour('17:59'), '17:30');
  assert.equal(T.snapToHalfHour('09:30'), '09:30');
  assert.equal(T.snapToHalfHour(''), '');
});

test('compareDay branches', () => {
  const od = { arrive: '09:05', leave: '18:10', inMins: 1, outMins: 0, stays: 1 };
  const e = (category, location, startTime = '09:00', endTime = '18:00') =>
    ({ date: 'x', category, location, startTime, endTime });
  assert.deepEqual(T.compareDay(undefined, od, true), { status: 'suggestNew', message: '記録なし・会社に滞在',
    suggestion: { category: '出勤', location: '出社', startTime: '09:00', endTime: '18:00' } });
  assert.equal(T.compareDay(undefined, undefined, true), null);
  assert.deepEqual(T.compareDay(e('年休', ''), od, true), { status: 'leaveConflict', message: '年休だが会社に滞在', suggestion: null });
  assert.equal(T.compareDay(e('欠勤', ''), undefined, true), null);
  assert.equal(T.compareDay(e('出勤', '出社'), undefined, false).status, 'noData');
  assert.equal(T.compareDay(e('出勤', '出社'), od, true).status, 'ok');
  assert.equal(T.compareDay(e('出勤', '出社'), od, true).message, '一致');
  const d = T.compareDay(e('出勤', '出社', '09:30', '18:00'), od, true);
  assert.deepEqual(d, { status: 'diff', message: 'タイムライン 09:00〜18:00', suggestion: { startTime: '09:00', endTime: '18:00' } });
  assert.equal(T.compareDay(e('出勤', '出社'), undefined, true).status, 'missingOffice');
  assert.deepEqual(T.compareDay(e('休日出勤', '混在', '09:00', '19:00'), od, true), { status: 'ok', message: '範囲内', suggestion: null });
  const x = T.compareDay(e('出勤', '混在', '09:30', '18:00'), od, true);
  assert.equal(x.status, 'diff');
  assert.equal(x.message, '会社 09:00〜18:00 が始業〜終業の外');
  assert.deepEqual(x.suggestion, { startTime: '09:00', endTime: '18:00' });
  assert.equal(T.compareDay(e('出勤', '混在'), undefined, true).status, 'missingOffice');
  const r = T.compareDay(e('出勤', 'リモート'), od, true);
  assert.deepEqual(r, { status: 'suggestLocation', message: 'リモートの記録だが会社に滞在 09:00〜18:00', suggestion: { locations: ['出社', '混在'] } });
  assert.equal(T.compareDay(e('出勤', ''), od, true).status, 'suggestLocation');
  assert.equal(T.compareDay(e('出勤', 'リモート'), undefined, true), null);
});

test('matchPeriod respects range bounds and sorts', () => {
  const od = new Map([
    ['2026-09-30', { arrive: '09:00', leave: '18:00', inMins: 1, outMins: 0, stays: 1 }],
    ['2026-10-02', { arrive: '09:00', leave: '18:00', inMins: 1, outMins: 0, stays: 1 }],
    ['2026-10-01', { arrive: '09:00', leave: '18:00', inMins: 1, outMins: 0, stays: 1 }],
    ['2026-10-04', { arrive: '09:00', leave: '18:00', inMins: 1, outMins: 0, stays: 1 }]
  ]);
  const entries = [
    { date: '2026-10-01', category: '出勤', location: '出社', startTime: '09:00', endTime: '18:00' },
    { date: '2026-10-03', category: '出勤', location: '出社', startTime: '09:00', endTime: '18:00' }
  ];
  const covered = new Set(['2026-10-01', '2026-10-02']);
  const rows = T.matchPeriod(entries, od, covered, { from: '2026-10-01', to: '2026-10-03' });
  assert.deepEqual(rows.map(r => [r.date, r.status]),
    [['2026-10-01', 'ok'], ['2026-10-02', 'suggestNew'], ['2026-10-03', 'noData']]);
  assert.equal(rows[0].entry, entries[0]);
  assert.equal(rows[1].officeDay, od.get('2026-10-02'));
});
