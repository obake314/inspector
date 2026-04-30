require('dotenv').config();
const express = require('express');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_UPDATE_TARGETS = [
  path.join(__dirname, 'server.js'),
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'public', 'css', 'style.css')
];

function getAppUpdatedAt() {
  // git log から最終コミット日時を取得（デプロイ方法に依存しない）
  try {
    const { execSync } = require('child_process');
    const dateStr = execSync('git log -1 --format=%ci', { cwd: __dirname, timeout: 3000 }).toString().trim();
    if (dateStr) return new Date(dateStr);
  } catch (_) {}
  // fallback: ファイルの mtime
  let latest = null;
  APP_UPDATE_TARGETS.forEach(filePath => {
    try {
      const stat = fs.statSync(filePath);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = stat;
    } catch (_) {}
  });
  return latest ? latest.mtime : null;
}

function formatAppUpdatedLabel(date) {
  if (!date) return 'LAST UPDATE : -';
  return `LAST UPDATE : ${date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
}

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

// AI プロバイダー設定（設定ファイル → 環境変数の優先順位）
// aiProvider: 'gemini' | 'gemini-pro' | 'claude-sonnet' | 'claude-opus' | 'gpt-4o' | 'o3' | 'gpt-5'
let AI_PROVIDER = savedSettings.aiProvider || process.env.AI_PROVIDER || 'gemini';

// 全モデルマップ
const AI_MODEL_MAP = {
  'gemini':        'gemini-2.5-flash',
  'gemini-pro':    'gemini-2.5-pro',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-opus':   'claude-opus-4-6',
  'gpt-4o':        'gpt-4o',
  'o3':            'o3',
  'gpt-5':         'gpt-5',
};

const AI_MAX_OUTPUT_TOKENS = 8192;
// Gemini 2.5 Pro は思考トークンが出力トークン枠に含まれるため多めに確保する
const AI_MAX_OUTPUT_TOKENS_BY_MODEL = {
  'gemini-2.5-pro': 32768,
};

function compactErrorMessage(error, maxLength = 700) {
  const raw = error?.message || String(error || '');
  const compact = raw
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function getAIErrorMeta(error) {
  const nested = error?.error && typeof error.error === 'object' ? error.error : {};
  const headers = error?.headers || error?.response?.headers || {};
  const headerRequestId = typeof headers.get === 'function'
    ? headers.get('x-request-id')
    : (headers['x-request-id'] || headers['X-Request-Id']);
  return {
    status: Number(error?.status || error?.statusCode || error?.response?.status || 0),
    code: String(error?.code || nested.code || ''),
    apiErrorType: String(error?.type || nested.type || ''),
    param: String(error?.param || nested.param || ''),
    requestId: String(error?.request_id || error?.requestID || error?.requestId || headerRequestId || ''),
    clientRequestId: String(error?.clientRequestId || ''),
    requestedModel: String(error?.requestedModel || ''),
    tokenParam: String(error?.tokenParam || '')
  };
}

function buildAICauseHint(provider, info) {
  const message = info.message || '';
  const isOpenAI  = provider === 'o3' || (provider && provider.startsWith('gpt'));
  const isGemini  = provider === 'gemini' || provider === 'gemini-pro';
  const isClaude  = provider === 'claude-sonnet' || provider === 'claude-opus';
  const providerName = isOpenAI ? 'OpenAI' : isGemini ? 'Google AI (Gemini)' : isClaude ? 'Anthropic (Claude)' : 'AI';
  const billingUrl  = isOpenAI ? 'https://platform.openai.com/usage'
    : isGemini ? 'https://ai.dev/rate-limit'
    : isClaude ? 'https://console.anthropic.com/settings/billing'
    : '';
  if (info.modelUnavailable) {
    return isOpenAI
      ? '選択したOpenAIモデルに現在のAPIキー/プロジェクト/利用Tierでアクセスできません。GPT-5はOpenAI APIのFree Tierでは利用できないため、請求設定とプロジェクト権限を確認してください。'
      : isGemini
        ? '選択したGeminiモデルにアクセスできません。Gemini 2.5 ProはFree Tierでは利用できません。Google AI StudioでPay-as-you-goへのアップグレードを確認してください。'
        : '選択したモデルにアクセスできません。モデル名、APIキーの権限、利用Tierを確認してください。';
  }
  if (info.authFailed) {
    return `APIキーが無効、期限切れ、または対象プロジェクトで許可されていません。設定パネルの${providerName}キーを確認してください。`;
  }
  if (info.rateLimited || info.quotaExceeded || /insufficient_quota|billing|balance/i.test(message)) {
    const urlText = billingUrl ? ` ${billingUrl} で使用状況を確認してください。` : '';
    return isGemini
      ? `Gemini APIの無料枠上限に達しました（limit: 0 はFree Tier非対応モデル）。gemini-flash（無料枠あり）に切り替えるか、Google AI StudioでPay-as-you-goを有効化してください。${urlText}`
      : `${providerName} APIのレート制限、クォータ不足、または課金/残高不足です。時間を置くか、${urlText}`;
  }
  if (/unsupported parameter|unknown parameter|not supported/i.test(message) || info.param) {
    const paramText = info.param || info.tokenParam || '送信パラメータ';
    return `${paramText} が選択モデルで非対応の可能性があります。GPT-5/o系は max_completion_tokens を使う必要があります。`;
  }
  if (/context_length|maximum context|too many tokens|token/i.test(message)) {
    return '入力HTML、画像、または出力上限がモデルのトークン制限に近い可能性があります。対象項目やHTML量を減らして再実行してください。';
  }
  if (/timeout|timed out|network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return `${providerName} APIへのネットワーク接続またはタイムアウトです。通信状態を確認して再実行してください。`;
  }
  return `${providerName} APIからエラーが返っています。status/code/param/requestIdを確認してください。`;
}

function classifyAIError(error, provider = '') {
  const message = compactErrorMessage(error);
  const meta = getAIErrorMeta(error);
  const status = meta.status;
  const code = meta.code;
  const rateLimited = status === 429
    || code === 'rate_limit_exceeded'
    || /429|too many requests|rate.?limit|quota/i.test(message);
  const quotaExceeded = /quota|insufficient_quota|billing|balance|GenerateRequests|GenerateContentInputTokens|free_tier/i.test(message);
  const modelUnavailable = status === 404
    || /model.*(not found|does not exist|not available|unsupported|access|permission)/i.test(message)
    || /(unsupported|invalid).{0,24}model/i.test(message)
    || /model_not_found/i.test(code);
  const authFailed = status === 401 || status === 403 || /api key|permission|unauthorized|authentication/i.test(message);
  const retryMatch = message.match(/retry(?:Delay| in)?["\s:]*([\d.]+)s/i);
  const retryAfterSeconds = retryMatch ? Number(retryMatch[1]) : null;
  const aiErrorType = modelUnavailable ? 'model_unavailable'
    : rateLimited ? 'api_error'
    : authFailed ? 'api_error'
    : 'api_error';
  const detailLabel = modelUnavailable ? 'モデル利用不可'
    : quotaExceeded ? 'APIクォータ不足'
    : rateLimited ? 'APIレート制限'
    : authFailed ? 'API認証エラー'
    : 'APIエラー';
  const info = { aiErrorType, detailLabel, status, rateLimited, quotaExceeded, authFailed, modelUnavailable, retryAfterSeconds, message, ...meta };
  info.causeHint = buildAICauseHint(provider, info);
  return info;
}

function buildAIErrorResponse(error, provider, requestedModel = provider) {
  if (requestedModel && !error.requestedModel) error.requestedModel = requestedModel;
  const info = classifyAIError(error, provider);
  const retryText = info.retryAfterSeconds ? ` ${Math.ceil(info.retryAfterSeconds)}秒後に再試行できます。` : '';
  const diagnosticParts = [
    info.status ? `status=${info.status}` : '',
    info.code ? `code=${info.code}` : '',
    info.apiErrorType ? `type=${info.apiErrorType}` : '',
    info.param ? `param=${info.param}` : '',
    info.requestedModel ? `model=${info.requestedModel}` : '',
    info.requestId ? `requestId=${info.requestId}` : '',
    info.clientRequestId ? `clientRequestId=${info.clientRequestId}` : ''
  ].filter(Boolean);
  const diagnosticText = diagnosticParts.length ? ` 診断情報: ${diagnosticParts.join(' / ')}` : '';
  const hintText = info.causeHint ? ` 原因候補: ${info.causeHint}` : '';
  const errorMessage = `${info.detailLabel}のためMULTI SCANを実行できませんでした。${retryText}${hintText} ${info.message}${diagnosticText}`;
  const httpStatus = info.modelUnavailable ? 404 : info.rateLimited ? 429 : info.authFailed ? 401 : 502;
  return {
    httpStatus,
    payload: {
      success: false,
      model: info.requestedModel || requestedModel || provider,
      provider,
      error: errorMessage,
      aiErrorType: info.aiErrorType,
      detailLabel: info.detailLabel,
      causeHint: info.causeHint,
      status: info.status || undefined,
      code: info.code || undefined,
      errorType: info.apiErrorType || undefined,
      param: info.param || undefined,
      requestId: info.requestId || undefined,
      clientRequestId: info.clientRequestId || undefined,
      rateLimited: info.rateLimited,
      quotaExceeded: info.quotaExceeded,
      modelUnavailable: info.modelUnavailable,
      retryAfterSeconds: info.retryAfterSeconds
    }
  };
}

function buildAIJsonParseErrorResponse(model, responseText) {
  const preview = String(responseText || '').slice(0, 500);
  return {
    success: false,
    model,
    error: `JSON解析失敗のためMULTI SCAN結果を取得できませんでした。AI応答が指定形式のJSON配列ではありません。応答先頭: ${preview || '（空）'}`,
    aiErrorType: 'json_parse_failed',
    detailLabel: 'JSON解析失敗',
    parseFailed: true,
    responsePreview: preview
  };
}

// Gemini API設定
let GEMINI_API_KEY = savedSettings.geminiApiKey || process.env.GEMINI_API_KEY || '';
let genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'placeholder');

// Anthropic API設定
let ANTHROPIC_API_KEY = savedSettings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
let anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY || 'placeholder' });

// OpenAI API設定
let OPENAI_API_KEY = savedSettings.openaiApiKey || process.env.OPENAI_API_KEY || '';
let openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY || 'placeholder' });

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
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
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
 * Gemini Flash / Pro APIを呼び出す関数
 */
async function callGeminiAPI(prompt, imageBase64 = null, modelKey = 'gemini') {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が設定されていません');
  const modelId = AI_MODEL_MAP[modelKey] || AI_MODEL_MAP['gemini'];

  const maxTokens = AI_MAX_OUTPUT_TOKENS_BY_MODEL[modelId] || AI_MAX_OUTPUT_TOKENS;
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens }
  });

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: imageBase64 }
    });
  }

  const result = await model.generateContent({ contents: [{ role: "user", parts }] });
  const response = await result.response;
  const finishReason = response.candidates?.[0]?.finishReason;
  const tokenLimited = finishReason === 'MAX_TOKENS';
  return { text: response.text(), tokenLimited };
}

/**
 * Claude Opus / Sonnet APIを呼び出す関数
 */
async function callClaudeAPI(prompt, imageBase64 = null, modelKey = 'claude-sonnet') {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  const modelId = AI_MODEL_MAP[modelKey] || AI_MODEL_MAP['claude-sonnet'];

  const contentParts = [];
  if (imageBase64) {
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
    });
  }
  contentParts.push({ type: 'text', text: prompt });

  const message = await anthropicClient.messages.create({
    model: modelId,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: contentParts }]
  });

  const tokenLimited = message.stop_reason === 'max_tokens';
  return { text: message.content[0].text, tokenLimited };
}

/**
 * OpenAI APIを呼び出す関数
 */
async function callOpenAIAPI(prompt, imageBase64 = null, modelKey = 'gpt-4o') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY が設定されていません');
  const modelId = AI_MODEL_MAP[modelKey] || AI_MODEL_MAP['gpt-4o'];

  const userContent = [];
  if (imageBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' }
    });
  }
  userContent.push({ type: 'text', text: prompt });

  // o系/GPT-5系は reasoning token を含む max_completion_tokens を使う。
  const usesMaxCompletionTokens = modelId === 'o3'
    || modelId.startsWith('o1')
    || /^gpt-5(?:[.\-]|$)/i.test(modelId);
  const tokenParam = usesMaxCompletionTokens
    ? { max_completion_tokens: AI_MAX_OUTPUT_TOKENS }
    : { max_tokens: AI_MAX_OUTPUT_TOKENS };
  const tokenParamName = Object.keys(tokenParam)[0];
  const clientRequestId = crypto.randomUUID();

  // OpenAI 系は json_object モードで確実に JSON を返させる。
  // プロンプト側で {"results":[...]} ラッパーを要求し、抽出側で配列を取り出す。
  const systemMessages = [{ role: 'system', content: 'Respond ONLY with valid JSON in the format {"results":[...]}. No markdown fences, no explanation.' }];
  const responseFormatParam = { response_format: { type: 'json_object' } };

  let completion;
  try {
    completion = await openaiClient.chat.completions.create({
      model: modelId,
      ...tokenParam,
      ...responseFormatParam,
      messages: [...systemMessages, { role: 'user', content: userContent }]
    }, {
      headers: { 'X-Client-Request-Id': clientRequestId }
    });
  } catch (error) {
    error.requestedModel = modelId;
    error.tokenParam = tokenParamName;
    error.clientRequestId = clientRequestId;
    throw error;
  }

  const tokenLimited = completion.choices[0].finish_reason === 'length';
  return { text: completion.choices[0].message.content, tokenLimited };
}

/**
 * 現在のAIプロバイダー設定に応じてAPIを呼び出す統合関数
 * @returns { text: string, modelName: string }
 */
async function callAI(prompt, imageBase64 = null) {
  const provider = AI_PROVIDER || 'gemini';
  const modelName = AI_MODEL_MAP[provider] || AI_MODEL_MAP['gemini'];

  if (provider === 'claude-sonnet' || provider === 'claude-opus') {
    const { text, tokenLimited } = await callClaudeAPI(prompt, imageBase64, provider);
    return { text, modelName, tokenLimited };
  }
  if (provider === 'gpt-4o' || provider === 'o3' || provider === 'gpt-5') {
    const { text, tokenLimited } = await callOpenAIAPI(prompt, imageBase64, provider);
    return { text, modelName, tokenLimited };
  }
  // Gemini Flash / Pro
  const { text, tokenLimited } = await callGeminiAPI(prompt, imageBase64, provider);
  return { text, modelName, tokenLimited };
}

app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  if (req.url.startsWith('/axe/api/')) {
    req.url = req.url.slice('/axe'.length);
  }
  next();
});
// 直近のAIレスポンス（デバッグ用）
let _lastAiDebug = null;

/** GET /api/last-ai-debug — 直近のMULTI CHECKでAIが返した生テキストを返す */
app.get('/api/last-ai-debug', (req, res) => {
  if (!_lastAiDebug) return res.json({ message: 'まだAI呼び出しがありません' });
  res.json(_lastAiDebug);
});

/**
 * 認証API
 */
app.get('/api/auth-status', (req, res) => {
  const appUpdatedAt = getAppUpdatedAt();
  res.json({
    passwordRequired: !!APP_PASSWORD_HASH,
    appUpdatedAt: appUpdatedAt ? appUpdatedAt.toISOString() : null,
    appUpdatedLabel: formatAppUpdatedLabel(appUpdatedAt)
  });
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

/** パスワードリセット — ワンタイムトークン方式 */
// トークンはメモリのみに保持（再起動で無効化）
let _resetToken = null;       // { token, expiresAt }
const RESET_TOKEN_TTL = 5 * 60 * 1000; // 5分

// Step1: トークン発行 → サーバーコンソールに出力
app.post('/api/request-reset', (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  _resetToken = { token, expiresAt: Date.now() + RESET_TOKEN_TTL };
  console.log('\n' + '='.repeat(60));
  console.log('[PASSWORD RESET] リセットトークンが発行されました');
  console.log(`  トークン: ${token}`);
  console.log(`  有効期限: 5分間`);
  console.log('='.repeat(60) + '\n');
  res.json({ success: true });
});

// Step2: トークン + 新パスワードでリセット実行
app.post('/api/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!_resetToken || Date.now() > _resetToken.expiresAt) {
    _resetToken = null;
    return res.status(400).json({ error: 'トークンが無効または期限切れです。再度トークンを発行してください' });
  }
  if (token !== _resetToken.token) {
    return res.status(401).json({ error: 'トークンが正しくありません' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'パスワードは4文字以上で入力してください' });
  }
  const saved = loadSettings();
  saved.passwordHash = hashPassword(newPassword);
  APP_PASSWORD_HASH = saved.passwordHash;
  saveSettingsFile(saved);
  _resetToken = null; // 使い捨て
  console.log('[Auth] パスワードをリセットしました');
  res.json({ success: true });
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
    anthropicApiKey: saved.anthropicApiKey ? '********' + (saved.anthropicApiKey.slice(-4)) : '',
    openaiApiKey: saved.openaiApiKey ? '********' + (saved.openaiApiKey.slice(-4)) : '',
    aiProvider: saved.aiProvider || AI_PROVIDER || 'gemini',
    serviceAccountKey: saved.serviceAccountKey ? '(設定済み)' : '',
    driveFolderId: saved.driveFolderId || GOOGLE_DRIVE_FOLDER_ID || '',
    reportFolderId: saved.reportFolderId || REPORT_FOLDER_ID || '',
    hasPassword: !!APP_PASSWORD_HASH,
    // AAA βは一時停止中。再開時はフロントUIと同時に戻す。
    // aaaBeta: saved.aaaBeta || false,
    aaaBeta: false,
    // 環境変数フォールバックの表示
    envGemini: !!process.env.GEMINI_API_KEY,
    envAnthropic: !!process.env.ANTHROPIC_API_KEY,
    envOpenAI: !!process.env.OPENAI_API_KEY,
    envServiceAccount: !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
    envFolder: !!process.env.GOOGLE_DRIVE_FOLDER_ID
  });
});

/**
 * 設定保存API
 */
app.post('/api/settings-save', (req, res) => {
  const { password, geminiApiKey, anthropicApiKey, openaiApiKey, aiProvider, serviceAccountKey, driveFolderId, reportFolderId, newPassword, aaaBeta } = req.body;
  // パスワード認証
  if (APP_PASSWORD_HASH && hashPassword(password || '') !== APP_PASSWORD_HASH) {
    return res.status(401).json({ error: '認証エラー' });
  }

  const saved = loadSettings();

  // AI プロバイダー選択
  if (aiProvider && Object.keys(AI_MODEL_MAP).includes(aiProvider)) {
    saved.aiProvider = aiProvider;
    AI_PROVIDER = aiProvider;
  }

  // Gemini API Key（マスク値でなければ更新）
  if (geminiApiKey && !geminiApiKey.startsWith('********')) {
    saved.geminiApiKey = geminiApiKey;
    GEMINI_API_KEY = geminiApiKey;
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  // Anthropic API Key（マスク値でなければ更新）
  if (anthropicApiKey && !anthropicApiKey.startsWith('********')) {
    saved.anthropicApiKey = anthropicApiKey;
    ANTHROPIC_API_KEY = anthropicApiKey;
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }

  // OpenAI API Key（マスク値でなければ更新）
  if (openaiApiKey && !openaiApiKey.startsWith('********')) {
    saved.openaiApiKey = openaiApiKey;
    OPENAI_API_KEY = openaiApiKey;
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
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

  // AAA βは一時停止中。保存済みtrueが残らないようfalse固定。
  // if (typeof aaaBeta === 'boolean') {
  //   saved.aaaBeta = aaaBeta;
  // }
  saved.aaaBeta = false;

  saveSettingsFile(saved);
  console.log('[Settings] 設定を保存しました');
  res.json({ success: true });
});

async function detectPageSignals(page) {
  try {
    return await page.evaluate(() => {
      const authKeywordRe = /(log\s?in|sign\s?in|sign\s?up|signin|signup|register|create account|passkey|webauthn|verification code|one[- ]?time code|otp|認証|ログイン|サインイン|新規登録|会員登録|パスワード|パスキー|確認コード|ワンタイム)/i;
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(frame => String(frame.getAttribute('src') || '').trim())
        .filter(Boolean);
      const mediaEmbedCount = iframeSrcs.filter(src =>
        /youtube\.com|youtu\.be|vimeo\.com|soundcloud\.com|spotify\.com\/embed|podcasters\.spotify\.com|player\.fm/i.test(src)
      ).length;
      const formSelector = [
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
        'select',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[role="spinbutton"]'
      ].join(',');
      const audioCount = document.querySelectorAll('audio').length;
      const videoCount = document.querySelectorAll('video').length;
      const formControlCount = document.querySelectorAll(formSelector).length;
      const passwordInputCount = document.querySelectorAll('input[type="password"], input[autocomplete*="current-password"], input[autocomplete*="new-password"]').length;
      const oneTimeCodeInputCount = document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i], input[name*="passcode" i], input[id*="passcode" i]').length;
      const passkeyTriggerCount = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(el => authKeywordRe.test([
          el.textContent || '',
          el.getAttribute('value') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || ''
        ].join(' ')))
        .length;
      const authFormCount = Array.from(document.querySelectorAll('form'))
        .filter(form => authKeywordRe.test([
          form.getAttribute('id') || '',
          form.getAttribute('class') || '',
          form.getAttribute('name') || '',
          form.getAttribute('action') || '',
          form.textContent || ''
        ].join(' ')))
        .length;
      const hasAnyMedia = (audioCount + videoCount + mediaEmbedCount) > 0;
      const hasVideoLikeMedia = (videoCount + mediaEmbedCount) > 0;
      return {
        audioCount,
        videoCount,
        mediaEmbedCount,
        formControlCount,
        passwordInputCount,
        oneTimeCodeInputCount,
        passkeyTriggerCount,
        authFormCount,
        hasAnyMedia,
        hasVideoLikeMedia,
        hasFormControls: formControlCount > 0,
        hasAuthenticationUi: (passwordInputCount + oneTimeCodeInputCount + passkeyTriggerCount + authFormCount) > 0
      };
    });
  } catch (error) {
    return {
      audioCount: 0,
      videoCount: 0,
      mediaEmbedCount: 0,
      formControlCount: 0,
      passwordInputCount: 0,
      oneTimeCodeInputCount: 0,
      passkeyTriggerCount: 0,
      authFormCount: 0,
      hasAnyMedia: false,
      hasVideoLikeMedia: false,
      hasFormControls: false,
      hasAuthenticationUi: false,
      detectionError: error.message
    };
  }
}

function getWcagTagsForLevel(level) {
  const tags = ['wcag2a', 'wcag21a', 'wcag22a'];
  if (level === 'AA' || level === 'AAA') {
    tags.push('wcag2aa', 'wcag21aa', 'wcag22aa');
  }
  if (level === 'AAA') {
    tags.push('wcag2aaa', 'wcag21aaa', 'wcag22aaa');
  }
  return tags;
}

function getColorContrastOverlapTargets(results, limit = 25) {
  const overlapRe = /overlapped by another element|background color could not be determined|背景色を判定できません/i;
  const targets = [];
  const seen = new Set();
  (results?.incomplete || []).forEach(rule => {
    if (rule?.id !== 'color-contrast') return;
    (rule.nodes || []).forEach(node => {
      const text = [
        rule.description, rule.help, node.failureSummary, node.message,
        ...(node.any || []).map(check => check.message),
        ...(node.all || []).map(check => check.message),
        ...(node.none || []).map(check => check.message)
      ].filter(Boolean).join(' ');
      if (!overlapRe.test(text)) return;
      (node.target || []).forEach(selector => {
        if (!selector || seen.has(selector) || targets.length >= limit) return;
        seen.add(selector);
        targets.push({ selector, html: node.html || '', failureSummary: node.failureSummary || '' });
      });
    });
  });
  return targets;
}

function createContrastFallbackRule(kind, nodes, summary) {
  return {
    id: 'color-contrast-overlap-fallback',
    impact: kind === 'fail' ? 'serious' : null,
    tags: ['cat.color', 'wcag2aa', 'wcag143'],
    description: 'BASIC補完: 重なり要素により背景色を判定できなかったテキストのコントラストを再検査',
    help: 'コントラスト（重なり要素補完）',
    helpUrl: '',
    nodes: nodes.map(node => ({
      any: [],
      all: [],
      none: [],
      impact: kind === 'fail' ? 'serious' : null,
      html: node.html || '',
      target: node.target || [],
      failureSummary: summary(node)
    }))
  };
}

async function cleanupContrastOverlapFallbackPatch(page) {
  try {
    await page.evaluate(() => {
      document.getElementById('__a11y_inspector_contrast_overlap_patch__')?.remove();
      document.querySelectorAll('[data-a11y-inspector-contrast-target]').forEach(el => {
        el.removeAttribute('data-a11y-inspector-contrast-target');
      });
    });
  } catch (_) {}
}

async function applyColorContrastOverlapFallback(page, results) {
  const targets = getColorContrastOverlapTargets(results);
  if (!targets.length) return null;

  let prepared = { patched: [], skipped: [] };
  try {
    prepared = await page.evaluate((items) => {
      const STYLE_ID = '__a11y_inspector_contrast_overlap_patch__';
      const ATTR = 'data-a11y-inspector-contrast-target';

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function describe(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return `${tag}${id || cls}${text ? ` "${text}"` : ''}`.slice(0, 120);
      }
      function isUnsafeBlocker(blocker, target) {
        if (!blocker || blocker === document.documentElement || blocker === document.body) return false;
        if (blocker === target || blocker.contains(target) || target.contains(blocker)) return false;
        const style = getComputedStyle(blocker);
        if (style.pointerEvents === 'none') return false;
        if (blocker.getAttribute('aria-hidden') === 'true' || ['presentation', 'none'].includes(blocker.getAttribute('role'))) return false;
        if (blocker.matches('a[href],button,input,select,textarea,iframe,video,audio,canvas,img,svg,object,[role="button"],[role="link"],[role="dialog"]')) return true;
        return String(blocker.textContent || '').replace(/\s+/g, ' ').trim().length > 0;
      }
      function blockersFor(el) {
        const rect = el.getBoundingClientRect();
        const insetX = Math.min(8, Math.max(1, rect.width / 4));
        const insetY = Math.min(8, Math.max(1, rect.height / 4));
        const points = [
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          { x: rect.left + insetX, y: rect.top + insetY },
          { x: rect.right - insetX, y: rect.top + insetY },
          { x: rect.left + insetX, y: rect.bottom - insetY },
          { x: rect.right - insetX, y: rect.bottom - insetY }
        ].filter(p => p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight);
        const blockers = [];
        points.forEach(point => {
          const stack = document.elementsFromPoint(point.x, point.y);
          const targetIndex = stack.findIndex(node => node === el || el.contains(node));
          if (targetIndex < 0) return;
          stack.slice(0, targetIndex).forEach(node => {
            if (!blockers.includes(node)) blockers.push(node);
          });
        });
        return blockers;
      }

      document.getElementById(STYLE_ID)?.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        [${ATTR}="true"] {
          position: relative !important;
          z-index: 2147483000 !important;
          isolation: isolate !important;
        }
      `;
      document.head.appendChild(style);

      const patched = [];
      const skipped = [];
      items.forEach(item => {
        let el = null;
        try {
          el = document.querySelector(item.selector);
        } catch (_) {}
        if (!isVisible(el)) {
          skipped.push({ ...item, reason: '対象要素が見つからない、または非表示です' });
          return;
        }
        const unsafe = blockersFor(el).filter(blocker => isUnsafeBlocker(blocker, el));
        if (unsafe.length) {
          skipped.push({
            ...item,
            reason: `装飾とは断定できない重なり要素があります: ${unsafe.slice(0, 3).map(describe).join(', ')}`
          });
          return;
        }
        el.setAttribute(ATTR, 'true');
        patched.push(item);
      });
      if (!patched.length) style.remove();
      return { patched, skipped };
    }, targets);

    if (!prepared.patched.length) {
      results.contrastOverlapFallback = {
        attempted: targets.length,
        patched: 0,
        skipped: prepared.skipped
      };
      return results.contrastOverlapFallback;
    }

    const retryBuilder = new AxePuppeteer(page);
    prepared.patched.forEach(item => retryBuilder.include(item.selector));
    retryBuilder.withRules('color-contrast');
    const retry = await retryBuilder.analyze();

    const failNodes = (retry.violations || [])
      .filter(rule => rule.id === 'color-contrast')
      .flatMap(rule => rule.nodes || []);
    const passNodes = (retry.passes || [])
      .filter(rule => rule.id === 'color-contrast')
      .flatMap(rule => rule.nodes || []);

    if (failNodes.length) {
      results.violations = results.violations || [];
      results.violations.push(createContrastFallbackRule('fail', failNodes, node => {
        const base = node.failureSummary ? ` / ${node.failureSummary}` : '';
        return `重なり要素を一時補正して再検査しました。コントラスト比が不足しています${base}`;
      }));
    }
    if (passNodes.length) {
      results.passes = results.passes || [];
      results.passes.push(createContrastFallbackRule('pass', passNodes, () => (
        '重なり要素を一時補正して再検査しました。color-contrast は合格です'
      )));
    }

    results.contrastOverlapFallback = {
      attempted: targets.length,
      patched: prepared.patched.length,
      skipped: prepared.skipped,
      passNodes: passNodes.length,
      failNodes: failNodes.length
    };
    return results.contrastOverlapFallback;
  } catch (error) {
    results.contrastOverlapFallback = {
      attempted: targets.length,
      patched: prepared.patched?.length || 0,
      skipped: prepared.skipped || [],
      error: error.message
    };
    return results.contrastOverlapFallback;
  } finally {
    await cleanupContrastOverlapFallbackPatch(page);
  }
}

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
    await page.setCacheEnabled(false);
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
	    const pageSignals = await detectPageSignals(page);

	    const builder = new AxePuppeteer(page);

    // WCAGレベルに応じたタグ設定の実装
    const tags = getWcagTagsForLevel(level);
    builder.withTags(tags);
    
	    const results = await builder.analyze();
	    await applyColorContrastOverlapFallback(page, results);
	    results.pageSignals = pageSignals;
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

    const tags = getWcagTagsForLevel(level);

    // 全URLを並列で検査
    const checkOne = async (url) => {
      let page;
      const runAxe = async () => {
        page = await browser.newPage();
        await applyViewportPreset(page, preset);
        if (basicAuth && basicAuth.user && basicAuth.pass) {
          await page.authenticate({ username: basicAuth.user, password: basicAuth.pass });
        }
        await page.setDefaultNavigationTimeout(60000);
        await page.goto(url, { waitUntil: 'networkidle2' });
        // ページ安定待ち（リダイレクト後の再レンダリングを待つ）
        await new Promise(r => setTimeout(r, 500));
        const pageSignals = await detectPageSignals(page);
        const builder = new AxePuppeteer(page);
        builder.withTags(tags);
        const results = await builder.analyze();
        await applyColorContrastOverlapFallback(page, results);
        results.pageSignals = pageSignals;
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
      };
      try {
        return await runAxe();
      } catch (error) {
        // Page/Frame is not ready: ページ遷移中にaxeが実行された場合は1回リトライ
        if (/not ready|frame.*detach|execution context/i.test(error.message)) {
          console.warn(`[Batch] Page not ready for ${url}, retrying...`);
          try {
            if (page) { try { await page.close(); } catch (_) {} page = null; }
            return await runAxe();
          } catch (retryError) {
            console.error(`[Batch] Retry failed for ${url}:`, retryError.message);
            return { url, success: false, error: retryError.message, navStructure: [] };
          }
        }
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
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            const text = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20);
            overflows.push(`${tag}${id}${cls}${text ? ' "'+text+'"' : ''} (右端:${Math.round(rect.right)}px, はみ出し:${Math.round(rect.right-320)}px)`.slice(0, 100));
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
      // select/textarea はユーザーエージェントがサイズを制御 → WCAG 2.5.8 UA例外
      const selectors = ['a', 'button', 'input:not([type="hidden"])', '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]'];
      const violations = [];
      const seen = new Set();
      const srOnlyPattern = /(^|[\s_-])(sr-only|screen-reader|screenreader|screen-reader-text|visually-hidden|visuallyhidden|visually_hidden|hidden-visually|u-hidden-visually|a11y-hidden|assistive-text|accessible-hidden|reader-only)([\s_-]|$)/i;
      function isScreenReaderOnlyElement(el) {
        let current = el;
        while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
          const marker = [
            current.id,
            current.getAttribute('class'),
            current.getAttribute('data-testid'),
            current.getAttribute('data-test')
          ].filter(Boolean).join(' ');
          if (srOnlyPattern.test(marker)) return true;
          current = current.parentElement;
        }
        return false;
      }
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          // インラインリンク除外（WCAG 2.5.8 Inline例外）
          if (el.tagName === 'A') {
            const cs = getComputedStyle(el);
            // display:inline の <a> はインライン扱い → 例外
            if (cs.display === 'inline') continue;
            // 前後にテキストノードがある場合もインライン
            const parent = el.parentNode;
            const siblings = Array.from(parent.childNodes);
            const idx = siblings.indexOf(el);
            const hasBefore = idx > 0 && siblings[idx - 1].nodeType === 3 && siblings[idx - 1].textContent.trim();
            const hasAfter = idx < siblings.length - 1 && siblings[idx + 1].nodeType === 3 && siblings[idx + 1].textContent.trim();
            if (hasBefore || hasAfter) continue;
            // 高さがline-heightと同程度（20px以下）かつブロック要素でない場合もインライン扱い
            const rect0 = el.getBoundingClientRect();
            const lineH = parseFloat(cs.lineHeight) || 0;
            if (rect0.height > 0 && rect0.height <= 20 && (lineH === 0 || rect0.height <= lineH * 1.2)) continue;
          }
          if (isScreenReaderOnlyElement(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          // input に label が紐付いている場合はラベルがクリック対象 → label サイズを有効ターゲットとして使用
          if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
            const wrappingLabel = el.closest('label');
            const associatedLabel = labelEl || wrappingLabel;
            if (associatedLabel) {
              const labelRect = associatedLabel.getBoundingClientRect();
              if (labelRect.width >= 24 && labelRect.height >= 24) continue;
            }
            // 視覚的に隠されている input（カスタムチェックボックス等）は除外
            const cs = getComputedStyle(el);
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none' ||
                (cs.position === 'absolute' && (parseFloat(cs.width) <= 1 || parseFloat(cs.height) <= 1 || cs.clip !== 'auto' || cs.clipPath !== 'none'))) continue;
          }
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30);
          // ナビゲーション項目パターン: <li><a> の場合、親 <li> の高さが実効的なターゲットサイズとなる
          let effectiveRect = rect;
          if (el.parentElement && el.parentElement.tagName === 'LI') {
            const parentRect = el.parentElement.getBoundingClientRect();
            if (parentRect.height > rect.height) effectiveRect = parentRect;
          }
          if (effectiveRect.width < 24 || effectiveRect.height < 24) {
            const id = el.id ? `#${el.id}` : '';
            const cls = el.getAttribute('class')
              ? '.' + el.getAttribute('class').trim().split(/\s+/).slice(0, 2).join('.')
              : '';
            violations.push({
              selector: `${tag}${id}${cls}`.slice(0, 80),
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
        ? '全インタラクティブ要素が24×24px以上（スクリーンリーダー専用要素を除く）'
        : `${result.length}個の要素がサイズ不足`,
      violations: result.map(v => `${v.selector} [${v.width}×${v.height}px] "${v.text}"`)
    };
  } catch (e) {
    return { sc: '2.5.8', name: 'ターゲットサイズ（24×24px）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.1.2 キーボードトラップなし */
const KEYBOARD_TRAP_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

// Tab をウィジェット内で使う正当なロール（キーボードトラップ検査から除外）
const WIDGET_ROLES_THAT_CAPTURE_TAB = new Set([
  'grid', 'treegrid', 'tree', 'listbox', 'menu', 'menubar',
  'tablist', 'spinbutton', 'slider', 'combobox'
]);

async function getActiveElementSnapshot(page) {
  try {
    return await page.evaluate((widgetRoles) => {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) return null;
      const tag = a.tagName.toLowerCase();
      const id = a.id ? `#${a.id}` : '';
      const cls = a.className && typeof a.className === 'string'
        ? '.' + a.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const text = (a.getAttribute('aria-label') || a.textContent || a.value || '').trim().slice(0, 25);
      // href や text を key に含め、同クラスの複数リンクを区別する（誤検出防止）
      const href = tag === 'a' ? (a.getAttribute('href') || '').replace(/^https?:\/\/[^/]+/, '').slice(-30) : '';
      let inModal = false;
      let isWidget = false;
      let p = a;
      while (p) {
        if (p.getAttribute) {
          if (p.getAttribute('aria-modal') === 'true') { inModal = true; break; }
          const role = p.getAttribute('role') || '';
          if (widgetRoles.includes(role)) { isWidget = true; break; }
        }
        p = p.parentElement;
      }
      // contenteditable は Tab でインデントするため除外
      if (a.isContentEditable) isWidget = true;
      const key = `${tag}${id}${cls}${href}${text ? '_' + text.slice(0, 15) : ''}`.slice(0, 100);
      const display = `${tag}${id}${cls}${text ? ' "' + text + '"' : ''}`.slice(0, 80);
      return { key, display, inModal, isWidget };
    }, [...WIDGET_ROLES_THAT_CAPTURE_TAB]);
  } catch (e) {
    // ナビゲーションによる実行コンテキスト破棄はnullを返して上位に委ねる
    return null;
  }
}

async function pressTabAndCapture(page, { shift = false } = {}) {
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  if (shift) await page.keyboard.up('Shift');
  await new Promise(resolve => setTimeout(resolve, 120));
  return getActiveElementSnapshot(page);
}

async function confirmKeyboardTrap(page, suspectKey) {
  try {
    const current = await getActiveElementSnapshot(page);
    if (!current || current.key !== suspectKey || current.inModal || current.isWidget) return false;
    // Escape で脱出できれば正当なフォーカス管理（ダイアログ等）→ トラップではない
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 60));
    const afterEsc = await getActiveElementSnapshot(page);
    if (afterEsc && afterEsc.key !== suspectKey) return false;
    // Shift+Tab → Tab → Tab の3回すべてで同じ要素に留まる場合のみトラップと確定
    const backward = await pressTabAndCapture(page, { shift: true });
    const restored = await pressTabAndCapture(page);
    const forward  = await pressTabAndCapture(page);
    return !!backward && !!restored && !!forward
      && backward.key === suspectKey
      && restored.key === suspectKey
      && forward.key === suspectKey;
  } catch (_) {
    return false;
  }
}

async function detectKeyboardTrapsByTabbing(page) {
  let focusableCount;
  try {
    focusableCount = await page.evaluate(selector =>
      document.querySelectorAll(selector).length,
      KEYBOARD_TRAP_FOCUSABLE_SELECTOR
    );
  } catch (_) {
    return { focusableCount: 0, traps: [] };
  }
  if (focusableCount <= 1) {
    return { focusableCount, traps: [] };
  }

  // ページ中央をクリックしてからTabを開始（フォーカス管理JSを正常に起動させる）
  try {
    await page.mouse.click(400, 300);
    await new Promise(r => setTimeout(r, 200));
  } catch (_) { /* クリック失敗は無視 */ }

  // フォーカス可能要素数が少ない場合は周回が起きやすいため閾値を上げる
  const cycleGuard = focusableCount <= 5 ? Infinity : focusableCount;
  const maxTabs = Math.min(focusableCount + 20, 60);
  const history = [];
  const traps = [];
  const seenTrapKeys = new Set();
  let tabCount = 0;
  // ナビゲーション検出: 開始前のURLを記録
  const startUrl = page.url ? page.url() : '';
  let nullStreak = 0; // 連続null回数（ナビゲーション発生の代理指標）

  for (let i = 0; i < maxTabs; i++) {
    const el = await pressTabAndCapture(page);

    // nullが3回連続 → ナビゲーションが発生した可能性が高いためループ中断
    if (!el) {
      nullStreak++;
      if (nullStreak >= 3) break;
      continue;
    }
    nullStreak = 0;

    // URLが変わった場合はナビゲーション発生 → ループ中断
    const currentUrl = page.url ? page.url() : '';
    if (startUrl && currentUrl && currentUrl !== startUrl) break;

    tabCount++;
    history.push(el);

    // フォーカス可能要素数を超えてTabしたら周回とみなし終了
    if (tabCount > cycleGuard + 5) break;

    if (history.length < 5) continue;
    const last  = history[history.length - 1];
    const prev  = history[history.length - 2];
    const prev2 = history[history.length - 3];
    const prev3 = history[history.length - 4];
    const prev4 = history[history.length - 5];
    if (last.inModal || last.isWidget) continue;
    // 5回連続で同じ要素に留まった場合のみ疑う
    if (last.key !== prev.key || last.key !== prev2.key || last.key !== prev3.key || last.key !== prev4.key) continue;
    if (seenTrapKeys.has(last.key)) continue;
    const confirmed = await confirmKeyboardTrap(page, last.key);
    if (confirmed) {
      seenTrapKeys.add(last.key);
      traps.push(last.display);
    }
  }

  return { focusableCount, traps };
}

async function check_2_1_2_keyboard_trap(page) {
  try {
    const { traps } = await detectKeyboardTrapsByTabbing(page);

    return {
      sc: '2.1.2', name: 'キーボードトラップなし',
      status: traps.length === 0 ? 'pass' : 'fail',
      message: traps.length === 0
        ? 'キーボードトラップは検出されませんでした'
        : `${traps.length}箇所でキーボードトラップを確認`,
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
      const srOnlyPattern = /(^|[\s_-])(sr-only|screen-reader|screenreader|screen-reader-text|visually-hidden|visuallyhidden|visually_hidden|hidden-visually|u-hidden-visually|a11y-hidden|assistive-text|accessible-hidden|reader-only)([\s_-]|$)/i;
      function isScreenReaderOnlyElement(el) {
        let current = el;
        while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
          const marker = [
            current.id,
            current.getAttribute('class'),
            current.getAttribute('data-testid'),
            current.getAttribute('data-test')
          ].filter(Boolean).join(' ');
          if (srOnlyPattern.test(marker)) return true;
          current = current.parentElement;
        }
        return false;
      }
      for (const el of els) {
        if (el.offsetHeight === 0) continue;
        if (isScreenReaderOnlyElement(el)) continue;
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
        ? 'テキスト間隔を拡張してもコンテンツのクリップなし（スクリーンリーダー専用要素を除く）'
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
      await new Promise(r => setTimeout(r, 80));
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        const parentEl = el.parentElement;
        const ctx = !el.id && parentEl && parentEl !== document.body ? ` in ${parentEl.tagName.toLowerCase()}${parentEl.id ? '#'+parentEl.id : ''}` : '';
        const label = `${tag}${id}${cls}${text ? ' "'+text+'"' : ''}${ctx}`.slice(0, 80);
        const selfStyle = getComputedStyle(el);
        // 2.4.11 の対象は sticky/fixed 要素による遮蔽。
        // フォーカス時に非表示の要素（スキップリンクなど show-on-focus パターン含む）はスキップ。
        const hiddenOnFocus = rect.width === 0
          || rect.height === 0
          || selfStyle.display === 'none'
          || selfStyle.visibility === 'hidden'
          || Number(selfStyle.opacity) === 0;
        if (hiddenOnFocus) return null;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topEls = document.elementsFromPoint(centerX, centerY) || [];
        const fixedEls = topEls.filter(e => {
          if (e === el || el.contains(e) || e.contains(el)) return false;
          const s = getComputedStyle(e);
          if (s.position !== 'fixed' && s.position !== 'sticky') return false;
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          if (Number(s.opacity) === 0) return false;
          if (s.pointerEvents === 'none') return false;
          const hasBg = s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
          const hasBorder = parseFloat(s.borderWidth) > 0;
          if (!hasBg && !hasBorder) return false;
          return true;
        });
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
      if (info.hiddenOnFocus) sc11violations.push(`${info.label}: focus時にも表示されません`);
      else if (info.fullyObscured) sc11violations.push(info.label);
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
  // page.url() はページ遷移後も安全に呼べるPuppeteer組み込みメソッドを使う
  const startUrl = page.url();
  const violations = [];
  let navigated = false;

  // MutationObserver + window.open フック注入
  try {
    await page.evaluate(() => {
      window.__unexpectedChanges = [];
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
    });
  } catch (_) {
    return { sc: '3.2.1/3.2.2', name: 'フォーカス・入力時の予期しない変化', status: 'manual_required', message: 'フック注入失敗のため手動確認が必要', violations: [] };
  }

  // Tab を送出しフォーカス移動中の予期しない変化を観測
  const maxCheck = 20;
  for (let i = 0; i < maxCheck; i++) {
    try {
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 120));
    } catch (_) {
      // キー送出失敗はコンテキスト破棄の可能性 → URL確認して終了
      const currentUrl = page.url();
      if (currentUrl !== startUrl) {
        violations.push(`[SC 3.2.1] フォーカス移動中にページ遷移: ${currentUrl}`);
        navigated = true;
      }
      break;
    }

    // page.url() はナビゲーション後も安全（page.evaluate不要）
    const currentUrl = page.url();
    if (currentUrl !== startUrl) {
      violations.push(`[SC 3.2.1] フォーカス移動でページ遷移: ${currentUrl}`);
      navigated = true;
      break;
    }

    // MutationObserver の記録を取得（コンテキスト生存中のみ）
    try {
      const interim = await page.evaluate(() => {
        const c = (window.__unexpectedChanges || []).slice();
        window.__unexpectedChanges = [];
        return c;
      });
      for (const c of interim) {
        violations.push(`[${c.type}] ${c.detail}`.slice(0, 80));
      }
    } catch (_) {
      // context破棄 → URL変化確認して終了
      const currentUrl2 = page.url();
      if (currentUrl2 !== startUrl) {
        violations.push(`[SC 3.2.1] フォーカス移動中にページ遷移（context破棄）: ${currentUrl2}`);
        navigated = true;
      }
      break;
    }
  }

  // select に値を入力してコンテキスト変化を確認（SC 3.2.2）
  if (!navigated) {
    try {
      await page.evaluate(() => {
        const sel = document.querySelector('select');
        if (sel && sel.options.length > 1) {
          sel.options[1].selected = true;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await new Promise(r => setTimeout(r, 500));

      const afterSelectUrl = page.url();
      if (afterSelectUrl !== startUrl) {
        violations.push(`[SC 3.2.2] select変更でページ遷移: ${afterSelectUrl}`);
      } else {
        // MutationObserver の残存記録を回収
        const final = await page.evaluate(() => {
          const c = (window.__unexpectedChanges || []).slice();
          try { window.__observer.disconnect(); } catch (_) {}
          return c;
        });
        for (const c of final) {
          violations.push(`[${c.type}] ${c.detail}`.slice(0, 80));
        }
      }
    } catch (_) {
      const afterUrl = page.url();
      if (afterUrl !== startUrl) {
        violations.push(`[SC 3.2.2] select変更中にページ遷移: ${afterUrl}`);
      }
    }
  }

  return {
    sc: '3.2.1/3.2.2', name: 'フォーカス・入力時の予期しない変化',
    status: violations.length === 0 ? 'pass' : 'fail',
    message: violations.length === 0
      ? 'フォーカス・入力によるコンテキスト変化は検出されませんでした'
      : `${violations.length}件の予期しない変化を検出`,
    violations
  };
}

/** SC 3.3.1 エラー特定
 *  必須フィールドを持つフォームのみ空送信し、エラー通知の有無を検査する。
 *  checkbox/radio は除外し、class*="error" の過検知を抑制。
 */
async function check_3_3_1_error_identification(page) {
  try {
    // 必須フィールドを持つフォームのみ対象にする
    const targetForms = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('form')).filter(form =>
        form.querySelector(
          'input[required]:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),' +
          'textarea[required], select[required],' +
          'input[aria-required="true"]:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),' +
          'textarea[aria-required="true"], select[aria-required="true"]'
        )
      ).length;
    });

    if (targetForms === 0) {
      // 必須フィールドを持つフォームがない場合は検査不要
      const totalForms = await page.evaluate(() => document.querySelectorAll('form').length);
      return {
        sc: '3.3.1', name: 'エラー特定',
        status: totalForms > 0 ? 'manual_required' : 'not_applicable',
        message: totalForms > 0
          ? `${totalForms}件のフォームは必須フィールドなし。エラー通知は手動確認が必要です`
          : 'フォームが見つかりません',
        violations: []
      };
    }

    // 必須フィールドを空にして送信（checkbox/radio/file は除外）
    await page.evaluate(() => {
      for (const form of document.querySelectorAll('form')) {
        const hasRequired = form.querySelector(
          'input[required]:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),' +
          'textarea[required], select[required],' +
          'input[aria-required="true"]:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),' +
          'textarea[aria-required="true"], select[aria-required="true"]'
        );
        if (!hasRequired) continue;
        const fields = form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]),' +
          'textarea, select'
        );
        for (const f of fields) { f.value = ''; }
        const submitBtn = form.querySelector('[type="submit"], button:not([type="button"]):not([type="reset"])');
        if (submitBtn) submitBtn.click();
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      const errorEls = new Set();

      // aria-invalid="true" — 最も信頼性の高いシグナル
      document.querySelectorAll('[aria-invalid="true"]').forEach(el => errorEls.add(el));

      // role="alert" / "alertdialog" でテキストを持つもの
      document.querySelectorAll('[role="alert"], [role="alertdialog"]').forEach(el => {
        if ((el.textContent || '').trim()) errorEls.add(el);
      });

      // HTML5 ネイティブバリデーション (:invalid 状態の入力フィールド)
      let nativeInvalidCount = 0;
      document.querySelectorAll('input:invalid, textarea:invalid, select:invalid').forEach(el => {
        nativeInvalidCount++;
        errorEls.add(el);
      });

      // フォーム内に限定した具体的なエラークラスパターン
      // 「error」単体は広すぎるため、フォームエラーを明示する複合クラスのみ対象
      const formErrorSelectors = [
        '[class*="error-message" i]', '[class*="error-text" i]',
        '[class*="field-error" i]',   '[class*="form-error" i]',
        '[class*="validation-error" i]', '[class*="input-error" i]',
        '[class*="error__" i]',       '[class*="__error" i]',
        '[data-error]', '[data-validate-error]'
      ].join(',');
      document.querySelectorAll('form').forEach(form => {
        form.querySelectorAll(formErrorSelectors).forEach(el => {
          if ((el.textContent || '').trim()) errorEls.add(el);
        });
      });

      const errorArray = [...errorEls].slice(0, 15);
      let associatedCount = 0;
      const violations = [];
      for (const el of errorArray) {
        const text = (el.textContent || '').trim().slice(0, 60);
        if (!text) continue;
        const refId = el.getAttribute('aria-describedby') || el.getAttribute('aria-errormessage');
        const hasAssociation = !!refId && !!document.getElementById(refId);
        if (hasAssociation) associatedCount++;
        violations.push({ text, hasAssociation });
      }
      return { errorCount: errorArray.length, associatedCount, nativeInvalidCount,
               violations: violations.map(v => `${v.hasAssociation ? '✓' : '✗関連付けなし'} "${v.text}"`) };
    });

    const pass = result.errorCount > 0;
    return {
      sc: '3.3.1', name: 'エラー特定',
      status: pass ? 'pass' : 'fail',
      message: pass
        ? `${targetForms}フォーム検査: エラー通知${result.errorCount}件検出 (${result.associatedCount}件が適切に関連付け済み)`
        : `${targetForms}フォームを空送信したがエラーメッセージが検出されませんでした`,
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
 *  page.keyboard.press('Tab') で実際にTab移動し :focus-visible を正しく評価する
 */
async function check_2_4_7_focus_visible(page) {
  try {
    // --- step1: 未フォーカス時のスタイルを収集 ---
    const preData = await page.evaluate(() => {
      function snap(el) {
        const s = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const id  = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        const parentEl = el.parentElement;
        const ctx = !el.id && parentEl && parentEl !== document.body
          ? ` in ${parentEl.tagName.toLowerCase()}${parentEl.id ? '#' + parentEl.id : ''}` : '';
        return {
          key:   `${tag}${id}${cls}`.slice(0, 60),
          label: `${tag}${id}${cls}${text ? ' "' + text + '"' : ''}${ctx}`.slice(0, 80),
          outlineWidth:  parseFloat(s.outlineWidth) || 0,
          outlineStyle:  s.outlineStyle,
          outlineColor:  s.outlineColor,
          boxShadow:     s.boxShadow,
          backgroundColor: s.backgroundColor,
          borderWidth:   parseFloat(s.borderWidth) || 0,
          borderColor:   s.borderColor
        };
      }
      return Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      }).slice(0, 35).map(snap);
    });

    if (preData.length === 0) {
      return [
        { sc: '2.4.7',  name: 'フォーカス可視（AA）',   status: 'pass', message: 'フォーカス可能要素なし', violations: [] },
        { sc: '2.4.13', name: 'フォーカスの外観（AA）', status: 'pass', message: 'フォーカス可能要素なし', violations: [] }
      ];
    }

    // キーボードモード確立（bodyクリック後にEsc→Tabで:focus-visibleをオン）
    try {
      await page.mouse.click(10, 10);
      await new Promise(r => setTimeout(r, 100));
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 60));
    } catch (_) {}

    // --- step2: 実際にTabして :focus-visible 込みのスタイルを収集 ---
    const byKey = new Map(preData.map(d => [d.key, d]));
    const checked = new Map(); // key → afterStyles
    const seen    = new Set();
    const maxTabs = preData.length + 10;

    for (let i = 0; i < maxTabs; i++) {
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 120));

      const after = await page.evaluate(() => {
        function isTransparent(c) {
          return !c || c === 'transparent' || /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
        }
        function effectiveBg(el) {
          let node = el;
          while (node && node !== document.documentElement) {
            const bg = window.getComputedStyle(node).backgroundColor;
            if (!isTransparent(bg)) return bg;
            node = node.parentElement;
          }
          return 'rgb(255,255,255)';
        }
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const s   = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const id  = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return {
          key:             `${tag}${id}${cls}`.slice(0, 60),
          outlineWidth:    parseFloat(s.outlineWidth) || 0,
          outlineStyle:    s.outlineStyle,
          outlineColor:    s.outlineColor,
          boxShadow:       s.boxShadow,
          backgroundColor: s.backgroundColor,
          borderWidth:     parseFloat(s.borderWidth) || 0,
          borderColor:     s.borderColor,
          adjBg:           effectiveBg(el.parentElement || el)
        };
      });

      if (!after) continue;
      if (seen.has(after.key)) break; // 一周したら終了
      seen.add(after.key);
      if (byKey.has(after.key)) checked.set(after.key, after);
    }

    // --- step3: before/after 差分を評価 ---
    function parseRgb(c) {
      if (!c) return null;
      const m = c.match(/rgba?\(\s*(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
    }
    function luminance([r, g, b]) {
      return [r, g, b].map((v, i) => {
        v /= 255;
        v = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        return v * [0.2126, 0.7152, 0.0722][i];
      }).reduce((a, b) => a + b, 0);
    }
    function contrastRatio(c1, c2) {
      if (!c1 || !c2) return 0;
      const l1 = luminance(c1), l2 = luminance(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    function isTransparentColor(c) {
      return !c || c === 'transparent' || /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
    }
    function parseShadow(s) {
      if (!s || s === 'none') return null;
      const colorMatch = s.match(/rgba?\([^)]+\)/);
      const color = colorMatch ? colorMatch[0] : null;
      const noColor = s.replace(/rgba?\([^)]+\)/, '').trim();
      const nums = (noColor.match(/(-?\d+\.?\d*)px/g) || []).map(parseFloat);
      const spread = nums.length >= 4 ? nums[3] : (nums.length === 3 ? 0 : null);
      return spread !== null ? { spread, color } : null;
    }

    const violations27  = [];
    const violations213 = [];

    for (const [key, a] of checked) {
      const b = byKey.get(key);
      if (!b) continue;

      const hasOutline    = a.outlineStyle !== 'none' && a.outlineWidth > 0 && !isTransparentColor(a.outlineColor);
      const hasBoxShadow  = a.boxShadow && a.boxShadow !== 'none' && a.boxShadow !== b.boxShadow;
      const bgChanged     = a.backgroundColor !== b.backgroundColor && !isTransparentColor(a.backgroundColor);
      const borderChanged = a.borderWidth !== b.borderWidth || a.borderColor !== b.borderColor;
      const hasFocusIndicator = hasOutline || hasBoxShadow || bgChanged || borderChanged;

      if (!hasFocusIndicator) {
        violations27.push(`${b.label} (outline:${a.outlineWidth}px, bg変化:${bgChanged}, shadow:${hasBoxShadow})`);
        violations213.push(`${b.label} ／ インジケーター未検出`);
        continue;
      }

      // SC 2.4.13: 面積 ≥2px + コントラスト比 ≥3:1
      let areaOk = false, crOk = false, areaNote = '', crNote = '';
      if (hasOutline) {
        areaOk   = a.outlineWidth >= 2;
        areaNote = `outline-width:${a.outlineWidth}px`;
        const cr = contrastRatio(parseRgb(a.outlineColor), parseRgb(a.adjBg));
        crOk   = cr >= 3;
        crNote = `コントラスト:${cr.toFixed(1)}:1`;
      } else if (hasBoxShadow) {
        const sh = parseShadow(a.boxShadow);
        if (sh) {
          areaOk   = sh.spread >= 2;
          areaNote = `box-shadow spread:${sh.spread}px`;
          const cr = contrastRatio(parseRgb(sh.color || a.adjBg), parseRgb(a.adjBg));
          crOk   = cr >= 3;
          crNote = `コントラスト:${cr.toFixed(1)}:1`;
        } else { areaOk = true; crOk = true; }
      } else if (bgChanged) {
        areaOk = true;
        const cr = contrastRatio(parseRgb(a.backgroundColor), parseRgb(a.adjBg));
        crOk   = cr >= 3;
        crNote = `背景コントラスト:${cr.toFixed(1)}:1`;
      } else if (borderChanged) {
        const bwDiff = a.borderWidth - b.borderWidth;
        areaOk   = bwDiff >= 2;
        areaNote = `border増分:${bwDiff.toFixed(1)}px`;
        const cr = contrastRatio(parseRgb(a.borderColor), parseRgb(a.adjBg));
        crOk   = cr >= 3;
        crNote = `コントラスト:${cr.toFixed(1)}:1`;
      }
      if (!areaOk || !crOk) {
        const reasons = [];
        if (!areaOk) reasons.push(`面積不足(${areaNote}、≥2px必要)`);
        if (!crOk)   reasons.push(`${crNote}（≥3:1必要）`);
        violations213.push(`${b.label} ／ ${reasons.join('、')}`);
      }
    }

    // Tab で到達しなかった要素（preData にあるが checked にない）は手動確認扱いにしてfailにしない
    const has247Fail = violations27.length > 0;
    const has213Fail = violations213.length > 0;
    return [
      {
        sc: '2.4.7', name: 'フォーカス可視（AA）',
        status: has247Fail ? 'fail' : 'pass',
        message: has247Fail
          ? `${violations27.length}個の要素でフォーカス時にスタイル変化なし`
          : 'フォーカス時にスタイル変化あり（outline/shadow/background/border）',
        violations: violations27
      },
      {
        sc: '2.4.13', name: 'フォーカスの外観（AA）',
        status: has213Fail ? 'fail' : 'pass',
        message: has213Fail
          ? `${violations213.length}個の要素が面積またはコントラスト比の要件を未達`
          : '検出した全フォーカスインジケーターが面積（≥2px）・コントラスト比（≥3:1）を満たしています',
        violations: violations213
      }
    ];
  } catch (e) {
    return [
      { sc: '2.4.7',  name: 'フォーカス可視（AA）',   status: 'error', message: e.message, violations: [] },
      { sc: '2.4.13', name: 'フォーカスの外観（AA）', status: 'error', message: e.message, violations: [] }
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
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        return { x: rect.left, y: rect.top, tabindex, label: `${tag}${id}${cls}${text ? ' "'+text+'"' : ''}`.slice(0, 80) };
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

/** SC 1.3.2 意味のある順序 */
async function check_1_3_2_meaningful_sequence(page) {
  try {
    const result = await page.evaluate(() => {
      const selector = [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'li', 'dt', 'dd',
        'label', 'legend', 'figcaption', 'caption',
        'td', 'th', 'summary'
      ].join(', ');
      const containerSelector = [
        'main',
        'article',
        'section',
        'form',
        'ol',
        'ul',
        'dl',
        'table',
        'fieldset',
        '[role="main"]',
        '[role="form"]',
        '[role="article"]',
        '[role="region"]'
      ].join(', ');
      const excludedSelector = 'header, nav, footer, aside, dialog, [aria-modal="true"], [hidden], [aria-hidden="true"]';
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
      const cssOrderIssues = [];
      const positionIssues = [];
      const grouped = new Map();

      const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
      const describe = el => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        const text = normalize(el.innerText || el.textContent || '').slice(0, 32);
        return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`.slice(0, 96);
      };
      const isVisible = el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const getContainerKey = el => {
        const container = el.closest(containerSelector) || el.parentElement;
        if (!container) return null;
        const parts = [];
        let current = container;
        let depth = 0;
        while (current && depth < 4) {
          const tag = current.tagName ? current.tagName.toLowerCase() : 'node';
          const id = current.id ? `#${current.id}` : '';
          const cls = current.className && typeof current.className === 'string'
            ? '.' + current.className.trim().split(/\s+/).slice(0, 1).join('.')
            : '';
          parts.unshift(`${tag}${id}${cls}`);
          current = current.parentElement;
          depth++;
        }
        return parts.join('>');
      };

      Array.from(document.querySelectorAll(selector)).forEach((el, domIndex) => {
        if (!isVisible(el)) return;
        if (el.closest(excludedSelector)) return;
        const text = normalize(el.innerText || el.textContent || '');
        if (text.length < 2) return;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const position = style.position || 'static';
        const order = Number(style.order || 0);
        const parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display || '' : '';
        const info = {
          domIndex,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          desc: describe(el)
        };

        if (order !== 0 && /(flex|grid)/i.test(parentDisplay) && cssOrderIssues.length < 6) {
          cssOrderIssues.push(`${info.desc} (order:${order})`);
        }

        if ((position === 'absolute' || position === 'fixed') && text.length >= 6) {
          const containerKey = getContainerKey(el);
          if (!containerKey) return;
          if (!grouped.has(containerKey)) grouped.set(containerKey, []);
          grouped.get(containerKey).push({ ...info, position });
          return;
        }

        const containerKey = getContainerKey(el);
        if (!containerKey) return;
        if (!grouped.has(containerKey)) grouped.set(containerKey, []);
        grouped.get(containerKey).push(info);
      });

      for (const items of grouped.values()) {
        if (!items || items.length < 3) continue;
        const minLeft = Math.min(...items.map(item => item.left));
        const maxLeft = Math.max(...items.map(item => item.left));
        const singleColumn = (maxLeft - minLeft) <= Math.min(160, viewportWidth * 0.18);
        if (!singleColumn) continue;

        let backtracks = 0;
        for (let i = 1; i < items.length; i++) {
          const prev = items[i - 1];
          const curr = items[i];
          if (curr.top < prev.top - 48) {
            backtracks++;
            if (positionIssues.length < 6) {
              positionIssues.push(`${prev.desc} の後に ${curr.desc} が視覚的に上へ戻っています`);
            }
          }
        }

        if (backtracks >= 2) break;
      }

      return { cssOrderIssues, positionIssues };
    });

    const violations = [...result.cssOrderIssues, ...result.positionIssues].slice(0, 8);
    return {
      sc: '1.3.2',
      name: '意味のある順序',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? '主要な本文・フォーム・表のDOM順と視覚順に大きな不一致は見つかりませんでした'
        : `${violations.length}件の順序ずれシグナルを検出しました`,
      violations
    };
  } catch (e) {
    return { sc: '1.3.2', name: '意味のある順序', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.3.3 感覚的特徴だけに依存しない */
async function check_1_3_3_sensory_characteristics(page) {
  try {
    const result = await page.evaluate(() => {
      const selector = 'p, li, label, legend, td, th, span, div, small, strong, em';
      const excludedSelector = 'script, style, noscript, header, nav, footer';
      const instructionPattern = /(クリック|押して|押下|選択|タップ|入力|進んで|移動して|確認して|参照して|open|click|tap|press|select|choose|enter|go to|move to)/i;
      const sensoryOnlyPattern = /(右|左|上|下|横|隣|手前|奥|上記|下記|赤|青|緑|黄|白|黒|丸|四角|三角|大きい|小さい|音が鳴|点滅|right|left|upper|lower|top|bottom|red|blue|green|yellow|round|square|triangle|large|small|sound|beep)/i;
      const textualIdentifierPattern = /(「[^」]{1,30}」|"[^"]{1,30}"|'[^']{1,30}'|ラベル|見出し|heading|label(ed)?|named|name|id=|タイトル|title|「次へ」|「送信」|「検索」|Next|Submit|Search|Login)/i;
      const candidates = [];

      const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
      const describe = el => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        return `${tag}${id}${cls}`.slice(0, 80);
      };
      const isVisible = el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      Array.from(document.querySelectorAll(selector)).forEach(el => {
        if (candidates.length >= 8) return;
        if (!isVisible(el)) return;
        if (el.closest(excludedSelector)) return;
        const text = normalize(el.innerText || el.textContent || '');
        if (text.length < 8 || text.length > 180) return;
        if (!instructionPattern.test(text)) return;
        if (!sensoryOnlyPattern.test(text)) return;
        if (textualIdentifierPattern.test(text)) return;
        candidates.push(`${describe(el)}: ${text.slice(0, 100)}`);
      });

      return candidates;
    });

    return {
      sc: '1.3.3',
      name: '感覚的特徴',
      status: result.length === 0 ? 'pass' : 'manual_required',
      message: result.length === 0
        ? '感覚的特徴だけに依存する疑いが強い操作指示は見つかりませんでした'
        : `${result.length}件の感覚依存らしい指示文候補を抽出しました`,
      violations: result
    };
  } catch (e) {
    return { sc: '1.3.3', name: '感覚的特徴', status: 'error', message: e.message, violations: [] };
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
      const srOnlyPattern = /(sr-only|screen-reader|screenreader|visually-hidden|visuallyhidden|hidden-visually|a11y-hidden|reader-only)/i;
      const els = document.querySelectorAll('p, span, div, li, td, th, h1, h2, h3, h4, h5, h6');
      for (const el of els) {
        if (el.offsetHeight === 0) continue;
        // clientHeight が極端に小さい（≤2px）要素はSR専用・装飾要素として除外
        if (el.clientHeight <= 2) continue;
        const style = getComputedStyle(el);
        if (style.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 4) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          // SR専用クラスを除外
          if (srOnlyPattern.test(el.getAttribute('class') || '')) continue;
          const text = el.textContent.trim().slice(0, 20);
          const parentEl = el.parentElement;
          const parentCtx = parentEl && parentEl !== document.body
            ? ` in ${parentEl.tagName.toLowerCase()}${parentEl.id ? '#' + parentEl.id : (parentEl.className && typeof parentEl.className === 'string' ? '.' + parentEl.className.trim().split(/\s+/)[0] : '')}` : '';
          issues.push(`${tag}${id}${cls}${text ? ' "' + text + '"' : ''}${parentCtx} (scrollH:${el.scrollHeight} > clientH:${el.clientHeight})`.slice(0, 100));
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

/** SC 1.2.1/1.2.2/1.2.4/1.2.5 メディアキャプション（1.2.3は別関数で専用検査） */
async function check_1_2_x_media_captions(page) {
  try {
    const result = await page.evaluate(async () => {
      const videos  = document.querySelectorAll('video');
      const audios  = document.querySelectorAll('audio');
      const iframes = document.querySelectorAll('iframe');
      const issues  = [];

      for (const v of videos) {
        const capTracks = v.querySelectorAll('track[kind="captions"], track[kind="subtitles"]');
        if (capTracks.length === 0) {
          issues.push(`video: キャプションtrack欠如 (src: ${(v.src || v.currentSrc || '').slice(0, 50)})`);
        } else {
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
      return { sc: '1.2.1 / 1.2.2 / 1.2.4 / 1.2.5', name: 'メディアキャプション（1.2.1/1.2.2/1.2.4/1.2.5）', status: 'not_applicable', message: 'video/audio/iframeが存在しません', violations: [] };
    }
    return {
      sc: '1.2.1 / 1.2.2 / 1.2.4 / 1.2.5', name: 'メディアキャプション（1.2.1/1.2.2/1.2.4/1.2.5）',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? `メディア要素(video:${result.videoCount}, audio:${result.audioCount}, iframe:${result.iframeCount})にキャプションあり`
        : `${result.issues.length}件のキャプション問題を検出`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '1.2.1 / 1.2.2 / 1.2.4 / 1.2.5', name: 'メディアキャプション（1.2.1/1.2.2/1.2.4/1.2.5）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.2.3 音声解説またはメディア代替（収録済）
 *  track[kind="descriptions"] / aria-describedby / 近接テキストキーワード / muted属性 を多段階検証
 */
async function check_1_2_3_audio_description(page) {
  try {
    const result = await page.evaluate(() => {
      const videos  = Array.from(document.querySelectorAll('video'));
      const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
        const s = f.src || '';
        return s.includes('youtube.com') || s.includes('youtu.be') || s.includes('vimeo.com');
      });

      if (videos.length === 0 && iframes.length === 0) {
        return { applicable: false, items: [] };
      }

      const DESC_KEYWORDS = ['音声解説', 'audio description', '音声ガイド', '解説版', 'テキスト版', 'transcript', '書き起こし', '代替テキスト', 'メディア代替'];
      const items = [];

      for (const v of videos) {
        const src = (v.src || v.currentSrc || '').slice(0, 80);

        // muted かつ controls なし → 装飾的動画、解説不要
        if (v.hasAttribute('muted') && !v.hasAttribute('controls')) {
          items.push({ status: 'pass', src, method: 'muted属性あり（音声なし装飾動画）' });
          continue;
        }

        // track[kind="descriptions"] の有無
        const descTracks = Array.from(v.querySelectorAll('track[kind="descriptions"]')).filter(t => t.src);
        if (descTracks.length > 0) {
          items.push({ status: 'pass', src, method: `track[kind="descriptions"] src="${descTracks[0].src.slice(-50)}"` });
          continue;
        }

        // aria-describedby → テキスト代替
        const describedById = v.getAttribute('aria-describedby');
        if (describedById) {
          const descEl = document.getElementById(describedById);
          if (descEl && descEl.textContent.trim().length > 15) {
            items.push({ status: 'pass', src, method: `aria-describedby="#${describedById}" テキスト代替あり` });
            continue;
          }
        }

        // 近接コンテナのテキスト・リンクにキーワード
        const container = v.closest('figure, section, article, div') || v.parentElement;
        const nearText = container ? container.textContent : '';
        const nearLinks = container ? Array.from(container.querySelectorAll('a')).map(a => a.textContent.trim()) : [];
        const hasKeyword = DESC_KEYWORDS.some(kw => nearText.toLowerCase().includes(kw.toLowerCase()));
        const hasDescLink = nearLinks.some(txt => DESC_KEYWORDS.some(kw => txt.toLowerCase().includes(kw.toLowerCase())));
        if (hasKeyword || hasDescLink) {
          const evidence = hasDescLink ? `近接リンク「${nearLinks.find(t => DESC_KEYWORDS.some(k => t.toLowerCase().includes(k.toLowerCase())))}」` : '近接テキストにキーワードあり';
          items.push({ status: 'unverified', src, method: `${evidence}（内容の確認が必要）` });
          continue;
        }

        // 小サイズ要素は装飾扱い
        const w = v.offsetWidth, h = v.offsetHeight;
        if (w > 0 && h > 0 && w < 80 && h < 80) {
          items.push({ status: 'pass', src, method: `小サイズ動画（${w}×${h}px）装飾と推定` });
          continue;
        }

        items.push({ status: 'fail', src, method: '音声解説またはメディア代替の証拠なし（track/aria-describedby/テキスト代替いずれも未検出）' });
      }

      // 埋め込み動画（YouTube/Vimeo）は解説有無をDOMから確認不可
      for (const iframe of iframes) {
        items.push({ status: 'unverified', src: iframe.src.slice(0, 80), method: '埋め込み動画のため手動確認が必要（音声解説トラックまたはテキスト代替の有無を確認）' });
      }

      return { applicable: true, items };
    });

    if (!result.applicable) {
      return { sc: '1.2.3', name: '音声解説またはメディア代替（収録済）', status: 'not_applicable', message: '動画要素が存在しません', violations: [] };
    }

    const failures   = result.items.filter(i => i.status === 'fail');
    const unverified = result.items.filter(i => i.status === 'unverified');

    if (failures.length > 0) {
      return {
        sc: '1.2.3', name: '音声解説またはメディア代替（収録済）',
        status: 'fail',
        message: `${failures.length}件の動画で音声解説またはメディア代替が未検出`,
        violations: failures.map(f => `[要修正] ${f.src || '動画'}: ${f.method}`)
      };
    }
    if (unverified.length > 0) {
      return {
        sc: '1.2.3', name: '音声解説またはメディア代替（収録済）',
        status: 'unverified',
        message: `${unverified.length}件の動画は手動確認が必要`,
        violations: unverified.map(u => `[要確認] ${u.src || '動画'}: ${u.method}`)
      };
    }
    return {
      sc: '1.2.3', name: '音声解説またはメディア代替（収録済）',
      status: 'pass',
      message: `全${result.items.length}件の動画で音声解説またはメディア代替を確認`,
      violations: []
    };
  } catch (e) {
    return { sc: '1.2.3', name: '音声解説またはメディア代替（収録済）', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 2.2.2 動くコンテンツ停止 */
async function check_2_2_2_pause_stop(page) {
  try {
    const result = await page.evaluate(() => {
      const issues = [];

      // ページ全体で一時停止/停止ボタンがあるか確認するヘルパー
      // テキスト・aria-label・クラス名から pause/stop/停止 等を探す
      const PAUSE_RE = /pause|stop|停止|一時停止|止める|スライド停止/i;
      function hasPauseControlInPage() {
        const btns = document.querySelectorAll('button, [role="button"], input[type="button"]');
        for (const b of btns) {
          const label = (b.textContent || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
          const cls = typeof b.className === 'string' ? b.className : '';
          if (PAUSE_RE.test(label) || PAUSE_RE.test(cls)) return true;
        }
        return false;
      }
      // aria-label に pause/stop 系の要素（Swiper等がsrのみのボタンを置く）
      function hasPauseAriaInPage() {
        const els = document.querySelectorAll('[aria-label]');
        for (const e of els) {
          if (PAUSE_RE.test(e.getAttribute('aria-label') || '')) return true;
        }
        return false;
      }
      const pageHasPauseControl = hasPauseControlInPage() || hasPauseAriaInPage();

      // --- video[autoplay] ---
      const autoplayVideos = document.querySelectorAll('video[autoplay]');
      for (const v of autoplayVideos) {
        if (!pageHasPauseControl) {
          issues.push(`video[autoplay]: 停止ボタン未確認`);
        }
      }

      // --- <marquee> ---
      for (const m of document.querySelectorAll('marquee')) {
        issues.push(`<marquee>要素: 動くコンテンツの停止手段なし`);
      }

      // --- スライダーライブラリ検出 ---
      // 主要ライブラリのクラス・data属性パターン
      const SLIDER_SELECTORS = [
        '.swiper', '.swiper-container',       // Swiper
        '.slick-slider', '.slick-list',        // Slick
        '.owl-carousel', '.owl-stage',         // Owl Carousel
        '.splide', '.splide__list',            // Splide
        '.glide', '.glide__slides',            // Glide.js
        '.flickity-slider',                    // Flickity
        '.keen-slider',                        // KeenSlider
        '[data-ride="carousel"]',              // Bootstrap carousel
        '.js-slider', '.js-carousel',          // 汎用命名
        '.hero-slider', '.top-slider',         // よくあるカスタム命名
        '.slide-wrap', '.slideshow',
      ].join(',');

      const sliderEls = document.querySelectorAll(SLIDER_SELECTORS);
      if (sliderEls.length > 0 && !pageHasPauseControl) {
        const names = Array.from(sliderEls).slice(0, 3).map(el => {
          const cls = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : (cls ? '.' + cls : '')}`;
        });
        issues.push(`自動再生スライダー候補(${sliderEls.length}個): ${names.join(', ')} — 停止ボタンなし`);
      }

      // --- CSSアニメーション無限ループ検出（クラスベース含む） ---
      // inlineスタイルに限らず、getComputedStyleで animationName != 'none' かつ
      // iterationCount が infinite な要素を探す（候補を絞るためクラス名でフィルタ）
      const ANIM_CLASS_RE = /slide|carousel|scroll|banner|ticker|marquee|rotate|spin|fade|move|animate/i;
      const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
        const cls = typeof el.className === 'string' ? el.className : '';
        const id = el.id || '';
        return ANIM_CLASS_RE.test(cls) || ANIM_CLASS_RE.test(id);
      });
      const infiniteAnims = [];
      for (const el of candidates.slice(0, 200)) {
        const style = getComputedStyle(el);
        const animName = style.animationName;
        const iterCount = style.animationIterationCount;
        const dur = parseFloat(style.animationDuration) || 0;
        if (animName && animName !== 'none' && (iterCount === 'infinite' || dur > 5)) {
          const tag = el.tagName.toLowerCase();
          const elId = el.id ? `#${el.id}` : '';
          const cls2 = typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          infiniteAnims.push(`${tag}${elId}${cls2}`);
          if (infiniteAnims.length >= 5) break;
        }
      }
      // インラインstyleからも取得（既存ロジックを維持）
      if (infiniteAnims.length === 0) {
        for (const el of document.querySelectorAll('[style*="animation"]')) {
          const style = getComputedStyle(el);
          const dur = parseFloat(style.animationDuration) || 0;
          const iterCount = style.animationIterationCount;
          if (dur > 5 || iterCount === 'infinite') {
            const tag = el.tagName.toLowerCase();
            const elId = el.id ? `#${el.id}` : '';
            infiniteAnims.push(`${tag}${elId} (${dur}s)`);
            if (infiniteAnims.length >= 5) break;
          }
        }
      }
      if (infiniteAnims.length > 0 && !pageHasPauseControl && sliderEls.length === 0) {
        issues.push(`無限ループCSSアニメーション: ${infiniteAnims.join(', ')} — 停止ボタンなし`);
      }

      return {
        issues,
        autoplayCount: autoplayVideos.length,
        sliderCount: sliderEls.length,
        infiniteAnimCount: infiniteAnims.length
      };
    });

    const hasMovingContent = result.autoplayCount > 0 || result.sliderCount > 0 || result.infiniteAnimCount > 0
      || document.querySelectorAll('marquee').length > 0;

    if (result.issues.length === 0 && result.autoplayCount === 0 && result.sliderCount === 0 && result.infiniteAnimCount === 0) {
      return {
        sc: '2.2.2', name: '動くコンテンツ停止',
        status: 'pass', message: '自動再生動画・スライダー・無限ループアニメーション・marqueeなし', violations: []
      };
    }

    return {
      sc: '2.2.2', name: '動くコンテンツ停止',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? `動くコンテンツあり（スライダー${result.sliderCount}・video${result.autoplayCount}）、停止手段を確認`
        : `${result.issues.length}件: 動くコンテンツに停止手段なし`,
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
      const authKeywordRe = /(passkey|webauthn|security key|verification code|one[- ]?time code|otp|認証|ログイン|サインイン|パスキー|セキュリティキー|確認コード|ワンタイム)/i;
      const pwInputs = Array.from(document.querySelectorAll('input[type="password"], input[autocomplete*="current-password"], input[autocomplete*="new-password"]'));
      const otpInputs = document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i], input[name*="passcode" i], input[id*="passcode" i]');
      const passkeyButtons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(el => authKeywordRe.test([
          el.textContent || '',
          el.getAttribute('value') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || ''
        ].join(' ')));
      const authForms = Array.from(document.querySelectorAll('form'))
        .filter(form => authKeywordRe.test([
          form.getAttribute('id') || '',
          form.getAttribute('class') || '',
          form.getAttribute('name') || '',
          form.getAttribute('action') || '',
          form.textContent || ''
        ].join(' ')));
      const hasAuthenticationUi = pwInputs.length > 0 || otpInputs.length > 0 || passkeyButtons.length > 0 || authForms.length > 0;
      if (!hasAuthenticationUi) return { notApplicable: true };
      if (pwInputs.length === 0) {
        return {
          notApplicable: false,
          manualRequired: true,
          issues: [`認証UIを検出しました（OTP:${otpInputs.length} / passkey:${passkeyButtons.length} / auth form:${authForms.length}）。認知機能テストの有無は手動確認してください`]
        };
      }

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
      return { notApplicable: false, manualRequired: false, issues };
    });

    if (result.notApplicable) {
      return {
        sc: '3.3.8', name: '認証アクセシブル',
        status: 'not_applicable', message: '認証UIが存在しません', violations: []
      };
    }
    if (result.manualRequired) {
      return {
        sc: '3.3.8', name: '認証アクセシブル',
        status: 'manual_required', message: '認証UIを検出しました。認知機能テストの有無は手動確認が必要です', violations: result.issues || []
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
      const ignoredKeyframes = new Set([
        'turn-on-visibility',
        'turn-off-visibility',
        'lightbox-zoom-in',
        'lightbox-zoom-out'
      ]);
      function parseCssTime(value) {
        const text = String(value || '').trim();
        if (!text || text === '0') return 0;
        const num = parseFloat(text);
        if (!Number.isFinite(num)) return 0;
        return text.endsWith('ms') ? num / 1000 : num;
      }
      // name → 最短 duration(秒) を記録（フェードインと高速点滅を区別するために使用）
      const usedAnimations = new Map();
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const names = String(style.animationName || '').split(',');
        const durations = String(style.animationDuration || '').split(',');
        names.forEach((rawName, idx) => {
          const name = rawName.trim().replace(/^['"]|['"]$/g, '');
          if (!name || name === 'none') return;
          const duration = parseCssTime(durations[idx] || durations[durations.length - 1]);
          if (duration > 0) {
            const prev = usedAnimations.get(name);
            usedAnimations.set(name, prev === undefined ? duration : Math.min(prev, duration));
          }
        });
      }
      // @keyframes で明滅パターン（往復する opacity 変化）を検出
      // 単方向フェードイン(0→1)はフラッシュではないため除外
      const flashIssues = [];
      const manualIssues = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              if (ignoredKeyframes.has(rule.name)) continue;
              if (!usedAnimations.has(rule.name)) continue;
              const keys = Array.from(rule.cssRules || []);
              if (keys.length >= 3) {
                let hasOpacityZero = false;
                let hasOpacityHigh = false;
                for (const key of keys) {
                  const text = key.cssText || '';
                  if (text.includes('opacity: 0') || text.includes('opacity:0') || /visibility\s*:\s*hidden/.test(text)) hasOpacityZero = true;
                  if (/opacity\s*:\s*(?:0*\.?[5-9]\d*|1)\b/.test(text) || /visibility\s*:\s*visible/.test(text)) hasOpacityHigh = true;
                }
                // 往復パターン（低 ↔ 高）のみが閃光候補。片方向フェードは対象外
                if (hasOpacityZero && hasOpacityHigh) {
                  const duration = usedAnimations.get(rule.name);
                  if (duration <= 1) {
                    flashIssues.push(`@keyframes "${rule.name}" (${duration}s): 高速明滅パターン — 手動確認してください`);
                  } else {
                    manualIssues.push(`@keyframes "${rule.name}" (${duration}s): 明滅パターンあり（低速）— 手動確認`);
                  }
                  if (flashIssues.length + manualIssues.length >= 5) break;
                }
              }
            }
          }
        } catch (e) {}
      }
      // video[autoplay] の点滅リスク
      const flashVideos = document.querySelectorAll('video[autoplay]');
      if (flashVideos.length > 0) {
        manualIssues.push(`video[autoplay] (${flashVideos.length}個): 点滅コンテンツの手動確認が必要`);
      }
      return { flashIssues, manualIssues };
    });

    const allIssues = [...result.flashIssues, ...result.manualIssues];
    const status = result.flashIssues.length > 0 ? 'fail'
                 : result.manualIssues.length > 0 ? 'manual_required'
                 : 'pass';
    return {
      sc: '2.3.1', name: '3回点滅（seizure）',
      status,
      message: status === 'pass'
        ? '点滅の疑いのあるアニメーションは検出されませんでした'
        : status === 'fail'
          ? `${result.flashIssues.length}件の高速明滅パターンを検出`
          : `${result.manualIssues.length}件の要確認アニメーション（手動確認推奨）`,
      violations: allIssues
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
 *  DEEPを主判定とし、本文中リンクとナビゲーションの current/selected 状態を決定論的に検査する。
 *  色語の意味依存（「赤いボタン」等）は MULTI が補助的に確認する。
 */
async function check_1_4_1_use_of_color(page) {
  try {
    const result = await page.evaluate(() => {
      function parseCssColor(cssColor) {
        if (!cssColor || cssColor === 'transparent') return null;
        const rgba = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/i);
        if (rgba) {
          if (rgba[4] !== undefined && parseFloat(rgba[4]) === 0) return null;
          return [+rgba[1], +rgba[2], +rgba[3]];
        }
        const hex = cssColor.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!hex) return null;
        const raw = hex[1];
        if (raw.length === 3) return raw.split('').map(ch => parseInt(ch + ch, 16));
        return [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)].map(part => parseInt(part, 16));
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
      function px(value) {
        const num = parseFloat(value || '0');
        return Number.isFinite(num) ? num : 0;
      }
      function fontWeight(value) {
        if (!value) return 400;
        if (value === 'normal') return 400;
        if (value === 'bold') return 700;
        const num = parseInt(value, 10);
        return Number.isFinite(num) ? num : 400;
      }
      function getColorContrast(styleA, styleB, prop = 'color') {
        const colorA = parseCssColor(styleA?.[prop] || '');
        const colorB = parseCssColor(styleB?.[prop] || '');
        if (!colorA || !colorB) return 1;
        return contrastRatio(colorA, colorB);
      }
      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function hasText(el) {
        return !!String(el?.textContent || '').replace(/\s+/g, ' ').trim();
      }
      function hasVisibleBorder(style) {
        return ['Top', 'Right', 'Bottom', 'Left'].some(side =>
          px(style[`border${side}Width`]) > 0 && !/none|hidden/i.test(style[`border${side}Style`] || '')
        );
      }
      function hasOutlineCue(style) {
        return px(style.outlineWidth) > 0 || (style.boxShadow && style.boxShadow !== 'none');
      }
      function hasWeightCue(style, refStyle) {
        const w = fontWeight(style.fontWeight);
        const rw = fontWeight(refStyle.fontWeight);
        return (w - rw) >= 200 || (w >= 600 && rw < 600);
      }
      function hasSizeCue(style, refStyle) {
        const size = px(style.fontSize);
        const ref = px(refStyle.fontSize) || 16;
        return size >= ref + 2 && size / ref >= 1.125;
      }
      function hasUnderlineCue(style, refStyle) {
        return style.textDecorationLine.includes('underline') && !refStyle.textDecorationLine.includes('underline');
      }
      function hasBackgroundCue(style, refStyle, containerStyle) {
        const bg = parseCssColor(style.backgroundColor);
        if (!bg) return false;
        const refBg = parseCssColor(refStyle.backgroundColor);
        const containerBg = parseCssColor(containerStyle?.backgroundColor || '');
        const fg = parseCssColor(style.color);
        const ownContrast = (bg && fg) ? contrastRatio(bg, fg) : 1;
        const refContrast = (bg && refBg) ? contrastRatio(bg, refBg) : 1;
        const containerContrast = (bg && containerBg) ? contrastRatio(bg, containerBg) : 1;
        return ownContrast >= 3 && (refContrast >= 3 || containerContrast >= 3);
      }
      function describeElement(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        const txt = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        return `${tag}${id || cls}${txt ? ` "${txt}"` : ''}`.slice(0, 120);
      }
      function isInlineTextLink(link, style, parentStyle) {
        if (!link.matches('a[href]') || !isVisible(link) || !hasText(link)) return false;
        if (link.closest('nav, header nav, footer nav, [role="navigation"], [role="tablist"], menu, [class*="nav" i], [class*="menu" i], [class*="tab" i]')) return false;
        if (style.display !== 'inline' && style.display !== 'inline-block') return false;
        if (hasVisibleBorder(style) || hasOutlineCue(style)) return false;
        if ((px(style.paddingLeft) + px(style.paddingRight) + px(style.paddingTop) + px(style.paddingBottom)) >= 8) return false;
        if (hasBackgroundCue(style, parentStyle, getComputedStyle(link.parentElement || document.body))) return false;
        const siblings = Array.from((link.parentNode && link.parentNode.childNodes) || []);
        const idx = siblings.indexOf(link);
        const hasBefore = idx > 0 && siblings.slice(0, idx).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const hasAfter = idx >= 0 && siblings.slice(idx + 1).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        if (hasBefore || hasAfter) return true;
        const parentText = String(link.parentElement?.textContent || '').replace(/\s+/g, ' ').trim();
        const linkText = String(link.textContent || '').replace(/\s+/g, ' ').trim();
        const surroundingText = parentText.replace(linkText, '').trim();
        return surroundingText.length >= Math.max(10, linkText.length + 4);
      }

      const issues = [];
      const inlineLinks = Array.from(document.querySelectorAll('a[href]'))
        .filter(link => {
          if (!link.parentElement) return false;
          const style = getComputedStyle(link);
          const parentStyle = getComputedStyle(link.parentElement);
          return isInlineTextLink(link, style, parentStyle);
        })
        .slice(0, 40);

      let inlineLinkIssueCount = 0;
      for (const link of inlineLinks) {
        const linkStyle = getComputedStyle(link);
        const parentStyle = getComputedStyle(link.parentElement);
        const hasNonColorCue = hasUnderlineCue(linkStyle, parentStyle)
          || hasWeightCue(linkStyle, parentStyle)
          || hasSizeCue(linkStyle, parentStyle)
          || hasVisibleBorder(linkStyle)
          || hasOutlineCue(linkStyle);
        const ratio = getColorContrast(linkStyle, parentStyle, 'color');
        if (!hasNonColorCue && ratio < 3) {
          inlineLinkIssueCount++;
          if (inlineLinkIssueCount <= 5) {
            issues.push(`${describeElement(link)}: 本文リンクが通常時に色だけで識別されている可能性 (周囲テキスト比 ${ratio.toFixed(2)}:1 / 要3:1以上)`);
          }
        }
      }
      if (inlineLinkIssueCount > 5) {
        issues.push(`（他${inlineLinkIssueCount - 5}件の本文リンクも同様に要確認）`);
      }

      const currentCandidates = Array.from(document.querySelectorAll(
        'nav [aria-current], [role="navigation"] [aria-current], header [aria-current], footer [aria-current], [role="tablist"] [aria-selected="true"], nav .active, nav .current, nav .selected, header nav .active, footer nav .active'
      ))
        .filter(el => isVisible(el) && hasText(el));
      const seenCurrent = new Set();

      for (const currentEl of currentCandidates) {
        if (seenCurrent.has(currentEl)) continue;
        seenCurrent.add(currentEl);
        const parent = currentEl.parentElement;
        if (!parent) continue;
        const peers = Array.from(parent.children).filter(el => el !== currentEl && isVisible(el) && hasText(el));
        if (peers.length === 0) continue;
        const peer = peers.find(el => el.tagName === currentEl.tagName) || peers[0];
        const style = getComputedStyle(currentEl);
        const peerStyle = getComputedStyle(peer);
        const parentStyle = getComputedStyle(parent);
        const hasNonColorCue = hasUnderlineCue(style, peerStyle)
          || hasWeightCue(style, peerStyle)
          || hasSizeCue(style, peerStyle)
          || (hasVisibleBorder(style) && !hasVisibleBorder(peerStyle))
          || (hasOutlineCue(style) && !hasOutlineCue(peerStyle))
          || hasBackgroundCue(style, peerStyle, parentStyle);
        const ratio = getColorContrast(style, peerStyle, 'color');
        if (!hasNonColorCue && ratio < 3) {
          issues.push(`${describeElement(currentEl)}: ナビゲーションの current/selected 状態が色だけで示されている可能性 (隣接項目比 ${ratio.toFixed(2)}:1 / 要3:1以上または非色手掛かり)`);
        }
      }

      return { issues, inlineLinkIssueCount, navIssueCount: Math.max(0, issues.length - Math.min(inlineLinkIssueCount, 5) - (inlineLinkIssueCount > 5 ? 1 : 0)) };
    });

    return {
      sc: '1.4.1', name: '色だけの情報伝達',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      message: result.issues.length === 0
        ? '本文リンクとナビゲーションの状態表示に、色以外の視覚的手がかりが確認できます'
        : `${result.issues.length}件: 本文リンクまたはナビゲーション状態が色だけで区別されている可能性`,
      violations: result.issues
    };
  } catch (e) {
    return { sc: '1.4.1', name: '色だけの情報伝達', status: 'error', message: e.message, violations: [] };
  }
}

/** SC 1.4.3 テキストのコントラスト最低限 */
async function check_1_4_3_text_contrast(page) {
  try {
    const result = await page.evaluate(() => {
      const SR_ONLY_RE = /\b(sr-only|screen-reader(-text)?|visually-hidden|visually_hidden|assistive-text|offscreen|hidden-text)\b/i;
      function parseCssColor(c) {
        if (!c || c === 'transparent') return null;
        const m = c.match(/rgba?\((\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)(?:,\s*([\d.]+))?\s*\)/i);
        if (!m) return null;
        if (m[4] !== undefined && parseFloat(m[4]) < 0.05) return null;
        return [+m[1], +m[2], +m[3]];
      }
      function luminance(r, g, b) {
        return [r, g, b].reduce((s, c, i) => {
          const v = c / 255;
          return s + (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][i];
        }, 0);
      }
      function cr(c1, c2) {
        const [l1, l2] = [luminance(...c1), luminance(...c2)].sort((a, b) => b - a);
        return (l1 + 0.05) / (l2 + 0.05);
      }
      function resolveBg(el) {
        let e = el;
        while (e && e !== document.documentElement) {
          const bg = parseCssColor(getComputedStyle(e).backgroundColor);
          if (bg) return bg;
          e = e.parentElement;
        }
        return [255, 255, 255];
      }
      function isSrOnly(el) {
        if (SR_ONLY_RE.test(el.className || '') || SR_ONLY_RE.test(el.id || '')) return true;
        const r = el.getBoundingClientRect();
        return r.width <= 1 && r.height <= 1;
      }
      function isLargeText(style) {
        const fs = parseFloat(style.fontSize) || 16;
        const fw = style.fontWeight === 'bold' ? 700 : (parseInt(style.fontWeight, 10) || 400);
        return fs >= 24 || (fs >= 18.67 && fw >= 700);
      }
      function desc(el) {
        const tag = el.tagName.toLowerCase();
        const id  = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const txt = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        return `${tag}${id || cls}${txt ? ` "${txt}"` : ''}`.slice(0, 100);
      }

      const MAX = 150;
      const seen = new Set();
      const violations = [];
      let checked = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode()) && checked < MAX) {
        const text = (node.textContent || '').trim();
        if (!text || text.length < 2) continue;
        const el = node.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (isSrOnly(el)) continue;
        const fg = parseCssColor(style.color);
        if (!fg) continue;
        const bg = resolveBg(el);
        const ratio = cr(fg, bg);
        const large = isLargeText(style);
        const required = large ? 3.0 : 4.5;
        checked++;
        if (ratio < required) {
          violations.push(`${desc(el)}: ${ratio.toFixed(1)}:1（必要: ${required}:1${large ? '、大きいテキスト' : ''}）`);
        }
      }
      return { violations, checked };
    });

    return {
      sc: '1.4.3',
      name: 'コントラスト（最低限）',
      status: result.violations.length === 0 ? 'pass' : 'fail',
      message: result.violations.length === 0
        ? `${result.checked}件のテキスト要素を検査、コントラスト不足なし（軽微な誤検出の可能性あり）`
        : `${result.violations.length}件のテキスト要素でコントラスト比不足（BASIC axe-coreで詳細確認推奨）`,
      violations: result.violations.slice(0, 15)
    };
  } catch (e) {
    return { sc: '1.4.3', status: 'error', violations: [], message: e.message };
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

    const issues = result.timers.map(ms => `setTimeout: ${Math.round(ms / 1000)}秒のタイマー検出 — UI上の制限時間であれば延長/無効化手段が必要（分析・keepalive等は対象外）`);

    return {
      sc: '2.2.1', name: '制限時間調整',
      // setTimeout だけではアナリティクス・セッション keepalive と UI 制限時間を区別できないため
      // タイマーが検出されても manual_required とし、手動確認を促す
      status: issues.length === 0 ? 'pass' : 'manual_required',
      message: issues.length === 0
        ? '長時間タイマー（20秒超）は検出されませんでした'
        : `${issues.length}件の長時間タイマーを検出 — UI制限時間かどうか手動確認が必要`,
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
      const failItems = [];
      const manualItems = [];
      // CSS @media orientation ルールで display:none / visibility:hidden を設定しているか
      // body/html/main/ルートラッパー等の広域セレクタのみ「向き固定」として fail
      // クラス・ID 付きのコンポーネント単位の非表示はレスポンシブデザインとして manual_required
      const broadSelectorRe = /^(body|html|main|\*|#root|#app|#wrapper|#content|#main|\.app\b|\.container\b|\.wrapper\b)/i;
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.MEDIA_RULE) {
              const cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
              if (cond.includes('orientation')) {
                for (const inner of rule.cssRules || []) {
                  const text = inner.cssText || '';
                  if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(text)) {
                    const selector = text.split('{')[0].trim();
                    if (broadSelectorRe.test(selector)) {
                      failItems.push(`@media(${cond}){ ${text.slice(0, 80)} } — ページ全体が特定方向で非表示`);
                    } else {
                      manualItems.push(`@media(${cond}){ ${text.slice(0, 80)} } — コンポーネント非表示（レスポンシブの可能性: 手動確認）`);
                    }
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
        failItems.push(`body transform:${bodyStyle.transform} — 表示方向がロックされている可能性`);
      }
      return { failItems, manualItems };
    });
    const allItems = [...issues.failItems, ...issues.manualItems];
    const status = issues.failItems.length > 0 ? 'fail'
                 : issues.manualItems.length > 0 ? 'manual_required'
                 : 'pass';
    return {
      sc: '1.3.4', name: '表示方向',
      status,
      message: status === 'pass'
        ? '表示方向を制限するCSSは検出されませんでした'
        : status === 'fail'
          ? `${issues.failItems.length}件: ページ全体が特定方向で非表示（向き固定の可能性）`
          : `${issues.manualItems.length}件: コンポーネント単位の orientation 非表示（手動確認推奨）`,
      violations: allItems
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
        { re: /(?:full|your|contact)?name\b|氏名|お名前/i,   autocomplete: 'name',           label: '氏名' },
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
      status: result.found ? 'pass' : 'not_applicable',
      message: result.found
        ? `header/footer/navにヘルプ/連絡先リンクあり: ${result.locations.slice(0, 3).join(', ')}`
        : 'header/footer内にヘルプ・連絡先・FAQリンクが見つかりません — ヘルプ手段がないページには SC 3.2.6 は適用されません',
      violations: []
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
      // マルチステップ UI がある場合のみ同名フィールド重複を fail とする
      // step indicator なし = 独立したフォームの共存（ログイン + 問い合わせ等）であり 3.3.7 対象外
      status: (result.issues.some(i => i.includes('重複')) && result.hasMultiStep) ? 'fail' : 'manual_required',
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
      // ファイル名パターン: Image2, img01, photo_3, figure01, pic2 etc.（拡張子あり/なし両対応）
      const fileNameAltRe = /^(image|img|photo|pic|picture|figure|fig|banner|icon|thumb|thumbnail)[_\-]?\d*(\.[a-z]{2,5})?$/i;
      const issues = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const ariaLabel = a.getAttribute('aria-label') || a.getAttribute('aria-labelledby');
        const text = (a.textContent || ariaLabel || '').trim().replace(/\s+/g, ' ');
        if (!text) {
          // テキストなし — alt付きimgのみのリンクかチェック
          const img = a.querySelector('img');
          const hasAriaLabel = !!ariaLabel;
          if (!hasAriaLabel) {
            if (!img) {
              const id = a.id ? `#${a.id}` : '';
              issues.push(`a${id}[href="${(a.getAttribute('href') || '').slice(0, 40)}"]: リンクテキストなし`);
            } else {
              const alt = img.getAttribute('alt');
              if (alt === null || alt === '') {
                const id = a.id ? `#${a.id}` : '';
                issues.push(`a${id}[href="${(a.getAttribute('href') || '').slice(0, 40)}"]: 画像リンクのalt空/なし — リンク目的不明`);
              } else if (fileNameAltRe.test(alt.trim())) {
                const id = a.id ? `#${a.id}` : '';
                issues.push(`a${id}[href="${(a.getAttribute('href') || '').slice(0, 40)}"]: 画像alt「${alt}」はファイル名パターン — リンク目的を説明していない`);
              }
            }
          }
        } else if (blacklist.test(text)) {
          const id = a.id ? `#${a.id}` : '';
          issues.push(`a${id}: 汎用テキスト「${text}」— リンク先が特定できない`);
        } else {
          // テキストがある場合でも、画像onlyリンクでaltがファイル名パターンか確認
          // （テキストノードが空白のみで実際の可視テキストがimgのaltだけの場合）
          const visibleText = (a.textContent || '').replace(/\s+/g, '').length;
          if (visibleText === 0 && !ariaLabel) {
            const img = a.querySelector('img');
            if (img) {
              const alt = img.getAttribute('alt');
              if (alt && fileNameAltRe.test(alt.trim())) {
                const id = a.id ? `#${a.id}` : '';
                issues.push(`a${id}[href="${(a.getAttribute('href') || '').slice(0, 40)}"]: 画像alt「${alt}」はファイル名パターン — リンク目的を説明していない`);
              }
            }
          }
        }
        if (issues.length >= 15) break;
      }
      return issues;
    });
    return {
      sc: '2.4.4', name: 'リンクの目的（汎用テキスト・画像リンク検出）',
      status: violations.length === 0 ? 'pass' : 'fail',
      message: violations.length === 0
        ? '汎用的なリンクテキスト・ファイル名パターンalt画像リンクは検出されませんでした'
        : `${violations.length}件: リンク目的が不明（汎用テキスト・ファイル名patternのalt等）`,
      violations
    };
  } catch (e) {
    return { sc: '2.4.4', name: 'リンクの目的（汎用テキスト・画像リンク検出）', status: 'error', message: e.message, violations: [] };
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
        // aria-pressed は toggle ボタンの有効な代替実装 (play/pause等) — aria-expanded 要求から除外
        if (el.getAttribute('aria-expanded') === null && el.getAttribute('aria-pressed') === null) {
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
      // HOMEページ（pathname が / または index.*）かつナビにホームへのリンクがない場合は
      // aria-current="page" が付かないのは自然な実装のためスキップ
      const isHomePage = /^\/?(index\.(html?|php|asp|aspx))?$/i.test(window.location.pathname);
      const navEls = [...document.querySelectorAll('nav, [role="navigation"]')];
      let navLinksTotal = 0;
      let hasAriaCurrent = false;
      let hasHomeLink = false;
      for (const nav of navEls) {
        const links = nav.querySelectorAll('a');
        navLinksTotal += links.length;
        if ([...links].some(a => a.hasAttribute('aria-current'))) hasAriaCurrent = true;
        if ([...links].some(a => {
          const href = (a.getAttribute('href') || '').trim();
          return href === '/' || href === '' || /^\/?index\.(html?|php|asp|aspx)$/i.test(href);
        })) hasHomeLink = true;
      }
      // ホームページかつナビにホームリンクなし → aria-current 未設定は誤検出とみなす
      const skipCurrentCheck = isHomePage && !hasHomeLink;
      if (navLinksTotal >= 2 && !hasAriaCurrent && !skipCurrentCheck) {
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
  const { url, basicAuth, viewportPreset } = req.body;
  // AAA βは一時停止中。再開時はreq.body.includeAAAを復帰する。
  // const { includeAAA } = req.body;
  const includeAAA = false;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });

  // リバースプロキシの proxy_read_timeout をかわすため Content-Type を先送りし、
  // 25秒ごとにスペースを書き込んで接続を維持する
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  const keepAliveInterval = setInterval(() => {
    try { if (!res.writableEnded) res.write(' '); } catch (_) {}
  }, 25000);
  const endWithJson = (statusCode, data) => {
    clearInterval(keepAliveInterval);
    if (res.writableEnded) return;
    if (!res.headersSent) res.statusCode = statusCode;
    try { res.write(JSON.stringify(data)); res.end(); } catch (_) {}
  };

  // リクエスト全体に8分のタイムアウトを設定
  const HANDLER_TIMEOUT = 8 * 60 * 1000;
  let handlerTimedOut = false;
  const handlerTimer = setTimeout(() => {
    handlerTimedOut = true;
    endWithJson(504, { error: 'DEEP SCANがタイムアウトしました（8分超過）。対象ページの応答が遅い可能性があります。' });
  }, HANDLER_TIMEOUT);

  let browser;
  try {
    const preset = normalizeViewportPreset(viewportPreset);
    console.log(`[Enhanced] Phase 1 検査開始: ${url} (View ${preset})`);
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await applyViewportPreset(page, preset);

    if (basicAuth && basicAuth.user && basicAuth.pass) {
      await page.authenticate({ username: basicAuth.user, password: basicAuth.pass });
    }

    // 初回読み込みは networkidle2 + 60s（ページの完全なレンダリングを待つ）
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1000));

    console.log('[Enhanced] 各検査を実行中...');

    const withTimeout = (fn, ms = 30000) =>
      Promise.race([fn(), new Promise(r => setTimeout(() => r({ status: 'error', message: 'タイムアウト', violations: [] }), ms))]);

    // 中間リロード用ヘルパー: analytics/WebSocket 常時接続サイトで networkidle2 が永久待機するのを防ぐため
    // 'load' イベント + 20s タイムアウトを使用（JS実行は完了、ネットワーク常時接続の影響を受けない）
    const reloadPage = () => page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(() => {});

    const results = [];

    // 1-1
    results.push(await withTimeout(() => check_1_4_10_reflow(page)));
    // viewport リセット確認
    await applyViewportPreset(page, preset).catch(() => {});

    // 1-2
    results.push(await withTimeout(() => check_2_5_8_target_size(page)));

    // 2.1.2 はヘッドレス環境の誤検知リスクが高いため PLAY スキャン(Playwright)に委譲
    results.push({ sc: '2.1.2', name: 'キーボードトラップなし', status: 'manual_required', message: 'PLAYスキャンで確認してください', violations: [] });

    // ページ再読み込みでキーボード状態リセット
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 1-4
    results.push(await withTimeout(() => check_2_4_1_skip_link(page)));

    // 1-5 SC 2.3.3 は AAA β停止中のため実行しない
    // if (includeAAA) results.push(await withTimeout(() => check_2_3_3_animation(page)));

    // 1-6
    results.push(await withTimeout(() => check_1_4_12_text_spacing(page)));

    // ページ再読み込み（スタイルリセット）
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 1-7 (2つの結果を返す)
    const focusObscured = await withTimeout(() => check_2_4_11_12_focus_obscured(page));
    if (Array.isArray(focusObscured)) results.push(...focusObscured);
    else results.push(focusObscured);

    // ページ再読み込み
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 1-8
    results.push(await withTimeout(() => check_3_2_1_2_unexpected_change(page)));

    // ページ再読み込み
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 1-9
    results.push(await withTimeout(() => check_3_3_1_error_identification(page)));

    // ページ再読み込み（Phase 2用）
    await reloadPage();
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
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 2-3
    results.push(await withTimeout(() => check_2_4_3_focus_order(page)));

    // ページ再読み込み
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 2-4
    results.push(await withTimeout(() => check_1_3_2_meaningful_sequence(page)));

    // 2-4b
    results.push(await withTimeout(() => check_1_3_3_sensory_characteristics(page)));

    // ページ再読み込み
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 2-5
    results.push(await withTimeout(() => check_1_4_4_text_resize(page)));

    // 2-6
    results.push(await withTimeout(() => check_1_2_x_media_captions(page)));

    // 2-6b SC 1.2.3 専用検査
    results.push(await withTimeout(() => check_1_2_3_audio_description(page)));

    // 2-7
    results.push(await withTimeout(() => check_2_2_2_pause_stop(page)));

    // 2-8
    results.push(await withTimeout(() => check_3_3_8_accessible_authentication(page)));

    // 2-9 (SC 2.3.1)
    results.push(await withTimeout(() => check_2_3_1_three_flashes(page)));

    // ページ再読み込み（Phase 3用）
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // --- Phase 3 ---
    console.log('[Enhanced] Phase 3 検査中...');

    // 3-1
    results.push(await withTimeout(() => check_1_4_13_hover_content(page)));

    // ページ再読み込み
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));

    // 3-2
    results.push(await withTimeout(() => check_1_4_1_use_of_color(page)));

    // 3-2b SC 1.4.3 テキストコントラスト（Puppeteer DOM計算）
    results.push(await withTimeout(() => check_1_4_3_text_contrast(page)));

    // 3-3
    results.push(await withTimeout(() => check_1_4_5_images_of_text(page)));

    // 3-4
    results.push(await withTimeout(() => check_2_2_1_timing_adjustable(page)));

    // 3-5
    await reloadPage();
    await new Promise(r => setTimeout(r, 1000));
    results.push(await withTimeout(() => check_3_3_3_error_suggestion(page)));

    // 3-6
    results.push(await withTimeout(() => check_2_5_1_7_gestures(page)));

    // ページ再読み込み（Section A用）
    await reloadPage();
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
    if (!handlerTimedOut) endWithJson(200, { success: true, url, viewportPreset: preset, results: finalResults, includeAAA: !!includeAAA, checkedAt: new Date().toISOString() });

  } catch (error) {
    console.error('[Enhanced] Error:', error);
    if (!handlerTimedOut) endWithJson(500, { error: error.message });
  } finally {
    clearTimeout(handlerTimer);
    if (browser) await browser.close();
  }
});

/**
 * AI評価 API
 */
function compactForAI(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function splitScForAI(scText) {
  if (!scText) return [];
  return String(scText)
    .split(/[\/,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function axeScFromTagsForAI(tags) {
  if (!Array.isArray(tags)) return '';
  for (const tag of tags) {
    const match = String(tag).match(/^wcag(\d)(\d)(\d{1,2})$/);
    if (match) return `${match[1]}.${match[2]}.${parseInt(match[3], 10)}`;
  }
  return '';
}

function scMatchesTargetsForAI(scText, targetScSet) {
  if (!targetScSet || targetScSet.size === 0) return true;
  const tokens = splitScForAI(scText);
  if (tokens.length === 0) return true;
  return tokens.some(sc => {
    if (targetScSet.has(sc)) return true;
    if (/^\d+\.\d+\.x$/i.test(sc)) {
      const prefix = sc.replace(/\.x$/i, '.');
      return [...targetScSet].some(target => target.startsWith(prefix));
    }
    return false;
  });
}

function compactAxeNodeForAI(node) {
  const target = Array.isArray(node?.target) ? node.target.join(' > ') : node?.target;
  return {
    target: compactForAI(target, 160),
    html: compactForAI(node?.html, 220),
    failureSummary: compactForAI(node?.failureSummary, 220)
  };
}

function compactBasicRuleForAI(rule) {
  return {
    id: rule.id || '',
    sc: axeScFromTagsForAI(rule.tags),
    impact: rule.impact || '',
    help: compactForAI(rule.help || rule.description, 220),
    targetCount: Array.isArray(rule.nodes) ? rule.nodes.length : 0,
    samples: (rule.nodes || []).slice(0, 3).map(compactAxeNodeForAI)
  };
}

function cleanBasicResultsForAI(basicResults, targetScSet) {
  if (!basicResults || typeof basicResults !== 'object') {
    return { counts: { violations: 0, incomplete: 0, passes: 0 }, violations: [], incomplete: [], passes: [] };
  }
  const includeRule = rule => scMatchesTargetsForAI(axeScFromTagsForAI(rule?.tags), targetScSet);
  const violations = (basicResults.violations || []).filter(includeRule).slice(0, 30).map(compactBasicRuleForAI);
  const incomplete = (basicResults.incomplete || []).filter(includeRule).slice(0, 20).map(compactBasicRuleForAI);
  const passes = (basicResults.passes || []).filter(includeRule).slice(0, 15).map(rule => ({
    id: rule.id || '',
    sc: axeScFromTagsForAI(rule.tags),
    help: compactForAI(rule.help || rule.description, 160)
  }));
  return {
    counts: {
      violations: (basicResults.violations || []).length,
      incomplete: (basicResults.incomplete || []).length,
      passes: (basicResults.passes || []).length
    },
    violations,
    incomplete,
    passes
  };
}

function normalizeToolStatusForAI(status) {
  if (status === 'pass' || status === 'fail' || status === 'not_applicable') return status;
  if (status === 'manual_required' || status === 'unverified' || status === 'error') return status;
  return status ? String(status) : 'unverified';
}

function cleanStructuredResultsForAI(results, targetScSet) {
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r && scMatchesTargetsForAI(r.sc, targetScSet))
    .slice(0, 80)
    .map(r => ({
      sc: r.sc || '',
      name: compactForAI(r.name || r.title || '', 120),
      status: normalizeToolStatusForAI(r.status),
      message: compactForAI(r.message || r.reason || '', 260),
      violations: (Array.isArray(r.violations) ? r.violations : [])
        .slice(0, 4)
        .map(v => compactForAI(v, 180))
    }));
}

function buildToolResultsForAI({ basicResults, extResults, deepResults, playResults, targetScSet }) {
  return {
    axe: cleanBasicResultsForAI(basicResults, targetScSet),
    ext: cleanStructuredResultsForAI(extResults, targetScSet),
    deep: cleanStructuredResultsForAI(deepResults, targetScSet),
    play: cleanStructuredResultsForAI(playResults, targetScSet)
  };
}

function toolResultCountsForAI(toolResults) {
  const countByStatus = (items) => {
    const counts = {};
    (items || []).forEach(item => {
      counts[item.status || 'unknown'] = (counts[item.status || 'unknown'] || 0) + 1;
    });
    return counts;
  };
  return {
    axeViolations: toolResults.axe?.violations?.length || 0,
    axeIncomplete: toolResults.axe?.incomplete?.length || 0,
    axePasses: toolResults.axe?.passes?.length || 0,
    ext: countByStatus(toolResults.ext),
    deep: countByStatus(toolResults.deep),
    play: countByStatus(toolResults.play)
  };
}

function relevantToolFindingsForAI(toolResults, ref) {
  const matches = item => scMatchesTargetsForAI(item?.sc, new Set([ref]));
  const findings = [];
  (toolResults.axe?.violations || []).filter(matches).slice(0, 3).forEach(item => {
    findings.push({ source: 'axe', status: 'fail', id: item.id, message: item.help, samples: item.samples });
  });
  (toolResults.axe?.incomplete || []).filter(matches).slice(0, 2).forEach(item => {
    findings.push({ source: 'axe', status: 'unverified', id: item.id, message: item.help, samples: item.samples });
  });
  (toolResults.axe?.passes || []).filter(matches).slice(0, 2).forEach(item => {
    findings.push({ source: 'axe', status: 'pass', id: item.id, message: item.help });
  });
  ['ext', 'deep', 'play'].forEach(source => {
    (toolResults[source] || []).filter(matches).slice(0, 4).forEach(item => {
      findings.push({ source, status: item.status, sc: item.sc, message: item.message, violations: item.violations });
    });
  });
  return findings.slice(0, 8);
}

function getMultiVerificationMethodForAI(item) {
  const ref = item?.ref || '';
  const methods = {
    '1.1.1': '画像リストの各imgを以下の順で評価する。【スキップ条件（違反にしない）】isHidden=trueは評価不要。role="presentation"またはrole="none"は評価不要。ariaLabelまたはariaLabelledbyが存在すればalt欠落でもpass。【隣接テキストによる装飾判定 - 最優先】同一リンク（a要素）内にscreen-reader-text・sr-only・visually-hidden等のSRテキストスパンがある場合、または同一li・div・figure・article等の親要素内に同じ内容を伝える可視テキスト（p・span・figcaption・h2・h3等）がある場合、その画像は装飾扱いであり alt="" はWCAG準拠（pass）。隣接テキストが画像と同じ情報（例：動物名・タイトル・リンク先）を提供している場合は絶対にfailにしてはならない。これは冗長なalt値を避けるためのWCAGベストプラクティスである。【alt=""（空）- 最重要】alt=""は意図的な装飾画像の宣言であり、それ自体はWCAG準拠（pass）。たとえ画像が意味を持つように見えても、alt=""を持つ画像を単独でfailにしてはならない。例外はinLink=trueかつBASICのrelevantToolFindingsにlink-name違反がある場合のみ（その場合はリンク名無しとして扱う）。【alt=null（属性なし）】上記スキップ条件を満たさない場合はfail。BASICがすでにfailを出している場合は違反内容を具体化する。【alt値の品質評価（最重要）】BASICが構造的には問題なしと判定した画像について、alt値が意味を持つかを確認する: (1)ファイル名・拡張子を含む（"image001.jpg" "photo.png"等）→fail、(2)汎用語のみのalt（"image" "img" "photo" "pic" "画像" "写真" "バナー" "アイコン" "図" 等）→fail、(3)【重要】汎用語＋連番のパターン（"Image2" "Image3" "img01" "photo_3" "pic2"等、単語に数字を付けただけのもの）は意味のある代替テキストではないのでfail、(4)スクリーンショットで画像が確認できれば内容との一致を評価。全画像がスキップまたは適切なalt/aria名を持つ場合はpass。一部確認不能ならmanual_required。',
    '1.2.1': 'audio/video/iframe等のメディアをHTMLと画面から探す。音声のみコンテンツがあり、近接する文字起こし・テキスト代替・説明リンクが確認できればpass。メディア内容の聴取が必要ならmanual_required。メディアが無ければnot_applicable。',
    '1.2.2': '収録済み動画があるか確認し、track kind="captions"、字幕ボタン、キャプション付きプレーヤー、字幕/文字起こしリンクを証拠にする。動画があるが字幕の有無をHTML/画面で確認できなければmanual_required。',
    '1.2.3': '動画に音声解説または同等のメディア代替があるか、リンク・説明・track・プレーヤー表示から確認する。映像内容の理解が必要で証拠が無い場合はmanual_required。動画が無ければnot_applicable。',
    '1.2.5': '収録済み動画の音声解説を確認する。音声解説付き版、説明音声トラック、詳細なテキスト代替が明示されていればpass。ページ証拠だけで確認不能ならmanual_required。',
    '1.3.3': 'DEEP結果に感覚依存らしい指示文候補があればそれを優先確認しつつ、「右の」「左の」「上の」「丸い」「赤い」「音が鳴ったら」など、位置・形・色・音だけで操作を指示する文言を探す。テキスト名やラベルも併記されていればpass、感覚的特徴だけならfail。',
    '1.4.1': 'DEEP結果で本文リンク識別とナビゲーション current/selected の視覚差分を先に確認し、その上で色語・凡例・必須/エラー/成功表示・操作指示の意味依存を確認する。「赤いボタン」「緑が完了」等、色だけで情報や操作を伝える場合はfail。文字・アイコン・形状・ラベルも併用されていればpass。証拠不足ならmanual_required。',
    '1.4.5': 'スクリーンショットとimg/背景画像から、本文や操作説明が画像化されていないか確認する。ロゴ等の例外を除き、読ませる目的の文字画像があればfail。画像内文字の有無が不確実ならmanual_required。',
    '2.4.4': 'リンクテキストと直近の見出し・段落・aria-label/titleを見て目的が分かるか確認する。「こちら」「詳細」「click here」等が文脈なしで並ぶ場合はfail。【画像のみのリンク】inLink=trueのimgがある場合、そのaltがリンク先を説明しているか確認する。alt="Image2"・alt="Image4"・alt="img01"等のファイル名パターン（汎用語＋数字）はリンク目的を説明せずfail（SC 2.4.4違反）。alt=""または属性なしの画像のみのリンクもfail。DEEPまたはBASICで画像リンクのalt問題が検出されていればそれを証拠として使用する。リンクが無ければnot_applicable。',
    '2.4.5': '検索、サイトマップ、グローバルナビ、パンくず、関連リンクなど、ページへ到達する複数手段の証拠を探す。単一ページ証拠ではサイト全体を確認できない場合はmanual_required。',
    '3.2.3': '複数ページ比較またはツール結果がある場合だけ、ナビゲーション順序・構成の一貫性を判定する。単一ページだけではmanual_required。明確な比較結果があればそれを尊重する。',
    '3.2.4': '同じ機能を持つコンポーネントの名称・ラベル・アイコンが一貫しているか、ツール結果や画面上の繰り返し要素で確認する。サイト横断確認が必要ならmanual_required。',
    '3.2.6': 'ヘルプ、問い合わせ、サポート導線の位置が一貫しているかをツール結果とヘッダー/フッターから確認する。複数ページ比較が無い場合はmanual_required。',
    '3.3.1': 'フォーム送信前後の可視エラー、aria-invalid、role="alert"、エラー文言、入力項目との関連付けを確認する。フォームが無ければnot_applicable。安全に送信できずエラー状態を作れない場合はmanual_required。',
    '3.3.3': '入力エラーに対して修正提案が具体的に出るか確認する。例、形式、必須理由、許容値などがあればpass。フォームはあるがエラー状態を確認できない場合はmanual_required。',
    '3.3.4': '法律・金融・データ変更・試験等の重要送信フォームか確認し、取消・確認・修正ステップの証拠を探す。該当フォームが無ければnot_applicable。送信フロー確認が必要ならmanual_required。',
    '3.3.7': '同じ情報の再入力を求めるフォームや複数ステップの重複入力を探す。autocompleteや前入力の再利用が見える場合はpass。ページ単体でフローを追えない場合はmanual_required。',
    '3.3.8': 'ログイン/認証フォームに、記憶テスト・CAPTCHA・パズル等の認知機能テストがあるか確認する。代替手段が無ければfail。認証UIが無ければnot_applicable。'
  };
  return methods[ref] || 'HTML、スクリーンショット、各自動スキャン結果から判断できる証拠だけで判定する。証拠不足ならmanual_requiredにする。';
}

app.post('/api/ai-evaluate', async (req, res) => {
  const { url, checkItems, viewportPreset, basicResults, extResults, deepResults, playResults } = req.body;
  const incomingCheckItems = Array.isArray(checkItems) ? checkItems : [];
  const hasAiTargetFlag = incomingCheckItems.some(item => Object.prototype.hasOwnProperty.call(item || {}, 'aiTarget'));
  const safeCheckItems = incomingCheckItems.filter(item => item && (!hasAiTargetFlag || item.aiTarget === true));
  const provider = AI_PROVIDER || 'gemini';
  _lastAiDebug = { provider, stage: 'received', url, itemCount: safeCheckItems.length, timestamp: new Date().toISOString() };
  const fallbackSuggestion = 'AI API設定後に再実行してください';
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
    return res.json({ success: true, model: provider, results: [] });
  }
  // プロバイダーに応じたAPIキー確認
  const activeApiKey =
    (provider === 'claude-sonnet' || provider === 'claude-opus')          ? ANTHROPIC_API_KEY
    : (provider === 'gpt-4o' || provider === 'o3' || provider === 'gpt-5') ? OPENAI_API_KEY
    : GEMINI_API_KEY;
  const keyNameMap = {
    'gemini': 'GEMINI_API_KEY', 'gemini-pro': 'GEMINI_API_KEY',
    'claude-sonnet': 'ANTHROPIC_API_KEY', 'claude-opus': 'ANTHROPIC_API_KEY',
    'gpt-4o': 'OPENAI_API_KEY', 'o3': 'OPENAI_API_KEY', 'gpt-5': 'OPENAI_API_KEY'
  };
  if (!activeApiKey) {
    const keyName = keyNameMap[provider] || 'AI_API_KEY';
    const reason = `${keyName} が未設定のため自動評価をスキップしました`;
    console.warn('[AI] ' + reason);
    _lastAiDebug = { ..._lastAiDebug, stage: 'no_api_key', reason };
    return res.json({
      success: true,
      model: 'manual-fallback',
      fallback: true,
      aiErrorType: 'api_error',
      detailLabel: 'APIエラー',
      reason,
      results: makeFallbackResults(reason)
    });
  }

  let browser;

  try {
    const preset = normalizeViewportPreset(viewportPreset);
    const activeModel = AI_MODEL_MAP[provider] || provider;
    console.log(`[${activeModel}] AI評価開始: ${url} (View ${preset})`);
    _lastAiDebug = { ..._lastAiDebug, stage: 'browser_launch' };
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

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
      .substring(0, 8000);

    // 1.1.1 alt品質評価用: img要素リストを構造化して抽出
    const imgAltList = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).slice(0, 20).map(img => {
        const alt = img.getAttribute('alt');
        return {
          src: (img.getAttribute('src') || '').split('/').pop().replace(/[?#].*$/, '').slice(0, 50),
          alt: alt,           // null=属性なし, ''=装飾(空alt), string=値あり
          ariaLabel: img.getAttribute('aria-label') || null,
          ariaLabelledby: img.getAttribute('aria-labelledby') || null,
          role: img.getAttribute('role') || null,
          inLink: !!img.closest('a'),
          inButton: !!img.closest('button'),
          isHidden: img.getAttribute('aria-hidden') === 'true'
        };
      });
    });

    await page.close();
    const targetScSet = new Set(safeCheckItems.map(item => item.ref).filter(Boolean));
    const toolResults = buildToolResultsForAI({ basicResults, extResults, deepResults, playResults, targetScSet });
    const toolResultCounts = toolResultCountsForAI(toolResults);
    _lastAiDebug = {
      ..._lastAiDebug,
      stage: 'page_done_calling_ai',
      targetRefs: [...targetScSet],
      toolResultCounts
    };

    // PLAYスキャン結果でカバー済みのアイテムをAI送信前に解決する
    // playResults は [{ sc, status, message, violations }] 形式
    const playScMap = new Map(); // sc → { status, message, violations }
    if (Array.isArray(playResults)) {
      playResults.forEach(r => {
        if (!r || !r.sc) return;
        // 複合SC（"2.1.1/2.1.3" 等）を分割してそれぞれ登録
        String(r.sc).split(/[/,]/).map(s => s.trim()).filter(Boolean).forEach(sc => {
          if (!playScMap.has(sc)) playScMap.set(sc, r);
        });
      });
    }

    // AI に送る項目と PLAY 結果で解決済みの項目に分離
    const playResolvedByOriginalIdx = new Map(); // originalIndex → result
    const itemsForAI = [];
    safeCheckItems.forEach((item, i) => {
      const sc = (item.ref || '').trim();
      const playR = playScMap.get(sc);
      // PLAY が unverified 以外の結果を持っている場合は解決済みとして扱う
      if (playR && playR.status && playR.status !== 'unverified') {
        const aiStatus = playR.status === 'fail' ? 'fail'
          : playR.status === 'pass' ? 'pass'
          : playR.status === 'not_applicable' ? 'not_applicable'
          : 'manual_required';
        const violations = Array.isArray(playR.violations) ? playR.violations : [];
        playResolvedByOriginalIdx.set(i, {
          index: i,
          status: aiStatus,
          confidence: 0.95,
          reason: `Playwright自動テスト結果: ${playR.message || aiStatus}`,
          evidence: violations.slice(0, 3).join(' / '),
          selector: '',
          suggestion: aiStatus === 'fail' ? (violations[0] || '') : ''
        });
      } else {
        itemsForAI.push({ ...item, _origIdx: i });
      }
    });

    console.log(`[MULTI] PLAY解決済: ${playResolvedByOriginalIdx.size}件, AI送信: ${itemsForAI.length}件`);

    if (itemsForAI.length === 0) {
      const normalizedPlayResults = safeCheckItems.map((_, idx) => playResolvedByOriginalIdx.get(idx) || {
        index: idx,
        status: 'manual_required',
        confidence: 0.3,
        reason: 'MULTIのAI評価対象がありませんでした',
        evidence: '',
        selector: '',
        suggestion: '対象項目の設定を確認してください'
      });
      return res.json({
        success: true,
        model: 'tool-resolved',
        tokenLimited: false,
        partialResults: false,
        missingCount: 0,
        warning: '',
        results: normalizedPlayResults
      });
    }

    const methodGuide = {};
    itemsForAI.forEach(item => {
      if (item.ref && !methodGuide[item.ref]) {
        methodGuide[item.ref] = getMultiVerificationMethodForAI(item);
      }
    });
    const evaluationItems = itemsForAI.map((item, i) => ({
      index: i,
      originalIndex: item.index ?? item._origIdx,
      wcag: item.ref,
      level: item.level,
      item: item.text,
      findings: relevantToolFindingsForAI(toolResults, item.ref)
    }));

    const prompt = `あなたはプロのアクセシビリティ監査員です。
MULTI SCANの役割は、AIが得意な自然言語・視覚的文脈の項目だけを評価し、BASIC/EXT/DEEP/PLAYの自動検査結果を補強・ファクトチェックすることです。
自動ツールで確定しているfail/pass/not_applicableと矛盾する判定を避け、failの場合は何が違反かと改善案を具体的に書いてください。
証拠が足りない場合は推測でpass/failにせず、必ずmanual_requiredにしてください。

## 対象URL
${url}

## 自動検査結果
${JSON.stringify(toolResults)}

## HTML（抜粋）
${shortHtml}
${targetScSet.has('1.1.1') ? `\n## 画像リスト（alt評価用、最大20件）\n${JSON.stringify(imgAltList)}\n` : ''}
## 検証方法ガイド（wcag番号→判定手順）
${JSON.stringify(methodGuide)}

## 評価対象
${JSON.stringify(evaluationItems)}

## 判定ルール
1. 評価対象配列にない項目は評価しない。
2. 検証方法ガイドの wcag 番号に対応する手順に従って判定する。
3. findings に fail がある場合は、その事実を尊重して違反内容と改善案を具体化する。
4. findings に fail または unverified がある場合は、1〜2文の簡潔な修正アクションを suggestion に必ず入れる。
5. findings に pass があり、HTML/画面にも矛盾が無い場合は、同じSCで新たな違反を作らない。
6. not_applicable は、該当要素や該当フローがページに存在しない根拠を書ける場合だけ使う。
7. pass/fail には、HTML断片・CSSセレクタ・画面上の文言・自動ツール名など、再現可能なevidenceを必ず入れる。
8. 「問題があります」「確認が必要です」だけの汎用文は禁止。

## 出力形式（JSONオブジェクトのみ、説明不要）
{
  "results": [
  {
    "index": 0,
    "status": "pass" | "fail" | "manual_required" | "not_applicable",
    "confidence": 0.3〜1.0,
    "reason": "具体的な判断理由。検出内容を1文で明記",
    "evidence": "HTML断片、CSSセレクタ、画面上の文言、自動ツール結果などの根拠",
    "selector": "該当するCSSセレクタ。属性値にダブルクォートを使わないこと（例: img[alt] は OK、img[alt=\"\"] は NG）。特定不能なら空文字",
    "suggestion": "修正アクション。fail/manual_requiredなら1〜2文で具体的に書く。pass/not_applicableなら空文字"
  }
  ],
  "improvementPlan": {
    "summary": "全スキャン結果を踏まえた改善方針を2〜3文で要約",
    "priorityActions": [
      {
        "priority": "high" | "medium" | "low",
        "title": "改善タスク名",
        "reason": "どの検出結果に基づくか。違反内容と影響",
        "steps": ["具体的な修正手順1", "具体的な修正手順2"],
        "relatedSc": ["2.4.4"],
        "sources": ["BASIC", "MULTI"]
      }
    ],
    "manualChecks": ["自動検査だけでは確定できず、手動確認が必要な確認事項"],
    "quickWins": ["短時間で改善できる項目"]
  }
}

全${itemsForAI.length}項目を評価してください。
improvementPlan はBASIC/EXT/DEEP/PLAY/MULTIの全結果を統合して作成し、最大6件の priorityActions に絞ってください。`;

    console.log(`[${provider}] AI API 呼び出し中...`);
    let aiResponse = '';
    let usedModel = provider;
    let aiTokenLimited = false;
    try {
      const aiResult = await callAI(prompt, screenshot);
      aiResponse = aiResult.text;
      usedModel = aiResult.modelName;
      aiTokenLimited = !!aiResult.tokenLimited;
      if (aiTokenLimited) console.warn('[AI] トークン上限に達しました。応答が途中で切れている可能性があります。');
    } catch (apiError) {
      const { httpStatus, payload } = buildAIErrorResponse(apiError, provider, activeModel);
      console.warn('[AI] ' + payload.error);
      _lastAiDebug = { ..._lastAiDebug, stage: 'api_error', httpStatus, error: payload.error, rawError: apiError?.message };
      return res.status(httpStatus).json(payload);
    }
    console.log('AI応答受信, 長さ:', aiResponse.length);
    _lastAiDebug = { ..._lastAiDebug, stage: 'ai_responded', model: usedModel, length: aiResponse.length, tokenLimited: aiTokenLimited, raw: aiResponse, timestamp: new Date().toISOString() };
    
    // AIが CSS 属性セレクタ内のダブルクォートをエスケープしないケース対応。
    // 例: "img[src*="file.jpg"][alt=""]" → "img[src*="file.jpg"][alt]"
    // JSON文字列の外にいる状態でしか書き換えないため、正常なJSON文字列は壊さない。
    function sanitizeAiJson(text) {
      // CSS属性セレクタ [attr="value"] の値のみを除去する
      // 旧実装: 文字単位ループで JSON 構造の [ も処理してしまい配列を破壊するバグがあった
      // 新実装: CSS属性セレクタ固有パターン（識別子=クォート値）にのみマッチする正規表現を使用
      // JSON配列 [{...}] や [1,2,3] は識別子+= で始まらないためマッチしない
      return text.replace(
        /\[([a-zA-Z_][\w:-]*[*^$~|!]?)=(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')\]/g,
        '[$1]'
      );
    }

    // ブラケットカウント方式で JSON 配列を抽出
    // 正規表現は文字列内の ] や } に誤反応するため使用しない
    function extractJsonArray(text) {
      // マークダウンコードブロックを除去
      const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
      for (const src of [cleaned, text.trim()]) {
        // 直接パース
        try {
          const p = JSON.parse(src);
          if (Array.isArray(p)) return p;
          if (p && typeof p === 'object') {
            const inner = Object.values(p).find(v => Array.isArray(v));
            if (inner) return inner;
          }
        } catch (e) {}
        // ブラケットカウントで配列位置を特定
        const start = src.indexOf('[');
        if (start === -1) continue;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < src.length; i++) {
          const c = src[i];
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '[') depth++;
            else if (c === ']') {
              depth--;
              if (depth === 0) {
                try {
                  const raw = src.slice(start, i + 1)
                    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
                    .replace(/,(\s*[}\]])/g, '$1'); // 末尾カンマ除去
                  const p = JSON.parse(raw);
                  if (Array.isArray(p)) return p;
                } catch (e) {}
                break;
              }
            }
          }
        }
      }
      return null;
    }

    function extractJsonObject(text) {
      const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
      for (const src of [cleaned, text.trim()]) {
        try {
          const parsed = JSON.parse(src);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (e) {}
        const start = src.indexOf('{');
        if (start === -1) continue;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < src.length; i++) {
          const c = src[i];
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                try {
                  const raw = src.slice(start, i + 1)
                    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
                    .replace(/,(\s*[}\]])/g, '$1');
                  const parsed = JSON.parse(raw);
                  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                } catch (e) {}
                break;
              }
            }
          }
        }
      }
      return null;
    }

    function normalizeImprovementPlan(plan) {
      if (!plan || typeof plan !== 'object') return null;
      const toText = (value, max = 600) => compactForAI(value, max);
      const toList = (value, maxItems = 6, maxText = 220) => (
        Array.isArray(value) ? value : []
      ).map(item => toText(item, maxText)).filter(Boolean).slice(0, maxItems);
      const priorityActions = (Array.isArray(plan.priorityActions) ? plan.priorityActions : [])
        .filter(action => action && typeof action === 'object')
        .slice(0, 6)
        .map(action => ({
          priority: ['high', 'medium', 'low'].includes(action.priority) ? action.priority : 'medium',
          title: toText(action.title, 160),
          reason: toText(action.reason, 360),
          steps: toList(action.steps, 5, 220),
          relatedSc: Array.isArray(action.relatedSc)
            ? action.relatedSc.map(sc => compactForAI(sc, 40)).filter(Boolean).slice(0, 6)
            : [],
          sources: Array.isArray(action.sources)
            ? action.sources.map(src => compactForAI(src, 40)).filter(Boolean).slice(0, 6)
            : []
        }))
        .filter(action => action.title || action.reason || action.steps.length);
      const normalized = {
        summary: toText(plan.summary, 700),
        priorityActions,
        manualChecks: toList(plan.manualChecks, 6, 260),
        quickWins: toList(plan.quickWins, 6, 220)
      };
      return normalized.summary || normalized.priorityActions.length || normalized.manualChecks.length || normalized.quickWins.length
        ? normalized
        : null;
    }

    // トークン切れで JSON が不完全な場合、完結しているオブジェクトを部分救出する
    function extractPartialItems(text) {
      const items = [];
      const src = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
      let i = src.indexOf('{');
      while (i !== -1 && i < src.length) {
        let depth = 0, inStr = false, esc = false, start = i;
        for (; i < src.length; i++) {
          const c = src[i];
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
          }
        }
        if (depth === 0) {
          try {
            const obj = JSON.parse(src.slice(start, i)
              .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
              .replace(/,(\s*[}\]])/g, '$1'));
            if (obj && typeof obj.index === 'number') items.push(obj);
          } catch (e) {}
        }
        i = src.indexOf('{', i);
      }
      return items;
    }

    let results = [];
    const sanitizedResponse = sanitizeAiJson(aiResponse);
    const extractedObject = extractJsonObject(sanitizedResponse);
    const improvementPlan = normalizeImprovementPlan(extractedObject?.improvementPlan);
    const extracted = Array.isArray(extractedObject?.results) ? extractedObject.results : extractJsonArray(sanitizedResponse);
    if (extracted) {
      results = extracted;
    } else if (aiTokenLimited) {
      // トークン上限による不完全なJSONから部分救出
      const partial = extractPartialItems(aiResponse);
      if (partial.length > 0) {
        results = partial;
        console.log(`部分救出: ${partial.length}件のアイテムを取得`);
      }
    }
    
    console.log('パース完了, 結果数:', results.length);
    
    // AI結果が空でPLAY解決済みも0件ならエラー
    if (results.length === 0 && playResolvedByOriginalIdx.size === 0) {
      console.log('AI応答（先頭500文字）:', aiResponse.substring(0, 500));
      return res.status(502).json(buildAIJsonParseErrorResponse(usedModel, aiResponse));
    }

    // AIの結果インデックスは itemsForAI の連番 → _origIdx で元インデックスに変換
    const byOriginalIdx = new Map(playResolvedByOriginalIdx); // PLAY解決済みをベースにマージ
    results.forEach((result) => {
      const aiIdx = Number(result.index);
      if (!Number.isInteger(aiIdx) || aiIdx < 0 || aiIdx >= itemsForAI.length) return;
      const origIdx = itemsForAI[aiIdx]._origIdx;
      byOriginalIdx.set(origIdx, {
        index: origIdx,
        status: normalizeStatus(result.status),
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
        reason: result.reason || 'AIの判断理由が未取得です',
        evidence: result.evidence || result.selector || result.target || '',
        selector: result.selector || '',
        suggestion: result.suggestion || ''
      });
    });

    const missingIndexes = [];
    const normalizedResults = safeCheckItems.map((_, idx) => {
      if (!byOriginalIdx.has(idx)) missingIndexes.push(idx);
      return byOriginalIdx.get(idx) || {
        index: idx,
        status: 'manual_required',
        confidence: 0.3,
        reason: aiTokenLimited
          ? 'AI応答がトークン上限で途中終了したため、手動確認が必要です'
          : 'AI応答に該当結果が無かったため、手動確認が必要です',
        evidence: '',
        selector: '',
        suggestion: '再実行するか手動で確認してください'
      };
    });

    const partialResults = aiTokenLimited || missingIndexes.length > 0;
    const warning = partialResults
      ? aiTokenLimited
        ? `AI応答がトークン上限で途中終了した可能性があります（未取得 ${missingIndexes.length} 項目）。`
        : `AI応答に未取得項目があります（未取得 ${missingIndexes.length} 項目）。`
      : '';

    res.json({
      success: true,
      model: usedModel,
      tokenLimited: aiTokenLimited,
      partialResults,
      missingCount: missingIndexes.length,
      warning,
      improvementPlan,
      results: normalizedResults
    });

  } catch (error) {
    console.error('AI評価エラー発生:', error.message);
    _lastAiDebug = { ..._lastAiDebug, stage: 'exception', error: error.message, stack: error.stack?.slice(0, 500) };
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
async function sheetsApiFetch(url, options, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    const cloned = res.clone();
    let data = {};
    try { data = await cloned.json(); } catch (_) {}
    const errMsg = data.error?.message || '';
    const isQuota = res.status === 429 || /quota|rate.?limit/i.test(errMsg);
    if (attempt < maxRetries && isQuota) {
      const delay = Math.min(1500 * Math.pow(2, attempt), 16000);
      console.warn(`[Sheets] quota exceeded, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return res;
  }
}

app.post('/api/export-report', async (req, res) => {
  const { coverRows, pages, improvementRows } = req.body;
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
    const COL = 10; // 列数（SC,項目,合否,検出数,検出箇所,指摘内容,改善方法,検査機関,お客様,再検査）

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
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidateTitle = attempt === 0 ? sheetTitle : `${sheetTitle}_${attempt + 1}`;
        addRes = await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
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

      // フロントエンドで buildSampleSheetData 変換済みの行を使用
      const sheetRows = page.sheetRows || [];

      const writeRes = await sheetsApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheetTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', headers, body: JSON.stringify({ values: sheetRows }) }
      );
      const writeData = await writeRes.json();
      if (writeData.error) throw new Error(`書き込み失敗: ${writeData.error.message}`);

      // 書式設定
      // sheetRows 構造: [URL行, 達成率行, 空行, ヘッダー行, データ行...]
      const resultColIdx = 2; // C列（合否）
      const headerRowIdx = 3; // 0-based
      const dataStartRowIdx = 4;
      const formatReqs = [
        // ヘッダー行（4行目、index=3）
        { repeatCell: {
          range: { sheetId: newSheetId, startRowIndex: headerRowIdx, endRowIndex: headerRowIdx + 1, startColumnIndex: 0, endColumnIndex: COL },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
            horizontalAlignment: 'CENTER'
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
        }},
        // 列幅: SC, 項目, 合否, 検出数, 検出箇所, 指摘内容, 改善方法, 検査機関記入欄, お客様記入欄, 再検査
        ...[70,240,70,60,180,280,200,120,120,70].map((px, i) => ({
          updateDimensionProperties: {
            range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: px }, fields: 'pixelSize'
          }
        })),
        // 合否列の条件付き書式（データ行: startRowIndex: 4）
        ...[ ['不合格', { red: 0.96, green: 0.8, blue: 0.8 }, { red: 0.7, green: 0, blue: 0 }],
             ['合格',   { red: 0.8, green: 0.94, blue: 0.8 }, { red: 0, green: 0.4, blue: 0 }],
             ['未検証', { red: 0.93, green: 0.93, blue: 0.93 }, { red: 0.4, green: 0.4, blue: 0.4 }]
        ].map(([val, bg, fg], idx) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId: newSheetId, startRowIndex: dataStartRowIdx, startColumnIndex: resultColIdx, endColumnIndex: resultColIdx + 1 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: val }] },
                format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: val === '不合格' || val === '合格' } }
              }
            }, index: idx
          }
        })),
        // フリーズ（URL/達成率/空/ヘッダー = 4行）
        { updateSheetProperties: {
          properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 4 } },
          fields: 'gridProperties.frozenRowCount'
        }}
      ];

      await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers, body: JSON.stringify({ requests: formatReqs })
      });

      pageTabInfo.push({ url: page.url, sheetId: newSheetId, title: sheetTitle, stats: page.stats || {} });
      console.log(`[Report] 結果シート作成: "${sheetTitle}"`);
    }

    // --- 表紙シート作成 ---
    const coverTitle = `表紙_${dateStr}_${timeStr}`;
    const addCoverRes = await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: coverTitle } } }] })
    });
    const addCoverData = await addCoverRes.json();
    if (!addCoverRes.ok) throw new Error(`表紙シート追加失敗: ${addCoverData.error?.message}`);
    const coverSheetId = addCoverData.replies[0].addSheet.properties.sheetId;

    // coverRows はフロントエンドで buildCoverSheetData により生成された行データ
    // 構造: [タイトル行, URL行, 空, ▼全体スコア, ヘッダー, 全体値, 空,
    //        ▼ページ別スコア, ページ別ヘッダー, ...ページ行, 空,
    //        ▼総合サマリー, サマリーヘッダー, ...SC行]
    const safeCoverRows = Array.isArray(coverRows) ? coverRows : [];
    const P = pages.length; // ページ数
    // 行インデックス（0-based）
    const coverTitleRow   = 0;
    const coverSectionA   = 3;  // ▼ 全体スコア
    const coverHeaderA    = 4;  // 達成率ヘッダー
    const coverSectionB   = 7;  // ▼ ページ別スコア
    const coverHeaderB    = 8;  // ページ別ヘッダー
    const coverSectionC   = 10 + P; // ▼ 総合サマリー
    const coverHeaderC    = 11 + P; // サマリーヘッダー
    const COVER_COL       = 8;  // 最大列数（ページ別スコアヘッダーが8列）

    await sheetsApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${coverTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers, body: JSON.stringify({ values: safeCoverRows }) }
    );

    // 表紙の書式
    const coverFormatReqs = [
      // タイトル行（青背景、マージ）
      { repeatCell: {
        range: { sheetId: coverSheetId, startRowIndex: coverTitleRow, endRowIndex: coverTitleRow + 1, startColumnIndex: 0, endColumnIndex: COVER_COL },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.102, green: 0.451, blue: 0.91 }
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor)'
      }},
      { mergeCells: { range: { sheetId: coverSheetId, startRowIndex: coverTitleRow, endRowIndex: coverTitleRow + 1, startColumnIndex: 0, endColumnIndex: COVER_COL }, mergeType: 'MERGE_ALL' }},
      // ▼ セクション見出し行
      ...[coverSectionA, coverSectionB, coverSectionC].filter(r => r < safeCoverRows.length).map(rowIdx => ({
        repeatCell: {
          range: { sheetId: coverSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: COVER_COL },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: { red: 0.1, green: 0.3, blue: 0.6 } },
            backgroundColor: { red: 0.9, green: 0.93, blue: 0.99 }
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      })),
      // ページ別スコア ヘッダー行
      { repeatCell: {
        range: { sheetId: coverSheetId, startRowIndex: coverHeaderB, endRowIndex: coverHeaderB + 1, startColumnIndex: 0, endColumnIndex: COVER_COL },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
          horizontalAlignment: 'CENTER'
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
      }},
      // 総合サマリー ヘッダー行
      ...(coverHeaderC < safeCoverRows.length ? [{ repeatCell: {
        range: { sheetId: coverSheetId, startRowIndex: coverHeaderC, endRowIndex: coverHeaderC + 1, startColumnIndex: 0, endColumnIndex: COVER_COL },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
          horizontalAlignment: 'CENTER'
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
      }}] : []),
      // 列幅: ページURL, 達成率, Level A, Level AA, 合格, 不合格, 未検証, 該当なし
      ...[300, 70, 70, 70, 55, 55, 55, 65].map((px, i) => ({
        updateDimensionProperties: {
          range: { sheetId: coverSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px }, fields: 'pixelSize'
        }
      })),
      // フリーズ（ページ別スコアヘッダー行まで = 9行）
      { updateSheetProperties: {
        properties: { sheetId: coverSheetId, gridProperties: { frozenRowCount: coverHeaderB + 1 } },
        fields: 'gridProperties.frozenRowCount'
      }}
    ];

    await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers, body: JSON.stringify({ requests: coverFormatReqs })
    });

    // --- 改善計画シート（improvementRows がある場合のみ）---
    let improvementTitle = null;
    if (Array.isArray(improvementRows) && improvementRows.length > 0) {
      improvementTitle = `改善計画_${dateStr}_${timeStr}`;
      const addImpRes = await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST', headers,
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: improvementTitle } } }] })
      });
      const addImpData = await addImpRes.json();
      if (!addImpRes.ok) {
        console.warn('[Report] 改善計画シート追加失敗:', addImpData.error?.message);
        improvementTitle = null;
      } else {
        const impSheetId = addImpData.replies[0].addSheet.properties.sheetId;
        await sheetsApiFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${improvementTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
          { method: 'PUT', headers, body: JSON.stringify({ values: improvementRows }) }
        );
        // ヘッダー行の書式設定
        await sheetsApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: 'POST', headers,
          body: JSON.stringify({ requests: [
            { repeatCell: {
              range: { sheetId: impSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.18, green: 0.34, blue: 0.6 },
                horizontalAlignment: 'CENTER'
              }},
              fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
            }},
            ...[50, 200, 80, 100, 300, 350].map((px, i) => ({
              updateDimensionProperties: {
                range: { sheetId: impSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
                properties: { pixelSize: px }, fields: 'pixelSize'
              }
            }))
          ]})
        });
        console.log(`[Report] 改善計画シート作成: ${improvementTitle}`);
      }
    }

    const allTabs = [coverTitle, ...(improvementTitle ? [improvementTitle] : []), ...pageTabInfo.map(p => p.title)];
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Report] Export完了: ${url} (表紙 + ${pageTabInfo.length}ページ${improvementTitle ? ' + 改善計画' : ''})`);
    res.json({ success: true, spreadsheetId, tabs: allTabs, url });

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
  const provider = AI_PROVIDER || 'gemini';
  const geminiKey    = GEMINI_API_KEY    || saved.geminiApiKey    || '';
  const anthropicKey = ANTHROPIC_API_KEY || saved.anthropicApiKey || '';
  const openaiKey    = OPENAI_API_KEY    || saved.openaiApiKey    || '';
  const aiConfigured =
    (provider === 'gemini' || provider === 'gemini-pro')            ? !!geminiKey
    : (provider === 'claude-sonnet' || provider === 'claude-opus')  ? !!anthropicKey
    : (provider === 'gpt-4o' || provider === 'o3' || provider === 'gpt-5') ? !!openaiKey
    : false;
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
      geminiConfigured: aiConfigured,
      aiProvider: provider,
      // AAA βは一時停止中。再開時は保存値参照を戻す。
      // aaaBeta: saved.aaaBeta || false
      aaaBeta: false
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

// ============================================================
// PLAYWRIGHT: Playwright アクセシビリティ検査
// ============================================================
const { chromium } = require('playwright');
const aceWindowPath = require.resolve('accessibility-checker-engine/ace-window.js');

/**
 * SC 4.1.2 - アクセシブルネーム・ロール監査（アクセシビリティスナップショット使用）
 */
async function pw_check_4_1_2_accessible_names(page) {
  const result = await page.evaluate(() => {
    const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
    const selectors = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="combobox"]', '[role="listbox"]', '[role="menuitem"]',
      '[role="switch"]', '[role="tab"]', '[role="searchbox"]'
    ];
    const nameless = [];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        function getAccessibleText(node) {
          if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return '';
          // img要素はalt属性がアクセシブルネームになる（accname-1.1）
          if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
          // aria-labelを持つ子要素はその値を使う
          if (node !== el && node.getAttribute && node.getAttribute('aria-label')) return node.getAttribute('aria-label');
          let text = '';
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) text += getAccessibleText(child);
          }
          return text;
        }
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const label = el.getAttribute('aria-label')
          ? el.getAttribute('aria-label')
          : ariaLabelledby
            ? (document.getElementById(ariaLabelledby)?.textContent || '')
            : getAccessibleText(el).trim() || el.getAttribute('title') || el.getAttribute('placeholder');
        if (!label || !label.trim()) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '';
          const role = el.getAttribute('role') || tag;
          const parentEl = el.parentElement;
          const ctx = !el.id && parentEl && parentEl !== document.body ? ` in ${parentEl.tagName.toLowerCase()}${parentEl.id ? '#'+parentEl.id : ''}` : '';
          nameless.push(`${tag}${id}${cls}${ctx} [role=${role}] アクセシブルネームなし | ${snap(el)}`);
          if (nameless.length >= 10) break;
        }
      }
      if (nameless.length >= 10) break;
    }
    return nameless;
  });
  return {
    sc: '4.1.2',
    status: result.length > 0 ? 'fail' : 'pass',
    violations: result,
    message: result.length > 0
      ? `${result.length}個のインタラクティブ要素にアクセシブルネームが未設定`
      : 'すべてのインタラクティブ要素にアクセシブルネームあり'
  };
}

/**
 * SC 4.1.3 - ステータスメッセージ（aria-live リージョン）
 */
async function pw_check_4_1_3_status_messages(page) {
  const result = await page.evaluate(() => {
    const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
    const live = Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]'));
    const dynamic = ['[class*="alert"]','[class*="notification"]','[class*="toast"]',
      '[class*="message"]','[class*="error"]','[class*="success"]','[class*="feedback"]']
      .flatMap(sel => Array.from(document.querySelectorAll(sel)))
      .filter(el => !live.some(l => l.contains(el) || el.contains(l)));
    return { liveCount: live.length, unlabeledDynamic: dynamic.slice(0, 5).map(el =>
      `${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''}${el.className ? '.'+el.className.split(' ')[0] : ''} | ${snap(el)}`
    )};
  });
  const hasIssue = result.liveCount === 0 && result.unlabeledDynamic.length > 0;
  return {
    sc: '4.1.3',
    status: result.liveCount > 0 ? 'pass' : (result.unlabeledDynamic.length > 0 ? 'fail' : 'not_applicable'),
    violations: hasIssue ? result.unlabeledDynamic.map(s => `動的コンテンツにaria-live未設定: ${s}`) : [],
    message: result.liveCount > 0
      ? `${result.liveCount}個のaria-liveリージョンを確認`
      : (result.unlabeledDynamic.length > 0 ? '動的コンテンツエリアにaria-liveが未設定' : 'aria-liveが必要な動的コンテンツなし（対象外）')
  };
}

/**
 * SC 2.4.6 - 見出しおよびラベル
 */
async function pw_check_2_4_6_headings_labels(page) {
  const issues = await page.evaluate(() => {
    const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
    const issues = [];
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      if (!h.textContent.trim()) issues.push(`空の${h.tagName.toLowerCase()}見出しタグ | ${snap(h)}`);
    });
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea').forEach(el => {
      if (el.getAttribute('aria-hidden') === 'true') return;
      const id = el.id;
      const hasLabel = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`))
        || el.getAttribute('aria-label')
        || el.getAttribute('aria-labelledby')
        || el.closest('label');
      if (!hasLabel) issues.push(`${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''}${el.name ? '[name='+el.name+']' : ''} にラベルなし | ${snap(el)}`);
    });
    return [...new Set(issues)];
  });
  return {
    sc: '2.4.6',
    status: issues.length > 0 ? 'fail' : 'pass',
    violations: issues.slice(0, 10),
    message: issues.length > 0 ? `${issues.length}件の見出し・ラベル問題を検出` : '見出し・ラベルの記述を確認（問題なし）'
  };
}

/**
 * SC 1.3.1 - 情報及び関係性（テーブル・フォームグループ構造）
 */
async function pw_check_1_3_1_info_relationships(page) {
  const issues = await page.evaluate(() => {
    const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
    const issues = [];
    document.querySelectorAll('table').forEach(table => {
      const isLayout = table.getAttribute('role') === 'presentation' || table.getAttribute('role') === 'none';
      if (!isLayout && !table.querySelector('th') && !table.querySelector('[scope]') && !table.querySelector('[role="columnheader"]')) {
        const id = table.id ? `#${table.id}` : '';
        const cls = table.className ? `.${String(table.className).split(' ')[0]}` : '';
        issues.push(`table${id}${cls} にヘッダーセルなし | ${snap(table)}`);
      }
    });
    const seen = new Set();
    document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(el => {
      const name = el.getAttribute('name');
      if (!name || seen.has(name)) return;
      const group = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
      if (group.length > 1 && !el.closest('fieldset')) {
        seen.add(name);
        issues.push(`input[name="${name}"] グループ（${group.length}件）にfieldsetなし | ${snap(el)}`);
      }
    });
    return [...new Set(issues)];
  });
  return {
    sc: '1.3.1',
    status: issues.length > 0 ? 'fail' : 'pass',
    violations: issues.slice(0, 10),
    message: issues.length > 0 ? `${issues.length}件の情報・関係性の問題を検出` : 'テーブル・フォームグループ構造を確認（問題なし）'
  };
}

/**
 * SC 2.4.7 - フォーカスの可視化（全フォーカス可能要素を順次確認）
 */
async function pw_check_2_4_7_focus_visible_all(page) {
  const issues = await page.evaluate(() => {
    // :focus-visible を正しく評価するためキーボードナビゲーションモードへ切替
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    function isTransparentColor(c) {
      return !c || c === 'transparent' || /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
    }

    const focusable = Array.from(document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }).slice(0, 40);
    const noFocus = [];
    focusable.forEach(el => {
      // 非フォーカス時のスタイルを先に取得
      if (document.activeElement === el) el.blur();
      const before = getComputedStyle(el);
      const bOutlineW = parseFloat(before.outlineWidth) || 0;
      const bBoxShadow = before.boxShadow;
      const bBg = before.backgroundColor;
      const bBorderColor = before.borderColor;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      el.focus({ preventScroll: true });
      const doc = el.ownerDocument;
      if (doc.activeElement !== el) return;
      const s = getComputedStyle(el);
      const aOutlineW = parseFloat(s.outlineWidth) || 0;
      const aOutlineC = s.outlineColor;
      const outlineOk = aOutlineW > 0 && s.outlineStyle !== 'none' && !isTransparentColor(aOutlineC);
      const shadowOk = s.boxShadow && s.boxShadow !== 'none' && s.boxShadow !== bBoxShadow;
      const bgChanged = s.backgroundColor !== bBg;
      const borderChanged = s.borderColor !== bBorderColor;
      el.blur();

      if (!outlineOk && !shadowOk && !bgChanged && !borderChanged) {
        const tag2 = el.tagName.toLowerCase();
        const id2 = el.id ? '#'+el.id : '';
        const cls2 = el.className ? '.'+String(el.className).split(' ').slice(0,2).join('.') : '';
        const text2 = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        const parentEl2 = el.parentElement;
        const ctx2 = !el.id && parentEl2 && parentEl2 !== document.body ? ` in ${parentEl2.tagName.toLowerCase()}${parentEl2.id ? '#'+parentEl2.id : ''}` : '';
        const h = el.outerHTML.replace(/\s+/g, ' ').trim();
        const snippetFv = h.length > 120 ? h.slice(0, 117) + '...' : h;
        noFocus.push(`${tag2}${id2}${cls2}${text2 ? ' "'+text2+'"' : ''}${ctx2} (outline:${s.outline}, shadow:${s.boxShadow !== 'none' ? 'あり' : 'なし'}) | ${snippetFv}`);
      }
    });
    return noFocus;
  });
  return {
    sc: '2.4.7',
    status: issues.length > 0 ? 'fail' : 'pass',
    violations: issues.slice(0, 10).map(s => `フォーカスインジケーターなし: ${s}`),
    message: issues.length > 0 ? `${issues.length}個の要素でフォーカス表示が検出されない` : `フォーカス可能要素のインジケーターを確認（問題なし）`
  };
}

/**
 * SC 2.1.1 - キーボード完全到達性（Tabキーシーケンス）
 */
async function pw_check_2_1_1_full_tab_sequence(page) {
  const MAX = 60;
  const visited = [];
  let prevKey = null;
  for (let i = 0; i < MAX; i++) {
    await page.keyboard.press('Tab');
    const cur = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute('role'),
        label: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().substring(0, 40),
        hidden: s.display === 'none' || s.visibility === 'hidden'
      };
    });
    if (!cur) break;
    const key = `${cur.tag}#${cur.id}|${cur.label}`;
    if (key === prevKey) break; // スタック
    if (i > 0 && key === visited[0]?.key) break; // ループ完了
    visited.push({ ...cur, key });
    prevKey = key;
  }
  const hidden = visited.filter(v => v.hidden);
  const issues = hidden.map(v => {
    const sel = `${v.tag}${v.id ? '#'+v.id : ''}`;
    return `非表示要素がTab順序に含まれる: ${sel}${v.label ? ' "'+v.label+'"' : ''} (role=${v.role || v.tag})`;
  });
  return {
    sc: '2.1.1',
    status: visited.length === 0 ? 'fail' : (issues.length > 0 ? 'fail' : 'pass'),
    violations: issues.slice(0, 10),
    message: visited.length === 0
      ? 'Tab操作可能な要素が見つかりません'
      : `Tab順序で${visited.length}個のインタラクティブ要素を確認${issues.length > 0 ? `（問題: ${issues.length}件）` : '（問題なし）'}`,
    tabSequence: visited.slice(0, 30).map(({ key, ...rest }) => rest)
  };
}

/** SC 2.4.2 - ページタイトル */
async function pw_check_2_4_2_page_title(page) {
  try {
    const title = await page.title();
    const trimmed = (title || '').trim();
    const violations = [];
    if (!trimmed) violations.push('titleタグがないか空白です');
    else if (trimmed.length < 3) violations.push(`タイトルが短すぎます（${trimmed.length}文字）: "${trimmed}"`);
    else if (/^(untitled|new tab|ページ|無題)$/i.test(trimmed)) violations.push(`意味のないタイトルです: "${trimmed}"`);
    return {
      sc: '2.4.2',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
      message: violations.length === 0 ? `ページタイトルあり: "${trimmed.substring(0, 50)}"` : violations[0]
    };
  } catch (e) {
    return { sc: '2.4.2', status: 'error', violations: [], message: e.message };
  }
}

/** SC 3.1.1 - ページの言語 */
async function pw_check_3_1_1_language(page) {
  try {
    const info = await page.evaluate(() => {
      const html = document.documentElement;
      const lang = html.getAttribute('lang') || html.getAttribute('xml:lang') || '';
      return { lang: lang.trim() };
    });
    const violations = [];
    if (!info.lang) violations.push('html要素にlang属性がありません');
    else if (!/^[a-zA-Z]{2,}(-[a-zA-Z0-9]+)*$/.test(info.lang)) violations.push(`langの値が不正です: "${info.lang}"`);
    return {
      sc: '3.1.1',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
      message: violations.length === 0 ? `lang="${info.lang}" が設定されています` : violations[0]
    };
  } catch (e) {
    return { sc: '3.1.1', status: 'error', violations: [], message: e.message };
  }
}

/** SC 1.3.5 - 入力目的の特定（autocomplete属性） */
async function pw_check_1_3_5_input_purpose(page) {
  try {
    const issues = await page.evaluate(() => {
      // WCAG 1.3.5 対象: 個人情報を収集するフィールドのみ
      // type から期待 autocomplete を一意に決定できるもの
      const typeToAC = {
        email: ['email'],
        tel: ['tel'],
        password: ['current-password', 'new-password'],
      };
      // name/id/placeholder パターンで個人情報フィールドを推定
      const personalInfoPatterns = [
        { re: /\bemail\b|メール/i,                      ac: 'email' },
        { re: /\btel\b|phone|電話/i,                    ac: 'tel' },
        { re: /given.?name|first.?name|名前|名$/i,      ac: 'given-name' },
        { re: /family.?name|last.?name|姓$/i,           ac: 'family-name' },
        { re: /(?:full|your|contact)?name\b|氏名|お名前/i, ac: 'name' },
        { re: /postal|zip|郵便/i,                       ac: 'postal-code' },
        { re: /\baddress\b|住所/i,                      ac: 'street-address' },
        { re: /birthday|birth.?date|生年月日/i,         ac: 'bday' },
        { re: /\busername\b|ユーザー.?名/i,             ac: 'username' },
        { re: /organization|会社.?名|組織/i,            ac: 'organization' },
        { re: /cc.?name|card.?name|カード.?名義/i,      ac: 'cc-name' },
        { re: /cc.?num|card.?num|カード.?番号/i,        ac: 'cc-number' },
        { re: /cc.?exp|card.?exp|有効.?期限/i,          ac: 'cc-exp' },
        { re: /\bcountry\b|国$/i,                       ac: 'country' },
      ];
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(el => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
      });
      const missing = [];
      inputs.forEach(el => {
        const type = (el.type || 'text').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio',
             'range', 'color', 'search', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const nameAttr = el.name ? `[name="${el.name}"]` : '';
        // type から直接判定できる場合（email/tel/password は type だけで十分な証拠）
        const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
        if (typeToAC[type]) {
          const expected = typeToAC[type];
          if (!expected.includes(ac)) {
            missing.push(`${tag}${id}${nameAttr} (type="${type}") に autocomplete="${expected[0]}" 推奨（現在: "${ac || '未設定'}"） | ${snap(el)}`);
          }
          return;
        }
        // name/id/placeholder パターンで個人情報フィールドか判定
        const hint = `${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''}`;
        for (const pat of personalInfoPatterns) {
          if (pat.re.test(hint)) {
            if (!ac || ac === 'on' || ac === 'off') {
              missing.push(`${tag}${id}${nameAttr} (type="${type}") に autocomplete="${pat.ac}" 推奨（現在: "${ac || '未設定'}"） | ${snap(el)}`);
            }
            break;
          }
        }
        // パターン不一致 = 個人情報フィールドと判定できないため 1.3.5 対象外
      });
      return missing;
    });
    return {
      sc: '1.3.5',
      status: issues.length === 0 ? 'pass' : 'fail',
      violations: issues.slice(0, 10),
      message: issues.length === 0
        ? '個人情報フィールドのautocomplete属性を確認（問題なし）'
        : `${issues.length}個の個人情報フィールドにautocompleteが不適切`
    };
  } catch (e) {
    return { sc: '1.3.5', status: 'error', violations: [], message: e.message };
  }
}

/** SC 3.3.2 - ラベルまたは説明（フォーム入力） */
async function pw_check_3_3_2_labels(page) {
  try {
    const issues = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(el => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
      });
      const unlabeled = [];
      inputs.forEach(el => {
        const type = (el.type || 'text').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
        const hasLabel = el.id && document.querySelector(`label[for="${el.id}"]`);
        const hasAriaLabel = el.getAttribute('aria-label');
        const hasAriaLabelledBy = el.getAttribute('aria-labelledby');
        const hasTitle = el.getAttribute('title');
        const hasPlaceholder = el.getAttribute('placeholder');
        const isWrapped = el.closest('label');
        if (!hasLabel && !hasAriaLabel && !hasAriaLabelledBy && !hasTitle && !hasPlaceholder && !isWrapped) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const name = el.name ? `[name="${el.name}"]` : '';
          const h = el.outerHTML.replace(/\s+/g, ' ').trim();
          const snippet = h.length > 120 ? h.slice(0, 117) + '...' : h;
          unlabeled.push(`${tag}${id}${name} (type="${type}") にラベルなし | ${snippet}`);
        }
      });
      return unlabeled;
    });
    return {
      sc: '3.3.2',
      status: issues.length === 0 ? 'pass' : 'fail',
      violations: issues.slice(0, 10),
      message: issues.length === 0
        ? 'フォーム入力すべてにラベルまたは説明があります'
        : `${issues.length}個の入力欄にラベルや説明がありません`
    };
  } catch (e) {
    return { sc: '3.3.2', status: 'error', violations: [], message: e.message };
  }
}

/** SC 2.5.3 - 名前の中のラベル（アクセシブルネームに視覚的ラベルが含まれるか） */
async function pw_check_2_5_3_label_in_name(page) {
  try {
    const issues = await page.evaluate(() => {
      const interactives = Array.from(document.querySelectorAll(
        'button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]'
      )).filter(el => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      });
      const mismatches = [];
      interactives.forEach(el => {
        const visibleText = (el.textContent || el.value || el.placeholder || '').trim().toLowerCase();
        if (!visibleText) return;
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!ariaLabel) return;
        if (!ariaLabel.includes(visibleText) && !visibleText.includes(ariaLabel)) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const h = el.outerHTML.replace(/\s+/g, ' ').trim();
          const snippet = h.length > 120 ? h.slice(0, 117) + '...' : h;
          mismatches.push(`${tag}${id} 表示:"${visibleText.substring(0,20)}" ≠ aria-label:"${ariaLabel.substring(0,20)}" | ${snippet}`);
        }
      });
      return mismatches;
    });
    return {
      sc: '2.5.3',
      status: issues.length === 0 ? 'pass' : 'fail',
      violations: issues.slice(0, 10),
      message: issues.length === 0
        ? 'アクセシブルネームに視覚的ラベルが含まれています（問題なし）'
        : `${issues.length}個の要素で表示テキストとaria-labelが不一致`
    };
  } catch (e) {
    return { sc: '2.5.3', status: 'error', violations: [], message: e.message };
  }
}

/** SC 1.3.2 - 意味のある順序（Playwright版） */
async function pw_check_1_3_2_meaningful_sequence(page) {
  try {
    return await check_1_3_2_meaningful_sequence(page);
  } catch (e) {
    return { sc: '1.3.2', status: 'error', violations: [], message: e.message };
  }
}

/** SC 1.3.3 - 感覚的特徴（Playwright版） */
async function pw_check_1_3_3_sensory_characteristics(page) {
  try {
    return await check_1_3_3_sensory_characteristics(page);
  } catch (e) {
    return { sc: '1.3.3', status: 'error', violations: [], message: e.message };
  }
}

/** SC 2.1.2 - キーボードトラップなし（Playwright版） */
async function pw_check_2_1_2_keyboard_trap(page) {
  try {
    const { traps } = await detectKeyboardTrapsByTabbing(page);
    return {
      sc: '2.1.2',
      status: traps.length === 0 ? 'pass' : 'fail',
      violations: traps,
      message: traps.length === 0 ? 'キーボードトラップは検出されませんでした' : `${traps.length}箇所でキーボードトラップを確認`
    };
  } catch (e) {
    return { sc: '2.1.2', status: 'error', violations: [], message: e.message };
  }
}

/** SC 2.1.4 - 文字キーショートカット（accesskey属性の検出） */
async function pw_check_2_1_4_character_shortcuts(page) {
  try {
    const issues = await page.evaluate(() => {
      const snap = el => { const h = el.outerHTML.replace(/\s+/g, ' ').trim(); return h.length > 120 ? h.slice(0, 117) + '...' : h; };
      const els = Array.from(document.querySelectorAll('[accesskey]'));
      return els.map(el => {
        const key = el.getAttribute('accesskey');
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
        return `${tag}${id} accesskey="${key}"${label ? ` (${label})` : ''} | ${snap(el)}`;
      });
    });
    return {
      sc: '2.1.4',
      status: issues.length === 0 ? 'pass' : 'fail',
      violations: issues.slice(0, 10),
      message: issues.length === 0
        ? '文字キーショートカット（accesskey）は検出されませんでした'
        : `${issues.length}個の要素にaccesskey属性があります（無効化・変更手段を確認してください）`
    };
  } catch (e) {
    return { sc: '2.1.4', status: 'error', violations: [], message: e.message };
  }
}

/** SC 2.4.3 - フォーカス順序（Playwright版） */
async function pw_check_2_4_3_focus_order(page) {
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
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        const h = el.outerHTML.replace(/\s+/g, ' ').trim();
        const snippet = h.length > 120 ? h.slice(0, 117) + '...' : h;
        return { x: rect.left, y: rect.top, tabindex, label: `${tag}${id}${cls}${text ? ' "'+text+'"' : ''}`.slice(0, 80), snippet };
      });
      if (!info) continue;
      if (info.tabindex > 0) tabindexIssues.push(`${info.label} (tabindex=${info.tabindex}) | ${info.snippet}`);
      positions.push({ x: info.x, y: info.y, label: info.label });
    }
    let orderViolations = 0;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i-1], curr = positions[i];
      if (curr.y < prev.y - 100 && curr.x > prev.x + 100) orderViolations++;
    }
    const violations = [...tabindexIssues];
    if (orderViolations > 2) violations.push(`フォーカス順序が視覚的読み順と大きく異なる箇所が${orderViolations}件`);
    return {
      sc: '2.4.3',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
      message: violations.length === 0
        ? 'フォーカス順序は論理的です（tabindex > 0 なし）'
        : `${violations.length}件の問題: tabindex > 0 または順序の逸脱`
    };
  } catch (e) {
    return { sc: '2.4.3', status: 'error', violations: [], message: e.message };
  }
}

/** SC 2.4.11 - フォーカスが隠れない（最低限、Playwright版） */
async function pw_check_2_4_11_focus_obscured(page) {
  try {
    const maxCheck = 30;
    const violations = [];
    for (let i = 0; i < maxCheck; i++) {
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 80));
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 25);
        const parentEl = el.parentElement;
        const ctx = !el.id && parentEl && parentEl !== document.body ? ` in ${parentEl.tagName.toLowerCase()}${parentEl.id ? '#'+parentEl.id : ''}` : '';
        const h = el.outerHTML.replace(/\s+/g, ' ').trim();
        const snippet = h.length > 120 ? h.slice(0, 117) + '...' : h;
        const label = `${tag}${id}${cls}${text ? ' "'+text+'"' : ''}${ctx} | ${snippet}`.slice(0, 200);
        const selfStyle = getComputedStyle(el);
        // 2.4.11 の対象は sticky/fixed 要素による遮蔽のみ。フォーカス時に非表示の要素はスキップ。
        const hiddenOnFocus = rect.width === 0
          || rect.height === 0
          || selfStyle.display === 'none'
          || selfStyle.visibility === 'hidden'
          || Number(selfStyle.opacity) === 0;
        if (hiddenOnFocus) return null;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topEls = document.elementsFromPoint(centerX, centerY) || [];
        const fixedEls = topEls.filter(e => {
          if (e === el || el.contains(e) || e.contains(el)) return false;
          const s = getComputedStyle(e);
          if (s.position !== 'fixed' && s.position !== 'sticky') return false;
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          if (Number(s.opacity) === 0) return false;
          if (s.pointerEvents === 'none') return false;
          const hasBg = s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
          const hasBorder = parseFloat(s.borderWidth) > 0;
          if (!hasBg && !hasBorder) return false;
          return true;
        });
        if (fixedEls.length === 0) return null;
        for (const fe of fixedEls) {
          const fr = fe.getBoundingClientRect();
          const ox = Math.max(0, Math.min(rect.right, fr.right) - Math.max(rect.left, fr.left));
          const oy = Math.max(0, Math.min(rect.bottom, fr.bottom) - Math.max(rect.top, fr.top));
          if (ox > 0 && oy > 0 && ox * oy >= rect.width * rect.height * 0.9) return { label, fully: true };
        }
        return null;
      });
      if (info?.fully) violations.push(`フォーカスが完全に隠れる: ${info.label}`);
    }
    return {
      sc: '2.4.11',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations: violations.slice(0, 10),
      message: violations.length === 0
        ? 'フォーカスが完全に隠れる要素は検出されませんでした'
        : `${violations.length}個の要素でフォーカスが完全に隠れています`
    };
  } catch (e) {
    return { sc: '2.4.11', status: 'error', violations: [], message: e.message };
  }
}

// ============================================================
// EXT SCAN: IBM Equal Access + Lighthouse相当 + CDP拡張検査
// ============================================================

// IBM ACE ルール → WCAG SC マッピング（主要ルール）
const IBM_RULE_SC_MAP = {
  'WCAG20_Img_HasAlt':                  '1.1.1',
  'WCAG20_Img_TitleEmptyWhenAltNull':   '1.1.1',
  'WCAG20_Img_PresentationImgHasNonNullAlt': '1.1.1',
  'WCAG20_Input_ExplicitLabel':         '1.3.1',
  'WCAG20_Input_LabelBefore':           '1.3.1',
  'WCAG20_Input_LabelAfter':            '1.3.1',
  'WCAG20_Label_RefValid':              '1.3.1',
  'WCAG20_Fieldset_HasLegend':          '1.3.1',
  'WCAG20_Table_Structure':             '1.3.1',
  'WCAG20_Table_CapSummRedundant':      '1.3.1',
  'RPT_Table_DataHeadingsAria':         '1.3.1',
  'WCAG20_Input_Autocomplete':          '1.3.5',
  'WCAG20_Text_Emoticons':              '1.3.3',
  'WCAG21_Input_Autocomplete':          '1.3.5',
  'RPT_Media_VideoObjectTrigger':       '1.2.1',
  'WCAG20_Object_HasText':              '1.1.1',
  'RPT_Elem_UniqueId':                  '4.1.1',
  'WCAG20_A_HasText':                   '2.4.4',
  'WCAG20_A_InSkipNav':                 '2.4.1',
  'RPT_Navigation_Skippable':           '2.4.1',
  'WCAG20_Frame_HasTitle':              '2.4.1',
  'WCAG20_Body_FirstASkips_Native_Host_Sematics': '2.4.1',
  'WCAG20_Doc_HasTitle':                '2.4.2',
  'WCAG20_Html_HasLang':                '3.1.1',
  'WCAG20_Html_Lang_Valid':             '3.1.1',
  'WCAG20_Elem_Lang_Valid':             '3.1.2',
  'WCAG20_Input_LabelBefore':           '1.3.1',
  'Rpt_Aria_ValidRole':                 '4.1.2',
  'Rpt_Aria_RequiredProperties':        '4.1.2',
  'Rpt_Aria_ValidPropertyValue':        '4.1.2',
  'Rpt_Aria_OrphanedContent_Native_Host_Sematics': '1.3.1',
  'Rpt_Aria_RegionLabel_Implicit':      '2.4.1',
  'WCAG20_Input_VisibleLabel':          '2.4.6',
  'RPT_Label_UniqueFor':                '1.3.1',
  'WCAG20_Select_HasOptGroup':          '1.3.1',
  'WCAG20_A_TargetAndText':             '3.2.5',
  'WCAG20_Elem_UniqueAccessKey':        '2.1.4',
  'WCAG20_Img_LinkTextNotRedundant':    '2.4.4',
  'RPT_List_UseMarkup':                 '1.3.1',
  'RPT_Blockquote_HasCite':             '1.3.1',
  'WCAG20_Input_HasOnchange':           '3.2.2',
  'WCAG20_Select_NoChangeAction':       '3.2.2',
  'WCAG20_Blink_AlwaysTriggers':        '2.2.2',
  'RPT_Marquee_Trigger':                '2.2.2',
  'WCAG20_Meta_RedirectZero':           '2.2.1',
  'RPT_Media_AltBrief':                 '1.1.1',
  'WCAG20_Style_BackgroundImage':       '1.1.1',
  'RPT_Embed_HasNoEmbed':               '1.1.1',
  'WCAG21_Style_Viewport':              '1.4.4',
  'WCAG22_Label_Tooltip_Required':      '3.3.2',
  'IBMA_Color_Contrast_WCAG2AA':        '1.4.3',
  'IBMA_Color_Contrast_WCAG2AA_PV':    '1.4.3',
};

function ibmRuleToSC(ruleId) {
  if (IBM_RULE_SC_MAP[ruleId]) return IBM_RULE_SC_MAP[ruleId];
  // WCAG21_X_Y → 2.1 型のパターンを推定
  const m = ruleId.match(/^WCAG(\d)(\d)_/);
  if (m) return `${m[1]}.${m[2]}.x`;
  return null;
}

/** EXT: IBM Equal Access Checker */
async function ext_check_ibm_ace(page) {
  try {
    await page.addScriptTag({ path: aceWindowPath });
    await page.waitForFunction(() => !!(window.ace && window.ace.Checker), { timeout: 10000 });
    const raw = await page.evaluate(async () => {
      try {
        const checker = new window.ace.Checker();
        const report = await checker.check(document, ['IBM_Accessibility']);
        return (report && report.results) ? report.results : [];
      } catch (e) {
        return { _error: e.message };
      }
    });
    if (!Array.isArray(raw)) return { source: 'IBM_ACE', sc: null, status: 'error', violations: [], message: raw._error || 'ACE実行エラー' };

    // SC別に集約
    const scMap = {};
    // aria-hidden="true" が付いた要素は AT から除外されているため
    // alt/名前チェック系の FAIL / POTENTIAL は誤検出として除外する
    const ARIA_HIDDEN_IMAGE_RULES = new Set([
      'WCAG20_Img_HasAlt', 'WCAG20_Img_TitleEmptyWhenAltNull',
      'WCAG20_Img_PresentationImgHasNonNullAlt', 'WCAG20_Object_HasText',
      'WCAG20_Img_LinkTextNotEmpty', 'RPT_Img_UsemapAlt',
    ]);
    raw.forEach(r => {
      const sc = ibmRuleToSC(r.ruleId);
      if (!sc) return;

      // aria-hidden="true" の要素に対する代替テキスト系チェックはスキップ
      if (ARIA_HIDDEN_IMAGE_RULES.has(r.ruleId) && r.snippet
        && /aria-hidden\s*=\s*["']true["']/i.test(r.snippet)) return;

      const isFail = Array.isArray(r.value) && r.value[1] === 'FAIL' && r.value[0] !== 'PASS';
      const isPass = Array.isArray(r.value) && r.value[1] === 'PASS';
      const isPotential = Array.isArray(r.value) && (r.value[1] === 'POTENTIAL' || r.value[1] === 'MANUAL');

      if (!scMap[sc]) {
        scMap[sc] = { sc, failRules: [], potentialRules: [], violations: [], passCount: 0, potentialCount: 0 };
      }

      if (isFail) {
        scMap[sc].failRules.push(r.ruleId);
        const loc = r.path && r.path.dom ? r.path.dom : (r.snippet ? r.snippet.slice(0, 80) : '');
        if (loc && !scMap[sc].violations.includes(loc)) scMap[sc].violations.push(loc);
      } else if (isPass) {
        scMap[sc].passCount++;
      } else if (isPotential) {
        scMap[sc].potentialRules.push(r.ruleId);
        scMap[sc].potentialCount++;
        const loc = r.path && r.path.dom ? r.path.dom : (r.snippet ? r.snippet.slice(0, 80) : '');
        if (loc && !scMap[sc].violations.includes(loc)) scMap[sc].violations.push(loc);
      }
    });

    return Object.values(scMap).map(s => {
      let status = 'unverified';
      let message = '';
      if (s.failRules.length > 0) {
        status = 'fail';
        message = `IBM ACE: SC ${s.sc} で違反を検出 (${s.violations.length}件)`;
      } else if (s.potentialCount > 0) {
        status = 'manual_required';
        message = `IBM ACE: SC ${s.sc} の手動確認が必要です (${s.potentialCount}件)`;
      } else if (s.passCount > 0) {
        status = 'pass';
        message = `IBM ACE: SC ${s.sc} をパスしました`;
      }

      return {
        source: 'IBM_ACE',
        sc: s.sc,
        status,
        violations: s.violations.slice(0, 10),
        message,
        name: `IBM Equal Access: SC ${s.sc}`
      };
    });
  } catch (e) {
    return [{ source: 'IBM_ACE', sc: null, status: 'error', violations: [], message: e.message }];
  }
}

/** EXT: SC 4.1.1 - 重複ID検出（ネイティブ） */
async function ext_check_4_1_1_dup_id(page) {
  try {
    const result = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[id]'));
      const seen = {};
      const dups = [];
      all.forEach(el => {
        if (!el.id) return;
        seen[el.id] = (seen[el.id] || 0) + 1;
      });
      Object.keys(seen).forEach(id => {
        if (seen[id] > 1) dups.push(`id="${id}" (${seen[id]}件)`);
      });
      return dups;
    });
    return {
      source: 'EXT_NATIVE',
      sc: '4.1.1',
      status: result.length === 0 ? 'pass' : 'fail',
      violations: result.slice(0, 15),
      message: result.length === 0
        ? '重複IDは検出されませんでした'
        : `${result.length}個の重複IDを検出`,
      name: 'SC 4.1.1: 重複ID検出'
    };
  } catch (e) {
    return { source: 'EXT_NATIVE', sc: '4.1.1', status: 'error', violations: [], message: e.message };
  }
}

/** EXT: SC 2.4.1 - ランドマーク領域（Lighthouse相当） */
async function ext_check_2_4_1_landmarks(page) {
  try {
    const result = await page.evaluate(() => {
      const hasMain = !!(
        document.querySelector('main') ||
        document.querySelector('[role="main"]')
      );
      const hasNav = !!(
        document.querySelector('nav') ||
        document.querySelector('[role="navigation"]')
      );
      const hasSkip = !!(
        document.querySelector('a[href^="#"]') ||
        document.querySelector('[class*="skip"]') ||
        document.querySelector('[id*="skip"]')
      );
      const issues = [];
      if (!hasMain) issues.push('<main>要素またはrole="main"が存在しません');
      if (!hasNav) issues.push('<nav>要素またはrole="navigation"が存在しません');
      if (!hasSkip) issues.push('スキップナビゲーションリンクが見当たりません');
      return { issues, hasMain, hasNav, hasSkip };
    });
    return {
      source: 'EXT_NATIVE',
      sc: '2.4.1',
      status: result.issues.length === 0 ? 'pass' : 'fail',
      violations: result.issues,
      message: result.issues.length === 0
        ? 'ランドマーク領域とスキップナビゲーションが確認できました'
        : result.issues.join('; '),
      name: 'SC 2.4.1: ランドマーク領域'
    };
  } catch (e) {
    return { source: 'EXT_NATIVE', sc: '2.4.1', status: 'error', violations: [], message: e.message };
  }
}

/** EXT: SC 2.1.1 - スクロール可能領域のキーボードアクセス（Lighthouse相当） */
async function ext_check_2_1_1_scrollable(page) {
  try {
    const violations = await page.evaluate(() => {
      const results = [];
      const all = Array.from(document.querySelectorAll('*'));
      all.forEach(el => {
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const isScrollable = (overflowY === 'auto' || overflowY === 'scroll' ||
                              overflowX === 'auto' || overflowX === 'scroll');
        if (!isScrollable) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const tabindex = el.getAttribute('tabindex');
        const role = el.getAttribute('role');
        const isNativeScrollable = ['textarea', 'select'].includes(el.tagName.toLowerCase());
        if (isNativeScrollable) return;
        if (!tabindex || parseInt(tabindex) < 0) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
          results.push(`${tag}${id}${cls} (overflow:${overflowY}/${overflowX})`);
        }
      });
      return results.slice(0, 10);
    });
    return {
      source: 'EXT_NATIVE',
      sc: '2.1.1',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
      message: violations.length === 0
        ? 'スクロール可能な要素はすべてキーボードでアクセス可能です'
        : `${violations.length}個のスクロール可能要素にtabindexがありません`,
      name: 'SC 2.1.1: スクロール領域キーボードアクセス'
    };
  } catch (e) {
    return { source: 'EXT_NATIVE', sc: '2.1.1', status: 'error', violations: [], message: e.message };
  }
}

/** EXT: SC 2.4.6 - 見出し階層順序（Lighthouse相当） */
async function ext_check_2_4_6_heading_order(page) {
  try {
    const result = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const issues = [];
      let prevLevel = 0;
      headings.forEach(h => {
        const level = parseInt(h.tagName[1]);
        if (prevLevel > 0 && level > prevLevel + 1) {
          const text = h.textContent.trim().slice(0, 40);
          issues.push(`h${prevLevel}の次にh${level}（スキップ）: "${text}"`);
        }
        prevLevel = level;
      });
      const h1Count = headings.filter(h => h.tagName === 'H1').length;
      if (h1Count === 0) issues.push('h1要素が存在しません');
      if (h1Count > 1) issues.push(`h1が${h1Count}個あります（1個推奨）`);
      return issues;
    });
    return {
      source: 'EXT_NATIVE',
      sc: '2.4.6',
      status: result.length === 0 ? 'pass' : 'fail',
      violations: result.slice(0, 10),
      message: result.length === 0
        ? '見出し階層は正しい順序です'
        : `見出し階層に${result.length}件の問題を検出`,
      name: 'SC 2.4.6: 見出し階層順序'
    };
  } catch (e) {
    return { source: 'EXT_NATIVE', sc: '2.4.6', status: 'error', violations: [], message: e.message };
  }
}

/** EXT: SC 2.1.4 - CDPイベントリスナーによるキーボードショートカット検出 */
async function ext_check_2_1_4_cdp_shortcuts(page) {
  try {
    const cdpSession = await page.context().newCDPSession(page);
    const { root: { nodeId: rootNodeId } } = await cdpSession.send('DOM.getDocument', { depth: 1 });

    // keydown/keypress ハンドラを持つ要素を探索
    const targetNodes = await page.evaluate(() => {
      const interactive = Array.from(document.querySelectorAll('body, [role], button, a, input, [tabindex]'));
      return interactive.slice(0, 30).map(el => ({
        selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
        objectId: null
      }));
    });

    const shortcuts = [];
    for (const n of targetNodes.slice(0, 20)) {
      try {
        const obj = await page.evaluateHandle(sel => {
          try { return document.querySelector(sel); } catch { return document.body; }
        }, n.selector);
        const { result } = await cdpSession.send('Runtime.callFunctionOn', {
          functionDeclaration: 'function() { return this; }',
          objectId: (await cdpSession.send('DOM.resolveNode', { nodeId: rootNodeId })).object.objectId,
          returnByValue: false
        }).catch(() => ({ result: null }));

        if (result && result.objectId) {
          const listeners = await cdpSession.send('DOMDebugger.getEventListeners', {
            objectId: result.objectId, depth: 1
          }).catch(() => ({ listeners: [] }));
          const kbListeners = (listeners.listeners || []).filter(l =>
            l.type === 'keydown' || l.type === 'keypress' || l.type === 'keyup'
          );
          if (kbListeners.length > 0) shortcuts.push(`${n.selector}: ${kbListeners.map(l => l.type).join(',')}`);
        }
      } catch (_) { /* スキップ */ }
    }
    await cdpSession.detach().catch(() => {});

    // 別途DOM静的チェックも実行
    const accesskeys = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[accesskey]')).slice(0, 10).map(el => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        return `${tag}${id} accesskey="${el.getAttribute('accesskey')}"`;
      });
    });

    const violations = [...accesskeys];
    if (shortcuts.length > 0) violations.push(`キーボードイベントハンドラ検出: ${shortcuts.slice(0, 3).join(', ')}`);

    return {
      source: 'EXT_CDP',
      sc: '2.1.4',
      status: violations.length === 0 ? 'pass' : 'unverified',
      violations: violations.slice(0, 10),
      message: violations.length === 0
        ? '文字キーショートカットは検出されませんでした'
        : `${violations.length}件の潜在的なショートカット要素を検出（無効化・変更手段の手動確認が必要）`,
      name: 'SC 2.1.4: 文字キーショートカット（CDP拡張）'
    };
  } catch (e) {
    return { source: 'EXT_CDP', sc: '2.1.4', status: 'error', violations: [], message: e.message };
  }
}

app.post('/api/ext-check', async (req, res) => {
  const { url, basicAuth, viewportPreset } = req.body;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });

  const HANDLER_TIMEOUT = 6 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) res.status(504).json({ error: 'EXT SCANがタイムアウトしました（6分超過）' });
  }, HANDLER_TIMEOUT);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const preset = (viewportPreset || 'desktop').toLowerCase();
    const viewport = (preset.includes('mobile') || preset.includes('iphone') || preset.includes('sp'))
      ? { width: 375, height: 812 }
      : { width: 1280, height: 800 };

    const contextOptions = { viewport };
    if (basicAuth && basicAuth.user && basicAuth.pass) {
      contextOptions.httpCredentials = { username: basicAuth.user, password: basicAuth.pass };
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1000);

    const withTimeout = (fn, ms = 30000) =>
      Promise.race([fn(), new Promise(r => setTimeout(() => r([{ source: 'EXT', sc: null, status: 'unverified', violations: [], message: 'タイムアウト' }]), ms))]);

    const results = [];

    // IBM ACE 検査（複数SC同時取得）
    const aceResults = await withTimeout(() => ext_check_ibm_ace(page));
    if (Array.isArray(aceResults)) results.push(...aceResults);
    else results.push(aceResults);

    // リロードして他の検査
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);

    // ネイティブ検査
    results.push(await withTimeout(() => ext_check_4_1_1_dup_id(page)));
    results.push(await withTimeout(() => ext_check_2_4_1_landmarks(page)));
    results.push(await withTimeout(() => ext_check_2_1_1_scrollable(page)));
    results.push(await withTimeout(() => ext_check_2_4_6_heading_order(page)));

    // CDP拡張検査
    results.push(await withTimeout(() => ext_check_2_1_4_cdp_shortcuts(page)));

    await page.close();

    // 配列をフラット化して単一アイテム結果に統一
    const flat = results.flat().filter(r => r && r.sc);
    console.log(`[EXT] 完了: ${flat.length}件 (${url})`);
    if (!timedOut) res.json({ success: true, url, results: flat, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[EXT] Error:', error);
    if (!timedOut && !res.headersSent) res.status(500).json({ error: error.message });
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
  }
});

/** SC 2.2.2 - 自動再生スライダー・アニメーション停止手段（Playwright版）
 *  document.getAnimations() でJS初期化後の実際の動作アニメーションを取得し、
 *  ページに停止/一時停止コントロールが存在するか確認する。
 */
async function pw_check_2_2_2_pause_stop(page) {
  try {
    // ページ読み込み後にスライダーのJSが初期化されるまで待機
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      // ページ全体で一時停止/停止コントロールを探す
      const PAUSE_RE = /pause|stop|停止|一時停止|止める|スライド停止/i;
      function findPauseControl() {
        // ボタン・role=button
        for (const el of document.querySelectorAll('button, [role="button"], input[type="button"]')) {
          const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          const cls = typeof el.className === 'string' ? el.className : '';
          if (PAUSE_RE.test(label) || PAUSE_RE.test(cls)) return true;
        }
        // aria-label属性
        for (const el of document.querySelectorAll('[aria-label]')) {
          if (PAUSE_RE.test(el.getAttribute('aria-label') || '')) return true;
        }
        return false;
      }

      // Web Animations API で実際に動いているアニメーションを取得
      const runningAnims = [];
      if (typeof document.getAnimations === 'function') {
        for (const anim of document.getAnimations()) {
          if (anim.playState !== 'running') continue;
          const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
          const iterations = timing.iterations;
          const duration = typeof timing.duration === 'number' ? timing.duration : 0;
          // 無限ループ または 5秒超
          if (iterations === Infinity || duration > 5000) {
            const target = anim.effect && anim.effect.target;
            if (!target) continue;
            const tag = target.tagName ? target.tagName.toLowerCase() : '';
            const id = target.id ? `#${target.id}` : '';
            const cls = typeof target.className === 'string'
              ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            const animName = anim.animationName || (anim.constructor && anim.constructor.name) || '?';
            runningAnims.push({ desc: `${tag}${id}${cls}`, animName, durationMs: Math.round(duration), iterations: iterations === Infinity ? 'infinite' : iterations });
            if (runningAnims.length >= 8) break;
          }
        }
      }

      // スライダーライブラリのクラスパターン検出
      const SLIDER_SELECTORS = [
        '.swiper', '.swiper-container',
        '.slick-slider', '.slick-list',
        '.owl-carousel', '.owl-stage',
        '.splide', '.splide__list',
        '.glide', '.glide__slides',
        '.flickity-slider',
        '.keen-slider',
        '[data-ride="carousel"]',
        '.js-slider', '.js-carousel',
        '.hero-slider', '.top-slider',
        '.slide-wrap', '.slideshow',
      ].join(',');
      const sliderEls = document.querySelectorAll(SLIDER_SELECTORS);
      const sliderInfo = Array.from(sliderEls).slice(0, 3).map(el => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `${tag}${id}${cls}`;
      });

      // video[autoplay]
      const autoplayVideos = Array.from(document.querySelectorAll('video[autoplay]')).length;
      // marquee
      const marquees = Array.from(document.querySelectorAll('marquee')).length;

      const hasPauseControl = findPauseControl();

      return { runningAnims, sliderInfo, sliderCount: sliderEls.length, autoplayVideos, marquees, hasPauseControl };
    });

    const violations = [];
    const { runningAnims, sliderInfo, sliderCount, autoplayVideos, marquees, hasPauseControl } = result;

    // marquee は無条件違反
    if (marquees > 0) {
      violations.push(`<marquee>要素${marquees}個: 停止手段なし（廃止要素）`);
    }

    // video[autoplay]
    if (autoplayVideos > 0 && !hasPauseControl) {
      violations.push(`video[autoplay] ${autoplayVideos}個: 停止/一時停止コントロールなし`);
    }

    // スライダーライブラリが検出され、停止ボタンがない場合
    if (sliderCount > 0 && !hasPauseControl) {
      violations.push(`自動再生スライダー候補${sliderCount}個 (${sliderInfo.join(', ')}): 停止コントロールなし`);
    }

    // Web Animations APIで確認された無限/長時間アニメーションがあり、停止ボタンがなく、スライダーとも重複しない場合
    if (runningAnims.length > 0 && !hasPauseControl && sliderCount === 0) {
      const descs = runningAnims.slice(0, 3).map(a => `${a.desc}(${a.animName},${a.iterations})`).join(', ');
      violations.push(`無限/長時間アニメーション${runningAnims.length}件: ${descs} — 停止コントロールなし`);
    }

    const nothingFound = sliderCount === 0 && autoplayVideos === 0 && marquees === 0 && runningAnims.length === 0;
    if (nothingFound) {
      return { sc: '2.2.2', status: 'pass', violations: [], message: '自動再生コンテンツ・スライダーなし' };
    }
    if (violations.length === 0) {
      return { sc: '2.2.2', status: 'pass', violations: [], message: `動くコンテンツあり（スライダー${sliderCount}・アニメ${runningAnims.length}）、停止手段を確認` };
    }
    return {
      sc: '2.2.2',
      status: 'fail',
      violations,
      message: `${violations.length}件: 自動再生コンテンツに停止手段なし（SC 2.2.2違反）`
    };
  } catch (e) {
    return { sc: '2.2.2', status: 'error', violations: [], message: e.message };
  }
}

app.post('/api/playwright-check', async (req, res) => {
  const { url, basicAuth, viewportPreset } = req.body;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });

  const HANDLER_TIMEOUT = 5 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) res.status(504).json({ error: 'PLAYWRIGHTがタイムアウトしました（5分超過）' });
  }, HANDLER_TIMEOUT);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    // ビューポート設定
    const preset = (viewportPreset || 'desktop').toLowerCase();
    const viewport = (preset.includes('mobile') || preset.includes('iphone') || preset.includes('sp'))
      ? { width: 375, height: 812 }
      : { width: 1280, height: 800 };

    const contextOptions = { viewport };
    if (basicAuth && basicAuth.user && basicAuth.pass) {
      contextOptions.httpCredentials = { username: basicAuth.user, password: basicAuth.pass };
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1000);

    const withTimeout = (fn, ms = 20000) =>
      Promise.race([fn(), new Promise(r => setTimeout(() => r({ sc: '?', status: 'unverified', violations: [], message: 'タイムアウト' }), ms))]);

    const results = [];
    // DOM静的検査（リロード不要）
    results.push(await withTimeout(() => pw_check_2_4_2_page_title(page)));
    results.push(await withTimeout(() => pw_check_3_1_1_language(page)));
    results.push(await withTimeout(() => pw_check_2_1_4_character_shortcuts(page)));
    results.push(await withTimeout(() => pw_check_1_3_5_input_purpose(page)));
    results.push(await withTimeout(() => pw_check_3_3_2_labels(page)));
    results.push(await withTimeout(() => pw_check_2_5_3_label_in_name(page)));
    // SC 2.2.2: JS初期化後の自動再生スライダー・アニメーション検出（2s待機込み）
    results.push(await withTimeout(() => pw_check_2_2_2_pause_stop(page), 25000));
    // アクセシビリティツリー検査
    results.push(await withTimeout(() => pw_check_4_1_2_accessible_names(page)));
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_4_1_3_status_messages(page)));
    results.push(await withTimeout(() => pw_check_2_4_6_headings_labels(page)));
    results.push(await withTimeout(() => pw_check_1_3_1_info_relationships(page)));
    results.push(await withTimeout(() => pw_check_1_3_2_meaningful_sequence(page)));
    results.push(await withTimeout(() => pw_check_1_3_3_sensory_characteristics(page)));
    // フォーカス系検査
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_2_4_7_focus_visible_all(page)));
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_2_1_1_full_tab_sequence(page)));
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_2_1_2_keyboard_trap(page)));
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_2_4_3_focus_order(page)));
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    results.push(await withTimeout(() => pw_check_2_4_11_focus_obscured(page)));

    await page.close();
    console.log(`[PLAY] 完了: ${results.length}件 (${url})`);
    if (!timedOut) res.json({ success: true, url, results, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[PLAY] Error:', error);
    if (!timedOut && !res.headersSent) res.status(500).json({ error: error.message });
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
  }
});

app.all('/api/playwright-check', (req, res) => {
  res.status(405).json({
    error: `PLAYWRIGHT APIはPOSTのみ対応しています: ${req.method} ${req.originalUrl}`
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// エラーハンドリング
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/axe/api/')) {
    return res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.originalUrl}` });
  }
  next();
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Puppeteer/Chrome クラッシュ等で未処理の例外が発生してもサーバーを落とさない
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] サーバーは継続します:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] サーバーは継続します:', reason);
});

// サーバー起動（最後に1回だけ記述）
const server = app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});

// タイムアウト設定をインスタンスに適用
server.timeout = 600000;        // 10分（DEEP SCANの最大所要時間に対応）
server.keepAliveTimeout = 600000;
