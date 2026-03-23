/**
 * アクセシビリティ検査レポート → Google Docs 報告書 生成 GAS
 *
 * ■ 設定手順
 *   1. レポートのスプレッドシートを開く
 *   2. 拡張機能 → Apps Script
 *   3. エディタ左のファイル一覧で「コード.gs」を選択し、中身を全て削除してこのファイルを貼り付け
 *   4. 左のファイル一覧に appsscript.json が表示されていなければ
 *      プロジェクトの設定（歯車アイコン）→「エディタで appsscript.json マニフェスト ファイルを表示する」にチェック
 *   5. appsscript.json を開き、中身を以下に差し替えて保存:
 *      {
 *        "timeZone": "Asia/Tokyo",
 *        "dependencies": {},
 *        "exceptionLogging": "STACKDRIVER",
 *        "runtimeVersion": "V8",
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/spreadsheets.readonly",
 *          "https://www.googleapis.com/auth/documents",
 *          "https://www.googleapis.com/auth/script.container.ui"
 *        ]
 *      }
 *   6. スプレッドシートをリロード → メニュー「報告書」が表示される
 *   7. 「報告書 ▸ Google Docs 報告書を生成」をクリック
 *   8. 初回は承認ダイアログが出るので「許可」
 *
 * ■ スプレッドシートの想定構成（検査ツールが自動生成）
 *   各タブ = 1URL分の検査結果
 *   行1: アクセシビリティ検査レポート（タイトル、セル結合）
 *   行2: 検査対象URL | https://example.com
 *   行3: 検査日時     | 2026/3/13 15:30:00
 *   行4: （空行）
 *   行5: 検査項目番号 | 検査項目 | 結果 | 場所 | 検出数 | 詳細 | 改善案
 *   行6～: データ行
 *
 * ■ 必要な権限（最小限）
 *   - spreadsheets.readonly : シートデータの読み取り
 *   - documents             : Docs の作成・書き込み
 *   - script.container.ui   : ダイアログ表示
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
    'label{display:block;margin-top:14px;font-weight:600;font-size:13px}',
    'input{width:100%;padding:7px 10px;margin-top:4px;border:1px solid #ccc;border-radius:4px;font-size:14px;box-sizing:border-box}',
    '.chips{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}',
    '.chip{padding:5px 12px;border:1px solid #1a73e8;border-radius:20px;font-size:12px;cursor:pointer;background:#fff;color:#1a73e8;user-select:none;transition:.15s}',
    '.chip.on{background:#1a73e8;color:#fff}',
    '.foot{margin-top:22px;display:flex;align-items:center;gap:12px;justify-content:flex-end}',
    '.btn{padding:9px 28px;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:600}',
    '.btn-p{background:#1a73e8;color:#fff}.btn-p:hover{background:#1557b0}.btn-p:disabled{background:#94bef8;cursor:wait}',
    '#msg{font-size:13px;color:#666;margin-top:10px;min-height:18px}',
    '</style>',

    '<label>社名 / 組織名</label>',
    '<input id="v_company" placeholder="例: 株式会社サンプル">',

    '<label>作成者</label>',
    '<input id="v_author" placeholder="例: 山田太郎">',

    '<label>作成日</label>',
    '<input id="v_date" type="date">',

    '<label>出力対象タブ（クリックで切替）</label>',
    '<div id="chips" class="chips"><span style="color:#999;font-size:12px">読込中...</span></div>',

    '<div class="foot"><button id="go" class="btn btn-p" onclick="go()">報告書を生成</button></div>',
    '<div id="msg"></div>',

    '<script>',
    'var P=function(n){return String(n).padStart(2,"0")};',
    'var N=new Date();',
    'document.getElementById("v_date").value=N.getFullYear()+"-"+P(N.getMonth()+1)+"-"+P(N.getDate());',

    'google.script.run.withSuccessHandler(function(list){',
    '  var el=document.getElementById("chips");el.innerHTML="";',
    '  if(!list.length){el.innerHTML="<span style=color:#d32f2f>対象タブなし</span>";return}',
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
   対象タブ一覧（ダイアログから呼ばれる）
   ============================================================ */
function getReportTabs() {
  var out = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function(s) {
    var v = s.getDataRange().getValues();
    if (v.length >= 6 && String(v[4][0]).trim() === '検査項目番号') out.push(s.getName());
  });
  return out;
}

/* ============================================================
   メイン : 報告書生成
   ============================================================ */
function generateReport(info) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var pages = readPages_(ss, info.tabs || []);
  if (!pages.length) throw new Error('対象タブが見つかりません');

  /* --- Docs 作成 --- */
  var dateLabel = info.createdDate || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var docTitle  = 'アクセシビリティ検査報告書' +
                  (info.company ? ' - ' + info.company : '') +
                  '（' + dateLabel + '）';
  var doc  = DocumentApp.create(docTitle);
  var body = doc.getBody();
  body.clear();

  /* ======================== 表紙 ======================== */
  body.appendParagraph('アクセシビリティ検査報告書')
    .setHeading(DocumentApp.ParagraphHeading.HEADING1)
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
    .editAsText().setBold(true).setFontSize(22).setForegroundColor('#1a73e8');

  body.appendParagraph('').setSpacingAfter(4);

  var meta = body.appendTable([
    ['社名 / 組織名', info.company  || ''],
    ['作成者',         info.author   || ''],
    ['作成日',         fmtDate_(info.createdDate)],
    ['検査対象ページ', String(pages.length) + ' ページ']
  ]);
  styleMeta_(meta);

  /* ===================== 総合サマリー ===================== */
  body.appendParagraph('').setSpacingAfter(2);
  heading_(body, '総合サマリー');

  var ts = totalSummary_(pages);
  var sm = body.appendTable([
    ['合格',                                  String(ts.pass)],
    ['不合格',                                String(ts.fail)],
    ['判定不能（要ヒューマンチェック）',      String(ts.unknown)],
    ['該当なし',                              String(ts.na)],
    ['未検証（要ヒューマンチェック）',        String(ts.unverified)],
    ['検査項目 合計',                         String(ts.total)]
  ]);
  styleMeta_(sm);

  // サマリーの値セルに色を付ける
  colorCell_(sm, 0, 1, '#2e7d32'); // 合格=緑
  colorCell_(sm, 1, 1, '#d32f2f'); // 不合格=赤
  colorCell_(sm, 2, 1, '#e65100'); // 判定不能=橙
  colorCell_(sm, 4, 1, '#757575'); // 未検証=灰

  /* ============== ページごとの結果 ============== */
  pages.forEach(function(pg, idx) {
    body.appendParagraph('');
    body.appendPageBreak();

    heading_(body, (idx + 1) + '. ' + pg.url);
    body.appendParagraph('検査日時 : ' + pg.time)
      .editAsText().setFontSize(10).setForegroundColor('#666').setItalic(true);

    /* ページ小計 */
    var ps = pg.summary;
    body.appendParagraph(
      '合格 ' + ps.pass + ' ／ 不合格 ' + ps.fail +
      ' ／ 判定不能 ' + ps.unknown + ' ／ 該当なし ' + ps.na +
      ' ／ 未検証 ' + ps.unverified
    ).editAsText().setFontSize(10).setBold(true);

    /* ---- 不合格 ---- */
    var fails = pg.rows.filter(function(r){return r.result==='不合格'});
    if (fails.length) {
      subHeading_(body, '不合格（' + fails.length + '件）', '#d32f2f');
      var t = [['No', '検査項目', '検出数', '場所', '詳細', '改善案']];
      fails.forEach(function(r){ t.push([r.no, cut_(r.item,80), r.count, cut_(r.location,100), cut_(r.detail,120), cut_(r.suggestion,120)]); });
      styleData_(body.appendTable(t), '#d32f2f');
    }

    /* ---- 判定不能 ---- */
    var unk = pg.rows.filter(function(r){return r.result==='判定不能'});
    if (unk.length) {
      subHeading_(body, '判定不能 ― 要ヒューマンチェック（' + unk.length + '件）', '#e65100');
      var t2 = [['No', '検査項目', '場所', '詳細']];
      unk.forEach(function(r){ t2.push([r.no, cut_(r.item,80), cut_(r.location,100), cut_(r.detail,120)]); });
      styleData_(body.appendTable(t2), '#e65100');
    }

    /* ---- 未検証 ---- */
    var unv = pg.rows.filter(function(r){return r.result==='未検証'});
    if (unv.length) {
      subHeading_(body, '未検証 ― 要ヒューマンチェック（' + unv.length + '件）', '#757575');
      var t3 = [['No', '検査項目']];
      unv.forEach(function(r){ t3.push([r.no, r.item]); });
      styleData_(body.appendTable(t3), '#9e9e9e');
    }

    /* ---- 該当なし ---- */
    var naItems = pg.rows.filter(function(r){return r.result==='該当なし'});
    if (naItems.length) {
      body.appendParagraph('該当なし : ' + naItems.length + ' 件')
        .editAsText().setFontSize(10).setForegroundColor('#999');
    }

    /* ---- 合格 ---- */
    var pass = pg.rows.filter(function(r){return r.result==='合格'});
    if (pass.length) {
      body.appendParagraph('合格 : ' + pass.length + ' 件')
        .editAsText().setFontSize(10).setForegroundColor('#2e7d32').setBold(true);
    }
  });

  /* ======================== フッター ======================== */
  body.appendParagraph('');
  body.appendHorizontalRule();
  body.appendParagraph('本報告書は axe-core 自動検査 および AI 評価エンジンにより生成されました。')
    .editAsText().setFontSize(8).setForegroundColor('#aaa');
  body.appendParagraph('判定不能 / 未検証の項目は目視によるヒューマンチェックが必要です。')
    .editAsText().setFontSize(8).setForegroundColor('#aaa');

  doc.saveAndClose();
  return doc.getUrl();
}

/* ============================================================
   シートデータ読み取り
   ============================================================ */
function readPages_(ss, selectedTabs) {
  var pages = [];
  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (selectedTabs.length && selectedTabs.indexOf(name) === -1) return;
    var v = sheet.getDataRange().getValues();
    if (v.length < 6 || String(v[4][0]).trim() !== '検査項目番号') return;

    var url  = String(v[1][1] || name);
    var time = String(v[2][1] || '');
    var rows = [], sm = {pass:0,fail:0,unknown:0,na:0,unverified:0};

    for (var i = 5; i < v.length; i++) {
      var r = v[i];
      if (!r[0] && !r[1]) continue;
      var res = String(r[2]||'').trim();
      rows.push({no:String(r[0]||''), item:String(r[1]||''), result:res,
                 location:String(r[3]||''), count:String(r[4]||''),
                 detail:String(r[5]||''), suggestion:String(r[6]||'')});
      if      (res==='合格')     sm.pass++;
      else if (res==='不合格')   sm.fail++;
      else if (res==='判定不能') sm.unknown++;
      else if (res==='該当なし') sm.na++;
      else                       sm.unverified++;
    }
    pages.push({url:url, time:time, rows:rows, summary:sm});
  });
  return pages;
}

/* ============================================================
   集計
   ============================================================ */
function totalSummary_(pages) {
  var t = {pass:0,fail:0,unknown:0,na:0,unverified:0,total:0};
  pages.forEach(function(p){
    t.pass+=p.summary.pass; t.fail+=p.summary.fail;
    t.unknown+=p.summary.unknown; t.na+=p.summary.na;
    t.unverified+=p.summary.unverified;
  });
  t.total = t.pass+t.fail+t.unknown+t.na+t.unverified;
  return t;
}

/* ============================================================
   見出しヘルパー
   ============================================================ */
function heading_(body, text) {
  body.appendParagraph(text)
    .setHeading(DocumentApp.ParagraphHeading.HEADING1)
    .editAsText().setForegroundColor('#1a73e8').setFontSize(15).setBold(true);
}
function subHeading_(body, text, color) {
  body.appendParagraph(text)
    .setHeading(DocumentApp.ParagraphHeading.HEADING2)
    .editAsText().setForegroundColor(color || '#333').setFontSize(12);
}

/* ============================================================
   テーブルスタイル
   ============================================================ */
function styleMeta_(table) {
  for (var i = 0; i < table.getNumRows(); i++) {
    var lc = table.getRow(i).getCell(0);
    lc.editAsText().setBold(true).setFontSize(10);
    lc.setBackgroundColor('#e8eaf6');
    lc.setWidth(200);
    table.getRow(i).getCell(1).editAsText().setFontSize(10);
  }
  table.setBorderWidth(1).setBorderColor('#bdbdbd');
}

function styleData_(table, hdrColor) {
  var hr = table.getRow(0);
  for (var c = 0; c < hr.getNumCells(); c++) {
    hr.getCell(c).setBackgroundColor(hdrColor || '#333');
    hr.getCell(c).editAsText().setBold(true).setFontSize(9).setForegroundColor('#fff');
  }
  for (var i = 1; i < table.getNumRows(); i++) {
    var bg = (i % 2 === 0) ? '#f5f5f5' : '#fff';
    for (var c2 = 0; c2 < table.getRow(i).getNumCells(); c2++) {
      table.getRow(i).getCell(c2).setBackgroundColor(bg);
      table.getRow(i).getCell(c2).editAsText().setFontSize(9);
    }
  }
  table.setBorderWidth(1).setBorderColor('#ccc');
}

function colorCell_(table, row, col, color) {
  try { table.getRow(row).getCell(col).editAsText().setForegroundColor(color).setBold(true); } catch(e){}
}

/* ============================================================
   ユーティリティ
   ============================================================ */
function cut_(s, n) { return (!s||s.length<=n) ? (s||'') : s.substring(0,n)+'…'; }

function fmtDate_(s) {
  if (!s) return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年MM月dd日');
  try { return Utilities.formatDate(new Date(s), 'Asia/Tokyo', 'yyyy年MM月dd日'); }
  catch(e) { return s; }
}
