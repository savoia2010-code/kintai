/* 打刻（案B）の純粋ロジック（DOM・通信なし）。仕様: docs/punch.md */
(function (root) {
  'use strict';

  var JST_MS = 9 * 3600 * 1000;
  var DAY_MS = 86400000;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function jstDate(ms) {
    var d = new Date(ms + JST_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function jstTime(ms) {
    var d = new Date(ms + JST_MS);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function isWeekend(dateStr) {
    var p = dateStr.split('-').map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return dow === 0 || dow === 6;
  }

  /** index.html の snapToHalfHour と同じ（30分単位の切り捨て） */
  function snapToHalfHour(timeStr) {
    if (!timeStr) return timeStr;
    var parts = timeStr.split(':').map(Number);
    return pad(parts[0]) + ':' + pad(parts[1] < 30 ? 0 : 30);
  }

  function isTimeOff(cat) { return cat === '年休' || cat === '欠勤'; }

  /**
   * 開始・終了報告の打刻から、その日の記録をどう保存するかを決める。
   * @param {object} p { type: 'start'|'end', nowMs, entries, location, tasks: string[] }
   * @returns {{ date, time, entry, isNew, skipped }} entry は保存する記録（実働などの計算前）。skipped は反映しない理由
   */
  function planPunch(p) {
    var nowMs = p.nowMs;
    var date = jstDate(nowMs);
    var raw = jstTime(nowMs);
    // 0:00〜4:59 の終了報告は前日の終業として扱う
    if (p.type === 'end' && Number(raw.slice(0, 2)) < 5) date = jstDate(nowMs - DAY_MS);
    var time = snapToHalfHour(raw);
    var location = p.location || 'リモート';
    var tasks = p.tasks || [];
    var existing = (p.entries || []).find(function (e) { return e.date === date; });

    if (existing && isTimeOff(existing.category)) {
      return { date: date, time: time, entry: null, isNew: false,
               skipped: existing.category + 'の記録があるため反映しませんでした' };
    }

    var notes = tasks.length > 0 ? tasks.join(', ') : null;
    var entry;
    if (existing) {
      entry = Object.assign({}, existing);
      if (p.type === 'start') { entry.startTime = time; entry.location = location; }
      else entry.endTime = time;
      if (notes !== null) entry.notes = notes;
    } else {
      entry = {
        date: date,
        category: isWeekend(date) ? '休日出勤' : '出勤',
        startTime: p.type === 'start' ? time : '',
        endTime: p.type === 'end' ? time : '',
        breakTime: '01:00',
        overtime: '00:00',
        location: location,
        notes: notes || '',
      };
    }
    return { date: date, time: time, entry: entry, isNew: !existing, skipped: null };
  }

  /** 打刻の時刻（ms）。端末の時刻があればそれを、無ければ受信日時（日本時間）を使う */
  function punchMs(pu) {
    var t = Date.parse(pu.clientTime || '');
    if (isFinite(t)) return t;
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(pu.receivedAt || '');
    return m ? Date.parse(m[1] + 'T' + m[2] + '+09:00') : NaN;
  }

  /**
   * 打刻と記録を日ごとに照らし合わせ、違う日を候補として返す
   * @returns rows [{ date, entry, status, message, suggestion, info }]
   */
  function comparePunches(entries, punches, range) {
    var byDate = {};
    (punches || []).forEach(function (pu) {
      if (!pu || !pu.date || pu.date < range.from || pu.date > range.to) return;
      var ms = punchMs(pu);
      if (!isFinite(ms)) return;
      var d = byDate[pu.date] = byDate[pu.date] || { start: null, end: null, arrive: null, leave: null };
      var t = jstTime(ms);
      // その日の最初の開始・到着、最後の終了・出発を使う（深夜0〜5時は日をまたいだ後とみなす）
      var key = t < '05:00' ? '1' + t : '0' + t;
      if (pu.type === 'start' || pu.type === 'arrive') {
        if (!d[pu.type] || key < d[pu.type].key) d[pu.type] = { key: key, time: t };
      } else if (pu.type === 'end' || pu.type === 'leave') {
        if (!d[pu.type] || key > d[pu.type].key) d[pu.type] = { key: key, time: t };
      }
    });
    var entryByDate = {};
    (entries || []).forEach(function (e) { if (e && e.date) entryByDate[e.date] = e; });

    return Object.keys(byDate).sort().map(function (date) {
      var d = byDate[date];
      var entry = entryByDate[date];
      var S = d.start ? snapToHalfHour(d.start.time) : null;
      var E = d.end ? snapToHalfHour(d.end.time) : null;
      var info = [];
      if (d.arrive) info.push('到着 ' + d.arrive.time);
      if (d.leave) info.push('出発 ' + d.leave.time);
      var label = '打刻 ' + (S || '—') + '〜' + (E || '—');
      var row = { date: date, entry: entry, info: info.join('・'), status: null, message: label, suggestion: null };
      if (!S && !E) return null; // 到着・出発だけの日は出さない（タイムライン照合で見る）
      if (!entry) {
        row.status = 'suggestNew';
        row.message = '記録なし・' + label;
        row.suggestion = { category: isWeekend(date) ? '休日出勤' : '出勤', startTime: S || '', endTime: E || '' };
        return row;
      }
      if (isTimeOff(entry.category)) {
        row.status = 'leaveConflict';
        row.message = entry.category + 'だが' + label;
        return row;
      }
      var sug = {};
      if (S && S !== entry.startTime) sug.startTime = S;
      if (E && E !== entry.endTime) sug.endTime = E;
      if (Object.keys(sug).length === 0) { row.status = 'ok'; row.message = '打刻と一致'; return row; }
      row.status = 'diff';
      row.suggestion = sug;
      return row;
    }).filter(Boolean);
  }

  /**
   * ショートカットの到着・出発（会社に着いた／離れた）を、その日の始業・終業に反映する。
   * 会社への到着・出発なので、反映するのは出社の日だけになる。
   * - 記録なし → 出勤（土日は休日出勤）・出社で新しく作る
   * - 記録あり → 始業・終業が「空欄」か「前回ここで自動で入れた値のまま」のときだけ書き換える
   *   （開始・終了ボタンや手で入れた時刻は変えない。昼の外出のあと最後の出発で終業を更新できる）
   * - 年休・欠勤の日は変えない
   * @param {object} p { entries, punches, range: {from, to}, marks: { [date]: {startTime, endTime} } }
   * @returns {{ changes: [{ entry, isNew, fields: string[] }], marks }} marks は更新後の「自動で入れた値」
   */
  function planArrivals(p) {
    var range = p.range;
    var byDate = {};
    (p.punches || []).forEach(function (pu) {
      if (!pu || (pu.type !== 'arrive' && pu.type !== 'leave')) return;
      if (!pu.date || pu.date < range.from || pu.date > range.to) return;
      var ms = punchMs(pu);
      if (!isFinite(ms)) return;
      var t = jstTime(ms);
      var key = t < '05:00' ? '1' + t : '0' + t;
      var d = byDate[pu.date] = byDate[pu.date] || {};
      if (pu.type === 'arrive') { if (!d.arrive || key < d.arrive.key) d.arrive = { key: key, time: t }; }
      else if (!d.leave || key > d.leave.key) d.leave = { key: key, time: t };
    });
    var entryByDate = {};
    (p.entries || []).forEach(function (e) { if (e && e.date) entryByDate[e.date] = e; });
    var marks = Object.assign({}, p.marks || {});
    var changes = [];

    Object.keys(byDate).sort().forEach(function (date) {
      var d = byDate[date];
      var A = d.arrive ? snapToHalfHour(d.arrive.time) : '';
      var L = d.leave ? snapToHalfHour(d.leave.time) : '';
      var existing = entryByDate[date];
      if (!existing) {
        changes.push({ isNew: true, fields: [A && 'startTime', L && 'endTime'].filter(Boolean), entry: {
          date: date, category: isWeekend(date) ? '休日出勤' : '出勤', startTime: A, endTime: L,
          breakTime: '01:00', overtime: '00:00', location: '出社', notes: '' } });
        marks[date] = { startTime: A, endTime: L };
        return;
      }
      if (isTimeOff(existing.category)) return;
      var mark = marks[date] || {};
      var entry = Object.assign({}, existing);
      var fields = [];
      var nextMark = { startTime: mark.startTime || '', endTime: mark.endTime || '' };
      var canSet = function (cur, prev) { return !cur || (prev && cur === prev); };
      if (A && A !== entry.startTime && canSet(entry.startTime, mark.startTime)) {
        entry.startTime = A; nextMark.startTime = A; fields.push('startTime');
      }
      if (L && L !== entry.endTime && canSet(entry.endTime, mark.endTime)) {
        entry.endTime = L; nextMark.endTime = L; fields.push('endTime');
      }
      if (fields.length === 0) return;
      marks[date] = nextMark;
      changes.push({ isNew: false, fields: fields, entry: entry });
    });
    return { changes: changes, marks: marks };
  }

  var api = { planPunch: planPunch, comparePunches: comparePunches, planArrivals: planArrivals, punchMs: punchMs,
              snapToHalfHour: snapToHalfHour, jstDate: jstDate, jstTime: jstTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KintaiPunch = api;
})(typeof window !== 'undefined' ? window : globalThis);
