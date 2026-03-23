require('dotenv').config();
const express = require('express');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// --- 設定の永続化（JSON）---
const SETTINGS_PATH = path.join(__dirname, '.settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) { console.warn('設定読み込みエラー:', e.message); }
  return {};
}

function saveSettingsFile(data) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// パスワードハッシュ
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// 起動時設定ロード
const savedSettings = loadSettings();

// Gemini API設定（設定ファイル → 環境変数の優先順位）
let GEMINI_API_KEY = savedSettings.geminiApiKey || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

let genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Google Sheets設定
const GOOGLE_SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '';
let GOOGLE_DRIVE_FOLDER_ID = savedSettings.driveFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || '';
let REPORT_FOLDER_ID = savedSettings.reportFolderId || '';

// スプレッドシートIDキャッシュ（自動検索・自動作成）
let cachedSpreadsheetId = null;

// アプリパスワード（環境変数 or 設定ファイル）
let APP_PASSWORD_HASH = savedSettings.passwordHash || (process.env.APP_PASSWORD ? hashPassword(process.env.APP_PASSWORD) : '');

function loadServiceAccountKey() {
  // 設定ファイル優先
  const saved = loadSettings();
  if (saved.serviceAccountKey) {
    try { return JSON.parse(saved.serviceAccountKey); } catch (e) {}
  }
  if (GOOGLE_SERVICE_ACCOUNT_KEY_PATH && fs.existsSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) {
    return JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'utf8'));
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  }
  return null;
}

async function getGoogleAccessToken(saKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: saKey.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const signInput = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(saKey.private_key, 'base64url');
  const jwt = `${signInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) {
    console.error(`[Google Auth] 認証失敗 (HTTP ${res.status}):`, JSON.stringify(data));
    throw new Error('Google認証失敗: ' + (data.error_description || data.error || 'unknown'));
  }
  console.log(`[Google Auth] 認証成功 (service account: ${saKey.client_email})`);
  return data.access_token;
}

/**
 * checkerフォルダ内のスプレッドシートを自動検索
 * GOOGLE_SPREADSHEET_ID 環境変数は不要
 */
async function getOrCreateSpreadsheet(token, saEmail) {
  if (cachedSpreadsheetId) {
    return cachedSpreadsheetId;
  }

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // checkerフォルダ内のスプレッドシートを検索
  if (GOOGLE_DRIVE_FOLDER_ID) {
    const query = `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=createdTime desc&pageSize=1`,
      { headers }
    );
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      cachedSpreadsheetId = searchData.files[0].id;
      console.log(`[Sheets] 既存スプレッドシート発見: "${searchData.files[0].name}" (${cachedSpreadsheetId})`);
      return cachedSpreadsheetId;
    }
  }

  // フォルダ内にスプレッドシートが無い場合
  const email = saEmail || '（設定画面で確認）';
  throw new Error(
    'checkerフォルダにスプレッドシートがありません。\n' +
    '手順:\n' +
    '1. Google Driveの「checker」フォルダを開く\n' +
    '2. 右クリック → Google スプレッドシート → 空白のスプレッドシート\n' +
    '3. 作成したスプレッドシートを開き、共有ボタンから ' + email + ' を「編集者」として追加\n' +
    '4. 再度「Google Sheetsに保存」をクリック'
  );
}

/**
 * 共通のブラウザ起動設定
 */
async function getBrowser() {
  const chromePaths = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  let executablePath = null;
  for (const p of chromePaths) {
    if (p && fs.existsSync(p)) {
      executablePath = p;
      break;
    }
  }

  const options = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--single-process'
    ],
  };

  if (executablePath) {
    options.executablePath = executablePath;
    console.log(`Chrome使用: ${executablePath}`);
  }

  return await puppeteer.launch(options);
}

/**
 * Gemini 2.5 APIを呼び出す関数
 */
async function callGeminiAPI(prompt, imageBase64 = null) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が設定されていません');

  const model = genAI.getGenerativeModel({ 
    model: GEMINI_MODEL,
    generationConfig: { responseMimeType: "application/json" }
  });

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inlineData: { mimeType: "image/png", data: imageBase64 }
    });
  }

  const result = await model.generateContent({ contents: [{ role: "user", parts }] });
  const response = await result.response;
  return response.text();
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * 認証API
 */
app.get('/api/auth-status', (req, res) => {
  res.json({ passwordRequired: !!APP_PASSWORD_HASH });
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!APP_PASSWORD_HASH) {
    return res.json({ success: true });
  }
  if (hashPassword(password || '') === APP_PASSWORD_HASH) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'パスワードが正しくありません' });
});

/**
 * 設定取得API（機密情報はマスク）
 */
app.post('/api/settings-get', (req, res) => {
  const { password } = req.body;
  // パスワード認証
  if (APP_PASSWORD_HASH && hashPassword(password || '') !== APP_PASSWORD_HASH) {
    return res.status(401).json({ error: '認証エラー' });
  }
  const saved = loadSettings();
  res.json({
    geminiApiKey: saved.geminiApiKey ? '********' + (saved.geminiApiKey.slice(-4)) : '',
    serviceAccountKey: saved.serviceAccountKey ? '(設定済み)' : '',
    driveFolderId: saved.driveFolderId || GOOGLE_DRIVE_FOLDER_ID || '',
    reportFolderId: saved.reportFolderId || REPORT_FOLDER_ID || '',
    hasPassword: !!APP_PASSWORD_HASH,
    // 環境変数フォールバックの表示
    envGemini: !!process.env.GEMINI_API_KEY,
    envServiceAccount: !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
    envFolder: !!process.env.GOOGLE_DRIVE_FOLDER_ID
  });
});

/**
 * 設定保存API
 */
app.post('/api/settings-save', (req, res) => {
  const { password, geminiApiKey, serviceAccountKey, driveFolderId, reportFolderId, newPassword } = req.body;
  // パスワード認証
  if (APP_PASSWORD_HASH && hashPassword(password || '') !== APP_PASSWORD_HASH) {
    return res.status(401).json({ error: '認証エラー' });
  }

  const saved = loadSettings();

  // Gemini API Key（マスク値でなければ更新）
  if (geminiApiKey && !geminiApiKey.startsWith('********')) {
    saved.geminiApiKey = geminiApiKey;
    GEMINI_API_KEY = geminiApiKey;
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  // Service Account Key（プレースホルダでなければ更新）
  if (serviceAccountKey && serviceAccountKey !== '(設定済み)') {
    try {
      JSON.parse(serviceAccountKey); // バリデーション
      saved.serviceAccountKey = serviceAccountKey;
    } catch (e) {
      return res.status(400).json({ error: 'Service Account KeyのJSON形式が不正です' });
    }
  }

  // Drive Folder ID
  if (typeof driveFolderId === 'string') {
    saved.driveFolderId = driveFolderId;
    GOOGLE_DRIVE_FOLDER_ID = driveFolderId;
  }

  // Report Folder ID
  if (typeof reportFolderId === 'string') {
    saved.reportFolderId = reportFolderId;
    REPORT_FOLDER_ID = reportFolderId;
  }

  // パスワード変更
  if (newPassword) {
    saved.passwordHash = hashPassword(newPassword);
    APP_PASSWORD_HASH = saved.passwordHash;
  }

  saveSettingsFile(saved);
  console.log('[Settings] 設定を保存しました');
  res.json({ success: true });
});

/**
 * アクセシビリティチェック（axe-core実行）API
 */
app.post('/api/check', async (req, res) => {
  const { url, level, basicAuth } = req.body; // basicAuth: { user, pass }
  let browser;
  try {
    console.log(`[Axe] 診断開始: ${url} (Level ${level})`);
    browser = await getBrowser();
    const page = await browser.newPage();
    
    // Basic認証がある場合
    if (basicAuth && basicAuth.user && basicAuth.pass) {
      await page.authenticate({
        username: basicAuth.user,
        password: basicAuth.pass
      });
      console.log('Basic認証を設定しました');
    }
    
    await page.setDefaultNavigationTimeout(60000);
    await page.goto(url, { waitUntil: 'networkidle2' });

    const builder = new AxePuppeteer(page);
    
    // WCAGレベルに応じたタグ設定の実装
    const tags = ['wcag2a', 'wcag21a', 'wcag22a'];
    if (level === 'AA' || level === 'AAA') {
      tags.push('wcag2aa', 'wcag21aa', 'wcag22aa');
    }
    if (level === 'AAA') {
      tags.push('wcag2aaa', 'wcag21aaa', 'wcag22aaa');
    }
    builder.withTags(tags);
    
    const results = await builder.analyze();
    await page.close();
    
    res.json({ success: true, results });

  } catch (error) {
    console.error('Scan Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * バッチアクセシビリティチェック（最大10URL同時検査）API
 */
app.post('/api/batch-check', async (req, res) => {
  const { urls, level, basicAuth } = req.body; // urls: string[]
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'URLの配列を指定してください' });
  }
  if (urls.length > 10) {
    return res.status(400).json({ error: '一度に検査できるURLは最大10件です' });
  }

  let browser;
  try {
    console.log(`[Axe Batch] ${urls.length}件の診断開始 (Level ${level})`);
    browser = await getBrowser();

    const tags = ['wcag2a', 'wcag21a', 'wcag22a'];
    if (level === 'AA' || level === 'AAA') {
      tags.push('wcag2aa', 'wcag21aa', 'wcag22aa');
    }
    if (level === 'AAA') {
      tags.push('wcag2aaa', 'wcag21aaa', 'wcag22aaa');
    }

    // 全URLを並列で検査
    const checkOne = async (url) => {
      let page;
      try {
        page = await browser.newPage();
        if (basicAuth && basicAuth.user && basicAuth.pass) {
          await page.authenticate({ username: basicAuth.user, password: basicAuth.pass });
        }
        await page.setDefaultNavigationTimeout(60000);
        await page.goto(url, { waitUntil: 'networkidle2' });

        const builder = new AxePuppeteer(page);
        builder.withTags(tags);
        const results = await builder.analyze();
        return { url, success: true, results };
      } catch (error) {
        console.error(`[Batch] Error for ${url}:`, error.message);
        return { url, success: false, error: error.message };
      } finally {
        if (page) try { await page.close(); } catch (e) {}
      }
    };

    const results = await Promise.all(urls.map(checkOne));
    res.json({ success: true, results });

  } catch (error) {
    console.error('Batch Scan Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * AI評価 API
 */
app.post('/api/ai-evaluate', async (req, res) => {
  const { url, checkItems } = req.body;
  let browser;

  try {
    console.log(`[${GEMINI_MODEL}] AI評価開始: ${url}`);
    browser = await getBrowser();
    const page = await browser.newPage();
    
    // タイムアウト延長
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);
    
    await page.setViewport({ width: 1280, height: 800 });
    
    // ページ読み込み（リトライ付き）
    let loaded = false;
    for (const waitUntil of ['networkidle2', 'domcontentloaded']) {
      try {
        await page.goto(url, { waitUntil, timeout: 60000 });
        loaded = true;
        console.log(`ページ読み込み完了: ${waitUntil}`);
        break;
      } catch (e) {
        console.log(`${waitUntil}で失敗、リトライ...`);
      }
    }
    if (!loaded) throw new Error('ページの読み込みに失敗しました');
    
    // 少し待機
    await new Promise(r => setTimeout(r, 2000));
    
    // スクリーンショット（小さめに）
    const screenshot = await page.screenshot({ 
      encoding: 'base64',
      type: 'jpeg',
      quality: 40,
      fullPage: false 
    });
    
    // HTML取得（短縮）
    const html = await page.content();
    const shortHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\s+/g, ' ')
      .substring(0, 15000);
    
    await page.close();

    const itemsList = checkItems.map((item, i) => 
      `${i}. ${item.text} (WCAG ${item.ref}, Level ${item.level}, カテゴリ: ${item.category})`
    ).join('\n');

    const prompt = `あなたはWCAG 2.2アクセシビリティの専門家です。
提供されたスクリーンショットとHTMLを分析し、以下の各項目を評価してください。

## 対象URL
${url}

## HTML（抜粋）
${shortHtml}

## 評価項目
${itemsList}

## 重要な評価ルール
1. **自動確認可能な項目**: スクリーンショットやHTMLから判断できるもの
   - 画像のalt属性の有無や内容
   - 見出し構造（h1〜h6の階層）
   - フォームのラベル
   - リンクテキストの明確さ
   - 色コントラスト
   - ページタイトルの有無
   
2. **自動確認不可能な項目**: 実際の操作が必要なもの
   - キーボード操作性（Tab移動、Enter/Space操作）
   - フォーカスインジケータの視認性
   - キーボードトラップの有無
   - 動画・音声の再生操作
   - タイムアウト動作
   - これらは status: "manual_required" を返す

3. **該当なし**: ページにその要素が存在しない場合
   - 動画がないページでの動画関連項目
   - フォームがないページでのフォーム項目
   - これらは status: "not_applicable" を返す

## 出力形式（JSON配列のみ、説明不要）
[
  {
    "index": 0,
    "status": "pass" | "fail" | "manual_required" | "not_applicable",
    "confidence": 0.5〜1.0,
    "reason": "判断理由",
    "suggestion": ""
  }
]

全${checkItems.length}項目を評価してください。`;

    console.log('Gemini API 呼び出し中...');
    const aiResponse = await callGeminiAPI(prompt, screenshot);
    console.log('AI応答受信, 長さ:', aiResponse.length);
    
    let results = [];
    try {
      // まず直接パースを試す
      results = JSON.parse(aiResponse);
    } catch (e) {
      console.log('直接パース失敗、JSON抽出を試行...');
      try {
        // JSON配列を抽出
        const jsonMatch = aiResponse.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          // 不正な文字を修正
          let cleanJson = jsonMatch[0]
            .replace(/[\x00-\x1F\x7F]/g, ' ')  // 制御文字を除去
            .replace(/,\s*}/g, '}')  // 末尾カンマを除去
            .replace(/,\s*]/g, ']'); // 末尾カンマを除去
          results = JSON.parse(cleanJson);
        }
      } catch (e2) {
        console.log('JSON抽出も失敗、個別パースを試行...');
        // 個別のオブジェクトを抽出
        const objectMatches = aiResponse.matchAll(/\{\s*"index"\s*:\s*(\d+)[^}]*\}/g);
        for (const match of objectMatches) {
          try {
            const obj = JSON.parse(match[0]);
            results.push(obj);
          } catch (e3) {
            // 個別オブジェクトのパースも失敗したらスキップ
          }
        }
      }
    }
    
    console.log('パース完了, 結果数:', results.length);
    
    // 結果が空の場合はエラー
    if (results.length === 0) {
      console.log('AI応答（先頭500文字）:', aiResponse.substring(0, 500));
      throw new Error('AI応答の解析に失敗しました。再度お試しください。');
    }

    res.json({ success: true, model: GEMINI_MODEL, results });

  } catch (error) {
    console.error('AI評価エラー発生:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
});


/**
 * Google Sheetsエクスポート API
 * checkerフォルダ内のスプレッドシートを自動検索し、複数タブ追加＋データ書き込み
 * body: { sheets: [{ rows, title }] } または後方互換で { rows, title }
 */
app.post('/api/export-sheets', async (req, res) => {
  try {
    // 後方互換: { rows, title } → sheets配列に変換
    let sheets = req.body.sheets;
    if (!sheets) {
      sheets = [{ rows: req.body.rows, title: req.body.title }];
    }

    const saKey = loadServiceAccountKey();
    if (!saKey) {
      return res.status(400).json({
        error: 'Google Service Account未設定',
        hint: 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH または GOOGLE_SERVICE_ACCOUNT_KEY 環境変数を設定してください'
      });
    }

    const token = await getGoogleAccessToken(saKey);
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const spreadsheetId = await getOrCreateSpreadsheet(token, saKey.client_email);

    // タブ名のベース日時
    const now = new Date();
    const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '');

    const createdTabs = [];

    for (const sheet of sheets) {
      if (!sheet.rows || sheet.rows.length === 0) continue;

      const sheetTitle = `${sheet.title || 'データ'}_${dateStr}_${timeStr}`;

      // 新しいシート（タブ）を追加
      console.log(`[Sheets] タブ追加: "${sheetTitle}" → ${spreadsheetId}`);
      const addSheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers,
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetTitle } } }]
        })
      });
      const addSheetResult = await addSheetRes.json();
      if (!addSheetRes.ok) {
        console.error(`[Sheets] タブ追加失敗 (HTTP ${addSheetRes.status}):`, JSON.stringify(addSheetResult));
        throw new Error(`シートタブの追加に失敗 (${addSheetRes.status}): ${addSheetResult.error?.message || JSON.stringify(addSheetResult)}`);
      }

      // データを書き込み
      const range = `'${sheetTitle}'!A1`;
      console.log(`[Sheets] データ書き込み: ${sheet.rows.length}行 → "${sheetTitle}"`);
      const writeRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', headers, body: JSON.stringify({ values: sheet.rows }) }
      );
      const writeResult = await writeRes.json();
      if (writeResult.error) {
        console.error(`[Sheets] 書き込み失敗 (HTTP ${writeRes.status}):`, JSON.stringify(writeResult.error));
        throw new Error(`データ書き込み失敗 (${writeRes.status}): ${writeResult.error.message}`);
      }

      createdTabs.push(sheetTitle);
    }

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Sheets] 書き込み完了: ${url} (タブ: ${createdTabs.join(', ')})`);
    res.json({ success: true, spreadsheetId, sheetTitles: createdTabs, url });

  } catch (error) {
    console.error('Sheets Export Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * レポート出力 API
 * body: { pages: [{ url, rows, timestamp }] }
 * 1URLあたり1シート。レポート用スプレッドシートを自動検索/作成。
 * 列: 検査項目番号, 検査項目, 結果, 場所, 検出数, 詳細, 改善案
 */
app.post('/api/export-report', async (req, res) => {
  const { pages } = req.body;
  if (!pages || pages.length === 0) {
    return res.status(400).json({ error: 'レポートデータがありません' });
  }

  try {
    const saKey = loadServiceAccountKey();
    if (!saKey) {
      return res.status(400).json({ error: 'Google Service Account未設定' });
    }

    const token = await getGoogleAccessToken(saKey);
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // レポート用フォルダ（未設定ならデータ保存先と同じ）
    const reportFolder = REPORT_FOLDER_ID || GOOGLE_DRIVE_FOLDER_ID;

    // レポート用スプレッドシートを検索（なければデータ保存先と別に管理）
    let spreadsheetId = null;
    if (reportFolder) {
      const query = `'${reportFolder}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and name contains 'レポート' and trashed=false`;
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=createdTime desc&pageSize=1`,
        { headers }
      );
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        spreadsheetId = searchData.files[0].id;
        console.log(`[Report] 既存レポートスプレッドシート発見: "${searchData.files[0].name}" (${spreadsheetId})`);
      }
    }

    // 見つからなければデータ保存先のスプレッドシートを使う
    if (!spreadsheetId) {
      spreadsheetId = await getOrCreateSpreadsheet(token, saKey.client_email);
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }).replace(/:/g, '');

    const createdTabs = [];

    for (const page of pages) {
      // タブ名: URLのホスト＋パスから生成
      let tabLabel;
      try {
        const u = new URL(page.url);
        tabLabel = (u.hostname + u.pathname).replace(/[\/\\?*\[\]]/g, '_').substring(0, 60);
      } catch { tabLabel = page.url.substring(0, 60); }
      const sheetTitle = `${tabLabel}_${dateStr}_${timeStr}`;

      // ヘッダー行（見出し用の情報行 + カラムヘッダー）
      const inspectionTime = page.timestamp
        ? new Date(page.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
        : now.toLocaleString('ja-JP');

      const sheetRows = [
        ['アクセシビリティ検査レポート', '', '', '', '', '', ''],
        ['検査対象URL', page.url, '', '', '', '', ''],
        ['検査日時', inspectionTime, '', '', '', '', ''],
        ['', '', '', '', '', '', ''],
        ['検査項目番号', '検査項目', '結果', '場所', '検出数', '詳細', '改善案'],
        ...page.rows
      ];

      // タブ追加
      console.log(`[Report] タブ追加: "${sheetTitle}" → ${spreadsheetId}`);
      const addSheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers,
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetTitle } } }]
        })
      });
      const addSheetResult = await addSheetRes.json();
      if (!addSheetRes.ok) {
        throw new Error(`シートタブの追加に失敗: ${addSheetResult.error?.message || JSON.stringify(addSheetResult)}`);
      }
      const newSheetId = addSheetResult.replies[0].addSheet.properties.sheetId;

      // データ書き込み
      const range = `'${sheetTitle}'!A1`;
      const writeRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', headers, body: JSON.stringify({ values: sheetRows }) }
      );
      const writeResult = await writeRes.json();
      if (writeResult.error) {
        throw new Error(`データ書き込み失敗: ${writeResult.error.message}`);
      }

      // 見出しの書式設定（太字、背景色など）
      const formatRequests = [
        // 1行目: レポートタイトル（太字、大きめフォント、背景色）
        { repeatCell: {
          range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 14 },
            backgroundColor: { red: 0.102, green: 0.451, blue: 0.91 },
            textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } }
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }},
        // 2-3行目: メタ情報（太字ラベル）
        { repeatCell: {
          range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.91, green: 0.92, blue: 0.96 } }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }},
        // 5行目: カラムヘッダー（太字、背景色）
        { repeatCell: {
          range: { sheetId: newSheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 7 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
            horizontalAlignment: 'CENTER'
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
        }},
        // 列幅設定
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 60 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 300 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 80 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
          properties: { pixelSize: 250 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
          properties: { pixelSize: 60 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
          properties: { pixelSize: 350 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
          properties: { pixelSize: 300 }, fields: 'pixelSize'
        }},
        // 結果列の条件付き書式：不合格=赤背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '不合格' }] },
              format: { backgroundColor: { red: 0.96, green: 0.8, blue: 0.8 }, textFormat: { foregroundColor: { red: 0.7, green: 0, blue: 0 }, bold: true } }
            }
          }, index: 0
        }},
        // 結果列の条件付き書式：合格=緑背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '合格' }] },
              format: { backgroundColor: { red: 0.8, green: 0.94, blue: 0.8 }, textFormat: { foregroundColor: { red: 0, green: 0.4, blue: 0 }, bold: true } }
            }
          }, index: 1
        }},
        // 結果列の条件付き書式：判定不能=黄背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '判定不能' }] },
              format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 }, textFormat: { foregroundColor: { red: 0.6, green: 0.4, blue: 0 }, bold: true } }
            }
          }, index: 2
        }},
        // 結果列の条件付き書式：未検証=グレー背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '未検証' }] },
              format: { backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 }, textFormat: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } }
            }
          }, index: 3
        }},
        // 該当なし=薄いグレー
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '該当なし' }] },
              format: { backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 }, textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } }
            }
          }, index: 4
        }},
        // タイトル行をマージ
        { mergeCells: {
          range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
          mergeType: 'MERGE_ALL'
        }},
        // フリーズ（ヘッダー行まで固定）
        { updateSheetProperties: {
          properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 5 } },
          fields: 'gridProperties.frozenRowCount'
        }}
      ];

      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers,
        body: JSON.stringify({ requests: formatRequests })
      });

      createdTabs.push(sheetTitle);
    }

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Report] レポート出力完了: ${url} (${createdTabs.length}タブ)`);
    res.json({ success: true, spreadsheetId, tabs: createdTabs, url });

  } catch (error) {
    console.error('Report Export Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Google Sheets設定確認 API
 */
app.get('/api/sheets-status', (req, res) => {
  const saKey = loadServiceAccountKey();
  res.json({
    configured: !!saKey,
    spreadsheetId: cachedSpreadsheetId || null,
    folderId: GOOGLE_DRIVE_FOLDER_ID || null,
    serviceAccount: saKey ? saKey.client_email : null
  });
});

/**
 * Google Sheets接続テスト API（診断用）
 */
app.get('/api/sheets-test', async (req, res) => {
  const results = { auth: null, sheets: null, drive: null };
  try {
    const saKey = loadServiceAccountKey();
    if (!saKey) {
      return res.json({ error: 'Service Account Key未設定', results });
    }
    results.serviceAccount = saKey.client_email;
    results.projectId = saKey.project_id;

    // 1. 認証テスト
    try {
      const token = await getGoogleAccessToken(saKey);
      results.auth = { ok: true };

      // 2. Sheets APIテスト（自動検索）
      try {
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const spreadsheetId = await getOrCreateSpreadsheet(token, saKey.client_email);
        const metaRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties.title`,
          { headers }
        );
        const meta = await metaRes.json();
        if (metaRes.ok) {
          const existingTabs = (meta.sheets || []).map(s => s.properties.title);
          results.sheets = { ok: true, spreadsheetId, spreadsheetTitle: meta.properties.title, tabs: existingTabs };
        } else {
          results.sheets = { ok: false, status: metaRes.status, error: meta.error?.message || JSON.stringify(meta) };
        }
      } catch (e) {
        results.sheets = { ok: false, error: e.message };
      }

      // 3. Drive フォルダアクセステスト
      if (GOOGLE_DRIVE_FOLDER_ID) {
        try {
          const headers = { 'Authorization': `Bearer ${token}` };
          const folderRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${GOOGLE_DRIVE_FOLDER_ID}?fields=id,name,mimeType`,
            { headers }
          );
          const folderData = await folderRes.json();
          if (folderRes.ok) {
            results.drive = { ok: true, folderName: folderData.name, folderId: folderData.id };
          } else {
            results.drive = { ok: false, status: folderRes.status, error: folderData.error?.message || JSON.stringify(folderData) };
          }
        } catch (e) {
          results.drive = { ok: false, error: e.message };
        }
      } else {
        results.drive = { ok: null, message: 'フォルダID未設定（タブ追加方式では不要）' };
      }
    } catch (e) {
      results.auth = { ok: false, error: e.message };
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message, results });
  }
});

/**
 * サービスアカウントのDriveファイル一覧・クリーンアップ API
 * GET  /api/drive-cleanup        → ファイル一覧＆ストレージ情報
 * POST /api/drive-cleanup        → 不要ファイルを削除
 *   body: { deleteAll: true } or { fileIds: ["id1","id2"] }
 */
app.get('/api/drive-cleanup', async (req, res) => {
  try {
    const saKey = loadServiceAccountKey();
    if (!saKey) return res.status(400).json({ error: 'Service Account未設定' });
    const token = await getGoogleAccessToken(saKey);
    const headers = { 'Authorization': `Bearer ${token}` };

    // サービスアカウントが所有する全ファイルを取得
    const files = [];
    let pageToken = '';
    do {
      const url = `https://www.googleapis.com/drive/v3/files?fields=nextPageToken,files(id,name,mimeType,size,createdTime)&pageSize=100&q=trashed=false` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const r = await fetch(url, { headers });
      const data = await r.json();
      if (data.files) files.push(...data.files);
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    // ゴミ箱のファイルも取得
    const trashedFiles = [];
    pageToken = '';
    do {
      const url = `https://www.googleapis.com/drive/v3/files?fields=nextPageToken,files(id,name,size,createdTime)&pageSize=100&q=trashed=true` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const r = await fetch(url, { headers });
      const data = await r.json();
      if (data.files) trashedFiles.push(...data.files);
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    // ストレージ使用量を取得
    const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers });
    const about = await aboutRes.json();

    res.json({
      storageQuota: about.storageQuota ? {
        limit: about.storageQuota.limit ? `${(about.storageQuota.limit / 1e9).toFixed(2)} GB` : '無制限',
        usage: `${(about.storageQuota.usage / 1e6).toFixed(2)} MB`,
        usageInDrive: `${(about.storageQuota.usageInDrive / 1e6).toFixed(2)} MB`,
        usageInDriveTrash: `${(about.storageQuota.usageInDriveTrash / 1e6).toFixed(2)} MB`
      } : null,
      fileCount: files.length,
      trashedCount: trashedFiles.length,
      files: files.map(f => ({ id: f.id, name: f.name, type: f.mimeType, size: f.size, created: f.createdTime })),
      trashedFiles: trashedFiles.map(f => ({ id: f.id, name: f.name, size: f.size, created: f.createdTime }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/drive-cleanup', async (req, res) => {
  try {
    const saKey = loadServiceAccountKey();
    if (!saKey) return res.status(400).json({ error: 'Service Account未設定' });
    const token = await getGoogleAccessToken(saKey);
    const headers = { 'Authorization': `Bearer ${token}` };

    const { deleteAll, fileIds, emptyTrash } = req.body;
    const deleted = [];
    const errors = [];

    // ゴミ箱を空にする
    if (emptyTrash) {
      const trashRes = await fetch('https://www.googleapis.com/drive/v3/files/emptyTrash', {
        method: 'DELETE', headers
      });
      if (trashRes.ok) {
        deleted.push({ action: 'emptyTrash', ok: true });
      } else {
        const err = await trashRes.json();
        errors.push({ action: 'emptyTrash', error: err.error?.message });
      }
    }

    // 全ファイル削除 or 指定ファイル削除
    let targetIds = fileIds || [];
    if (deleteAll) {
      const files = [];
      let pageToken = '';
      do {
        const url = `https://www.googleapis.com/drive/v3/files?fields=nextPageToken,files(id,name)&pageSize=100&q=trashed=false` +
          (pageToken ? `&pageToken=${pageToken}` : '');
        const r = await fetch(url, { headers });
        const data = await r.json();
        if (data.files) files.push(...data.files);
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      targetIds = files.map(f => f.id);
    }

    for (const id of targetIds) {
      const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
        method: 'DELETE', headers
      });
      if (delRes.ok) {
        deleted.push({ id, ok: true });
      } else {
        const err = await delRes.json().catch(() => ({}));
        errors.push({ id, status: delRes.status, error: err.error?.message });
      }
    }

    res.json({ deleted: deleted.length, errors, message: `${deleted.length}件のファイルを削除しました` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// エラーハンドリング
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// サーバー起動（最後に1回だけ記述）
const server = app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});

// タイムアウト設定をインスタンスに適用
server.timeout = 120000;
server.keepAliveTimeout = 120000;