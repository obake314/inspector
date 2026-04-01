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

/** SC 3.3.1 エラー特定 */
async function check_3_3_1_error_identification(page) {
  try {
    const formInfo = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return null;
      const fields = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      return { found: true, fieldCount: fields.length };
    });

    if (!formInfo) {
      return {
        sc: '3.3.1', name: 'エラー特定',
        status: 'not_applicable', message: 'フォームが見つかりません', violations: []
      };
    }

    // フォームフィールドをクリアしてsubmit
    await page.evaluate(() => {
      const form = document.querySelector('form');
      const fields = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
      for (const f of fields) { f.value = ''; }
      // submit ボタンを探してクリック
      const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    const result = await page.evaluate(() => {
      // エラーの検出
      const ariaInvalid = document.querySelectorAll('[aria-invalid="true"]');
      const alerts = document.querySelectorAll('[role="alert"], [role="alertdialog"]');
      const errorCls = document.querySelectorAll('[class*="error" i], [class*="invalid" i]');

      const errorEls = [...new Set([...ariaInvalid, ...alerts, ...errorCls])].slice(0, 10);
      const violations = [];
      let associatedCount = 0;

      for (const el of errorEls) {
        const text = (el.textContent || '').trim().slice(0, 60);
        // aria-describedby / aria-errormessage 関連付け確認
        const describedById = el.getAttribute('aria-describedby') || el.getAttribute('aria-errormessage');
        const hasAssociation = !!describedById && !!document.getElementById(describedById);
        if (hasAssociation) associatedCount++;
        violations.push({ text, hasAssociation });
      }

      return {
        errorCount: errorEls.length,
        associatedCount,
        violations: violations.map(v => `${v.hasAssociation ? '✓' : '✗関連付けなし'} "${v.text}"`)
      };
    });

    const pass = result.errorCount > 0; // エラーが表示された = エラー特定機能あり
    return {
      sc: '3.3.1', name: 'エラー特定',
      status: pass ? 'pass' : 'fail',
      message: pass
        ? `エラー表示あり（${result.errorCount}件検出、${result.associatedCount}件が適切に関連付け済み）`
        : 'フォーム送信後にエラーメッセージが表示されませんでした（aria-invalid / role=alert 未検出）',
      violations: pass ? result.violations.filter(v => !v.startsWith('✓')) : ['エラーメッセージが表示されない可能性があります']
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

/** SC 2.4.7 フォーカス可視 + SC 2.4.13 フォーカスの外観 */
async function check_2_4_7_focus_visible(page) {
  try {
    const violations27 = [];
    const violations213 = [];
    const maxCheck = 20;

    for (let i = 0; i < maxCheck; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const style = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const label = `${tag}${id}`.slice(0, 50);

        // フォーカスインジケータ確認
        const outline = style.outlineWidth;
        const outlineStyle = style.outlineStyle;
        const boxShadow = style.boxShadow;
        const border = style.borderWidth;
        const bg = style.backgroundColor;

        // outline が none/0 かつ box-shadow もなし = 非表示の可能性
        const outlineW = parseFloat(outline) || 0;
        const hasOutline = outlineStyle !== 'none' && outlineW > 0;
        const hasBoxShadow = boxShadow && boxShadow !== 'none';
        const hasFocusIndicator = hasOutline || hasBoxShadow;

        // SC 2.4.13: outline が 2px 以上か
        const meets213 = outlineW >= 2;

        return { label, hasFocusIndicator, meets213, outlineW };
      });
      if (!info) continue;
      if (!info.hasFocusIndicator) violations27.push(`${info.label} (outline:${info.outlineW}px)`);
      if (!info.meets213) violations213.push(`${info.label} (outline:${info.outlineW}px < 2px)`);
    }

    return [
      {
        sc: '2.4.7', name: 'フォーカス可視（AA）',
        status: violations27.length === 0 ? 'pass' : 'fail',
        message: violations27.length === 0
          ? 'フォーカスインジケータあり（outline/box-shadow）'
          : `${violations27.length}個の要素でフォーカスが不可視の可能性`,
        violations: violations27
      },
      {
        sc: '2.4.13', name: 'フォーカスの外観（AAA）',
        status: violations213.length === 0 ? 'pass' : 'fail',
        message: violations213.length === 0
          ? 'outline-widthが2px以上の要素あり'
          : `${violations213.length}個の要素でoutline-widthが2px未満`,
        violations: violations213
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

/** SC 1.2.1-1.2.5 メディアキャプション */
async function check_1_2_x_media_captions(page) {
  try {
    const result = await page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      const audios = document.querySelectorAll('audio');
      const iframes = document.querySelectorAll('iframe');
      const issues = [];

      for (const v of videos) {
        const tracks = v.querySelectorAll('track[kind="captions"], track[kind="subtitles"]');
        const descTracks = v.querySelectorAll('track[kind="descriptions"]');
        if (tracks.length === 0) issues.push(`video: キャプションtrack欠如 (src: ${(v.src || v.currentSrc || '').slice(0, 50)})`);
        if (descTracks.length === 0) issues.push(`video: 音声解説track欠如`);
      }
      for (const a of audios) {
        // 近接要素に transcript テキストがあるか
        const parent = a.parentElement;
        const hasTranscript = parent && (parent.textContent || '').toLowerCase().includes('transcript');
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

      return {
        videoCount: videos.length,
        audioCount: audios.length,
        iframeCount: iframes.length,
        issues
      };
    });

    if (result.videoCount === 0 && result.audioCount === 0 && result.iframeCount === 0) {
      return {
        sc: '1.2.x', name: 'メディアキャプション（1.2.1-1.2.5）',
        status: 'not_applicable', message: 'video/audio/iframeが存在しません', violations: []
      };
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

/** SC 1.4.1 色だけの情報伝達 */
async function check_1_4_1_use_of_color(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];
      // リンクに下線・太字・その他の視覚的差異があるか確認
      const links = document.querySelectorAll('p a, li a, td a');
      let linksWithoutUnderline = 0;
      for (const link of Array.from(links).slice(0, 30)) {
        const style = getComputedStyle(link);
        const parentStyle = getComputedStyle(link.parentElement);
        const hasUnderline = style.textDecorationLine.includes('underline');
        const hasBold = parseInt(style.fontWeight) >= 700;
        const hasBorder = style.borderBottomWidth !== '0px';
        // 色が親と異なるが下線等なし
        if (!hasUnderline && !hasBold && !hasBorder) {
          linksWithoutUnderline++;
        }
      }
      if (linksWithoutUnderline > 0) {
        issues.push(`テキストリンク ${linksWithoutUnderline}個: 色以外の視覚的差異（下線・太字等）なし — コントラスト比3:1以上が必要`);
      }
      // エラー表示が色のみか
      const errorEls = document.querySelectorAll('[class*="error" i], [aria-invalid="true"]');
      for (const el of errorEls) {
        const hasIcon = el.querySelector('svg, img, [aria-label], [title]');
        if (!hasIcon && !(el.textContent || '').trim()) {
          issues.push(`エラー表示が色のみの可能性: ${el.tagName.toLowerCase()}`.slice(0, 80));
        }
      }
      return issues;
    });

    return {
      sc: '1.4.1', name: '色だけの情報伝達',
      status: result.length === 0 ? 'pass' : 'fail',
      message: result.length === 0
        ? '色以外の視覚的手がかりが確認できます'
        : `${result.length}件: 色のみで情報を伝達している可能性`,
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

/**
 * Phase 1 高精度検査 API
 */
app.post('/api/enhanced-check', async (req, res) => {
  const { url, basicAuth } = req.body;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });

  let browser;
  try {
    console.log(`[Enhanced] Phase 1 検査開始: ${url}`);
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

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
    await page.setViewport({ width: 1280, height: 800 }).catch(() => {});

    // 1-2
    results.push(await withTimeout(() => check_2_5_8_target_size(page)));

    // 1-3
    results.push(await withTimeout(() => check_2_1_2_keyboard_trap(page)));

    // ページ再読み込みでキーボード状態リセット
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 1-4
    results.push(await withTimeout(() => check_2_4_1_skip_link(page)));

    // 1-5
    results.push(await withTimeout(() => check_2_3_3_animation(page)));

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

    await page.close();
    console.log(`[Enhanced] 完了: ${results.length}基準を検査`);
    res.json({ success: true, url, results, checkedAt: new Date().toISOString() });

  } catch (error) {
    console.error('[Enhanced] Error:', error);
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
 * 列: 検査項目番号, 検査項目, 適合レベル, 結果, 場所, 検出数, 詳細, 改善案
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
        ['アクセシビリティ検査レポート', '', '', '', '', '', '', ''],
        ['検査対象URL', page.url, '', '', '', '', '', ''],
        ['検査日時', inspectionTime, '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['検査項目番号', '検査項目', '適合レベル', '結果', '場所', '検出数', '詳細', '改善案'],
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
          range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.102, green: 0.451, blue: 0.91 }
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
          range: { sheetId: newSheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 8 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
            horizontalAlignment: 'CENTER'
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
        }},
        // 列幅設定（8列）
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 60 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 280 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 80 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
          properties: { pixelSize: 80 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
          properties: { pixelSize: 250 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
          properties: { pixelSize: 60 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
          properties: { pixelSize: 350 }, fields: 'pixelSize'
        }},
        { updateDimensionProperties: {
          range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 },
          properties: { pixelSize: 300 }, fields: 'pixelSize'
        }},
        // 結果列（col 3）の条件付き書式：不合格=赤背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '不合格' }] },
              format: { backgroundColor: { red: 0.96, green: 0.8, blue: 0.8 }, textFormat: { foregroundColor: { red: 0.7, green: 0, blue: 0 }, bold: true } }
            }
          }, index: 0
        }},
        // 結果列の条件付き書式：合格=緑背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '合格' }] },
              format: { backgroundColor: { red: 0.8, green: 0.94, blue: 0.8 }, textFormat: { foregroundColor: { red: 0, green: 0.4, blue: 0 }, bold: true } }
            }
          }, index: 1
        }},
        // 結果列の条件付き書式：判定不能=黄背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '判定不能' }] },
              format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 }, textFormat: { foregroundColor: { red: 0.6, green: 0.4, blue: 0 }, bold: true } }
            }
          }, index: 2
        }},
        // 結果列の条件付き書式：未検証=グレー背景
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '未検証' }] },
              format: { backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 }, textFormat: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } }
            }
          }, index: 3
        }},
        // 該当なし=薄いグレー
        { addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId: newSheetId, startRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '該当なし' }] },
              format: { backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 }, textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } }
            }
          }, index: 4
        }},
        // タイトル行をマージ（8列）
        { mergeCells: {
          range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
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
  const saved = loadSettings();
  const geminiKey = saved.geminiApiKey || GEMINI_API_KEY;
  const folderId = saved.driveFolderId || GOOGLE_DRIVE_FOLDER_ID || '';
  res.json({
    configured: !!saKey,
    spreadsheetId: cachedSpreadsheetId || null,
    folderId: folderId || null,
    serviceAccount: saKey ? saKey.client_email : null,
    geminiConfigured: !!geminiKey
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