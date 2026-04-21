/**
 * アクセシビリティ検査レポート → Google Docs「評価報告書」生成 GAS
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
    .addItem('アクセシビリティ評価報告書を生成', 'showReportDialog')
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
    '.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
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

    '<label>対象サイト名</label>',
    '<input id="v_siteName" placeholder="例: 株式会社サンプル コーポレートサイト">',

    '<label>作成者</label>',
    '<input id="v_author" placeholder="例: 山田太郎">',

    '<div class="row">',
    '<div><label>作成日</label><input id="v_date" type="date"></div>',
    '<div><label>バージョン</label><input id="v_version" value="1.0"></div>',
    '</div>',

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
    '    .generateReport({company:document.getElementById("v_company").value,siteName:document.getElementById("v_siteName").value,author:document.getElementById("v_author").value,createdDate:document.getElementById("v_date").value,version:document.getElementById("v_version").value,tabs:sel});',
    '}',
    '</script>'
  ].join('\n'))
  .setWidth(440)
  .setHeight(500);

  SpreadsheetApp.getUi().showModalDialog(html, '報告書生成');
}

/* ============================================================
   対象タブ一覧
   ============================================================ */
function getReportTabs() {
  var out = [];
  var GRID = SpreadsheetApp.SheetType.GRID;
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function(s) {
    try {
      // DATASOURCE・OBJECT シートは読み取り時にPERMISSION_DENIEDが発生するためスキップ
      if (s.getType() !== GRID) return;
      var lastRow = s.getLastRow();
      var lastCol = s.getLastColumn();
      if (lastRow === 0 || lastCol === 0) return;
      var rows = Math.min(lastRow, 8);
      var cols = Math.min(lastCol, 12);
      var v = s.getRange(1, 1, rows, cols).getDisplayValues();
      if (detectReportSheet_(v)) out.push(s.getName());
    } catch (e) {
      // 読み取り不可のシートはスキップ
    }
  });
  return out;
}

/* ============================================================
   メイン: 報告書生成（評価報告書形式）
   ============================================================ */
function generateReport(info) {
  info = info || {};
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var pages = readPages_(ss, info.tabs || []);
  if (!pages.length) throw new Error('対象タブが見つかりません');

  info = normalizeReportInfo_(info, pages);
  var dateLabel = info.createdDate || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var docTitle  = 'アクセシビリティ評価報告書' +
                  (info.siteName ? ' - ' + info.siteName : '') +
                  '（' + dateLabel + '）';
  var doc  = DocumentApp.create(docTitle);
  var body = doc.getBody();
  body.clear();

  // デフォルトスタイル
  var defaultStyle = {};
  defaultStyle[DocumentApp.Attribute.FONT_SIZE] = 10;
  defaultStyle[DocumentApp.Attribute.FONT_FAMILY] = 'Arial';
  body.setAttributes(defaultStyle);

  var totalScore = calcTotalScore_(pages);
  var criterionGroups = buildCriterionGroups_(pages);
  var issues = buildIssueList_(pages);

  appendCover_(body, info);
  body.appendPageBreak();

  appendHeading_(body, '1. エグゼクティブサマリー', 1);
  body.appendParagraph(
    '本報告書は、' + info.siteName + 'に対して実施したアクセシビリティ評価の結果をまとめたものです。評価は ' +
    info.standard + ' を基準として実施しました。'
  ).editAsText().setFontSize(10);

  appendHeading_(body, '総合評価結果', 2);
  appendSummaryTable_(body, totalScore);
  body.appendParagraph(buildExecutiveSummary_(info, totalScore, issues))
    .editAsText().setFontSize(10);

  appendHeading_(body, '2. 評価概要', 1);
  appendHeading_(body, '2.1 評価方法', 2);
  appendBullets_(body, [
    '自動テスト: axe-core による WCAG 関連ルールの検査',
    '高精度検査: Puppeteer によるページ操作、キーボード操作、表示状態の確認',
    'AI 評価: HTML、スクリーンショット、検査結果をもとにした達成基準単位の補助判定',
    '手動確認: AI または自動検査で判断できない項目の目視レビュー前提項目を抽出'
  ]);

  appendHeading_(body, '2.2 評価対象ページ', 2);
  appendTargetPagesTable_(body, pages);

  body.appendPageBreak();
  appendHeading_(body, '3. WCAG 2.2 達成基準別評価結果', 1);
  body.appendParagraph(
    'WCAG 2.2 の4原則（知覚可能・操作可能・理解可能・堅牢）に基づき、Level A・Level AA の各達成基準を評価しました。' +
    '【2.2新規】と記載された項目は WCAG 2.2 で追加された達成基準です。'
  ).editAsText().setFontSize(10);
  appendCriteriaSections_(body, criterionGroups);

  body.appendPageBreak();
  appendHeading_(body, '4. 問題点一覧と改善推奨', 1);
  body.appendParagraph('以下の表に、評価で発見された問題点と推奨される改善対応策をまとめます。重要度は「高」「中」「低」の3段階で示します。')
    .editAsText().setFontSize(10);
  appendIssuesTable_(body, issues);

  appendHeading_(body, '5. 改善ロードマップ', 1);
  body.appendParagraph('以下の優先度に従って改善を実施することを推奨します。')
    .editAsText().setFontSize(10);
  appendRoadmapTable_(body, issues, info.createdDate);

  appendHeading_(body, '6. 推奨事項', 1);
  appendHeading_(body, '6.1 短期的な改善推奨（3ヶ月以内）', 2);
  appendBullets_(body, buildShortTermRecommendations_(issues));
  appendHeading_(body, '6.2 中長期的な組織的取り組み', 2);
  appendBullets_(body, [
    '開発プロセスにアクセシビリティチェックを組み込み、リリース前の回帰確認を継続する。',
    'デザインシステムにコントラスト、フォーカス表示、フォームラベル、ターゲットサイズの基準を明文化する。',
    '開発者・デザイナー向けに WCAG 2.2 の新規項目を含む定期的なアクセシビリティ研修を実施する。',
    '障害のある実ユーザー、スクリーンリーダー利用者、キーボード利用者を含むユーザーテストを定期的に実施する。'
  ]);

  appendHeading_(body, '7. 参照規格・ツール', 1);
  appendReferenceTable_(body, info);

  appendHeading_(body, '改訂履歴', 1);
  appendRevisionTable_(body, info);

  body.appendParagraph('── 報告書終了 ──')
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
    .editAsText().setFontSize(9).setForegroundColor('#777');

  doc.saveAndClose();
  return doc.getUrl();
}

/* ============================================================
   評価報告書: 章立て・集計ヘルパー
   ============================================================ */
function normalizeReportInfo_(info, pages) {
  info = info || {};
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var createdDate = String(info.createdDate || today).trim();
  var siteName = String(info.siteName || info.company || deriveSiteName_(pages)).trim();
  var period = String(info.period || '').trim();
  if (!period) {
    var start = String(info.periodStart || '').trim();
    var end = String(info.periodEnd || '').trim();
    if (start && end) period = fmtDate_(start) + ' 〜 ' + fmtDate_(end);
    else if (start) period = fmtDate_(start) + ' 〜';
    else if (end) period = '〜 ' + fmtDate_(end);
  }
  if (!period) period = fmtDate_(createdDate);

  return {
    siteName: siteName || '対象サイト',
    company: String(info.company || siteName || '').trim(),
    author: String(info.author || '').trim() || 'アクセシビリティ検査チーム',
    createdDate: createdDate,
    createdDateLabel: fmtDate_(createdDate),
    period: period,
    standard: String(info.standard || 'WCAG 2.2 Level AA / JIS X 8341-3:2016').trim(),
    version: String(info.version || '1.0').trim()
  };
}

function appendCover_(body, info) {
  body.appendParagraph('アクセシビリティ評価報告書')
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
    .editAsText().setBold(true).setFontSize(24).setForegroundColor('#1f2937');
  body.appendParagraph('WCAG 2.2 Level AA 準拠審査')
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
    .editAsText().setBold(true).setFontSize(14).setForegroundColor('#4b5563');
  body.appendParagraph('').setSpacingAfter(16);

  var meta = [
    ['対象サイト', info.siteName],
    ['審査基準', info.standard],
    ['審査実施期間', info.period],
    ['報告書作成日', info.createdDateLabel],
    ['審査担当者', info.author],
    ['バージョン', info.version]
  ];
  var table = body.appendTable(meta);
  styleTable_(table, {
    headerRows: 0,
    widths: [120, 360],
    fontSize: 10,
    firstColumnHeader: true
  });
}

function appendHeading_(body, text, level) {
  var p = body.appendParagraph(text);
  p.setHeading(level === 1 ? DocumentApp.ParagraphHeading.HEADING1 : DocumentApp.ParagraphHeading.HEADING2);
  var t = p.editAsText();
  t.setBold(true).setForegroundColor(level === 1 ? '#1f2937' : '#374151');
  t.setFontSize(level === 1 ? 15 : 12);
  p.setSpacingBefore(level === 1 ? 12 : 8).setSpacingAfter(4);
  return p;
}

function appendBullets_(body, items) {
  items.forEach(function(item) {
    body.appendListItem(item)
      .setGlyphType(DocumentApp.GlyphType.BULLET)
      .editAsText().setFontSize(10).setForegroundColor('#111827');
  });
}

function appendSummaryTable_(body, totalScore) {
  var review = totalScore.unknown + totalScore.unverified;
  var table = body.appendTable([
    ['合格', '不合格', '要確認', '対象外'],
    [totalScore.pass + ' 項目', totalScore.fail + ' 項目', review + ' 項目', totalScore.na + ' 項目']
  ]);
  styleTable_(table, {
    headerRows: 1,
    widths: [110, 110, 110, 110],
    fontSize: 11,
    centerColumns: [0, 1, 2, 3],
    headerBackground: '#e5e7eb',
    headerColor: '#111827'
  });
  for (var c = 0; c < table.getRow(1).getNumCells(); c++) {
    table.getRow(1).getCell(c).editAsText().setBold(true).setFontSize(12);
  }
}

function appendTargetPagesTable_(body, pages) {
  var rows = [['No.', 'ページ名', 'URL']];
  pages.forEach(function(pg, idx) {
    rows.push([String(idx + 1), getPageName_(pg), pg.url]);
  });
  var table = body.appendTable(rows);
  styleTable_(table, {
    headerRows: 1,
    widths: [38, 150, 320],
    fontSize: 9,
    centerColumns: [0]
  });
}

function appendCriteriaSections_(body, criterionGroups) {
  var sections = [
    {key: '1', title: '3.1 原則1: 知覚可能（Perceivable）'},
    {key: '2', title: '3.2 原則2: 操作可能（Operable）'},
    {key: '3', title: '3.3 原則3: 理解可能（Understandable）'},
    {key: '4', title: '3.4 原則4: 堅牢（Robust）'}
  ];
  sections.forEach(function(section) {
    appendHeading_(body, section.title, 2);
    var items = criterionGroups[section.key] || [];
    if (!items.length) {
      body.appendParagraph('該当する達成基準の検査結果はありません。')
        .editAsText().setFontSize(9).setForegroundColor('#666');
      return;
    }
    var data = [['達成基準', '内容', 'レベル', '判定', '備考・詳細']];
    items.forEach(function(item) {
      data.push([
        item.sc,
        (isWcag22New_(item.sc) ? '【2.2新規】' : '') + item.title,
        item.level,
        item.result,
        item.detail
      ]);
    });
    var table = body.appendTable(data);
    styleTable_(table, {
      headerRows: 1,
      widths: [62, 185, 45, 58, 190],
      fontSize: 8,
      centerColumns: [0, 2, 3],
      resultColumn: 3
    });
  });
}

function appendIssuesTable_(body, issues) {
  if (!issues.length) {
    body.appendParagraph('今回の検査データでは、不合格として記録された問題はありません。要確認項目については別途目視確認を行ってください。')
      .editAsText().setFontSize(10);
    return;
  }
  var rows = [['No.', '重要度', '問題の説明', '該当箇所', '推奨対応策']];
  issues.forEach(function(issue, idx) {
    rows.push([
      String(idx + 1),
      issue.severity,
      issue.description,
      issue.location,
      issue.suggestion
    ]);
  });
  var table = body.appendTable(rows);
  styleTable_(table, {
    headerRows: 1,
    widths: [32, 44, 175, 140, 185],
    fontSize: 8,
    centerColumns: [0, 1]
  });
  for (var i = 1; i < table.getNumRows(); i++) {
    var sev = table.getRow(i).getCell(1).getText().trim();
    if (sev === '高') table.getRow(i).getCell(1).setBackgroundColor('#fee2e2');
    else if (sev === '中') table.getRow(i).getCell(1).setBackgroundColor('#fef3c7');
    else table.getRow(i).getCell(1).setBackgroundColor('#e5e7eb');
    table.getRow(i).getCell(1).editAsText().setBold(true);
  }
}

function appendRoadmapTable_(body, issues, createdDate) {
  var high = summarizeIssueTitles_(issues, '高') || '重大な阻害要因の確認と即時修正';
  var middle = summarizeIssueTitles_(issues, '中') || '残存する不合格項目と要確認項目の改善';
  var low = summarizeIssueTitles_(issues, '低') || '軽微な改善、回帰テスト、運用ルールの整備';
  var rows = [
    ['フェーズ', '目標期限', '対応内容'],
    ['フェーズ 1\n緊急対応', deadlineLabel_(createdDate, 1), high],
    ['フェーズ 2\n優先対応', deadlineLabel_(createdDate, 3), middle],
    ['フェーズ 3\n継続改善', deadlineLabel_(createdDate, 6) + '〜', low]
  ];
  var table = body.appendTable(rows);
  styleTable_(table, {
    headerRows: 1,
    widths: [95, 100, 330],
    fontSize: 9
  });
}

function appendReferenceTable_(body, info) {
  var table = body.appendTable([
    ['項目', '詳細'],
    ['審査基準', info.standard],
    ['自動テストツール', 'axe-core / Puppeteer による自動検査'],
    ['AI評価', 'HTML、スクリーンショット、検査結果をもとにした達成基準別の補助判定'],
    ['手動確認対象', 'キーボード操作、フォーカス表示、フォーム、代替テキスト、コントラスト、ターゲットサイズ等'],
    ['レポート生成', 'Google Sheets の検査結果を Google Apps Script で集計し、Google Docs として出力']
  ]);
  styleTable_(table, {
    headerRows: 1,
    widths: [130, 380],
    fontSize: 9
  });
}

function appendRevisionTable_(body, info) {
  var table = body.appendTable([
    ['Ver.', '日付', '担当者', '変更内容'],
    [info.version, info.createdDateLabel, info.author, '初版作成・検査結果反映']
  ]);
  styleTable_(table, {
    headerRows: 1,
    widths: [50, 100, 150, 220],
    fontSize: 9,
    centerColumns: [0, 1]
  });
}

function styleTable_(table, opt) {
  opt = opt || {};
  var headerRows = opt.headerRows || 0;
  var widths = opt.widths || [];
  var fontSize = opt.fontSize || 9;
  var centerMap = {};
  (opt.centerColumns || []).forEach(function(c) { centerMap[c] = true; });

  table.setBorderWidth(1).setBorderColor('#9ca3af');
  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      var cell = row.getCell(c);
      if (widths[c]) cell.setWidth(widths[c]);
      cell.editAsText().setFontSize(fontSize).setForegroundColor('#111827');
      if (r < headerRows) {
        cell.setBackgroundColor(opt.headerBackground || '#374151');
        cell.editAsText().setBold(true).setForegroundColor(opt.headerColor || '#ffffff');
      } else if (opt.firstColumnHeader && c === 0) {
        cell.setBackgroundColor('#f3f4f6');
        cell.editAsText().setBold(true);
      } else if (r % 2 === 0) {
        cell.setBackgroundColor('#f9fafb');
      }
      if (centerMap[c]) cell.setAttributes(centerAttr_());
    }
    if (opt.resultColumn !== undefined && r >= headerRows) {
      styleResultCell_(row.getCell(opt.resultColumn));
    }
  }
}

function styleResultCell_(cell) {
  var result = cell.getText().trim();
  if (result === '不合格') {
    cell.setBackgroundColor('#fee2e2');
    cell.editAsText().setBold(true).setForegroundColor('#991b1b');
  } else if (result === '要確認') {
    cell.setBackgroundColor('#fef3c7');
    cell.editAsText().setBold(true).setForegroundColor('#92400e');
  } else if (result === '合格') {
    cell.setBackgroundColor('#dcfce7');
    cell.editAsText().setBold(true).setForegroundColor('#166534');
  } else if (result === '対象外') {
    cell.setBackgroundColor('#e5e7eb');
    cell.editAsText().setForegroundColor('#4b5563');
  }
}

function calcTotalScore_(pages) {
  var total = {pass:0, fail:0, unknown:0, na:0, unverified:0, total:0, applicable:0, rate:0};
  pages.forEach(function(pg) {
    var s = calcScore_(pg);
    total.pass += s.pass;
    total.fail += s.fail;
    total.unknown += s.unknown;
    total.na += s.na;
    total.unverified += s.unverified;
    total.total += s.total;
    total.applicable += s.applicable;
  });
  total.rate = total.applicable > 0 ? Math.round(total.pass / total.applicable * 100) : 0;
  return total;
}

function buildExecutiveSummary_(info, score, issues) {
  var review = score.unknown + score.unverified;
  if (!score.fail && !review) {
    return '評価の結果、対象サイトは ' + info.standard + ' の適合要件に対して大きな阻害要因は確認されませんでした。今後もコンテンツ追加時の回帰確認を継続することを推奨します。';
  }
  var msg = '評価の結果、対象サイトは ' + info.standard + ' の適合要件に対して部分的に準拠しています。';
  if (score.fail) msg += '不合格となった ' + score.fail + ' 項目については改善が必要です。';
  if (review) msg += 'また、要確認となった ' + review + ' 項目については目視確認を行い、必要に応じて修正してください。';
  var highIssues = issues.filter(function(i) { return i.severity === '高'; }).slice(0, 3);
  if (highIssues.length) {
    msg += ' 特に ' + highIssues.map(function(i) { return i.sc + ' ' + i.title; }).join('、') + ' は利用者への影響が大きいため、優先的な対応を推奨します。';
  }
  return msg;
}

function buildCriterionGroups_(pages) {
  var map = {};
  pages.forEach(function(pg) {
    pg.rows.forEach(function(r) {
      var sc = normalizeSc_(r.sc || extractSc_(r.item));
      if (!sc) return;
      var title = normalizeCriterionTitle_(r);
      var key = sc + '|' + title;
      if (!map[key]) {
        map[key] = {sc: sc, title: title, level: r.level || '', rows: []};
      }
      map[key].rows.push({page: pg, row: r});
      if (!map[key].level && r.level) map[key].level = r.level;
    });
  });

  var grouped = {'1': [], '2': [], '3': [], '4': []};
  Object.keys(map).forEach(function(key) {
    var item = map[key];
    item.result = combineCriterionResult_(item.rows);
    item.detail = buildCriterionDetail_(item);
    var principle = firstSc_(item.sc).split('.')[0];
    if (!grouped[principle]) grouped[principle] = [];
    grouped[principle].push(item);
  });
  Object.keys(grouped).forEach(function(k) {
    grouped[k].sort(function(a, b) { return scSortValue_(a.sc) - scSortValue_(b.sc); });
  });
  return grouped;
}

function combineCriterionResult_(entries) {
  var hasFail = false, hasReview = false, hasPass = false, hasNa = false;
  entries.forEach(function(entry) {
    var r = entry.row.result;
    if (r === '不合格') hasFail = true;
    else if (r === '判定不能' || r === '要手動確認' || r === 'エラー' || r === '未検証') hasReview = true;
    else if (r === '合格') hasPass = true;
    else if (r === '該当なし' || r === '対象外') hasNa = true;
    else hasReview = true;
  });
  if (hasFail) return '不合格';
  if (hasReview) return '要確認';
  if (hasPass) return '合格';
  if (hasNa) return '対象外';
  return '要確認';
}

function buildCriterionDetail_(item) {
  var priority = item.result;
  var parts = [];
  item.rows.forEach(function(entry) {
    var r = entry.row;
    if (priority === '不合格' && r.result !== '不合格') return;
    if (priority === '要確認' && !(r.result === '判定不能' || r.result === '要手動確認' || r.result === 'エラー' || r.result === '未検証')) return;
    var text = compactFindingText_(r);
    if (!text && priority === '合格') text = '検出された問題なし';
    if (!text && priority === '対象外') text = '該当箇所なし';
    if (text) parts.push(getPageName_(entry.page) + ': ' + text);
  });
  parts = uniqueList_(parts).slice(0, 3);
  if (parts.length) return cut_(parts.join(' / '), 180);
  if (priority === '合格') return '検出された問題なし';
  if (priority === '対象外') return '該当箇所なし';
  return '目視確認が必要';
}

function buildIssueList_(pages) {
  var map = {};
  pages.forEach(function(pg) {
    pg.rows.forEach(function(r) {
      if (r.result !== '不合格') return;
      var sc = normalizeSc_(r.sc || extractSc_(r.item));
      var title = normalizeCriterionTitle_(r);
      var suggestion = buildIssueSuggestion_(r);
      var description = buildIssueDescription_(r, sc, title);
      var key = [sc, title, cut_(description, 80), cut_(suggestion, 80)].join('|');
      if (!map[key]) {
        map[key] = {
          sc: sc || '—',
          title: title || '検査項目',
          severity: normalizeSeverity_(r),
          description: description,
          locationList: [],
          suggestion: suggestion
        };
      }
      var loc = buildIssueLocation_(pg, r);
      if (loc) map[key].locationList.push(loc);
      var newSeverity = normalizeSeverity_(r);
      if (severityRank_(newSeverity) < severityRank_(map[key].severity)) {
        map[key].severity = newSeverity;
      }
    });
  });

  var issues = Object.keys(map).map(function(k) {
    var issue = map[k];
    issue.location = cut_(uniqueList_(issue.locationList).slice(0, 4).join('\n'), 180) || '該当箇所未記録';
    return issue;
  });
  issues.sort(function(a, b) {
    var sev = severityRank_(a.severity) - severityRank_(b.severity);
    if (sev !== 0) return sev;
    return scSortValue_(a.sc) - scSortValue_(b.sc);
  });
  return issues;
}

function buildIssueDescription_(r, sc, title) {
  var detail = compactFindingText_(r);
  var base = (sc ? sc + ' ' : '') + title + ' が基準を満たしていません。';
  return cut_(detail ? base + detail : base, 170);
}

function buildIssueLocation_(pg, r) {
  var parts = [getPageName_(pg)];
  if (r.location) parts.push(r.location);
  return parts.join(' / ');
}

function buildIssueSuggestion_(r) {
  if (r.suggestion) return cut_(r.suggestion, 190);
  var sc = firstSc_(normalizeSc_(r.sc || extractSc_(r.item)));
  var fallback = {
    '1.1.1': '画像やアイコンの目的に応じて適切な代替テキストを設定し、装飾画像には alt="" を指定する。',
    '1.3.1': '見出し、リスト、フォームラベルなどの構造をHTML要素またはARIAでプログラムが解釈できるようにする。',
    '1.4.3': '通常テキストは4.5:1以上、大きなテキストは3:1以上のコントラスト比を確保する。',
    '1.4.11': 'UIコンポーネントや重要なグラフィックの視覚情報は3:1以上のコントラスト比を確保する。',
    '2.1.1': 'マウス操作だけでなく、キーボードのみですべての機能を操作できるようにする。',
    '2.1.2': 'モーダルやメニュー内でフォーカスが閉じ込められたり、意図せず背景へ抜けたりしないように制御する。',
    '2.4.4': 'リンクテキスト単体、または文脈からリンク先の目的が分かる文言に修正する。',
    '2.4.7': ':focus-visible 等で視認性の高いフォーカス表示を実装し、outline: none のみの指定を避ける。',
    '2.5.8': 'ポインタ入力のターゲットを24×24 CSS px以上にするか、十分な間隔を確保する。',
    '3.3.2': '入力欄にはラベルまたは説明を付与し、必須項目や入力形式を明確に示す。'
  };
  return fallback[sc] || '該当箇所の実装を達成基準に沿って見直し、修正後に再検査を行う。';
}

function buildShortTermRecommendations_(issues) {
  if (!issues.length) {
    return [
      '要確認項目を目視で確認し、判断結果を検査シートへ反映する。',
      '新規ページや更新ページに対して同じ検査フローを適用し、継続的に品質を確認する。',
      'リリース前チェックリストにアクセシビリティ検査を組み込む。'
    ];
  }
  var out = [];
  issues.forEach(function(issue) {
    if (out.length >= 6) return;
    var text = issue.sc + ' ' + issue.title + ': ' + issue.suggestion;
    if (out.indexOf(text) === -1) out.push(text);
  });
  return out;
}

function summarizeIssueTitles_(issues, severity) {
  var titles = uniqueList_(issues.filter(function(i) {
    return i.severity === severity;
  }).map(function(i) {
    return i.sc + ' ' + i.title;
  })).slice(0, 5);
  if (!titles.length) return '';
  return titles.join('、') + ' の修正';
}

function compactFindingText_(r) {
  var parts = [];
  if (r.count && r.count !== '—' && r.count !== '-') parts.push(r.count + '件検出');
  if (r.detail) parts.push(r.detail);
  else if (r.suggestion) parts.push(r.suggestion);
  else if (r.location) parts.push(r.location);
  return cut_(parts.join(' / '), 150);
}

function normalizeSeverity_(r) {
  var s = String(r.severity || '').trim();
  if (s === '緊急' || s === '重大' || s === '高') return '高';
  if (s === '中程度' || s === '中') return '中';
  if (s === '軽微' || s === '低') return '低';
  var sc = firstSc_(normalizeSc_(r.sc || extractSc_(r.item)));
  if (/^(1\.1\.1|1\.3\.1|2\.1\.1|2\.1\.2|2\.4\.7)$/.test(sc)) return '高';
  if (/^(1\.4\.3|1\.4\.11|2\.5\.8|3\.3\.1|3\.3\.2)$/.test(sc)) return '中';
  return '中';
}

function severityRank_(s) {
  if (s === '高') return 1;
  if (s === '中') return 2;
  return 3;
}

function deriveSiteName_(pages) {
  if (!pages || !pages.length) return '対象サイト';
  var parsed = parseUrlParts_(pages[0].url);
  return parsed ? parsed.hostname : (pages[0].url || '対象サイト');
}

function getPageName_(pg) {
  if (pg.pageName) return pg.pageName;
  var parsed = parseUrlParts_(pg.url);
  if (!parsed) return pg.sheetName || pg.url || 'ページ';
  if (!parsed.pathname || parsed.pathname === '/') return 'トップページ';
  var parts = parsed.pathname.split('/').filter(Boolean);
  return safeDecode_(parts[parts.length - 1] || parts[0] || parsed.hostname);
}

function parseUrlParts_(url) {
  var m = String(url || '').match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
  if (!m) return null;
  return {hostname: m[1], pathname: m[2] || '/'};
}

function safeDecode_(s) {
  try { return decodeURIComponent(s); }
  catch(e) { return s; }
}

function normalizeCriterionTitle_(r) {
  var title = String(r.title || r.item || '').trim();
  title = title.replace(/^\s*\d+\.\d+\.\d+\s*/, '');
  title = title.replace(/\[WCAG\s*[\d.]+\s*A{1,3}\]/g, '').trim();
  title = title.replace(/^[:：\s-]+/, '');
  return title || '達成基準';
}

function normalizeSc_(s) {
  var list = String(s || '').match(/\d+\.\d+\.\d+/g);
  return list ? uniqueList_(list).join(', ') : '';
}

function extractSc_(s) {
  var m = String(s || '').match(/\d+\.\d+\.\d+/);
  return m ? m[0] : '';
}

function firstSc_(s) {
  var m = String(s || '').match(/\d+\.\d+\.\d+/);
  return m ? m[0] : '';
}

function scSortValue_(s) {
  var sc = firstSc_(s);
  if (!sc) return 999999;
  var parts = sc.split('.');
  return Number(parts[0]) * 10000 + Number(parts[1]) * 100 + Number(parts[2]);
}

function isWcag22New_(s) {
  var newSc = {
    '2.4.11': true, '2.4.12': true, '2.4.13': true,
    '2.5.7': true, '2.5.8': true,
    '3.2.6': true, '3.3.7': true, '3.3.8': true, '3.3.9': true
  };
  return !!newSc[firstSc_(s)];
}

function uniqueList_(list) {
  var seen = {}, out = [];
  list.forEach(function(v) {
    v = String(v || '').trim();
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

function deadlineLabel_(baseDate, monthOffset) {
  var d = parseDate_(baseDate) || new Date();
  d.setMonth(d.getMonth() + monthOffset);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy年M月末');
}

function parseDate_(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ============================================================
   シートデータ読み取り（現行11列 / 旧8列 / 旧7列対応）
   ============================================================ */
function readPages_(ss, selectedTabs) {
  var pages = [];
  var GRID = SpreadsheetApp.SheetType.GRID;
  var coverUrlMap = getCoverUrlMap_(ss);
  ss.getSheets().forEach(function(sheet) {
    try { if (sheet.getType() !== GRID) return; } catch(e) { return; }
    var name = sheet.getName();
    if (selectedTabs.length && selectedTabs.indexOf(name) === -1) return;
    var v;
    try { v = sheet.getDataRange().getDisplayValues(); } catch(e) { return; }
    var detected = detectReportSheet_(v);
    if (!detected) return;

    var url  = coverUrlMap[name] || String(v[1] && v[1][1] || name);
    var time = String(v[2] && v[2][1] || '');

    if (detected.format === 'current11') {
      pages.push({
        sheetName: name,
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
          no: String(r[0]||''), sc: extractSc_(r[1]), item: String(r[1]||''), title: normalizeLegacyTitle_(r[1]), level: String(r[2]||''),
          result: String(r[3]||'').trim(),
          location: String(r[4]||''), count: String(r[5]||''),
          severity: '', detail: String(r[6]||''), suggestion: String(r[7]||'')
        });
      } else {
        // 旧7列形式: No, 検査項目, 結果, 場所, 検出数, 詳細, 改善案
        // 検査項目からレベルを抽出
        var itemText = String(r[1]||'');
        var level = '';
        var levelMatch = itemText.match(/\[WCAG\s[\d.]+\s+(A{1,3})\]/);
        if (levelMatch) level = levelMatch[1];
        rows.push({
          no: String(r[0]||''), sc: extractSc_(itemText), item: itemText, title: normalizeLegacyTitle_(itemText), level: level,
          result: String(r[2]||'').trim(),
          location: String(r[3]||''), count: String(r[4]||''),
          severity: '', detail: String(r[5]||''), suggestion: String(r[6]||'')
        });
      }
    }
    pages.push({sheetName: name, url: url, time: time, rows: rows});
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
      checkType: String(r[1] || '').trim(),
      sc: String(r[2] || '').trim(),
      item: [String(r[2] || '').trim(), String(r[3] || '').trim()].filter(Boolean).join(' '),
      title: String(r[3] || '').trim(),
      level: String(r[4] || ''),
      result: result,
      location: String(r[6] || ''),
      count: String(r[7] || ''),
      severity: String(r[8] || ''),
      detail: String(r[9] || ''),
      suggestion: String(r[10] || '')
    });
  }
  return rows;
}

function normalizeLegacyTitle_(s) {
  var title = String(s || '').trim();
  title = title.replace(/\[WCAG\s*[\d.]+\s*A{1,3}\]/g, '').trim();
  title = title.replace(/^\s*\d+\.\d+\.\d+\s*/, '').trim();
  return title;
}

function getCoverUrlMap_(ss) {
  var map = {};
  var GRID = SpreadsheetApp.SheetType.GRID;
  ss.getSheets().forEach(function(sheet) {
    try { if (sheet.getType() !== GRID) return; } catch(e) { return; }
    var v;
    try { v = sheet.getDataRange().getDisplayValues(); } catch(e) { return; }
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
