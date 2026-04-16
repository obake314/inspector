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

const STATUS_NONE = 'NONE';
const STATUS_NG = 'NG';
const STATUS_OK = 'OK';

async function getSheetsConnectivityStatus() {
  const saved = loadSettings();
  const saKey = loadServiceAccountKey();
  const folderId = (GOOGLE_DRIVE_FOLDER_ID || saved.driveFolderId || '').trim();

  let serviceAccountStatus = saKey ? STATUS_NG : STATUS_NONE;
  let driveFolderStatus = folderId ? STATUS_NG : STATUS_NONE;
  let sheetsStatus = STATUS_NONE;

  let serviceAccountError = null;
  let driveFolderError = null;
  let spreadsheetId = null;
  let token = null;

  if (saKey) {
    try {
      token = await getGoogleAccessToken(saKey);
      serviceAccountStatus = STATUS_OK;
    } catch (e) {
      serviceAccountStatus = STATUS_NG;
      serviceAccountError = e.message;
    }
  }

  if (folderId) {
    if (token) {
      try {
        spreadsheetId = await getOrCreateSpreadsheet(token, saKey.client_email);
        driveFolderStatus = STATUS_OK;
      } catch (e) {
        driveFolderStatus = STATUS_NG;
        driveFolderError = e.message;
      }
    } else {
      driveFolderStatus = STATUS_NG;
      driveFolderError = 'Service Account の疎通確認に失敗したため Drive Folder を確認できません';
    }
  }

  if (serviceAccountStatus === STATUS_NONE && driveFolderStatus === STATUS_NONE) {
    sheetsStatus = STATUS_NONE;
  } else if (serviceAccountStatus === STATUS_OK && driveFolderStatus === STATUS_OK) {
    sheetsStatus = STATUS_OK;
  } else {
    sheetsStatus = STATUS_NG;
  }

  let sheetsStatusDetail = '';
  if (sheetsStatus === STATUS_NONE) {
    sheetsStatusDetail = 'Google Service Account Key / Google Drive Folder ID を入力してください';
  } else if (sheetsStatus === STATUS_NG) {
    sheetsStatusDetail = driveFolderError || serviceAccountError || 'Google Sheets疎通確認に失敗しました';
  }

  return {
    sheetsStatus,
    serviceAccountStatus,
    driveFolderStatus,
    serviceAccountError,
    driveFolderError,
    sheetsStatusDetail,
    serviceAccount: saKey ? saKey.client_email : null,
    folderId: folderId || null,
    spreadsheetId: spreadsheetId || cachedSpreadsheetId || null
  };
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

function normalizeViewportPreset(raw) {
  return String(raw || 'desktop').toLowerCase() === 'iphone-se' ? 'iphone-se' : 'desktop';
}

async function applyViewportPreset(page, presetRaw) {
  const preset = normalizeViewportPreset(presetRaw);
  if (preset === 'iphone-se') {
    const device = puppeteer.KnownDevices['iPhone SE'];
    await page.emulate(device);
    return preset;
  }
  await page.setViewport({ width: 1280, height: 800 });
  return 'desktop';
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
    aaaBeta: saved.aaaBeta || false,
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
  const { password, geminiApiKey, serviceAccountKey, driveFolderId, reportFolderId, newPassword, aaaBeta } = req.body;
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

  // Service Account Key
  if (typeof serviceAccountKey === 'string') {
    if (!serviceAccountKey.trim()) {
      delete saved.serviceAccountKey; // 空欄保存でクリア
      cachedSpreadsheetId = null;
    } else if (serviceAccountKey !== '(設定済み)') {
      try {
        JSON.parse(serviceAccountKey); // バリデーション
        saved.serviceAccountKey = serviceAccountKey;
        cachedSpreadsheetId = null;
      } catch (e) {
        return res.status(400).json({ error: 'Service Account KeyのJSON形式が不正です' });
      }
    }
  }

  // Drive Folder ID
  if (typeof driveFolderId === 'string') {
    saved.driveFolderId = driveFolderId;
    GOOGLE_DRIVE_FOLDER_ID = driveFolderId;
    cachedSpreadsheetId = null;
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

  // AAA ベータ設定
  if (typeof aaaBeta === 'boolean') {
    saved.aaaBeta = aaaBeta;
  }

  saveSettingsFile(saved);
  console.log('[Settings] 設定を保存しました');
  res.json({ success: true });
});

/**
 * アクセシビリティチェック（axe-core実行）API
 */
app.post('/api/check', async (req, res) => {
  const { url, level, basicAuth, viewportPreset } = req.body; // basicAuth: { user, pass }
  let browser;
  try {
    const preset = normalizeViewportPreset(viewportPreset);
    console.log(`[Axe] 診断開始: ${url} (Level ${level}, View ${preset})`);
    browser = await getBrowser();
    const page = await browser.newPage();
    await applyViewportPreset(page, preset);
    
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
    
    res.json({ success: true, viewportPreset: preset, results });

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
  const { urls, level, basicAuth, viewportPreset } = req.body; // urls: string[]
  const preset = normalizeViewportPreset(viewportPreset);
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'URLの配列を指定してください' });
  }
  if (urls.length > 10) {
    return res.status(400).json({ error: '一度に検査できるURLは最大10件です' });
  }

  let browser;
  try {
    console.log(`[Axe Batch] ${urls.length}件の診断開始 (Level ${level}, View ${preset})`);
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
        await applyViewportPreset(page, preset);
        if (basicAuth && basicAuth.user && basicAuth.pass) {
          await page.authenticate({ username: basicAuth.user, password: basicAuth.pass });
        }
        await page.setDefaultNavigationTimeout(60000);
        await page.goto(url, { waitUntil: 'networkidle2' });

        const builder = new AxePuppeteer(page);
        builder.withTags(tags);
        const results = await builder.analyze();

        // SC 3.2.3/3.2.4 用にナビ構造を抽出
        const navStructure = await page.evaluate(() => {
          const navEls = Array.from(document.querySelectorAll('nav, [role="navigation"]'));
          return navEls.map(nav => {
            const label = nav.getAttribute('aria-label') || nav.getAttribute('aria-labelledby') || '';
            const links = Array.from(nav.querySelectorAll('a')).map(a => ({
              text: a.textContent.trim().replace(/\s+/g, ' '),
              href: a.getAttribute('href') || ''
            }));
            return { label, links };
          });
        });

        return { url, success: true, results, navStructure };
      } catch (error) {
        console.error(`[Batch] Error for ${url}:`, error.message);
        return { url, success: false, error: error.message, navStructure: [] };
      } finally {
        if (page) try { await page.close(); } catch (e) {}
      }
    };

    const results = await Promise.all(urls.map(checkOne));

    // SC 3.2.3/3.2.4 一貫したナビゲーション・識別の横断比較
    let navConsistency = null;
    const successResults = results.filter(r => r.success && r.navStructure && r.navStructure.length > 0);
    if (successResults.length >= 2) {
      const issues = [];
      const baseUrl = successResults[0].url;
      const baseNavs = successResults[0].navStructure;

      for (let i = 1; i < successResults.length; i++) {
        const targetUrl = successResults[i].url;
        const targetNavs = successResults[i].navStructure;

        // nav要素の数が異なる
        if (baseNavs.length !== targetNavs.length) {
          issues.push({
            type: 'nav_count_mismatch',
            message: `ナビゲーション要素数が異なります（${baseUrl}: ${baseNavs.length}個, ${targetUrl}: ${targetNavs.length}個）`,
            urls: [baseUrl, targetUrl]
          });
          continue;
        }

        // 各navの順序・リンクテキストを比較
        baseNavs.forEach((baseNav, idx) => {
          const targetNav = targetNavs[idx];
          if (!targetNav) return;

          const baseLinks = baseNav.links.map(l => l.text).join('|');
          const targetLinks = targetNav.links.map(l => l.text).join('|');

          if (baseLinks !== targetLinks) {
            // 順序の違いを検出
            const baseSet = new Set(baseNav.links.map(l => l.text));
            const targetSet = new Set(targetNav.links.map(l => l.text));
            const missing = [...baseSet].filter(t => !targetSet.has(t));
            const added = [...targetSet].filter(t => !baseSet.has(t));

            if (missing.length > 0 || added.length > 0) {
              issues.push({
                type: 'nav_links_differ',
                message: `ナビゲーション${idx + 1}のリンク構成が異なります`,
                urls: [baseUrl, targetUrl],
                missing: missing.slice(0, 5),
                added: added.slice(0, 5)
              });
            } else {
              // リンクは同じだが順序が違う
              issues.push({
                type: 'nav_order_differ',
                message: `ナビゲーション${idx + 1}のリンク順序が異なります`,
                urls: [baseUrl, targetUrl]
              });
            }
          }
        });
      }

      navConsistency = {
        sc: '3.2.3 / 3.2.4',
        title: '一貫したナビゲーション・識別',
        result: issues.length === 0 ? 'pass' : 'fail',
        comparedUrls: successResults.map(r => r.url),
        issues
      };
    }

    res.json({ success: true, results, navConsistency });

  } catch (error) {
    console.error('Batch Scan Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ============================================================
// Phase 1: 高精度Puppeteer自動検査 — 検査関数群
// ============================================================

/** SC 1.4.10 リフロー: 320pxでの水平スクロール検出 */
async function check_1_4_10_reflow(page) {
  try {
    await page.setViewport({ width: 320, height: 256 });
    await new Promise(r => setTimeout(r, 500));
    const result = await page.evaluate(() => {
      const overflows = [];
      const scrollW = document.documentElement.scrollWidth;
      const pass = scrollW <= 320;
      if (!pass) {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.right > 320 && rect.width > 0) {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls = el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).join('.') : '';
            overflows.push(`${tag}${id}${cls}`.slice(0, 80));
            if (overflows.length >= 10) break;
          }
        }
      }
      return { pass, scrollWidth: scrollW, overflows };
    });
    await page.setViewport({ width: 1280, height: 800 });
    return {
      sc: '1.4.10', name: 'リフロー（320px）',
      status: result.pass ? 'pass' : 'fail',
      message: result.pass
        ? '320px幅でも横スクロールなし'
        : `横スクロール発生 (scrollWidth: ${result.scrollWidth}px)`,
      violations: result.overflows
    };
  } catch (e) {
    await page.setViewport({ width: 1280, height: 800 }).catch(() => {});
    return { sc: '1.4.10', name: 'リフロー（320px）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.5.8 ターゲットサイズ24x24px */
async function check_2_5_8_target_size(page) {
  try {
    const result = await page.evaluate(() => {
      const selectors = ['a', 'button', 'input:not([type="hidden"])', 'select', 'textarea', '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]'];
      const violations = [];
      const seen = new Set();
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          // インラインリンク除外: a タグで前後にテキストノードがある場合
          if (el.tagName === 'A') {
            const parent = el.parentNode;
            let siblings = Array.from(parent.childNodes);
            const idx = siblings.indexOf(el);
            const hasBefore = idx > 0 && siblings[idx - 1].nodeType === 3 && siblings[idx - 1].textContent.trim();
            const hasAfter = idx < siblings.length - 1 && siblings[idx + 1].nodeType === 3 && siblings[idx + 1].textContent.trim();
            if (hasBefore || hasAfter) continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.width < 24 || rect.height < 24) {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30);
            violations.push({
              selector: `${tag}${id}`.slice(0, 60),
              text,
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
            if (violations.length >= 20) break;
          }
        }
        if (violations.length >= 20) break;
      }
      return violations;
    });
    return {
      sc: '2.5.8', name: 'ターゲットサイズ（24×24px）',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? '全インタラクティブ要素が24×24px以上'
        : `${result.length}個の要素がサイズ不足`,
      violations: result.map(v => `${v.selector} [${v.width}×${v.height}px] "${v.text}"`)
    };
  } catch (e) {
    return { sc: '2.5.8', name: 'ターゲットサイズ（24×24px）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.1.2 キーボードトラップなし */
async function check_2_1_2_keyboard_trap(page) {
  try {
    const focusableCount = await page.evaluate(() => {
      return document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ).length;
    });

    const maxTabs = Math.min(focusableCount + 20, 50);
    const history = [];

    // 最初のfocusable要素にフォーカス
    await page.keyboard.press('Tab');

    for (let i = 0; i < maxTabs; i++) {
      const el = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const tag = a.tagName.toLowerCase();
        const id = a.id ? `#${a.id}` : '';
        const cls = a.className && typeof a.className === 'string'
          ? '.' + a.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        // aria-modal ダイアログ内かチェック
        let inModal = false;
        let p = a;
        while (p) { if (p.getAttribute && p.getAttribute('aria-modal') === 'true') { inModal = true; break; } p = p.parentElement; }
        return { key: `${tag}${id}${cls}`.slice(0, 60), inModal };
      });
      if (el) history.push(el);
      await page.keyboard.press('Tab');
    }

    // 連続3回同一要素 = トラップ（aria-modal除外）
    const traps = [];
    for (let i = 2; i < history.length; i++) {
      if (history[i].key === history[i - 1].key && history[i].key === history[i - 2].key && !history[i].inModal) {
        if (!traps.includes(history[i].key)) traps.push(history[i].key);
      }
    }

    return {
      sc: '2.1.2', name: 'キーボードトラップなし',
      status: traps.length === 0 ? 'pass' : 'fail',
      message: traps.length === 0
        ? 'キーボードトラップは検出されませんでした'
        : `${traps.length}箇所でキーボードトラップを検出`,
      violations: traps
    };
  } catch (e) {
    return { sc: '2.1.2', name: 'キーボードトラップなし', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.4.1 スキップリンク */
async function check_2_4_1_skip_link(page) {
  try {
    const result = await page.evaluate(() => {
      // 最初のfocusable要素を確認
      const focusable = document.querySelector(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"])'
      );
      let skipLink = null;
      let skipLinkTarget = null;
      if (focusable && focusable.tagName === 'A') {
        const href = focusable.getAttribute('href') || '';
        const text = (focusable.textContent || '').toLowerCase();
        if (href.startsWith('#') && (text.includes('skip') || text.includes('main') || text.includes('content') || text.includes('メイン') || text.includes('本文'))) {
          skipLink = focusable.textContent.trim();
          const target = document.querySelector(href);
          skipLinkTarget = target ? true : false;
        }
      }
      // ランドマーク確認
      const landmarks = {
        main: !!document.querySelector('main, [role="main"]'),
        nav: !!document.querySelector('nav, [role="navigation"]'),
        header: !!document.querySelector('header, [role="banner"]'),
      };
      return { skipLink, skipLinkTarget, landmarks };
    });

    const hasSkip = !!result.skipLink && result.skipLinkTarget === true;
    const hasMain = result.landmarks.main;
    const pass = hasSkip || hasMain;

    const issues = [];
    if (!result.skipLink) issues.push('スキップリンクが見当たりません');
    else if (!result.skipLinkTarget) issues.push(`スキップリンク「${result.skipLink}」のリンク先が存在しません`);
    if (!result.landmarks.main) issues.push('<main>またはrole="main"がありません');
    if (!result.landmarks.nav) issues.push('<nav>またはrole="navigation"がありません');

    return {
      sc: '2.4.1', name: 'スキップリンク・ランドマーク',
      status: pass ? 'pass' : 'fail',
      message: pass
        ? `スキップリンク${result.skipLink ? `「${result.skipLink}」` : ''}またはランドマークが存在`
        : issues.join(' / '),
      violations: pass ? [] : issues
    };
  } catch (e) {
    return { sc: '2.4.1', name: 'スキップリンク・ランドマーク', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.3.3 アニメーション無効化（prefers-reduced-motion） */
async function check_2_3_3_animation(page) {
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await new Promise(r => setTimeout(r, 500));
    const result = await page.evaluate(() => {
      // document.getAnimations()
      const running = document.getAnimations ? document.getAnimations().filter(a => a.playState === 'running') : [];
      // styleSheets に @media(prefers-reduced-motion) ルールがあるか
      let hasMediaRule = false;
      try {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules || []) {
              if (rule.media && rule.conditionText && rule.conditionText.includes('prefers-reduced-motion')) {
                hasMediaRule = true;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
      return {
        runningCount: running.length,
        hasMediaRule,
        runningList: running.slice(0, 10).map(a => {
          const el = a.effect && a.effect.target;
          if (!el) return '(unknown)';
          const tag = el.tagName ? el.tagName.toLowerCase() : '?';
          const id = el.id ? `#${el.id}` : '';
          return `${tag}${id}`.slice(0, 60);
        })
      };
    });
    // media rule がある = 対応済みとみなす
    const pass = result.hasMediaRule || result.runningCount === 0;
    return {
      sc: '2.3.3', name: 'アニメーション無効化対応',
      status: pass ? 'pass' : 'fail',
      message: pass
        ? result.hasMediaRule
          ? '@media(prefers-reduced-motion)ルールあり — アニメーション制御に対応'
          : 'アニメーションなし（reduce時）'
        : `prefers-reduced-motion:reduce 時に${result.runningCount}個のアニメーションが動作中`,
      violations: pass ? [] : result.runningList
    };
  } catch (e) {
    return { sc: '2.3.3', name: 'アニメーション無効化対応', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.4.12 テキスト間隔調整 */
async function check_1_4_12_text_spacing(page) {
  try {
    // スタイル注入前の高さを記録
    const before = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, a, label');
      for (const el of els) {
        if (el.offsetHeight > 0 && el.scrollHeight > 0) {
          results.push({ key: el.tagName + (el.id ? '#' + el.id : ''), scrollH: el.scrollHeight, clientH: el.clientHeight });
        }
      }
      return results;
    });

    const styleHandle = await page.addStyleTag({
      content: '* { line-height: 1.5em !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }'
    });
    await new Promise(r => setTimeout(r, 300));

    const violations = await page.evaluate(() => {
      const issues = [];
      const els = document.querySelectorAll('p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, a, label');
      for (const el of els) {
        if (el.offsetHeight === 0) continue;
        const style = getComputedStyle(el);
        if (style.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 2) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          issues.push(`${tag}${id}${cls} (scrollH:${el.scrollHeight} > clientH:${el.clientHeight})`.slice(0, 80));
          if (issues.length >= 15) break;
        }
      }
      return issues;
    });

    // スタイル削除
    await page.evaluate(el => el.remove(), styleHandle);

    return {
      sc: '1.4.12', name: 'テキスト間隔調整',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? 'テキスト間隔を拡張してもコンテンツのクリップなし'
        : `${violations.length}個の要素でテキストがクリップされます`,
      violations
    };
  } catch (e) {
    return { sc: '1.4.12', name: 'テキスト間隔調整', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.4.11/12 フォーカス隠れなし */
async function check_2_4_11_12_focus_obscured(page) {
  try {
    const maxCheck = 30;
    const sc11violations = []; // 完全に隠れる
    const sc12violations = []; // 一部隠れる

    for (let i = 0; i < maxCheck; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topEls = document.elementsFromPoint(centerX, centerY) || [];
        const fixedEls = topEls.filter(e => {
          if (e === el || el.contains(e) || e.contains(el)) return false;
          const s = getComputedStyle(e);
          return s.position === 'fixed' || s.position === 'sticky';
        });
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const label = `${tag}${id}`.slice(0, 60);
        if (fixedEls.length === 0) return null;
        // 重複面積計算
        const fixedRects = fixedEls.map(e => e.getBoundingClientRect());
        let fullyObscured = false;
        let partiallyObscured = false;
        for (const fr of fixedRects) {
          const overlapX = Math.max(0, Math.min(rect.right, fr.right) - Math.max(rect.left, fr.left));
          const overlapY = Math.max(0, Math.min(rect.bottom, fr.bottom) - Math.max(rect.top, fr.top));
          if (overlapX > 0 && overlapY > 0) {
            const overlapArea = overlapX * overlapY;
            const elArea = rect.width * rect.height;
            if (overlapArea >= elArea * 0.9) fullyObscured = true;
            else partiallyObscured = true;
          }
        }
        return { label, fullyObscured, partiallyObscured };
      });
      if (!info) continue;
      if (info.fullyObscured) sc11violations.push(info.label);
      else if (info.partiallyObscured) sc12violations.push(info.label);
    }

    const results = [];
    results.push({
      sc: '2.4.11', name: 'フォーカス隠れなし（AA）',
      status: sc11violations.length === 0 ? 'pass' : 'fail',
      message: sc11violations.length === 0
        ? 'フォーカスが完全に隠れる要素は検出されませんでした'
        : `${sc11violations.length}個の要素でフォーカスが完全に隠れています`,
      violations: sc11violations
    });
    results.push({
      sc: '2.4.12', name: 'フォーカス隠れなし（AAA）',
      status: sc12violations.length === 0 ? 'pass' : 'fail',
      message: sc12violations.length === 0
        ? 'フォーカスが一部隠れる要素は検出されませんでした'
        : `${sc12violations.length}個の要素でフォーカスが一部隠れています`,
      violations: sc12violations
    });
    return results;
  } catch (e) {
    return [
      { sc: '2.4.11', name: 'フォーカス隠れなし（AA）', status: 'error', message: e.message, violations: [] },
      { sc: '2.4.12', name: 'フォーカス隠れなし（AAA）', status: 'error', message: e.message, violations: [] }
    ];
  }
}

/** SC 3.2.1/3.2.2 フォーカス/入力時の予期しない変化 */
async function check_3_2_1_2_unexpected_change(page) {
  try {
    // MutationObserver + window.open フック注入
    await page.evaluate(() => {
      window.__unexpectedChanges = [];
      const origOpen = window.open;
      window.open = function(...args) {
        window.__unexpectedChanges.push({ type: 'window.open', detail: args[0] || '' });
        return null;
      };
      window.__observer = new MutationObserver(mutations => {
        let added = 0;
        for (const m of mutations) added += m.addedNodes.length + m.removedNodes.length;
        if (added > 30) {
          window.__unexpectedChanges.push({ type: 'large-dom-change', detail: `${added}ノード変化` });
        }
      });
      window.__observer.observe(document.body, { childList: true, subtree: true });
      const origSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function() {
        window.__unexpectedChanges.push({ type: 'auto-submit', detail: this.action || '(unknown)' });
        return origSubmit.apply(this, arguments);
      };
      window.__startUrl = location.href;
    });

    const maxCheck = 20;
    for (let i = 0; i < maxCheck; i++) {
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 100));
      // URL変化チェック
      const urlChanged = await page.evaluate(() => location.href !== window.__startUrl);
      if (urlChanged) break;
    }

    // select/input に値を入力してコンテキスト変化を確認
    await page.evaluate(() => {
      const sel = document.querySelector('select');
      if (sel && sel.options.length > 1) {
        const prev = sel.value;
        sel.options[1].selected = true;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 500));

    const changes = await page.evaluate(() => {
      const urlChanged = location.href !== window.__startUrl;
      if (urlChanged) window.__unexpectedChanges.push({ type: 'url-change', detail: location.href });
      window.__observer.disconnect();
      return window.__unexpectedChanges.slice(0, 10);
    });

    return {
      sc: '3.2.1/3.2.2', name: 'フォーカス・入力時の予期しない変化',
      status: changes.length === 0 ? 'pass' : 'fail',
      message: changes.length === 0
        ? 'フォーカス・入力によるコンテキスト変化は検出されませんでした'
        : `${changes.length}件の予期しない変化を検出`,
      violations: changes.map(c => `[${c.type}] ${c.detail}`.slice(0, 80))
    };
  } catch (e) {
    return { sc: '3.2.1/3.2.2', name: 'フォーカス・入力時の予期しない変化', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 3.3.1 エラー特定
 *  [改善] 全フォームをテスト、aria-errormessage/aria-describedby 関連付けを検証
 */
async function check_3_3_1_error_identification(page) {
  try {
    const formCount = await page.evaluate(() => document.querySelectorAll('form').length);
    if (formCount === 0) {
      return { sc: '3.3.1', name: 'エラー特定', status: 'not_applicable', message: 'フォームが見つかりません', violations: [] };
    }

    // 全フォームを空送信
    await page.evaluate(() => {
      for (const form of document.querySelectorAll('form')) {
        const fields = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea');
        for (const f of fields) { f.value = ''; }
        const submitBtn = form.querySelector('[type="submit"], button:not([type="button"]):not([type="reset"])');
        if (submitBtn) submitBtn.click();
      }
    });
    await new Promise(r => setTimeout(r, 1200));

    const result = await page.evaluate(() => {
      const ariaInvalid = document.querySelectorAll('[aria-invalid="true"]');
      const alerts      = document.querySelectorAll('[role="alert"], [role="alertdialog"]');
      const errorCls    = document.querySelectorAll('[class*="error" i]:not(form):not(input), [class*="invalid" i]:not(input)');
      const errorEls    = [...new Set([...ariaInvalid, ...alerts, ...errorCls])].slice(0, 15);

      let associatedCount = 0;
      const violations = [];
      for (const el of errorEls) {
        const text = (el.textContent || '').trim().slice(0, 60);
        if (!text) continue;
        // aria-describedby / aria-errormessage の関連付け確認
        const refId = el.getAttribute('aria-describedby') || el.getAttribute('aria-errormessage');
        const hasAssociation = !!refId && !!document.getElementById(refId);
        if (hasAssociation) associatedCount++;
        violations.push({ text, hasAssociation });
      }
      return {
        errorCount: errorEls.length,
        associatedCount,
        violations: violations.map(v => `${v.hasAssociation ? '✓' : '✗関連付けなし'} "${v.text}"`)
      };
    });

    const pass = result.errorCount > 0;
    return {
      sc: '3.3.1', name: 'エラー特定',
      status: pass ? 'pass' : 'fail',
      message: pass
        ? `${formCount}フォーム検査: エラー${result.errorCount}件 (${result.associatedCount}件が適切に関連付け済み)`
        : `${formCount}フォームを空送信したがエラーメッセージが検出されませんでした`,
      violations: pass ? result.violations.filter(v => v.startsWith('✗')) : ['エラーメッセージ未表示の可能性']
    };
  } catch (e) {
    return { sc: '3.3.1', name: 'エラー特定', status: 'error', message: e.message, violations: [] };
  }
}

// ============================================================
// Phase 2: 高自動化・中〜高精度（期待精度80-90%）
// ============================================================

/** SC 2.1.1 キーボード操作可能 */
async function check_2_1_1_keyboard_operable(page) {
  try {
    const result = await page.evaluate(async () => {
      const violations = [];
      const interactives = document.querySelectorAll('[onclick], [onmousedown], [onmouseup], [ondblclick]');
      for (const el of interactives) {
        const tag = el.tagName.toLowerCase();
        // すでにフォーカス可能な要素は除外
        if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) continue;
        const tabindex = el.getAttribute('tabindex');
        const role = el.getAttribute('role');
        const focusableRoles = ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option'];
        if (focusableRoles.includes(role)) continue;
        if (tabindex !== null && tabindex !== '-1') continue;
        // tabindexなし + クリックハンドラあり = 疑わしい
        const style = window.getComputedStyle(el);
        const isCursorPointer = style.cursor === 'pointer';
        if (isCursorPointer || el.hasAttribute('onclick')) {
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          violations.push(`${tag}${id}${cls} (tabindex未設定, onclick/cursor:pointer)`.slice(0, 80));
          if (violations.length >= 15) break;
        }
      }
      return violations;
    });
    return {
      sc: '2.1.1', name: 'キーボード操作可能',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? 'キーボード操作不可な疑いのある要素は検出されませんでした'
        : `${result.length}個の要素がキーボード操作不可の可能性`,
      violations: result
    };
  } catch (e) {
    return { sc: '2.1.1', name: 'キーボード操作可能', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.4.7 フォーカス可視 + SC 2.4.13 フォーカスの外観
 *  [改善] el.focus() でスタイル差分を計測 — Tab依存より正確
 */
async function check_2_4_7_focus_visible(page) {
  try {
    const results = await page.evaluate(() => {
      const violations27 = [];
      const violations213 = [];
      const focusables = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).slice(0, 25);

      for (const el of focusables) {
        el.blur();
        const before = window.getComputedStyle(el);
        const bOutlineW   = parseFloat(before.outlineWidth) || 0;
        const bOutlineS   = before.outlineStyle;
        const bBoxShadow  = before.boxShadow;
        const bBg         = before.backgroundColor;
        const bBorderW    = parseFloat(before.borderWidth) || 0;
        const bBorderColor= before.borderColor;

        el.focus({ preventScroll: true });
        const after = window.getComputedStyle(el);
        const aOutlineW   = parseFloat(after.outlineWidth) || 0;
        const aOutlineS   = after.outlineStyle;
        const aBoxShadow  = after.boxShadow;
        const aBg         = after.backgroundColor;
        const aBorderW    = parseFloat(after.borderWidth) || 0;
        const aBorderColor= after.borderColor;
        el.blur();

        const tag   = el.tagName.toLowerCase();
        const id    = el.id ? `#${el.id}` : '';
        const label = `${tag}${id}`.slice(0, 50);

        // フォーカス時にいずれかのプロパティが変化したか
        const hasOutline    = aOutlineS !== 'none' && aOutlineW > 0;
        const hasBoxShadow  = aBoxShadow && aBoxShadow !== 'none' && aBoxShadow !== bBoxShadow;
        const bgChanged     = aBg !== bBg;
        const borderChanged = aBorderW !== bBorderW || aBorderColor !== bBorderColor;
        const hasFocusIndicator = hasOutline || hasBoxShadow || bgChanged || borderChanged;

        // SC 2.4.13: outline が 2px 以上
        const meets213 = aOutlineW >= 2;

        if (!hasFocusIndicator) {
          violations27.push(`${label} (outline:${aOutlineW}px, bg変化:${bgChanged}, shadow:${hasBoxShadow})`);
        }
        if (!meets213) {
          violations213.push(`${label} (outline-width:${aOutlineW}px < 2px)`);
        }
      }
      return { violations27, violations213 };
    });

    return [
      {
        sc: '2.4.7', name: 'フォーカス可視（AA）',
        status: results.violations27.length === 0 ? 'pass' : 'fail',
        message: results.violations27.length === 0
          ? 'フォーカス時にスタイル変化あり（outline/shadow/background/border）'
          : `${results.violations27.length}個の要素でフォーカス時にスタイル変化なし`,
        violations: results.violations27
      },
      {
        sc: '2.4.13', name: 'フォーカスの外観（AAA）',
        status: results.violations213.length === 0 ? 'pass' : 'fail',
        message: results.violations213.length === 0
          ? 'outline-widthが2px以上'
          : `${results.violations213.length}個の要素でoutline-widthが2px未満`,
        violations: results.violations213
      }
    ];
  } catch (e) {
    return [
      { sc: '2.4.7', name: 'フォーカス可視（AA）', status: 'error', message: e.message, violations: [] },
      { sc: '2.4.13', name: 'フォーカスの外観（AAA）', status: 'error', message: e.message, violations: [] }
    ];
  }
}

/** SC 2.4.3 フォーカス順序 */
async function check_2_4_3_focus_order(page) {
  try {
    const maxCheck = 30;
    const positions = [];
    const tabindexIssues = [];

    for (let i = 0; i < maxCheck; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const rect = el.getBoundingClientRect();
        const tabindex = parseInt(el.getAttribute('tabindex') || '0', 10);
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        return { x: rect.left, y: rect.top, tabindex, label: `${tag}${id}`.slice(0, 50) };
      });
      if (!info) continue;
      if (info.tabindex > 0) tabindexIssues.push(`${info.label} (tabindex=${info.tabindex})`);
      positions.push({ x: info.x, y: info.y, label: info.label });
    }

    // 視覚的な順序（上→下, 左→右）からの大きな逸脱を検出
    let orderViolations = 0;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      // 前の要素より大幅に上かつ右にない場合に逸脱と判断（ざっくり）
      if (curr.y < prev.y - 100 && curr.x > prev.x + 100) {
        orderViolations++;
      }
    }

    const violations = [...tabindexIssues];
    if (orderViolations > 2) violations.push(`フォーカス順序が視覚的読み順と大きく異なる箇所が${orderViolations}件`);

    return {
      sc: '2.4.3', name: 'フォーカス順序',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? 'フォーカス順序は論理的です（tabindex > 0 なし）'
        : `${violations.length}件の問題: tabindex > 0 または順序の逸脱`,
      violations
    };
  } catch (e) {
    return { sc: '2.4.3', name: 'フォーカス順序', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.4.4 テキスト200%拡大 */
async function check_1_4_4_text_resize(page) {
  try {
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await new Promise(r => setTimeout(r, 500));
    const violations = await page.evaluate(() => {
      const issues = [];
      const els = document.querySelectorAll('p, span, div, li, td, th, h1, h2, h3, h4, h5, h6');
      for (const el of els) {
        if (el.offsetHeight === 0) continue;
        const style = getComputedStyle(el);
        if (style.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 4) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          issues.push(`${tag}${id} (scrollH:${el.scrollHeight} > clientH:${el.clientHeight})`.slice(0, 80));
          if (issues.length >= 15) break;
        }
      }
      // 横スクロール
      const scrollW = document.documentElement.scrollWidth;
      const clientW = document.documentElement.clientWidth;
      if (scrollW > clientW + 10) {
        issues.push(`横スクロール発生: scrollWidth ${scrollW}px > ${clientW}px`);
      }
      return issues;
    });
    // リセット
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    return {
      sc: '1.4.4', name: 'テキスト200%拡大',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? 'テキスト200%でもコンテンツのクリップ・横スクロールなし'
        : `${violations.length}件: テキスト拡大時にコンテンツが見えなくなる可能性`,
      violations
    };
  } catch (e) {
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; }).catch(() => {});
    return { sc: '1.4.4', name: 'テキスト200%拡大', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.2.1-1.2.5 メディアキャプション
 *  [改善] track ファイルの HTTP 200 確認を追加
 */
async function check_1_2_x_media_captions(page) {
  try {
    const result = await page.evaluate(async () => {
      const videos  = document.querySelectorAll('video');
      const audios  = document.querySelectorAll('audio');
      const iframes = document.querySelectorAll('iframe');
      const issues  = [];

      for (const v of videos) {
        const capTracks  = v.querySelectorAll('track[kind="captions"], track[kind="subtitles"]');
        const descTracks = v.querySelectorAll('track[kind="descriptions"]');
        if (capTracks.length === 0) {
          issues.push(`video: キャプションtrack欠如 (src: ${(v.src || v.currentSrc || '').slice(0, 50)})`);
        } else {
          // track ファイルの HTTP 確認
          for (const t of capTracks) {
            const src = t.src;
            if (src) {
              try {
                const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
                if (!res.ok) issues.push(`track file HTTP ${res.status}: ${src.slice(-60)}`);
              } catch (e) {
                issues.push(`track fileアクセスエラー: ${src.slice(-60)}`);
              }
            }
          }
        }
        if (descTracks.length === 0) issues.push(`video: 音声解説track欠如`);
      }
      for (const a of audios) {
        const parent = a.parentElement;
        const nearText = (parent ? parent.textContent : '').toLowerCase();
        const hasTranscript = nearText.includes('transcript') || nearText.includes('書き起こし') || nearText.includes('テキスト版');
        if (!hasTranscript) issues.push(`audio: トランスクリプト未確認 (src: ${(a.src || '').slice(0, 50)})`);
      }
      for (const iframe of iframes) {
        const src = iframe.src || '';
        if (src.includes('youtube.com') || src.includes('youtu.be')) {
          if (!src.includes('cc_load_policy=1')) {
            issues.push(`YouTube iframe: cc_load_policy=1 パラメータなし (${src.slice(0, 60)})`);
          }
        }
      }
      return { videoCount: videos.length, audioCount: audios.length, iframeCount: iframes.length, issues };
    });

    if (result.videoCount === 0 && result.audioCount === 0 && result.iframeCount === 0) {
      return { sc: '1.2.x', name: 'メディアキャプション（1.2.1-1.2.5）', status: 'not_applicable', message: 'video/audio/iframeが存在しません', violations: [] };
    }
    return {
      sc: '1.2.x', name: 'メディアキャプション（1.2.1-1.2.5）',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? `メディア要素(video:${result.videoCount}, audio:${result.audioCount}, iframe:${result.iframeCount})にキャプション/解説あり`
        : `${result.issues.length}件のメディアアクセシビリティ問題を検出`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '1.2.x', name: 'メディアキャプション（1.2.1-1.2.5）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.2.2 動くコンテンツ停止 */
async function check_2_2_2_pause_stop(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];
      // video[autoplay]
      const autoplayVideos = document.querySelectorAll('video[autoplay]');
      for (const v of autoplayVideos) {
        const parent = v.parentElement;
        const hasPauseBtn = parent && parent.querySelector('button, [role="button"]');
        if (!hasPauseBtn) issues.push(`video[autoplay]: 停止ボタン未確認`);
      }
      // marquee
      const marquees = document.querySelectorAll('marquee');
      for (const m of marquees) {
        issues.push(`<marquee>要素: 動くコンテンツの停止手段なし`);
      }
      // CSS animation が長い要素
      const animated = document.querySelectorAll('[style*="animation"]');
      const longAnimations = [];
      for (const el of animated) {
        const style = getComputedStyle(el);
        const dur = parseFloat(style.animationDuration) || 0;
        if (dur > 5) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          longAnimations.push(`${tag}${id} (${dur}s)`);
          if (longAnimations.length >= 5) break;
        }
      }
      if (longAnimations.length > 0) {
        issues.push(`長時間CSSアニメーション(5秒超): ${longAnimations.join(', ')}`);
      }
      return { issues, autoplayCount: autoplayVideos.length };
    });

    if (result.autoplayCount === 0 && result.issues.length === 0) {
      return {
        sc: '2.2.2', name: '動くコンテンツ停止',
        status: 'pass', message: '自動再生動画・marquee・長時間アニメーションなし', violations: []
      };
    }

    return {
      sc: '2.2.2', name: '動くコンテンツ停止',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? '動くコンテンツに停止手段あり'
        : `${result.issues.length}件の問題を検出`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '2.2.2', name: '動くコンテンツ停止', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 3.3.8 認証アクセシブル */
async function check_3_3_8_accessible_authentication(page) {
  try {
    const result = await page.evaluate(() => {
      const pwInputs = document.querySelectorAll('input[type="password"]');
      if (pwInputs.length === 0) return { notApplicable: true };

      const issues = [];
      for (const input of pwInputs) {
        const autocomplete = input.getAttribute('autocomplete') || '';
        if (!autocomplete.includes('current-password') && !autocomplete.includes('new-password') && !autocomplete.includes('off')) {
          issues.push(`パスワード入力(id:${input.id || '?'}): autocomplete="${autocomplete}" — current-password/new-passwordが推奨`);
        }
      }
      // CAPTCHA検出
      const captchaFrames = document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha');
      if (captchaFrames.length > 0) {
        issues.push(`CAPTCHA検出 (${captchaFrames.length}個): 音声代替の有無を手動確認してください`);
      }
      return { notApplicable: false, issues };
    });

    if (result.notApplicable) {
      return {
        sc: '3.3.8', name: '認証アクセシブル',
        status: 'not_applicable', message: 'パスワード入力フィールドが存在しません', violations: []
      };
    }

    return {
      sc: '3.3.8', name: '認証アクセシブル',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? 'パスワードフィールドにautocomplete属性が設定されています'
        : `${result.issues.length}件の問題を検出`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '3.3.8', name: '認証アクセシブル', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.3.1 3回点滅 (CSS/アニメーション解析) */
async function check_2_3_1_three_flashes(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];
      // @keyframes で急速な色変化を検出
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              const keys = Array.from(rule.cssRules || []);
              // 明暗反転を0%→50%→100%でチェック
              if (keys.length >= 3) {
                let hasFlash = false;
                for (const key of keys) {
                  const text = key.cssText || '';
                  if (text.includes('opacity: 0') || text.includes('opacity:0') || text.includes('visibility: hidden')) {
                    hasFlash = true;
                  }
                }
                if (hasFlash) {
                  // アニメーション速度を確認（適用要素のanimation-duration）
                  const elWithAnim = document.querySelector(`[style*="${rule.name}"], *`);
                  issues.push(`@keyframes "${rule.name}": 点滅を含む可能性のあるアニメーション — 速度を手動確認してください`);
                  if (issues.length >= 5) break;
                }
              }
            }
          }
        } catch (e) {}
      }
      // video[autoplay] の点滅リスク
      const flashVideos = document.querySelectorAll('video[autoplay]');
      if (flashVideos.length > 0) {
        issues.push(`video[autoplay] (${flashVideos.length}個): 点滅コンテンツの手動確認が必要`);
      }
      return issues;
    });

    return {
      sc: '2.3.1', name: '3回点滅（seizure）',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? '点滅の疑いのあるアニメーションは検出されませんでした'
        : `${result.length}件の要確認アニメーションを検出（手動確認推奨）`,
      violations: result
    };
  } catch (e) {
    return { sc: '2.3.1', name: '3回点滅（seizure）', status: 'error', message: e.message, violations: [] };
  }
}

// ============================================================
// Phase 3: ハイブリッド（Puppeteer + AI補助）
// ============================================================

/** SC 1.4.13 ホバーコンテンツ */
async function check_1_4_13_hover_content(page) {
  try {
    const hoverTargets = await page.evaluate(() => {
      const els = document.querySelectorAll('[title], [data-tooltip], [aria-describedby], .tooltip, [class*="tooltip" i], [class*="popover" i]');
      return Array.from(els).slice(0, 10).map(el => {
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: `${tag}${id}`.slice(0, 40) };
      }).filter(e => e.x > 0 && e.y > 0);
    });

    if (hoverTargets.length === 0) {
      return {
        sc: '1.4.13', name: 'ホバーコンテンツ',
        status: 'not_applicable', message: 'ホバーコンテンツの疑いのある要素が見当たりません', violations: []
      };
    }

    const issues = [];
    for (const target of hoverTargets.slice(0, 5)) {
      await page.mouse.move(target.x, target.y);
      await new Promise(r => setTimeout(r, 500));
      const appeared = await page.evaluate(() => {
        // 新しく表示された要素を探す
        const visible = Array.from(document.querySelectorAll('[role="tooltip"], .tooltip, [class*="tooltip" i]'))
          .filter(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
        if (visible.length === 0) return null;
        const el = visible[0];
        // Escape で消えるか
        return { text: (el.textContent || '').trim().slice(0, 50) };
      });
      if (appeared) {
        // Escape でコンテンツが消えるか確認
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 200));
        const dismissed = await page.evaluate(() => {
          const visible = Array.from(document.querySelectorAll('[role="tooltip"], .tooltip, [class*="tooltip" i]'))
            .filter(el => el.offsetParent !== null);
          return visible.length === 0;
        });
        if (!dismissed) {
          issues.push(`${target.label}: ホバーコンテンツがEscapeで閉じない — "${appeared.text}"`);
        }
      }
    }

    return {
      sc: '1.4.13', name: 'ホバーコンテンツ',
      status: issues.length === 0 ? 'pass' : 'fail',
      message: issues.length === 0
        ? 'ホバーコンテンツはEscapeで閉じることを確認'
        : `${issues.length}件: ホバーコンテンツがEscapeで閉じない可能性`,
      violations: issues
    };
  } catch (e) {
    return { sc: '1.4.13', name: 'ホバーコンテンツ', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.4.1 色だけの情報伝達
 *  [改善] 下線なしリンクの色コントラスト比（3:1）計算を追加
 */
async function check_1_4_1_use_of_color(page) {
  try {
    const result = await page.evaluate(() => {
      // 相対輝度計算（WCAG 2.x準拠）
      function parseCssColor(cssColor) {
        const m = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      }
      function getLuminance(r, g, b) {
        return [r, g, b].reduce((sum, c, i) => {
          const v = c / 255;
          return sum + (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][i];
        }, 0);
      }
      function contrastRatio(c1, c2) {
        const [l1, l2] = [c1, c2].map(c => getLuminance(...c)).sort((a, b) => b - a);
        return (l1 + 0.05) / (l2 + 0.05);
      }

      const issues = [];
      const links = Array.from(document.querySelectorAll('p a, li a, td a')).slice(0, 30);
      let lowContrastCount = 0;

      for (const link of links) {
        if (!link.parentElement) continue;
        const linkStyle   = getComputedStyle(link);
        const parentStyle = getComputedStyle(link.parentElement);

        const hasUnderline = linkStyle.textDecorationLine.includes('underline');
        const hasBold      = parseInt(linkStyle.fontWeight) >= 700;
        const hasBorder    = linkStyle.borderBottomWidth !== '0px';

        if (!hasUnderline && !hasBold && !hasBorder) {
          // 下線等なし → コントラスト比 3:1 以上を要求
          const linkRgb   = parseCssColor(linkStyle.color);
          const parentRgb = parseCssColor(parentStyle.color);
          if (linkRgb && parentRgb) {
            const ratio = contrastRatio(linkRgb, parentRgb);
            if (ratio < 3.0) {
              lowContrastCount++;
              if (lowContrastCount <= 5) {
                const id = link.id ? `#${link.id}` : '';
                issues.push(`a${id}: 下線なし + 周囲テキストとのコントラスト比${ratio.toFixed(2)}:1 (要3:1以上)`);
              }
            }
          } else {
            // 色が取れない場合は件数のみカウント
            lowContrastCount++;
          }
        }
      }
      if (lowContrastCount > 5) {
        issues.push(`（他${lowContrastCount - 5}件の下線なしリンクも同様に要確認）`);
      }

      // エラー表示が色のみか
      for (const el of document.querySelectorAll('[class*="error" i], [aria-invalid="true"]')) {
        const hasNonColor = el.querySelector('svg, img, [aria-label], [title]') || (el.textContent || '').trim().length > 0;
        if (!hasNonColor) issues.push(`エラー表示が色のみの可能性: ${el.tagName.toLowerCase()}`.slice(0, 80));
      }
      return issues;
    });

    return {
      sc: '1.4.1', name: '色だけの情報伝達',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? '色以外の視覚的手がかりが確認できます'
        : `${result.length}件: 色のみで情報を伝達している可能性（下線なしリンクのコントラスト比不足を含む）`,
      violations: result
    };
  } catch (e) {
    return { sc: '1.4.1', name: '色だけの情報伝達', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.4.5 文字画像 */
async function check_1_4_5_images_of_text(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];
      // canvas/svg に text が含まれるか
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        issues.push(`canvas要素 ${canvases.length}個: テキスト含有の手動確認が必要`);
      }
      // img の alt に長いテキストが含まれるか
      const imgs = document.querySelectorAll('img[alt]');
      for (const img of imgs) {
        const alt = img.getAttribute('alt') || '';
        if (alt.length > 20 && !img.closest('a')) {
          issues.push(`img[alt="${alt.slice(0, 40)}..."]: 文字画像の可能性`);
          if (issues.length >= 5) break;
        }
      }
      // background-image に文字含有（CSS的には検出困難なのでフラグのみ）
      const elementsWithBg = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = getComputedStyle(el);
        return style.backgroundImage && style.backgroundImage !== 'none' && !['IMG', 'VIDEO'].includes(el.tagName);
      });
      if (elementsWithBg.length > 0) {
        issues.push(`background-imageを持つ要素 ${elementsWithBg.length}個: 文字画像の可能性 — 手動確認を推奨`);
      }
      return issues;
    });

    return {
      sc: '1.4.5', name: '文字画像',
      status: result.length === 0 ? 'pass' : 'manual_required',
      message: result.length === 0
        ? '文字画像の疑いのある要素は検出されませんでした'
        : `${result.length}件: 文字画像の可能性あり（手動確認推奨）`,
      violations: result
    };
  } catch (e) {
    return { sc: '1.4.5', name: '文字画像', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.2.1 制限時間調整（setTimeout/setInterval検出） */
async function check_2_2_1_timing_adjustable(page) {
  try {
    await page.evaluate(() => {
      window.__timerCount = 0;
      window.__longTimers = [];
      const origSetTimeout = window.setTimeout;
      window.setTimeout = function(fn, delay, ...args) {
        if (delay > 20000) { // 20秒以上のタイマー
          window.__timerCount++;
          window.__longTimers.push(delay);
        }
        return origSetTimeout(fn, delay, ...args);
      };
    });
    await new Promise(r => setTimeout(r, 2000));
    const result = await page.evaluate(() => ({
      count: window.__timerCount || 0,
      timers: (window.__longTimers || []).slice(0, 5)
    }));

    const issues = result.timers.map(ms => `setTimeout: ${Math.round(ms / 1000)}秒のタイマー検出 — ユーザーに延長/無効化手段が必要`);

    return {
      sc: '2.2.1', name: '制限時間調整',
      status: issues.length === 0 ? 'pass' : 'fail',
      message: issues.length === 0
        ? '長時間タイマー（20秒超）は検出されませんでした'
        : `${issues.length}件の長時間タイマーを検出`,
      violations: issues
    };
  } catch (e) {
    return { sc: '2.2.1', name: '制限時間調整', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 3.3.3 エラー修正提案 */
async function check_3_3_3_error_suggestion(page) {
  try {
    const formInfo = await page.evaluate(() => {
      return !!document.querySelector('form');
    });
    if (!formInfo) {
      return { sc: '3.3.3', name: 'エラー修正提案', status: 'not_applicable', message: 'フォームが存在しません', violations: [] };
    }

    // 空フォーム送信
    await page.evaluate(() => {
      const form = document.querySelector('form');
      const fields = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
      for (const f of fields) { f.value = ''; }
      const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    const result = await page.evaluate(() => {
      const errorMsgs = document.querySelectorAll('[role="alert"], [aria-invalid="true"] + *, [class*="error" i]:not(input)');
      const issues = [];
      for (const el of errorMsgs) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        // 修正提案があるか（具体的な指示を含むか）
        const hasSpecificGuidance = text.length > 10 &&
          (text.includes('入力') || text.includes('選択') || text.includes('確認') ||
           text.includes('enter') || text.includes('select') || text.includes('check'));
        if (!hasSpecificGuidance) {
          issues.push(`エラーメッセージに修正提案なし: "${text.slice(0, 60)}"`);
        }
      }
      return { errorCount: errorMsgs.length, issues };
    });

    return {
      sc: '3.3.3', name: 'エラー修正提案',
      status: result.errorCount === 0 ? 'manual_required' : (result.issues.length === 0 ? 'pass' : 'fail'),
      message: result.errorCount === 0
        ? 'エラーメッセージが表示されませんでした — 手動確認が必要'
        : result.issues.length === 0
          ? `${result.errorCount}件のエラーメッセージに修正提案あり`
          : `${result.issues.length}件のエラーメッセージに具体的な修正提案なし`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '3.3.3', name: 'エラー修正提案', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.5.1/2.5.7 ジェスチャ/ドラッグ代替 */
async function check_2_5_1_7_gestures(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];
      // touchstart/touchmove/draggable を持つ要素
      const draggables = document.querySelectorAll('[draggable="true"]');
      for (const el of draggables) {
        const parent = el.parentElement;
        const hasAltBtn = parent && parent.querySelector('button, [role="button"]');
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        if (!hasAltBtn) {
          issues.push(`${tag}${id}[draggable]: ドラッグの代替UIが未確認`.slice(0, 80));
        }
      }
      // ジェスチャ系ライブラリのクラス（Hammer.js, Swiper等）
      const gestureEls = document.querySelectorAll('.swiper, .swiper-container, [data-hammer], .slick-slider, .owl-carousel');
      if (gestureEls.length > 0) {
        const hasNavBtns = document.querySelector('.swiper-button-next, .slick-next, .owl-next, [aria-label*="next" i], [aria-label*="次"]');
        if (!hasNavBtns) {
          issues.push(`スワイプ/ジェスチャUI (${gestureEls.length}個): ボタンによる代替操作が未確認`);
        }
      }
      return issues;
    });

    return {
      sc: '2.5.1/2.5.7', name: 'ジェスチャ・ドラッグ代替',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? 'ドラッグ・スワイプの代替手段の問題は検出されませんでした'
        : `${result.length}件: ジェスチャ/ドラッグの代替UIを確認してください`,
      violations: result
    };
  } catch (e) {
    return { sc: '2.5.1/2.5.7', name: 'ジェスチャ・ドラッグ代替', status: 'error', message: e.message, violations: [] };
  }
}

// ============================================================
// Section A: 新規自動化チェック（A/AA 未実装項目）
// ============================================================

/** SC 2.5.3 名前（ラベル）に名前が含まれる
 *  visible text と aria-label が食い違うと音声入力ユーザーが操作できない
 */
async function check_2_5_3_label_in_name(page) {
  try {
    const violations = await page.evaluate(() => {
      const issues = [];
      const interactives = document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="reset"]');
      for (const el of interactives) {
        const ariaLabel = el.getAttribute('aria-label') || '';
        if (!ariaLabel) continue;
        const visibleText = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
        if (!visibleText) continue;
        // aria-label がvisible textを含まない場合は違反
        if (!ariaLabel.toLowerCase().includes(visibleText.toLowerCase().slice(0, 15))) {
          const tag = el.tagName.toLowerCase();
          const id  = el.id ? `#${el.id}` : '';
          issues.push(`${tag}${id}: aria-label="${ariaLabel}" ≠ visible="${visibleText.slice(0, 40)}"`);
          if (issues.length >= 10) break;
        }
      }
      return issues;
    });
    return {
      sc: '2.5.3', name: '名前（ラベル）に名前が含まれる',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? 'aria-labelは全てvisibleテキストを含んでいます'
        : `${violations.length}件: aria-labelとvisibleテキストが不一致（音声入力で操作できない可能性）`,
      violations
    };
  } catch (e) {
    return { sc: '2.5.3', name: '名前（ラベル）に名前が含まれる', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.3.4 表示方向
 *  CSS でポートレート/ランドスケープを強制している検出
 */
async function check_1_3_4_orientation(page) {
  try {
    const issues = await page.evaluate(() => {
      const found = [];
      // CSS @media orientation ルールで display:none / visibility:hidden を設定しているか
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.MEDIA_RULE) {
              const cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
              if (cond.includes('orientation')) {
                for (const inner of rule.cssRules || []) {
                  const text = inner.cssText || '';
                  if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(text)) {
                    found.push(`@media(${cond}){ ${text.slice(0, 80)} } — 特定方向でコンテンツ非表示`);
                  }
                }
              }
            }
          }
        } catch (e) {}
      }
      // body/html に transform:rotate がないか
      const bodyStyle = getComputedStyle(document.body);
      if (/rotate\((?!0)/.test(bodyStyle.transform)) {
        found.push(`body transform:${bodyStyle.transform} — 表示方向がロックされている可能性`);
      }
      return found;
    });
    return {
      sc: '1.3.4', name: '表示方向',
      status: issues.length === 0 ? 'pass' : 'fail',
      message: issues.length === 0
        ? '表示方向を制限するCSSは検出されませんでした'
        : `${issues.length}件: 特定方向でコンテンツを非表示にしている可能性`,
      violations: issues
    };
  } catch (e) {
    return { sc: '1.3.4', name: '表示方向', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.3.5 入力目的の特定
 *  個人情報フィールドに適切な autocomplete 属性があるか
 */
async function check_1_3_5_input_purpose(page) {
  try {
    const violations = await page.evaluate(() => {
      const issues = [];
      // type/name/placeholder から個人情報フィールドを推定し autocomplete を確認
      const patterns = [
        { re: /email|メール/i,          autocomplete: 'email',          label: 'メール' },
        { re: /tel|phone|電話/i,         autocomplete: 'tel',            label: '電話番号' },
        { re: /\bname\b|氏名|お名前/i,   autocomplete: 'name',           label: '氏名' },
        { re: /given.?name|名前|first.?name/i, autocomplete: 'given-name',  label: '名' },
        { re: /family.?name|姓|last.?name/i,   autocomplete: 'family-name', label: '姓' },
        { re: /postal|zip|郵便/i,        autocomplete: 'postal-code',    label: '郵便番号' },
        { re: /address|住所/i,           autocomplete: 'street-address', label: '住所' },
        { re: /birthday|生年月日|birth/i, autocomplete: 'bday',          label: '生年月日' },
      ];
      for (const input of document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])')) {
        const hint = `${input.type || ''} ${input.name || ''} ${input.placeholder || ''} ${input.id || ''}`.toLowerCase();
        for (const pat of patterns) {
          if (pat.re.test(hint)) {
            const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
            if (!ac || ac === 'off' || ac === 'on') {
              const id = input.id ? `#${input.id}` : (input.name ? `[name=${input.name}]` : '');
              issues.push(`input${id}: ${pat.label}フィールドに autocomplete="${ac || '(未設定)'}" — "${pat.autocomplete}"推奨`);
            }
            break;
          }
        }
      }
      return issues;
    });
    return {
      sc: '1.3.5', name: '入力目的の特定（autocomplete）',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? '個人情報フィールドに適切なautocomplete属性が設定されています'
        : `${violations.length}個の個人情報フィールドでautocompleteが不適切`,
      violations
    };
  } catch (e) {
    return { sc: '1.3.5', name: '入力目的の特定（autocomplete）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.5.2 ポインタキャンセル
 *  mousedown で即座にアクションが実行される要素を検出
 */
async function check_2_5_2_pointer_cancellation(page) {
  try {
    const violations = await page.evaluate(() => {
      const issues = [];
      // onmousedown 属性で直接アクション（location変更・submit等）を実行している要素
      const els = document.querySelectorAll('[onmousedown]');
      for (const el of els) {
        const handler = el.getAttribute('onmousedown') || '';
        // location/submit/href 変更を示すパターン
        if (/location|submit|href|navigate|window\.open/i.test(handler)) {
          const tag = el.tagName.toLowerCase();
          const id  = el.id ? `#${el.id}` : '';
          issues.push(`${tag}${id}[onmousedown="${handler.slice(0, 60)}"]: mousedownで即座にアクション実行`);
          if (issues.length >= 10) break;
        }
      }
      return issues;
    });
    return {
      sc: '2.5.2', name: 'ポインタキャンセル',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? 'mousedownで即座にアクションを実行する要素は検出されませんでした'
        : `${violations.length}件: mousedownイベントでキャンセル不可能なアクションの可能性`,
      violations
    };
  } catch (e) {
    return { sc: '2.5.2', name: 'ポインタキャンセル', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.5.4 モーション操作の代替
 *  DeviceMotion/DeviceOrientation イベントリスナーを検出（ページ読み込み前に注入）
 */
async function check_2_5_4_motion_actuation(page) {
  try {
    // ページ内スクリプト実行前にフックを注入
    await page.evaluateOnNewDocument(() => {
      window.__motionListeners = [];
      const origAEL = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, ...args) {
        if (type === 'devicemotion' || type === 'deviceorientation') {
          window.__motionListeners.push(type);
        }
        return origAEL.apply(this, [type, ...args]);
      };
    });
    // ページを再読み込みしてフックを有効にする（check前に呼ばれるreloadは不要のためここでは再評価のみ）
    const motionListeners = await page.evaluate(() => window.__motionListeners || []);
    if (motionListeners.length === 0) {
      return { sc: '2.5.4', name: 'モーション操作の代替', status: 'pass', message: 'DeviceMotion/DeviceOrientationイベントは未使用', violations: [] };
    }
    // 代替UIがあるか確認
    const hasAlternative = await page.evaluate(() => {
      return !!(document.querySelector('button, [role="button"], input[type="button"]'));
    });
    const violations = motionListeners.map(t => `${t}イベントを使用: ボタン等の代替UI${hasAlternative ? 'あり（内容を手動確認）' : 'なし'}`);
    return {
      sc: '2.5.4', name: 'モーション操作の代替',
      status: hasAlternative ? 'manual_required' : 'fail',
      message: hasAlternative
        ? `モーションイベント使用 — 代替UIの存在を確認（手動確認推奨）`
        : 'モーションイベント使用 + 代替UIが見つかりません',
      violations
    };
  } catch (e) {
    return { sc: '2.5.4', name: 'モーション操作の代替', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 3.2.6 ヘルプの位置一貫性
 *  ヘルプ・連絡先リンクがheader/footer内の一定位置にあるか
 */
async function check_3_2_6_consistent_help(page) {
  try {
    const result = await page.evaluate(() => {
      const helpPatterns = [
        /^tel:/i, /^mailto:/i,
        /help|support|faq|contact|ヘルプ|サポート|お問い合わせ|よくある/i
      ];
      const header = document.querySelector('header, [role="banner"]');
      const footer = document.querySelector('footer, [role="contentinfo"]');
      const nav    = document.querySelector('nav, [role="navigation"]');

      function findHelp(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll('a')).filter(a => {
          const href = (a.getAttribute('href') || '').toLowerCase();
          const text = (a.textContent || '').toLowerCase();
          return helpPatterns.some(p => p.test(href) || p.test(text));
        }).map(a => (a.textContent || a.href || '').trim().slice(0, 40));
      }

      const headerHelp = findHelp(header);
      const footerHelp = findHelp(footer);
      const navHelp    = findHelp(nav);
      const allHelp    = [...headerHelp, ...footerHelp, ...navHelp];

      return { found: allHelp.length > 0, locations: allHelp, hasHeader: !!header, hasFooter: !!footer };
    });

    if (!result.hasHeader && !result.hasFooter) {
      return { sc: '3.2.6', name: 'ヘルプの位置一貫性', status: 'manual_required', message: 'header/footer要素が検出されません — 手動確認が必要', violations: [] };
    }
    return {
      sc: '3.2.6', name: 'ヘルプの位置一貫性',
      status: result.found ? 'pass' : 'fail',
      message: result.found
        ? `header/footer/navにヘルプ/連絡先リンクあり: ${result.locations.slice(0, 3).join(', ')}`
        : 'header/footer内にヘルプ・連絡先・FAQリンクが見つかりません',
      violations: result.found ? [] : ['ヘルプリンク（tel/mailto/contact/FAQ）をheader/footerに配置してください']
    };
  } catch (e) {
    return { sc: '3.2.6', name: 'ヘルプの位置一貫性', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 3.3.7 冗長な入力
 *  マルチステップフォームで既入力データの再要求を検出
 */
async function check_3_3_7_redundant_entry(page) {
  try {
    const result = await page.evaluate(() => {
      // マルチステップのパターンを検出
      const stepIndicators = document.querySelectorAll('[class*="step" i], [class*="wizard" i], [class*="progress" i], [aria-current="step"]');
      const forms = document.querySelectorAll('form');
      const issues = [];

      if (stepIndicators.length > 0) {
        // マルチステップ確認
        issues.push(`マルチステップUIを検出(${stepIndicators.length}個の要素): 前ステップの入力値が再要求されていないか手動確認が必要`);
      }
      if (forms.length > 1) {
        // 同一ページに複数フォーム: 同じフィールドが重複してないか
        const allInputNames = [];
        const duplicates = [];
        for (const form of forms) {
          for (const inp of form.querySelectorAll('input[name]:not([type="hidden"]):not([type="submit"])')) {
            const n = inp.name;
            if (allInputNames.includes(n)) {
              if (!duplicates.includes(n)) duplicates.push(n);
            } else {
              allInputNames.push(n);
            }
          }
        }
        if (duplicates.length > 0) {
          issues.push(`複数フォームで同名フィールドが重複: ${duplicates.slice(0, 5).join(', ')} — 冗長な入力の可能性`);
        }
      }

      // autocomplete で前入力値を再利用しているか
      const requiredInputs = document.querySelectorAll('input[required]:not([type="hidden"]):not([type="submit"])');
      let noAutocomplete = 0;
      for (const inp of requiredInputs) {
        const ac = inp.getAttribute('autocomplete');
        if (!ac || ac === 'off') noAutocomplete++;
      }
      if (noAutocomplete > 2 && stepIndicators.length > 0) {
        issues.push(`必須フィールド${noAutocomplete}個でautocompleteなし: マルチステップでの再入力を強いている可能性`);
      }

      return { issues, hasMultiStep: stepIndicators.length > 0, formCount: forms.length };
    });

    if (result.issues.length === 0 && !result.hasMultiStep) {
      return { sc: '3.3.7', name: '冗長な入力', status: 'pass', message: 'マルチステップフォームは検出されませんでした', violations: [] };
    }
    return {
      sc: '3.3.7', name: '冗長な入力',
      status: result.issues.some(i => i.includes('重複')) ? 'fail' : 'manual_required',
      message: result.issues.length === 0
        ? 'マルチステップUI検出 — 手動確認を推奨'
        : `${result.issues.length}件の問題を検出`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '3.3.7', name: '冗長な入力', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.4.4 リンクの目的（コンテキスト内）— Section B 新規
 *  汎用的なリンクテキスト（「こちら」「詳しくは」等）を検出
 */
async function check_2_4_4_link_purpose(page) {
  try {
    const violations = await page.evaluate(() => {
      // 日本語・英語の汎用リンクテキストブラックリスト
      const blacklist = /^(こちら|ここ|詳しくは|詳細|続きを読む|もっと見る|click here|here|read more|more|learn more|details|続き|see more|view more|全文|全て)$/i;
      const issues = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const text = (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (!text) {
          // テキストなし — alt付きimgのみのリンク以外は違反
          const hasImg = a.querySelector('img[alt]:not([alt=""])');
          const hasAriaLabel = a.getAttribute('aria-label') || a.getAttribute('aria-labelledby');
          if (!hasImg && !hasAriaLabel) {
            const id = a.id ? `#${a.id}` : '';
            issues.push(`a${id}[href="${(a.getAttribute('href') || '').slice(0, 40)}"]: リンクテキストなし`);
          }
        } else if (blacklist.test(text)) {
          const id = a.id ? `#${a.id}` : '';
          issues.push(`a${id}: 汎用テキスト「${text}」— リンク先が特定できない`);
        }
        if (issues.length >= 15) break;
      }
      return issues;
    });
    return {
      sc: '2.4.4', name: 'リンクの目的（汎用テキスト検出）',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? '汎用的なリンクテキストは検出されませんでした'
        : `${violations.length}件: リンク目的が不明なテキスト（「こちら」「read more」等）`,
      violations
    };
  } catch (e) {
    return { sc: '2.4.4', name: 'リンクの目的（汎用テキスト検出）', status: 'error', message: e.message, violations: [] };
  }
}

/** ARIA動的属性チェック
 *  aria-expanded / aria-current / aria-live の欠落を静的+動的で検出
 */
async function check_aria_attributes(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = { expanded: [], current: [], live: [] };

      // --- aria-expanded ---
      // aria-controls / aria-haspopup を持つ要素、または toggle/dropdown/accordion クラスの button/a
      const togglePattern = /toggle|dropdown|collapse|accordion|menu|expand/i;
      const candidates = [
        ...document.querySelectorAll('[aria-controls], [aria-haspopup]'),
        ...[...document.querySelectorAll('button, [role="button"], a')].filter(el => {
          const cls = (el.className && typeof el.className === 'string') ? el.className : '';
          return togglePattern.test(cls) || togglePattern.test(el.getAttribute('data-bs-toggle') || '');
        })
      ];
      const seen = new Set();
      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.getAttribute('aria-expanded') === null) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          const label = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30);
          issues.expanded.push(`${tag}${id}${cls}: "${label}" — aria-expanded属性なし`);
          if (issues.expanded.length >= 10) break;
        }
      }

      // --- aria-current ---
      const navEls = [...document.querySelectorAll('nav, [role="navigation"]')];
      let navLinksTotal = 0;
      let hasAriaCurrent = false;
      for (const nav of navEls) {
        const links = nav.querySelectorAll('a');
        navLinksTotal += links.length;
        if ([...links].some(a => a.hasAttribute('aria-current'))) hasAriaCurrent = true;
      }
      if (navLinksTotal >= 2 && !hasAriaCurrent) {
        issues.current.push(`navまたは[role=navigation]内の${navLinksTotal}件のリンクにaria-current="page"なし`);
      }

      // --- aria-live / role="alert" ---
      const hasForm = document.querySelectorAll('form').length > 0;
      const hasDynamicClass = document.querySelectorAll(
        '[class*="error"],[class*="alert"],[class*="notification"],[class*="toast"],[class*="flash"],[class*="message"]'
      ).length > 0;
      const hasLiveRegion = document.querySelectorAll(
        '[aria-live],[role="alert"],[role="status"],[role="log"],[role="marquee"],[aria-atomic]'
      ).length > 0;
      if ((hasForm || hasDynamicClass) && !hasLiveRegion) {
        const hint = hasForm ? 'フォームあり' : '動的通知クラスあり';
        issues.live.push(`${hint}だがaria-live / role="alert" のリージョンが見当たりません（動的エラー通知が未実装の可能性）`);
      }

      return {
        expandedCount: issues.expanded.length,
        currentMissing: issues.current.length > 0,
        liveMissing: issues.live.length > 0,
        issues: { expanded: issues.expanded, current: issues.current, live: issues.live }
      };
    });

    const allViolations = [
      ...result.issues.expanded.map(v => `[aria-expanded欠落] ${v}`),
      ...result.issues.current.map(v => `[aria-current欠落] ${v}`),
      ...result.issues.live.map(v => `[aria-live欠落] ${v}`)
    ];

    const hasIssues = allViolations.length > 0;
    // live/currentはページ実装次第で必須でない場合もあるためmanual_requiredとする
    const status = result.issues.expanded.length > 0 ? 'fail'
      : (result.currentMissing || result.liveMissing) ? 'manual_required'
      : 'pass';

    return {
      sc: '4.1.2/4.1.3',
      name: 'ARIA動的属性（expanded/current/live）',
      status,
      message: hasIssues
        ? `aria-expanded: ${result.expandedCount}件, aria-current: ${result.currentMissing ? '未設定' : 'OK'}, aria-live: ${result.liveMissing ? '未設定の可能性' : 'OK'}`
        : 'aria-expanded / aria-current / aria-live の欠落は検出されませんでした',
      violations: allViolations
    };
  } catch (e) {
    return { sc: '4.1.2/4.1.3', name: 'ARIA動的属性（expanded/current/live）', status: 'error', message: e.message, violations: [] };
  }
}

/**
 * Phase 1 高精度検査 API
 */
// WCAG 2.2 AAA の SC 識別子（AAA betaオフ時に除外）
const AAA_SC_LIST = new Set(['2.3.3','2.4.12','2.4.13','2.1.3','3.3.9','2.3.2','2.2.3','2.2.4','2.2.5','2.2.6','2.4.6','2.4.8','2.4.9','2.4.10','1.4.6','1.4.7','1.4.8','1.4.9','2.5.5','2.5.6','3.1.3','3.1.4','3.1.5','3.1.6','3.2.5','3.3.5','3.3.6','3.3.9']);

app.post('/api/enhanced-check', async (req, res) => {
  const { url, basicAuth, includeAAA, viewportPreset } = req.body;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });

  // リクエスト全体に8分のタイムアウトを設定
  const HANDLER_TIMEOUT = 8 * 60 * 1000;
  let handlerTimedOut = false;
  const handlerTimer = setTimeout(() => {
    handlerTimedOut = true;
    if (!res.headersSent) {
      res.status(504).json({ error: 'DEEP SCANがタイムアウトしました（8分超過）。対象ページの応答が遅い可能性があります。' });
    }
  }, HANDLER_TIMEOUT);

  let browser;
  try {
    const preset = normalizeViewportPreset(viewportPreset);
    console.log(`[Enhanced] Phase 1 検査開始: ${url} (View ${preset})`);
    browser = await getBrowser();
    const page = await browser.newPage();
    await applyViewportPreset(page, preset);

    if (basicAuth && basicAuth.user && basicAuth.pass) {
      await page.authenticate({ username: basicAuth.user, password: basicAuth.pass });
    }

    await page.setDefaultNavigationTimeout(60000);
    await page.goto(url, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1000));

    console.log('[Enhanced] 各検査を実行中...');

    const withTimeout = (fn, ms = 30000) =>
      Promise.race([fn(), new Promise(r => setTimeout(() => r({ status: 'error', message: 'タイムアウト', violations: [] }), ms))]);

    const results = [];

    // 1-1
    results.push(await withTimeout(() => check_1_4_10_reflow(page)));
    // viewport リセット確認
    await applyViewportPreset(page, preset).catch(() => {});

    // 1-2
    results.push(await withTimeout(() => check_2_5_8_target_size(page)));

    // 1-3
    results.push(await withTimeout(() => check_2_1_2_keyboard_trap(page)));

    // ページ再読み込みでキーボード状態リセット
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 1-4
    results.push(await withTimeout(() => check_2_4_1_skip_link(page)));

    // 1-5 SC 2.3.3 は AAA のみ → aaaBeta オフ時はスキップ
    if (includeAAA) results.push(await withTimeout(() => check_2_3_3_animation(page)));

    // 1-6
    results.push(await withTimeout(() => check_1_4_12_text_spacing(page)));

    // ページ再読み込み（スタイルリセット）
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 1-7 (2つの結果を返す)
    const focusObscured = await withTimeout(() => check_2_4_11_12_focus_obscured(page));
    if (Array.isArray(focusObscured)) results.push(...focusObscured);
    else results.push(focusObscured);

    // ページ再読み込み
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 1-8
    results.push(await withTimeout(() => check_3_2_1_2_unexpected_change(page)));

    // ページ再読み込み
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 1-9
    results.push(await withTimeout(() => check_3_3_1_error_identification(page)));

    // ページ再読み込み（Phase 2用）
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // --- Phase 2 ---
    console.log('[Enhanced] Phase 2 検査中...');

    // 2-1
    results.push(await withTimeout(() => check_2_1_1_keyboard_operable(page)));

    // 2-2 (2つの結果)
    const focusVisible = await withTimeout(() => check_2_4_7_focus_visible(page));
    if (Array.isArray(focusVisible)) results.push(...focusVisible);
    else results.push(focusVisible);

    // ページ再読み込み（フォーカス状態リセット）
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 2-3
    results.push(await withTimeout(() => check_2_4_3_focus_order(page)));

    // ページ再読み込み
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 2-4
    results.push(await withTimeout(() => check_1_4_4_text_resize(page)));

    // 2-5
    results.push(await withTimeout(() => check_1_2_x_media_captions(page)));

    // 2-6
    results.push(await withTimeout(() => check_2_2_2_pause_stop(page)));

    // 2-7
    results.push(await withTimeout(() => check_3_3_8_accessible_authentication(page)));

    // 2-8 (SC 2.3.1)
    results.push(await withTimeout(() => check_2_3_1_three_flashes(page)));

    // ページ再読み込み（Phase 3用）
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // --- Phase 3 ---
    console.log('[Enhanced] Phase 3 検査中...');

    // 3-1
    results.push(await withTimeout(() => check_1_4_13_hover_content(page)));

    // ページ再読み込み
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 3-2
    results.push(await withTimeout(() => check_1_4_1_use_of_color(page)));

    // 3-3
    results.push(await withTimeout(() => check_1_4_5_images_of_text(page)));

    // 3-4
    results.push(await withTimeout(() => check_2_2_1_timing_adjustable(page)));

    // 3-5
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    results.push(await withTimeout(() => check_3_3_3_error_suggestion(page)));

    // 3-6
    results.push(await withTimeout(() => check_2_5_1_7_gestures(page)));

    // ページ再読み込み（Section A用）
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // --- Section A: 新規チェック (A/AA) ---
    console.log('[Enhanced] Section A 新規チェック中...');

    results.push(await withTimeout(() => check_2_5_3_label_in_name(page)));
    results.push(await withTimeout(() => check_1_3_4_orientation(page)));
    results.push(await withTimeout(() => check_1_3_5_input_purpose(page)));
    results.push(await withTimeout(() => check_2_5_2_pointer_cancellation(page)));
    results.push(await withTimeout(() => check_2_5_4_motion_actuation(page)));
    results.push(await withTimeout(() => check_3_2_6_consistent_help(page)));
    results.push(await withTimeout(() => check_3_3_7_redundant_entry(page)));
    results.push(await withTimeout(() => check_2_4_4_link_purpose(page)));
    results.push(await withTimeout(() => check_aria_attributes(page)));

    await page.close();

    // AAA フィルタリング（includeAAA が false の場合は AAA SC を除外）
    const finalResults = includeAAA
      ? results
      : results.filter(r => !AAA_SC_LIST.has(r.sc));

    console.log(`[Enhanced] 完了: ${finalResults.length}基準を検査 (includeAAA:${!!includeAAA})`);
    if (!handlerTimedOut) res.json({ success: true, url, viewportPreset: preset, results: finalResults, includeAAA: !!includeAAA, checkedAt: new Date().toISOString() });

  } catch (error) {
    console.error('[Enhanced] Error:', error);
    if (!handlerTimedOut && !res.headersSent) res.status(500).json({ error: error.message });
  } finally {
    clearTimeout(handlerTimer);
    if (browser) await browser.close();
  }
});

/**
 * AI評価 API
 */
app.post('/api/ai-evaluate', async (req, res) => {
  const { url, checkItems, viewportPreset } = req.body;
  const safeCheckItems = Array.isArray(checkItems) ? checkItems : [];
  const fallbackSuggestion = 'Gemini API設定後に再実行してください';
  const makeFallbackResults = (reason) => {
    return safeCheckItems.map((_, index) => ({
      index,
      status: 'manual_required',
      confidence: 0.3,
      reason,
      suggestion: fallbackSuggestion
    }));
  };
  const normalizeStatus = (status) => {
    if (status === 'pass' || status === 'fail' || status === 'not_applicable' || status === 'manual_required') {
      return status;
    }
    return 'manual_required';
  };

  if (!url) {
    return res.status(400).json({ error: 'URLを指定してください' });
  }
  if (safeCheckItems.length === 0) {
    return res.json({ success: true, model: GEMINI_MODEL, results: [] });
  }
  if (!GEMINI_API_KEY) {
    const reason = 'GEMINI_API_KEY が未設定のため自動評価をスキップしました';
    console.warn('[AI] ' + reason);
    return res.json({ success: true, model: 'manual-fallback', fallback: true, reason, results: makeFallbackResults(reason) });
  }

  let browser;

  try {
    const preset = normalizeViewportPreset(viewportPreset);
    console.log(`[${GEMINI_MODEL}] AI評価開始: ${url} (View ${preset})`);
    browser = await getBrowser();
    const page = await browser.newPage();
    
    // タイムアウト延長
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);
    
    await applyViewportPreset(page, preset);
    
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

    const itemsList = safeCheckItems.map((item, i) =>
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

全${safeCheckItems.length}項目を評価してください。`;

    console.log('Gemini API 呼び出し中...');
    let aiResponse = '';
    try {
      aiResponse = await callGeminiAPI(prompt, screenshot);
    } catch (apiError) {
      const reason = `AIサービスに接続できないため手動確認へフォールバックしました: ${apiError.message}`;
      console.warn('[AI] ' + reason);
      return res.json({ success: true, model: 'manual-fallback', fallback: true, reason, results: makeFallbackResults(reason) });
    }
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

    const byIndex = new Map();
    results.forEach((result) => {
      const idx = Number(result.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= safeCheckItems.length) return;
      byIndex.set(idx, {
        index: idx,
        status: normalizeStatus(result.status),
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
        reason: result.reason || 'AIの判断理由が未取得です',
        suggestion: result.suggestion || ''
      });
    });

    const normalizedResults = safeCheckItems.map((_, idx) => {
      return byIndex.get(idx) || {
        index: idx,
        status: 'manual_required',
        confidence: 0.3,
        reason: 'AI応答に該当結果が無かったため、手動確認が必要です',
        suggestion: '再実行するか手動で確認してください'
      };
    });

    res.json({ success: true, model: GEMINI_MODEL, results: normalizedResults });

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
 * GoogleSheetExport API
 * body: { pages: [{ url, rows, timestamp, stats }] }
 * 構成: 表紙シート + 1URLあたり1シート（PC+SP 統合済み）
 * 列(11列): No, 検査種別, SC, 検査項目, 適合レベル, 結果, 場所, 検出数, 重要度, 詳細, 改善案
 * PC+SP 時は rows に「＜PC VIEW＞」「＜SP VIEW＞」区切り行が含まれる
 * stats は computeRowStats() によるレポート行の実数値（表紙集計と一致）
 */
app.post('/api/export-report', async (req, res) => {
  const { pages } = req.body;
  if (!pages || pages.length === 0) {
    return res.status(400).json({ error: 'レポートデータがありません' });
  }

  try {
    const saKey = loadServiceAccountKey();
    if (!saKey) return res.status(400).json({ error: 'Google Service Account未設定' });

    const token = await getGoogleAccessToken(saKey);
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const reportFolder = REPORT_FOLDER_ID || GOOGLE_DRIVE_FOLDER_ID;
    let spreadsheetId = null;
    if (reportFolder) {
      const query = `'${reportFolder}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and name contains 'レポート' and trashed=false`;
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=createdTime desc&pageSize=1`,
        { headers }
      );
      const searchData = await searchRes.json();
      if (searchData.files?.length > 0) {
        spreadsheetId = searchData.files[0].id;
        console.log(`[Report] 既存スプレッドシート: "${searchData.files[0].name}"`);
      }
    }
    if (!spreadsheetId) spreadsheetId = await getOrCreateSpreadsheet(token, saKey.client_email);

    const now = new Date();
    const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '');
    const COL = 11; // 列数

    // --- 結果シートを順次作成 ---
    const pageTabInfo = []; // { url, sheetId, title, stats }

    for (const page of pages) {
      let tabLabel;
      try {
        const u = new URL(page.url);
        tabLabel = (u.hostname + u.pathname).replace(/[\/\\?*[\]:]/g, '_').replace(/%20/g, '_').replace(/_+/g, '_').replace(/_$/, '').substring(0, 50);
      } catch { tabLabel = page.url.replace(/[^\w.-]/g, '_').substring(0, 50); }

      // 同名シートが存在する場合は suffix を付けて回避
      let sheetTitle = `${tabLabel}_${dateStr}_${timeStr}`;
      let addData, addRes;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateTitle = attempt === 0 ? sheetTitle : `${sheetTitle}_${attempt + 1}`;
        addRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: 'POST', headers,
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: candidateTitle } } }] })
        });
        addData = await addRes.json();
        if (addRes.ok) { sheetTitle = candidateTitle; break; }
        const errMsg = addData.error?.message || '';
        if (!errMsg.includes('already exists')) throw new Error(`シート追加失敗: ${errMsg}`);
        console.warn(`[Report] シート名重複、リトライ (attempt ${attempt + 1}): "${candidateTitle}"`);
      }
      if (!addRes.ok) throw new Error(`シート追加失敗: ${addData.error?.message}`);
      const newSheetId = addData.replies[0].addSheet.properties.sheetId;

      // 1行目: カラムヘッダーのみ（メタ情報は表紙に移動）
      const sheetRows = [
        ['No', '検査種別', 'SC', '検査項目', '適合レベル', '結果', '場所', '検出数', '重要度', '詳細', '改善案'],
        ...page.rows
      ];

      const writeRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheetTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', headers, body: JSON.stringify({ values: sheetRows }) }
      );
      const writeData = await writeRes.json();
      if (writeData.error) throw new Error(`書き込み失敗: ${writeData.error.message}`);

      // 書式設定
      const resultColIdx = 5; // F列（結果）
      const formatReqs = [
        // ヘッダー行
        { repeatCell: {
          range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COL },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
            horizontalAlignment: 'CENTER'
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
        }},
        // 列幅: No, 検査種別, SC, 検査項目, 適合レベル, 結果, 場所, 検出数, 重要度, 詳細, 改善案
        ...[50,70,70,240,70,70,180,60,70,280,220].map((px, i) => ({
          updateDimensionProperties: {
            range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: px }, fields: 'pixelSize'
          }
        })),
        // 結果列の条件付き書式（データ行: startRowIndex: 1）
        ...[ ['不合格', { red: 0.96, green: 0.8, blue: 0.8 }, { red: 0.7, green: 0, blue: 0 }],
             ['合格',   { red: 0.8, green: 0.94, blue: 0.8 }, { red: 0, green: 0.4, blue: 0 }],
             ['判定不能', { red: 1, green: 0.95, blue: 0.8 },  { red: 0.6, green: 0.4, blue: 0 }],
             ['未検証', { red: 0.93, green: 0.93, blue: 0.93 }, { red: 0.4, green: 0.4, blue: 0.4 }],
             ['該当なし', { red: 0.95, green: 0.95, blue: 0.95 }, { red: 0.6, green: 0.6, blue: 0.6 }],
             ['対象外',   { red: 0.95, green: 0.95, blue: 0.95 }, { red: 0.6, green: 0.6, blue: 0.6 }]
        ].map(([val, bg, fg], idx) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId: newSheetId, startRowIndex: 1, startColumnIndex: resultColIdx, endColumnIndex: resultColIdx + 1 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: val }] },
                format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: val === '不合格' || val === '合格' } }
              }
            }, index: idx
          }
        })),
        // フリーズ（1行）
        { updateSheetProperties: {
          properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount'
        }}
      ];

      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers, body: JSON.stringify({ requests: formatReqs })
      });

      pageTabInfo.push({ url: page.url, sheetId: newSheetId, title: sheetTitle, stats: page.stats || {} });
      console.log(`[Report] 結果シート作成: "${sheetTitle}"`);
    }

    // --- 表紙シート作成 ---
    const coverTitle = `表紙_${dateStr}_${timeStr}`;
    const addCoverRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: coverTitle } } }] })
    });
    const addCoverData = await addCoverRes.json();
    if (!addCoverRes.ok) throw new Error(`表紙シート追加失敗: ${addCoverData.error?.message}`);
    const coverSheetId = addCoverData.replies[0].addSheet.properties.sheetId;

    // 全体集計（新形式: critical/serious/moderate/minor/pass/na/unverified）
    const totalStats = { critical: 0, serious: 0, moderate: 0, minor: 0, pass: 0, na: 0, unverified: 0, fail: 0 };
    pageTabInfo.forEach(p => {
      const s = p.stats;
      // 新形式（buildStats）のフィールドを使用。旧形式フォールバックあり
      if (s.critical !== undefined) {
        totalStats.critical += s.critical || 0;
        totalStats.serious  += s.serious  || 0;
        totalStats.moderate += s.moderate || 0;
        totalStats.minor    += s.minor    || 0;
      } else {
        totalStats.serious += s.fail || 0; // 旧形式のfailはseriousに
      }
      totalStats.pass       += s.pass       || 0;
      totalStats.na         += s.na         || 0;
      totalStats.unverified += s.unverified || 0;
    });
    totalStats.fail = totalStats.critical + totalStats.serious + totalStats.moderate + totalStats.minor;
    // 単ページの場合は passRate をそのまま使用、複数ページは pass/total で算出
    const firstStats = pageTabInfo[0]?.stats || {};
    const totalSC = firstStats.total || (totalStats.pass + totalStats.fail + totalStats.na + totalStats.unverified);
    const overallRate = totalSC > 0 ? Math.round(totalStats.pass / totalSC * 100) : null;
    const inspectionTime = pages[0].timestamp
      ? new Date(pages[0].timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : now.toLocaleString('ja-JP');

    const coverRows = [
      ['アクセシビリティ検査レポート', '', '', '', '', '', '', '', '', ''],
      ['作成日時', inspectionTime, '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', ''],
      ['■ 全体スコア', '', '', '', '', '', '', '', '', ''],
      ['スコア', overallRate !== null ? `${overallRate}%` : '—', '', '', '', '', '', '', '', ''],
      ['緊急', totalStats.critical, '重大', totalStats.serious, '中程度', totalStats.moderate, '軽微', totalStats.minor, '合格', totalStats.pass],
      ['該当なし', totalStats.na, '未検証', totalStats.unverified, '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', ''],
      ['■ ページ別スコア', '', '', '', '', '', '', '', '', ''],
      ['No', 'URL', '緊急', '重大', '中程度', '軽微', '合格', '該当なし', '未検証', 'スコア', '結果シート'],
      ...pageTabInfo.map((p, idx) => {
        const s = p.stats;
        const rate = s.passRate !== undefined ? `${s.passRate}%`
          : (() => { const ch = (s.pass || 0) + (s.fail || 0); return ch > 0 ? `${Math.round((s.pass || 0) / ch * 100)}%` : '—'; })();
        const link = `=HYPERLINK("https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${p.sheetId}","${p.title.replace(/"/g, '""')}")`;
        return [String(idx + 1), p.url, s.critical || 0, s.serious || 0, s.moderate || 0, s.minor || 0, s.pass || 0, s.na || 0, s.unverified || 0, rate, link];
      })
    ];

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${coverTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers, body: JSON.stringify({ values: coverRows }) }
    );

    // 表紙の書式
    const coverFormatReqs = [
      // タイトル行（青背景）
      { repeatCell: {
        range: { sheetId: coverSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.102, green: 0.451, blue: 0.91 }
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor)'
      }},
      { mergeCells: { range: { sheetId: coverSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 }, mergeType: 'MERGE_ALL' }},
      // ■見出し行（セクション）: ■全体スコア=row3, ■ページ別スコア=row8
      ...([3, 8].map(rowIdx => ({
        repeatCell: {
          range: { sheetId: coverSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 11 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: { red: 0.1, green: 0.3, blue: 0.6 } },
            backgroundColor: { red: 0.9, green: 0.93, blue: 0.99 }
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      }))),
      // ページ別ヘッダー行（row10 = index 9）
      { repeatCell: {
        range: { sheetId: coverSheetId, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 11 },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
          horizontalAlignment: 'CENTER'
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
      }},
      // 列幅: No, URL, 緊急, 重大, 中程度, 軽微, 合格, 該当なし, 未検証, スコア, 結果シート
      ...[40, 300, 55, 55, 65, 55, 55, 65, 65, 60, 240].map((px, i) => ({
        updateDimensionProperties: {
          range: { sheetId: coverSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px }, fields: 'pixelSize'
        }
      })),
      // フリーズ（10行目まで）
      { updateSheetProperties: {
        properties: { sheetId: coverSheetId, gridProperties: { frozenRowCount: 10 } },
        fields: 'gridProperties.frozenRowCount'
      }}
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers, body: JSON.stringify({ requests: coverFormatReqs })
    });

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Report] Export完了: ${url} (表紙 + ${pageTabInfo.length}ページ)`);
    res.json({ success: true, spreadsheetId, tabs: [coverTitle, ...pageTabInfo.map(p => p.title)], url });

  } catch (error) {
    console.error('Report Export Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Google Sheets設定確認 API
 */
app.get('/api/sheets-status', async (req, res) => {
  const saved = loadSettings();
  const geminiKey = GEMINI_API_KEY || saved.geminiApiKey || '';
  try {
    const status = await getSheetsConnectivityStatus();
    res.json({
      configured: status.sheetsStatus === STATUS_OK,
      sheetsStatus: status.sheetsStatus,
      sheetsStatusDetail: status.sheetsStatusDetail,
      spreadsheetId: status.spreadsheetId,
      folderId: status.folderId,
      serviceAccount: status.serviceAccount,
      serviceAccountConfigured: status.serviceAccountStatus !== STATUS_NONE,
      driveFolderConfigured: status.driveFolderStatus !== STATUS_NONE,
      serviceAccountStatus: status.serviceAccountStatus,
      driveFolderStatus: status.driveFolderStatus,
      serviceAccountError: status.serviceAccountError,
      driveFolderError: status.driveFolderError,
      geminiConfigured: !!geminiKey,
      aaaBeta: saved.aaaBeta || false
    });
  } catch (e) {
    console.error('[sheets-status] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
server.timeout = 600000;        // 10分（DEEP SCANの最大所要時間に対応）
server.keepAliveTimeout = 600000;
