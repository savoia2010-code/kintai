/**
 * 勤務記録アプリ - Google Apps Script
 *
 * スクリプトプロパティ設定（必須）:
 *   SPREADSHEET_ID   : 連携するスプレッドシートのID
 *   WORKER_NAME      : シート名に使う名前（例: 山田）
 *   CHATWORK_TOKEN   : Chatwork APIトークン
 *   CHATWORK_ROOM_ID : Chatwork 送信先ルームID
 *   ACCESS_KEY       : アプリからの読み書きに必要な合言葉（doGet / doPost 共通）
 *
 * シート命名規則: {WORKER_NAME}/{YY}/{MM}
 *   例: 山田/26/03
 *
 * 締め日: 前月26日〜当月25日 を1ヶ月とする
 *
 * デプロイ設定:
 *   実行するユーザー: 自分
 *   アクセスできるユーザー: 全員
 */

// ============================================================
// エントリポイント
// ============================================================


function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const keyError = checkAccessKey(data.key);
    if (keyError) return respond({ status: 'error', message: keyError });

    if      (data.action === 'saveRecord')   { saveRecord(data);                                                        }
    else if (data.action === 'deleteRecord') { deleteRecord(data);                                                       }
    else if (data.action === 'notify')       { sendChatwork(data.message);                                               }
    else if (data.action === 'uploadFile')   { uploadFileToChatwork(data.base64Data, data.fileName, data.mimeType, data.message); }
    else    { throw new Error('不明なアクション: ' + data.action); }

    return respond({ status: 'ok' });

  } catch (err) {
    console.error(err);
    return respond({ status: 'error', message: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 合言葉を検証する。問題なければ null、拒否ならエラーメッセージを返す
 * @param {string} providedKey リクエストに付いてきた合言葉
 */
function checkAccessKey(providedKey) {
  const expectedKey = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  if (!expectedKey) return 'スクリプトプロパティ ACCESS_KEY が未設定です';
  if (typeof providedKey !== 'string' || providedKey !== expectedKey) return '合言葉が違います';
  return null;
}

// ============================================================
// スプレッドシート取得
// ============================================================

function getSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const id    = props.getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ SPREADSHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

// ============================================================
// Chatwork 通知
// ============================================================

function sendChatwork(message) {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty('CHATWORK_TOKEN');
  const roomId = props.getProperty('CHATWORK_ROOM_ID');
  if (!token || !roomId) {
    console.warn('Chatwork トークンまたはルームIDが未設定です');
    return;
  }
  UrlFetchApp.fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method:  'post',
    headers: { 'X-ChatWorkToken': token },
    payload: { body: message },
  });
}

// ============================================================
// Chatwork ファイルアップロード
// ============================================================

function uploadFileToChatwork(base64Data, fileName, mimeType, message) {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty('CHATWORK_TOKEN');
  const roomId = props.getProperty('CHATWORK_ROOM_ID');
  if (!token || !roomId) {
    console.warn('Chatwork トークンまたはルームIDが未設定です');
    return;
  }
  const decoded = Utilities.base64Decode(base64Data);
  const blob    = Utilities.newBlob(decoded, mimeType, fileName);
  UrlFetchApp.fetch(`https://api.chatwork.com/v2/rooms/${roomId}/files`, {
    method:  'post',
    headers: { 'X-ChatWorkToken': token },
    payload: {
      file:    blob,
      message: message || '',
    },
  });
}

// ============================================================
// シート名・期間の計算
// ============================================================

/**
 * 日付文字列からシート名を返す
 * 締め日ルール: 26日以降は「翌月」扱い
 * 例) 2026-03-18 → 山田/26/03
 *     2026-03-26 → 山田/26/04
 */
function getSheetName(dateStr) {
  const workerName = PropertiesService.getScriptProperties().getProperty('WORKER_NAME') || '名無し';
  const d = new Date(dateStr + 'T00:00:00');
  let year  = d.getFullYear();
  let month = d.getMonth() + 1;

  if (d.getDate() >= 26) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }

  const yy = String(year).slice(-2);
  const mm  = String(month).padStart(2, '0');
  return `${workerName}/${yy}/${mm}`;
}

/**
 * シートが対象とする期間（前月26日〜当月25日）を返す
 */
function getPeriod(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  let year  = d.getFullYear();
  let month = d.getMonth() + 1;

  if (d.getDate() >= 26) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }

  let startYear  = year;
  let startMonth = month - 1;
  if (startMonth < 1) { startMonth = 12; startYear -= 1; }

  const start = new Date(startYear, startMonth - 1, 26);
  const end   = new Date(year,      month - 1,      25);

  return { start, end };
}

// ============================================================
// シート取得 / 初期構築
// ============================================================

function getOrCreateSheet(sheetName, start, end) {
  const ss    = getSpreadsheet();
  let   sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    setupSheet(sheet, start, end);
  }

  return sheet;
}

/**
 * 日本の祝日を Google カレンダーから取得
 */
function getHolidays(start, end) {
  try {
    const cal     = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    if (!cal) return [];
    const nextDay = new Date(end.getTime() + 86400000);
    return cal.getEvents(start, nextDay).map(ev => {
      const d = ev.getStartTime();
      return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    });
  } catch (e) {
    console.warn('祝日取得失敗:', e);
    return [];
  }
}

/**
 * シートの初期設定
 * - 1行目: タイトル
 * - 2行目: ヘッダー
 * - 3〜33行目: 日付行（前月26日〜当月25日）
 * - 35行目: 合計行
 */
function setupSheet(sheet, start, end) {
  const headers   = ['日付', '区分', '始業', '終業', '休憩', '実働時間', 'みなし時間', '時間外', '場所', '備考'];
  const COL_COUNT = headers.length; // 10

  // ---- 1行目: タイトル ----
  const titleCell = sheet.getRange(1, 1, 1, COL_COUNT);
  titleCell.merge();
  titleCell.setValue(sheet.getName() + ' 勤務記録');
  titleCell.setFontWeight('bold')
           .setHorizontalAlignment('center')
           .setBackground('#4A86E8')
           .setFontColor('#FFFFFF')
           .setFontSize(12);

  // ---- 2行目: ヘッダー ----
  const headerRange = sheet.getRange(2, 1, 1, COL_COUNT);
  headerRange.setValues([headers]);
  headerRange.setBackground('#CFE2F3')
             .setFontWeight('bold')
             .setHorizontalAlignment('center');

  // ---- 祝日一覧 ----
  const holidays = getHolidays(start, end);

  // ---- 3〜33行目: 日付行 ----
  let row = 3;
  const cur = new Date(start);
  while (cur <= end && row <= 33) {
    const dateStr   = Utilities.formatDate(cur, 'Asia/Tokyo', 'yyyy-MM-dd');
    const dayOfWeek = cur.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidays.includes(dateStr);

    sheet.getRange(row, 1).setValue(cur.getDate()); // A列: 日のみ数値

    if (isWeekend || isHoliday) {
      sheet.getRange(row, 1, 1, COL_COUNT).setBackground('#FF9900');
    }

    cur.setDate(cur.getDate() + 1);
    row++;
  }

  // ---- 35行目: 合計行 ----
  const sumRow = sheet.getRange(35, 1, 1, COL_COUNT);
  sumRow.setBackground('#CFE2F3').setFontWeight('bold');
  sheet.getRange(35, 1).setValue('合計');
  sheet.getRange(35, 6).setFormula('=SUM(F3:F33)'); // 実働時間
  sheet.getRange(35, 7).setFormula('=SUM(G3:G33)'); // みなし時間
  sheet.getRange(35, 8).setFormula('=SUM(H3:H33)'); // 時間外
  sheet.getRange(35, 6, 1, 3).setNumberFormat('[h]:mm'); // 24時間超え対応

  // ---- 列幅 ----
  sheet.setColumnWidth(1,  55);
  sheet.setColumnWidth(2,  75);
  sheet.setColumnWidth(3,  65);
  sheet.setColumnWidth(4,  65);
  sheet.setColumnWidth(5,  65);
  sheet.setColumnWidth(6,  80);
  sheet.setColumnWidth(7,  90);
  sheet.setColumnWidth(8,  70);
  sheet.setColumnWidth(9,  80);
  sheet.setColumnWidth(10, 220);

  // ---- 枠線（2〜35行目） ----
  sheet.getRange(2, 1, 34, COL_COUNT)
       .setBorder(true, true, true, true, true, true,
                  '#CCCCCC', SpreadsheetApp.BorderStyle.SOLID);

  // ---- 行の高さ ----
  sheet.setRowHeight(1, 30);
  sheet.setRowHeight(2, 24);
}

// ============================================================
// 行の検索
// ============================================================

/**
 * A列の日付（日のみ数値）と突き合わせて行番号を返す
 * 見つからない場合は -1
 */
function findRowByDate(sheet, dateStr) {
  const d      = new Date(dateStr + 'T00:00:00');
  const day    = d.getDate();
  const values = sheet.getRange(3, 1, 31, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === day) return i + 3;
  }
  return -1;
}

// ============================================================
// 時間変換ユーティリティ
// ============================================================

/** "HH:MM" → スプレッドシートのtime値（1 = 24時間） */
function timeStrToFraction(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return '';
  return (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)) / 1440;
}

/** 分 → スプレッドシートのtime値 */
function minsToFraction(mins) {
  if (!mins || isNaN(mins)) return 0;
  return mins / 1440;
}

// ============================================================
// doPost ハンドラ実装
// ============================================================

/**
 * 記録の保存（新規・更新共通）
 */
function saveRecord(data) {
  const { start, end } = getPeriod(data.date);
  const sheetName      = getSheetName(data.date);
  const sheet          = getOrCreateSheet(sheetName, start, end);

  const row = findRowByDate(sheet, data.date);
  if (row < 0) {
    throw new Error('日付 ' + data.date + ' に対応する行が見つかりません（シート: ' + sheetName + '）');
  }

  sheet.getRange(row, 2).setValue(data.category || '');                                          // B: 区分
  sheet.getRange(row, 3).setValue(timeStrToFraction(data.startTime));                           // C: 始業
  sheet.getRange(row, 4).setValue(timeStrToFraction(data.endTime));                             // D: 終業
  sheet.getRange(row, 5).setValue(timeStrToFraction(data.breakTime));                           // E: 休憩
  sheet.getRange(row, 6).setValue(minsToFraction(data.actualMins));                             // F: 実働時間
  sheet.getRange(row, 7).setValue(minsToFraction(data.deemedMins));                             // G: みなし時間
  sheet.getRange(row, 8).setValue(timeStrToFraction(data.overtime));                            // H: 時間外
  sheet.getRange(row, 9).setValue(data.location || (data.isRemote ? 'リモート' : '出社'));      // I: 場所
  sheet.getRange(row, 10).setValue(data.notes || '');                                           // J: 備考

  // 時間列フォーマット
  sheet.getRange(row, 3, 1, 3).setNumberFormat('h:mm'); // C〜E
  sheet.getRange(row, 6, 1, 3).setNumberFormat('h:mm'); // F〜H

  // 年休・欠勤は時間列クリア
  if (data.category === '年休' || data.category === '欠勤') {
    sheet.getRange(row, 3, 1, 6).clearContent(); // C〜H
  }
}

/**
 * 記録の削除（B〜K列クリア、A列の日付は保持）
 */
function deleteRecord(data) {
  const sheetName = getSheetName(data.date);
  const sheet     = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;

  const row = findRowByDate(sheet, data.date);
  if (row < 0) return;

  sheet.getRange(row, 2, 1, 9).clearContent(); // B〜J列
}

// ============================================================
// 読み出し（アプリへの復元用）
// ============================================================

/**
 * GET エントリポイント
 *
 * 例) {デプロイURL}?action=getRecords&key=合言葉
 *     {デプロイURL}?action=getRecords&key=合言葉&month=2026-08
 *
 * スクリプトプロパティ ACCESS_KEY と一致しない場合は拒否する。
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const keyError = checkAccessKey(params.key);
    if (keyError) return respond({ status: 'error', message: keyError });

    const action = params.action || 'getRecords';
    if (action === 'getRecords') {
      return respond({ status: 'ok', entries: getRecords(params.month) });
    }
    throw new Error('不明なアクション: ' + action);

  } catch (err) {
    console.error(err);
    return respond({ status: 'error', message: err.message });
  }
}

/**
 * 記録を取得する
 * @param {string} [month] 'YYYY-MM'（○月度）。省略時は全シート。
 */
function getRecords(month) {
  const ss         = getSpreadsheet();
  const workerName = PropertiesService.getScriptProperties().getProperty('WORKER_NAME') || '名無し';

  let sheets;
  if (month) {
    const parts = String(month).split('-');
    const name  = `${workerName}/${String(parts[0]).slice(-2)}/${zeroPad(parts[1])}`;
    const sh    = ss.getSheetByName(name);
    sheets = sh ? [sh] : [];
  } else {
    sheets = ss.getSheets().filter(s => s.getName().indexOf(workerName + '/') === 0);
  }

  const out = [];
  sheets.forEach(sh => readSheetRecords(sh).forEach(r => out.push(r)));
  out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return out;
}

/**
 * 1シート分を読み取ってアプリの entry 形式に変換する
 * シート構成: 3〜33行目が日付行、A列=日のみ、B〜J列=区分〜備考
 */
function readSheetRecords(sheet) {
  const parts = sheet.getName().split('/');
  const yy = parseInt(parts[parts.length - 2], 10);
  const mm = parseInt(parts[parts.length - 1], 10);
  if (isNaN(yy) || isNaN(mm)) return [];

  const days = sheet.getRange(3, 1, 31, 1).getValues();          // A列
  const disp = sheet.getRange(3, 2, 31, 9).getDisplayValues();   // B〜J列

  const out = [];
  for (let i = 0; i < days.length; i++) {
    const day = Number(days[i][0]);
    if (!day) continue;

    const row      = disp[i];
    const category = String(row[0] || '').trim();
    if (!category) continue;   // 区分が空の行は未入力とみなす

    // ○月度 + 日 → 実際の日付（26日以降は前月）
    let y = 2000 + yy, m = mm;
    if (day >= 26) { m -= 1; if (m < 1) { m = 12; y -= 1; } }

    out.push({
      date:       `${y}-${zeroPad(m)}-${zeroPad(day)}`,
      category:   category,
      startTime:  normalizeTime(row[1]),
      endTime:    normalizeTime(row[2]),
      breakTime:  normalizeTime(row[3]) || '00:00',
      actualMins: hhmmToMins(row[4]),
      deemedMins: hhmmToMins(row[5]),
      overtime:   normalizeTime(row[6]) || '00:00',
      location:   String(row[7] || '').trim(),
      notes:      String(row[8] || '').trim(),
    });
  }
  return out;
}

function zeroPad(n) {
  return String(n).padStart(2, '0');
}

/** 表示値 "9:00" → "09:00"（空や不正値は ''） */
function normalizeTime(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const p = s.split(':');
  if (p.length < 2) return '';
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return '';
  return zeroPad(h) + ':' + zeroPad(m);
}

/** 表示値 "7:30" → 450（分） */
function hhmmToMins(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  const p = s.split(':');
  if (p.length < 2) return 0;
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
}
