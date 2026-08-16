// MyShelf 中継所（Vercel Serverless Function・楽天商品検索プロキシ）
// おかえし手帖の中継所と同じ設計：
//  - 楽天「Webアプリケーション」は Referer 認証のため、node:https で Referer/Origin を確実に送る
//  - アプリID／アフィリエイトIDはサーバーの環境変数にのみ置き、フロントには出さない
//  - アフィリエイトIDはサイト運営者のものを常に適用する
//
// 環境変数（Vercel → Settings → Environment Variables）
//  RAKUTEN_APP_ID        … アプリケーションID
//  RAKUTEN_AFFILIATE_ID  … アフィリエイトID
//  RAKUTEN_REFERER       … 楽天に登録した「許可されたWebサイト」と同じ値
//  ALLOWED_ORIGINS       … 任意。カンマ区切りの許可オリジン（未設定なら同一オリジンのみ想定）
//  ALLOW_NO_ORIGIN       … 任意。'0' でOriginなしリクエストを遮断
//
// 乱用対策: ①Origin許可制 ②IPごと30回/分の簡易レート制限 ③既知パラメータのみ転送・hits上限クランプ

const https = require('node:https');

const ENDPOINTS = {
  book:   'https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404',
  movie:  'https://app.rakuten.co.jp/services/api/BooksDVD/Search/20170404',
  museum: 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601',
};

const ALLOWED_PARAMS = new Set([
  'title', 'keyword', 'author', 'artistName', 'hits', 'page', 'sort',
  'booksGenreId', 'genreId', 'formatVersion',
]);
const MAX_HITS = 30;

const DEFAULT_ALLOWED = ['http://localhost:3000', 'http://localhost:8081'];
function allowedOrigins() {
  const env = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_ALLOWED;
}
function originMatches(origin, patterns) {
  if (!origin) return false;
  let host = '';
  try { host = new URL(origin).host; } catch (e) { return false; }
  return patterns.some(p => {
    const pat = p.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
    return host === pat;
  });
}

// 簡易レート制限（メモリ内・ウォーム時のみ有効な軽い防御）
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60000;
const rateHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateHits.set(ip, arr);
  if (rateHits.size > 5000) rateHits.clear();
  return arr.length > RATE_LIMIT;
}

function requestOrigin(req) {
  const origin = req.headers.origin || '';
  if (origin) return origin;
  const ref = req.headers.referer || '';
  try { const u = new URL(ref); return `${u.protocol}//${u.host}`; } catch (e) { return ''; }
}

module.exports = async (req, res) => {
  const selfHost = req.headers.host || '';
  const allow = allowedOrigins();
  const origin = requestOrigin(req);
  const sameOrigin = !!origin && !!selfHost && origin.endsWith(selfHost);
  const originAllowed = sameOrigin || originMatches(origin, allow);
  const noOrigin = !origin;
  const allowNoOrigin = process.env.ALLOW_NO_ORIGIN !== '0';

  if (originAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!originAllowed && !(noOrigin && allowNoOrigin)) {
    res.status(403).json({ error: 'origin not allowed' }); return;
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) { res.status(429).json({ error: 'too many requests' }); return; }

  const appId = process.env.RAKUTEN_APP_ID || '';
  if (!appId) { res.status(503).json({ error: 'not_configured', message: 'RAKUTEN_APP_ID が未設定です' }); return; }

  const query = req.query || {};
  const src = String(Array.isArray(query.src) ? query.src[0] : (query.src || 'book'));
  const endpoint = ENDPOINTS[src] || ENDPOINTS.book;
  const referer = process.env.RAKUTEN_REFERER || `https://${selfHost}`;

  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (!ALLOWED_PARAMS.has(k)) continue; // 未知パラメータは無視
      let val = Array.isArray(v) ? v[0] : v;
      if (k === 'hits') val = String(Math.min(MAX_HITS, Math.max(1, parseInt(val, 10) || 10)));
      params.set(k, String(val));
    }
    params.set('applicationId', appId);
    const aff = process.env.RAKUTEN_AFFILIATE_ID || '';
    if (aff) params.set('affiliateId', aff);
    params.set('format', 'json');
    params.set('formatVersion', '2');

    const url = new URL(endpoint);
    url.search = params.toString();

    const result = await new Promise((resolve, reject) => {
      const r = https.get(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: {
            Referer: referer,
            Origin: referer,
            'User-Agent': 'Mozilla/5.0 (myshelf)',
          },
        },
        (resp) => {
          let body = '';
          resp.on('data', (c) => (body += c));
          resp.on('end', () => resolve({ status: resp.statusCode || 200, body }));
        }
      );
      r.on('error', reject);
      r.setTimeout(15000, () => { r.destroy(new Error('timeout')); });
    });

    res.status(result.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    res.send(result.body);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
