/**
 * アクセシビリティ検査レポート → Google Docs「達成基準リスト」生成 GAS
 *
 * ■ 設定手順
 *   1. レポートのスプレッドシートを開く
 *   2. 拡張機能 → Apps Script
 *   3. コード.gs の中身を全削除してこのファイルを貼り付け保存
 *   4. プロジェクトの設定（歯車）→「エディタで appsscript.json を表示」にチェック
 *   5. appsscript.json を開き中身を差し替えて保存
 *   6. スプレッドシートをリロード → メニュー「報告書」が表示される
 *
 * ■ 対応スプレッドシート構成
 *   現行11列: No | 検査種別 | SC | 検査項目 | 適合レベル | 結果 | 場所 | 検出数 | 重要度 | 詳細 | 改善案
 *   旧8列:   検査項目番号 | 検査項目 | 適合レベル | 結果 | 場所 | 検出数 | 詳細 | 改善案
 *   旧7列:   検査項目番号 | 検査項目 | 結果 | 場所 | 検出数 | 詳細 | 改善案
 */

/* ============================================================
   メニュー
   ============================================================ */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('報告書')
    .addItem('Google Docs 報告書を生成', 'showReportDialog')
    .addToUi();
}

/* ============================================================
   ダイアログ
   ============================================================ */
function showReportDialog() {
  var html = HtmlService.createHtmlOutput([
    '<style>',
    'body{font-family:"Noto Sans JP","Hiragino Sans",sans-serif;padding:16px;color:#333}',
    'label{display:block;margin-top:14px;font-weight:600;font-size:14px}',
    'input{width:100%;padding:7px 10px;margin-top:4px;border:1px solid #ccc;font-size:14px;box-sizing:border-box}',
    '.chips{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}',
    '.chip{padding:5px 12px;border:1px solid #1a73e8;font-size:14px;cursor:pointer;background:#fff;color:#1a73e8;user-select:none;transition:.15s}',
    '.chip.on{background:#1a73e8;color:#fff}',
    '.foot{margin-top:22px;display:flex;align-items:center;gap:12px;justify-content:flex-end}',
    '.btn{padding:9px 28px;border:none;cursor:pointer;font-size:14px;font-weight:600}',
    '.btn-p{background:#1a73e8;color:#fff}.btn-p:hover{background:#1557b0}.btn-p:disabled{background:#94bef8;cursor:wait}',
    '#msg{font-size:14px;color:#666;margin-top:10px;min-height:18px}',
    '</style>',

    '<label>社名 / 組織名</label>',
    '<input id="v_company" placeholder="例: 株式会社サンプル">',

    '<label>作成者</label>',
    '<input id="v_author" placeholder="例: 山田太郎">',

    '<label>作成日</label>',
    '<input id="v_date" type="date">',

    '<label>出力対象タブ（クリックで切替）</label>',
    '<div id="chips" class="chips"><span style="color:#999;font-size:14px">読込中...</span></div>',

    '<div class="foot"><button id="go" class="btn btn-p" onclick="go()">報告書を生成</button></div>',
    '<div id="msg"></div>',

    '<script>',
    'var P=function(n){return String(n).padStart(2,"0")};',
    'var N=new Date();',
    'document.getElementById("v_date").value=N.getFullYear()+"-"+P(N.getMonth()+1)+"-"+P(N.getDate());',

    'google.script.run.withFailureHandler(function(e){',
    '  var el=document.getElementById("chips");',
    '  el.innerHTML="<span style=\\"color:#d32f2f\\">読込エラー: "+(e&&e.message?e.message:e)+"</span>";',
    '}).withSuccessHandler(function(list){',
    '  var el=document.getElementById("chips");el.innerHTML="";',
    '  if(!list.length){el.innerHTML="<span style=\\"color:#d32f2f\\">対象タブなし</span>";return}',
    '  list.forEach(function(t){',
    '    var c=document.createElement("span");c.className="chip on";c.textContent=t;c.dataset.n=t;',
    '    c.onclick=function(){this.classList.toggle("on")};el.appendChild(c);',
    '  });',
    '}).getReportTabs();',

    'function go(){',
    '  var b=document.getElementById("go"),m=document.getElementById("msg");',
    '  b.disabled=true;b.textContent="生成中...";m.style.color="#666";m.textContent="報告書を生成しています...";',
    '  var sel=[];document.querySelectorAll(".chip.on").forEach(function(c){sel.push(c.dataset.n)});',
    '  google.script.run',
    '    .withSuccessHandler(function(url){if(url)window.open(url,"_blank");google.script.host.close()})',
    '    .withFailureHandler(function(e){b.disabled=false;b.textContent="報告書を生成";m.style.color="#d32f2f";m.textContent="エラー: "+e.message})',
    '    .generateReport({company:document.getElementById("v_company").value,author:document.getElementById("v_author").value,createdDate:document.getElementById("v_date").value,tabs:sel});',
    '}',
    '</script>'
  ].join('\n'))
  .setWidth(440)
  .setHeight(480);

  SpreadsheetApp.getUi().showModalDialog(html, '報告書生成');
}

/* ============================================================
   対象タブ一覧
   ============================================================ */
function getReportTabs() {
  var out = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function(s) {
    var v = s.getDataRange().getValues();
    if (detectReportSheet_(v)) out.push(s.getName());
  });
  return out;
}

/* ============================================================
   メイン: 報告書生成（達成基準リスト形式）
   ============================================================ */
function generateReport(info) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var pages = readPages_(ss, info.tabs || []);
  if (!pages.length) throw new Error('対象タブが見つかりません');

  var dateLabel = info.createdDate || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var docTitle  = '達成基準リスト' +
                  (info.company ? ' - ' + info.company : '') +
                  '（' + dateLabel + '）';
  var doc  = DocumentApp.create(docTitle);
  var body = doc.getBody();
  body.clear();

  // デフォルトスタイル
  var defaultStyle = {};
  defaultStyle[DocumentApp.Attribute.FONT_SIZE] = 10;
  defaultStyle[DocumentApp.Attribute.FONT_FAMILY] = 'Arial';
  body.setAttributes(defaultStyle);

  // ページごとに達成基準リストを生成
  pages.forEach(function(pg, pageIdx) {
    if (pageIdx > 0) body.appendPageBreak();

    /* ======================== タイトル ======================== */
    body.appendParagraph('達成基準リスト')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .editAsText().setBold(true).setFontSize(18).setForegroundColor('#000');

    body.appendParagraph('').setSpacingAfter(2);

    /* ======================== 説明文 ======================== */
    body.appendParagraph('「結果」の欄は、検証の結果、適合している達成基準を「○」、適合していない達成基準を「×」としています。')
      .editAsText().setFontSize(9).setForegroundColor('#333');
    body.appendParagraph('「△」はAI評価の確信度が低い項目（要目視確認）、「ー」は未検証の項目です。')
      .editAsText().setFontSize(9).setForegroundColor('#333');

    /* ======================== 右上: 日付・社名 ======================== */
    var metaLines = [];
    metaLines.push('検査日時: ' + pg.time);
    metaLines.push(fmtDate_(info.createdDate));
    if (info.company) metaLines.push(info.company);
    if (info.author)  metaLines.push('作成者: ' + info.author);

    var metaPara = body.appendParagraph(metaLines.join('\n'));
    metaPara.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    metaPara.editAsText().setFontSize(9).setForegroundColor('#333');

    /* ======================== 検査対象URL ======================== */
    body.appendParagraph('検査対象: ' + pg.url)
      .editAsText().setFontSize(9).setForegroundColor('#1a73e8').setUnderline(true);

    body.appendParagraph('').setSpacingAfter(2);

    /* ======================== スコア表示 ======================== */
    var score = calcScore_(pg);
    var scoreText = '項目達成率: ' + score.rate + '%（' +
                    score.pass + ' / ' + score.applicable + ' 項目適合）';
    var scorePara = body.appendParagraph(scoreText);
    scorePara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    var scoreStyle = scorePara.editAsText();
    scoreStyle.setBold(true).setFontSize(14);
    if (score.rate >= 90) {
      scoreStyle.setForegroundColor('#2e7d32');
    } else if (score.rate >= 70) {
      scoreStyle.setForegroundColor('#e65100');
    } else {
      scoreStyle.setForegroundColor('#d32f2f');
    }

    /* サマリー行 */
    body.appendParagraph(
      '合格: ' + score.pass + '  不合格: ' + score.fail +
      '  判定不能: ' + score.unknown + '  該当なし: ' + score.na +
      '  未検証: ' + score.unverified + '  合計: ' + score.total
    ).editAsText().setFontSize(9).setBold(true).setForegroundColor('#555');

    body.appendParagraph('').setSpacingAfter(4);

    /* ======================== 達成基準テーブル ======================== */
    var headerRow = ['No.', '達成基準', '適合レベル', '適用', '結果', '注記'];
    var tableData = [headerRow];

    pg.rows.forEach(function(r) {
      var applicable = mapApplicable_(r.result);
      var resultMark = mapResult_(r.result);
      var note = buildNote_(r);
      tableData.push([r.no, r.item, r.level, applicable, resultMark, note]);
    });

    var table = body.appendTable(tableData);

    // ヘッダー行スタイル
    var hdr = table.getRow(0);
    for (var h = 0; h < hdr.getNumCells(); h++) {
      hdr.getCell(h).setBackgroundColor('#333366');
      hdr.getCell(h).editAsText().setBold(true).setFontSize(9).setForegroundColor('#fff');
    }

    // 列幅
    table.getRow(0).getCell(0).setWidth(40);   // No.
    table.getRow(0).getCell(1).setWidth(200);  // 達成基準
    table.getRow(0).getCell(2).setWidth(60);   // 適合レベル
    table.getRow(0).getCell(3).setWidth(40);   // 適用
    table.getRow(0).getCell(4).setWidth(40);   // 結果
    table.getRow(0).getCell(5).setWidth(150);  // 注記

    // データ行スタイル
    for (var i = 1; i < table.getNumRows(); i++) {
      var row = table.getRow(i);
      for (var c = 0; c < row.getNumCells(); c++) {
        row.getCell(c).editAsText().setFontSize(9);
      }

      // 適用列・結果列のセンタリング
      row.getCell(2).setAttributes(centerAttr_());
      row.getCell(3).setAttributes(centerAttr_());
      row.getCell(4).setAttributes(centerAttr_());

      // 結果セルの色付け
      var resultText = row.getCell(4).getText().trim();
      if (resultText === '×') {
        row.getCell(4).setBackgroundColor('#fff2cc'); // 黄色背景（不合格）
        row.getCell(4).editAsText().setForegroundColor('#d32f2f').setBold(true);
      } else if (resultText === '△') {
        row.getCell(4).setBackgroundColor('#fce4ec'); // 薄ピンク（判定不能）
        row.getCell(4).editAsText().setForegroundColor('#e65100').setBold(true);
      } else if (resultText === '○') {
        row.getCell(4).editAsText().setForegroundColor('#333');
      }

      // 交互背景色（結果セル以外）
      if (i % 2 === 0) {
        for (var c2 = 0; c2 < row.getNumCells(); c2++) {
          if (c2 !== 4 || (resultText !== '×' && resultText !== '△')) {
            row.getCell(c2).setBackgroundColor('#f8f8f8');
          }
        }
      }
    }

    table.setBorderWidth(1).setBorderColor('#999');
  });

  /* ======================== 全ページ総合スコア ======================== */
  if (pages.length > 1) {
    body.appendPageBreak();
    body.appendParagraph('総合達成基準スコア')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .editAsText().setBold(true).setFontSize(16).setForegroundColor('#333366');

    body.appendParagraph('').setSpacingAfter(4);

    var totalScore = {pass:0,fail:0,unknown:0,na:0,unverified:0,total:0,applicable:0};
    pages.forEach(function(pg) {
      var s = calcScore_(pg);
      totalScore.pass += s.pass;
      totalScore.fail += s.fail;
      totalScore.unknown += s.unknown;
      totalScore.na += s.na;
      totalScore.unverified += s.unverified;
      totalScore.total += s.total;
      totalScore.applicable += s.applicable;
    });
    var totalRate = totalScore.applicable > 0 ? Math.round(totalScore.pass / totalScore.applicable * 100) : 0;

    var totalScorePara = body.appendParagraph(totalRate + '%');
    totalScorePara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    var tsStyle = totalScorePara.editAsText();
    tsStyle.setBold(true).setFontSize(36);
    if (totalRate >= 90) { tsStyle.setForegroundColor('#2e7d32'); }
    else if (totalRate >= 70) { tsStyle.setForegroundColor('#e65100'); }
    else { tsStyle.setForegroundColor('#d32f2f'); }

    body.appendParagraph(totalScore.pass + ' / ' + totalScore.applicable + ' 項目適合')
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .editAsText().setFontSize(12).setForegroundColor('#555');

    body.appendParagraph('').setSpacingAfter(4);

    // ページ別サマリーテーブル
    var sumData = [['ページ', '達成率', '合格', '不合格', '判定不能', '該当なし', '未検証']];
    pages.forEach(function(pg, idx) {
      var s = calcScore_(pg);
      sumData.push([
        cut_(pg.url, 50),
        s.rate + '%',
        String(s.pass),
        String(s.fail),
        String(s.unknown),
        String(s.na),
        String(s.unverified)
      ]);
    });
    var sumTable = body.appendTable(sumData);
    var sumHdr = sumTable.getRow(0);
    for (var sh = 0; sh < sumHdr.getNumCells(); sh++) {
      sumHdr.getCell(sh).setBackgroundColor('#333366');
      sumHdr.getCell(sh).editAsText().setBold(true).setFontSize(9).setForegroundColor('#fff');
    }
    for (var si = 1; si < sumTable.getNumRows(); si++) {
      for (var sc = 0; sc < sumTable.getRow(si).getNumCells(); sc++) {
        sumTable.getRow(si).getCell(sc).editAsText().setFontSize(9);
      }
    }
    sumTable.setBorderWidth(1).setBorderColor('#999');
  }

  /* ======================== フッター ======================== */
  body.appendParagraph('');
  body.appendHorizontalRule();
  body.appendParagraph('本報告書は axe-core 自動検査 および AI 評価エンジンにより生成されました。')
    .editAsText().setFontSize(8).setForegroundColor('#aaa');
  body.appendParagraph('△（判定不能）= AIが評価したが確信度が低い項目、ー（未検証）= 自動検査では検出できない項目です。いずれも目視によるヒューマンチェックが必要です。')
    .editAsText().setFontSize(8).setForegroundColor('#aaa');

  doc.saveAndClose();
  return doc.getUrl();
}

/* ============================================================
   シートデータ読み取り（現行11列 / 旧8列 / 旧7列対応）
   ============================================================ */
function readPages_(ss, selectedTabs) {
  var pages = [];
  var coverUrlMap = getCoverUrlMap_(ss);
  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (selectedTabs.length && selectedTabs.indexOf(name) === -1) return;
    var v = sheet.getDataRange().getValues();
    var detected = detectReportSheet_(v);
    if (!detected) return;

    var url  = coverUrlMap[name] || String(v[1] && v[1][1] || name);
    var time = String(v[2] && v[2][1] || '');

    if (detected.format === 'current11') {
      pages.push({
        url: url,
        time: time,
        rows: readCurrentRows_(v, detected.headerRow)
      });
      return;
    }

    // ヘッダー行から列構成を判定（8列: 適合レベルあり / 7列: 旧形式）
    var headerRow = detected.headerRow;
    var hasLevelCol = detected.format === 'legacy8';

    var rows = [];
    for (var i = headerRow + 1; i < v.length; i++) {
      var r = v[i];
      if (!r[0] && !r[1]) continue;

      if (hasLevelCol) {
        // 新8列形式: No, 検査項目, 適合レベル, 結果, 場所, 検出数, 詳細, 改善案
        rows.push({
          no: String(r[0]||''), item: String(r[1]||''), level: String(r[2]||''),
          result: String(r[3]||'').trim(),
          location: String(r[4]||''), count: String(r[5]||''),
          detail: String(r[6]||''), suggestion: String(r[7]||'')
        });
      } else {
        // 旧7列形式: No, 検査項目, 結果, 場所, 検出数, 詳細, 改善案
        // 検査項目からレベルを抽出
        var itemText = String(r[1]||'');
        var level = '';
        var levelMatch = itemText.match(/\[WCAG\s[\d.]+\s+(A{1,3})\]/);
        if (levelMatch) level = levelMatch[1];
        rows.push({
          no: String(r[0]||''), item: itemText, level: level,
          result: String(r[2]||'').trim(),
          location: String(r[3]||''), count: String(r[4]||''),
          detail: String(r[5]||''), suggestion: String(r[6]||'')
        });
      }
    }
    pages.push({url: url, time: time, rows: rows});
  });
  return pages;
}

function detectReportSheet_(values) {
  if (!values || !values.length) return null;

  // 現行フォーマット: 1行目に 11列ヘッダー
  for (var i = 0; i < Math.min(values.length, 8); i++) {
    var r = values[i] || [];
    if (String(r[0]).trim() === 'No' &&
        String(r[1]).trim() === '検査種別' &&
        String(r[2]).trim() === 'SC' &&
        String(r[3]).trim() === '検査項目' &&
        String(r[5]).trim() === '結果') {
      return {format: 'current11', headerRow: i};
    }
  }

  // 旧フォーマット: 5行目に 検査項目番号 ヘッダー
  for (var j = 0; j < Math.min(values.length, 8); j++) {
    var row = values[j] || [];
    if (String(row[0]).trim() !== '検査項目番号') continue;
    return {
      format: String(row[2]).trim() === '適合レベル' ? 'legacy8' : 'legacy7',
      headerRow: j
    };
  }

  return null;
}

function readCurrentRows_(values, headerRow) {
  var rows = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var r = values[i] || [];
    var no = String(r[0] || '').trim();
    var result = String(r[5] || '').trim();

    // PC/SP 区切り行や空行はDocsの達成基準表には出さない
    if (!result) continue;
    if (!no || /^＜.*＞$/.test(no)) continue;

    rows.push({
      no: no,
      item: [String(r[2] || '').trim(), String(r[3] || '').trim()].filter(Boolean).join(' '),
      level: String(r[4] || ''),
      result: result,
      location: String(r[6] || ''),
      count: String(r[7] || ''),
      detail: String(r[9] || ''),
      suggestion: String(r[10] || '')
    });
  }
  return rows;
}

function getCoverUrlMap_(ss) {
  var map = {};
  ss.getSheets().forEach(function(sheet) {
    var v = sheet.getDataRange().getDisplayValues();
    if (!v.length || String(v[0][0]).trim() !== 'アクセシビリティ検査レポート') return;
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][0]).trim() !== 'No' || String(v[i][1]).trim() !== 'URL') continue;
      for (var r = i + 1; r < v.length; r++) {
        var url = String(v[r][1] || '').trim();
        var tabName = String(v[r][10] || '').trim();
        if (url && tabName) map[tabName] = url;
      }
      return;
    }
  });
  return map;
}

/* ============================================================
   スコア計算
   ============================================================ */
function calcScore_(pg) {
  var s = {pass:0, fail:0, unknown:0, na:0, unverified:0, total:0, applicable:0, rate:0};
  pg.rows.forEach(function(r) {
    s.total++;
    switch (r.result) {
      case '合格':     s.pass++; break;
      case '不合格':   s.fail++; break;
      case '判定不能': s.unknown++; break;
      case '要手動確認': s.unknown++; break;
      case 'エラー':   s.unknown++; break;
      case '該当なし': s.na++; break;
      case '対象外':   s.na++; break;
      default:         s.unverified++; break;
    }
  });
  s.applicable = s.pass + s.fail + s.unknown;
  s.rate = s.applicable > 0 ? Math.round(s.pass / s.applicable * 100) : 0;
  return s;
}

/* ============================================================
   結果マッピング（達成基準リスト形式）
   ============================================================ */
function mapResult_(result) {
  switch (result) {
    case '合格':     return '○';
    case '不合格':   return '×';
    case '判定不能': return '△';
    case '要手動確認': return '△';
    case 'エラー':   return '△';
    case '該当なし': return '○';
    case '対象外':   return '○';
    case '未検証':   return 'ー';
    default:         return 'ー';
  }
}

function mapApplicable_(result) {
  return (result === '該当なし' || result === '対象外') ? 'ー' : '○';
}

function buildNote_(r) {
  if (r.result === '該当なし') return '該当箇所なし';
  if (r.result === '対象外') return '対象外';
  if (r.result === '未検証')   return '要目視確認';
  if (r.result === '判定不能') return 'AI判定: 確信度低' + (r.detail ? ' / ' + cut_(r.detail, 60) : '');
  if (r.result === '要手動確認') return '要目視確認' + (r.detail ? ' / ' + cut_(r.detail, 60) : '');
  if (r.result === 'エラー') return '検査エラー' + (r.detail ? ' / ' + cut_(r.detail, 60) : '');
  if (r.result === '不合格') {
    var parts = [];
    if (r.count && r.count !== '—') parts.push(r.count + '件検出');
    if (r.suggestion) parts.push(cut_(r.suggestion, 80));
    else if (r.detail) parts.push(cut_(r.detail, 80));
    return parts.join(' / ') || '';
  }
  return '';
}

/* ============================================================
   ヘルパー
   ============================================================ */
function centerAttr_() {
  var a = {};
  a[DocumentApp.Attribute.HORIZONTAL_ALIGNMENT] = DocumentApp.HorizontalAlignment.CENTER;
  return a;
}

function cut_(s, n) { return (!s||s.length<=n) ? (s||'') : s.substring(0,n)+'…'; }

function fmtDate_(s) {
  if (!s) return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年MM月dd日');
  try { return Utilities.formatDate(new Date(s), 'Asia/Tokyo', 'yyyy年MM月dd日'); }
  catch(e) { return s; }
}
