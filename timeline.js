/* タイムライン照合の純粋ロジック（DOM・通信なし）。仕様: docs/timeline-matching.md */
(function (root) {
  'use strict';

  var JST_MS = 9 * 3600 * 1000;
  var DAY_MS = 86400000;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function jstDate(ms) {
    var d = new Date(ms + JST_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function jstMins(ms) {
    var d = new Date(ms + JST_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function dateToMs(dateStr) { // JST 00:00 の epoch ms
    var p = dateStr.split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]) - JST_MS;
  }

  function dayOfWeek(dateStr) { // 0=日
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }

  function parseGeo(s) {
    if (typeof s !== 'string') return null;
    var m = /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(s);
    if (!m) return null;
    var lat = Number(m[1]), lng = Number(m[2]);
    return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function numOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function parseTimeline(json) {
    var list = Array.isArray(json) ? json
      : (json && Array.isArray(json.semanticSegments) ? json.semanticSegments : []);
    var visits = [];
    var covered = new Set();
    list.forEach(function (seg) {
      if (!seg || typeof seg !== 'object') return;
      var s = Date.parse(seg.startTime), e = Date.parse(seg.endTime);
      if (!isFinite(s) || !isFinite(e) || e <= s) return;
      // 終了がちょうど 0:00 の区間は翌日を「触った」ことにしない
      var lastMs = e - 1;
      for (var t = dateToMs(jstDate(s)); t <= lastMs; t += DAY_MS) covered.add(jstDate(t));
      covered.add(jstDate(s));
      if (seg.visit && typeof seg.visit === 'object') {
        var v = seg.visit;
        var c = v.topCandidate && typeof v.topCandidate === 'object' ? v.topCandidate : {};
        var geo = parseGeo(c.placeLocation);
        var pid = typeof c.placeID === 'string' ? c.placeID : '';
        visits.push({
          start: s, end: e, placeId: pid,
          lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
          probability: numOrNull(c.probability !== undefined ? c.probability : v.probability)
        });
      }
    });
    return { visits: visits, coveredDates: covered };
  }

  function splitByDay(visit) {
    var out = [];
    var s = visit.start, e = visit.end;
    if (!(e > s)) return out;
    var dayStart = dateToMs(jstDate(s));
    while (dayStart < e) {
      var next = dayStart + DAY_MS;
      var a = Math.max(s, dayStart), b = Math.min(e, next);
      if (b > a) {
        out.push({
          date: jstDate(dayStart),
          startMins: Math.floor((a - dayStart) / 60000),
          endMins: b >= next ? 1440 : Math.floor((b - dayStart) / 60000),
          visit: visit
        });
      }
      dayStart = next;
    }
    return out;
  }

  function distanceM(lat1, lng1, lat2, lng2) {
    var R = 6371008.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function hasCoords(o) {
    return o && typeof o.lat === 'number' && typeof o.lng === 'number' && isFinite(o.lat) && isFinite(o.lng);
  }

  function unionLength(intervals) {
    return unionIntervals(intervals).reduce(function (n, iv) { return n + (iv[1] - iv[0]); }, 0);
  }

  function unionIntervals(intervals) {
    var sorted = intervals.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    sorted.forEach(function (iv) {
      var last = out[out.length - 1];
      if (last && iv[0] <= last[1]) { if (iv[1] > last[1]) last[1] = iv[1]; }
      else out.push([iv[0], iv[1]]);
    });
    return out;
  }

  function findOfficeCandidates(visits, opts) {
    opts = opts || {};
    var minStay = opts.minStayMins != null ? opts.minStayMins : 30;
    var radius = opts.radiusM != null ? opts.radiusM : 150;
    var limit = opts.limit != null ? opts.limit : 5;

    var pieces = [];
    (visits || []).forEach(function (v) {
      splitByDay(v).forEach(function (p) {
        var dow = dayOfWeek(p.date);
        if (dow === 0 || dow === 6) return;
        var a = Math.max(p.startMins, 480), b = Math.min(p.endMins, 1200);
        if (b - a < minStay) return;
        pieces.push({ date: p.date, a: a, b: b, visit: v });
      });
    });

    var places = [];
    var byPid = new Map();
    function addTo(place, pc) {
      place.pieces.push(pc);
      if (hasCoords(pc.visit)) {
        place.n++; place.sLat += pc.visit.lat; place.sLng += pc.visit.lng;
        place.lat = place.sLat / place.n; place.lng = place.sLng / place.n;
      }
    }
    function newPlace(pid) {
      return { placeId: pid, pieces: [], n: 0, sLat: 0, sLng: 0, lat: null, lng: null };
    }
    // 1周目: 場所IDあり
    pieces.forEach(function (pc) {
      var pid = pc.visit.placeId;
      if (!pid) return;
      var pl = byPid.get(pid);
      if (!pl) { pl = newPlace(pid); places.push(pl); byPid.set(pid, pl); }
      addTo(pl, pc);
    });
    // 2周目: 場所IDなし（近さ）
    pieces.forEach(function (pc) {
      if (pc.visit.placeId) return;
      var pl = null;
      if (hasCoords(pc.visit)) {
        var best = Infinity;
        places.forEach(function (x) {
          if (x.lat === null) return;
          var d = distanceM(pc.visit.lat, pc.visit.lng, x.lat, x.lng);
          if (d <= radius && d < best) { best = d; pl = x; }
        });
      }
      if (!pl) { pl = newPlace(''); places.push(pl); }
      addTo(pl, pc);
    });

    var results = places.map(function (pl) {
      var byDate = {};
      pl.pieces.forEach(function (pc) { (byDate[pc.date] = byDate[pc.date] || []).push([pc.a, pc.b]); });
      var dates = Object.keys(byDate).sort();
      var total = 0;
      dates.forEach(function (d) { total += unionLength(byDate[d]); });
      var key = pl.placeId ||
        (pl.lat !== null ? 'geo:' + pl.lat.toFixed(4) + ',' + pl.lng.toFixed(4) : 'unknown');
      return {
        key: key,
        days: dates.length,
        avgMins: dates.length ? Math.round(total / dates.length) : 0,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        office: { placeId: pl.placeId, lat: pl.lat, lng: pl.lng }
      };
    });
    results.sort(function (x, y) { return y.days - x.days || y.avgMins - x.avgMins; });
    return results.slice(0, limit);
  }

  function isOfficeVisit(visit, office, radiusM) {
    if (!visit || !office) return false;
    var r = radiusM != null ? radiusM : 150;
    if (visit.placeId && office.placeId && visit.placeId === office.placeId) return true;
    if (hasCoords(visit) && hasCoords(office)) {
      return distanceM(visit.lat, visit.lng, office.lat, office.lng) <= r;
    }
    return false;
  }

  function fmt(mins) { return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }

  function summarizeOfficeDays(visits, office, opts) {
    opts = opts || {};
    var minStay = opts.minStayMins != null ? opts.minStayMins : 30;
    var byDate = {};
    (visits || []).forEach(function (v) {
      if (!isOfficeVisit(v, office)) return;
      splitByDay(v).forEach(function (p) {
        if (opts.from && p.date < opts.from) return;
        if (opts.to && p.date > opts.to) return;
        if (p.endMins - p.startMins < minStay) return;
        (byDate[p.date] = byDate[p.date] || []).push([p.startMins, p.endMins]);
      });
    });
    var map = new Map();
    Object.keys(byDate).sort().forEach(function (date) {
      var u = unionIntervals(byDate[date]);
      var arrive = u[0][0], leave = u[u.length - 1][1];
      var inMins = u.reduce(function (n, iv) { return n + iv[1] - iv[0]; }, 0);
      map.set(date, {
        arrive: fmt(arrive), leave: fmt(leave),
        inMins: inMins, outMins: (leave - arrive) - inMins, stays: u.length
      });
    });
    return map;
  }

  /** index.html の snapToHalfHour と同一挙動 */
  function snapToHalfHour(timeStr) {
    if (!timeStr) return timeStr;
    var parts = timeStr.split(':').map(Number);
    return pad(parts[0]) + ':' + pad(parts[1] < 30 ? 0 : 30);
  }

  function compareDay(entry, officeDay, hasData) {
    var A = officeDay ? snapToHalfHour(officeDay.arrive) : null;
    var L = officeDay ? snapToHalfHour(officeDay.leave) : null;
    if (!entry) {
      if (!officeDay) return null;
      return {
        status: 'suggestNew', message: '記録なし・会社に滞在',
        suggestion: { category: '出勤', location: '出社', startTime: A, endTime: L }
      };
    }
    var cat = entry.category;
    if (cat === '年休' || cat === '欠勤') {
      if (!officeDay) return null;
      return { status: 'leaveConflict', message: cat + 'だが会社に滞在', suggestion: null };
    }
    if (cat !== '出勤' && cat !== '休日出勤') return null;
    if (!hasData) return { status: 'noData', message: 'タイムラインなし', suggestion: null };
    var loc = entry.location;
    if (loc === '出社') {
      if (!officeDay) {
        return { status: 'missingOffice', message: '出社の記録だが会社の滞在なし', suggestion: null };
      }
      if (A === entry.startTime && L === entry.endTime) {
        return { status: 'ok', message: '一致', suggestion: null };
      }
      return { status: 'diff', message: 'タイムライン ' + A + '〜' + L, suggestion: { startTime: A, endTime: L } };
    }
    if (loc === '混在') {
      if (!officeDay) {
        return { status: 'missingOffice', message: '混在の記録だが会社の滞在なし', suggestion: null };
      }
      if (officeDay.arrive >= entry.startTime && officeDay.leave <= entry.endTime) {
        return { status: 'ok', message: '範囲内', suggestion: null };
      }
      return {
        status: 'diff', message: '会社 ' + A + '〜' + L + ' が始業〜終業の外',
        suggestion: {
          startTime: entry.startTime < A ? entry.startTime : A,
          endTime: entry.endTime > L ? entry.endTime : L
        }
      };
    }
    // リモート / 未設定
    if (!officeDay) return null;
    return {
      status: 'suggestLocation', message: 'リモートの記録だが会社に滞在 ' + A + '〜' + L,
      suggestion: { locations: ['出社', '混在'] }
    };
  }

  function matchPeriod(entries, officeDays, coveredDates, range) {
    var from = range.from, to = range.to;
    var byDate = {};
    (entries || []).forEach(function (e) { if (e && e.date) byDate[e.date] = e; });
    var rows = [];
    for (var t = dateToMs(from), end = dateToMs(to); t <= end; t += DAY_MS) {
      var date = jstDate(t);
      var entry = byDate[date];
      var od = officeDays && officeDays.get ? officeDays.get(date) : undefined;
      var has = !!(coveredDates && coveredDates.has(date));
      var r = compareDay(entry, od, has);
      if (r) rows.push({ date: date, entry: entry, officeDay: od, status: r.status, message: r.message, suggestion: r.suggestion });
    }
    return rows;
  }

  var api = {
    parseTimeline: parseTimeline, jstDate: jstDate, jstMins: jstMins, splitByDay: splitByDay,
    distanceM: distanceM, findOfficeCandidates: findOfficeCandidates, isOfficeVisit: isOfficeVisit,
    summarizeOfficeDays: summarizeOfficeDays, snapToHalfHour: snapToHalfHour,
    compareDay: compareDay, matchPeriod: matchPeriod
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KintaiTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis);
