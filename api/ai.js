// AI文章整形（サーバー側でAPIキーを保持。未設定なら503を返しアプリ側は定型整形にフォールバック）
// 環境変数: ANTHROPIC_API_KEY（任意）, AI_MODEL（任意・既定 claude-sonnet-4-5）
const https = require('node:https');

const RATE_LIMIT = 12, RATE_WINDOW_MS = 60000;
const hitsMap = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hitsMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hitsMap.set(ip, arr);
  if (hitsMap.size > 5000) hitsMap.clear();
  return arr.length > RATE_LIMIT;
}
const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) { res.status(503).json({ error: 'not_configured' }); return; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) { res.status(429).json({ error: 'too_many_requests' }); return; }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  const inst = b.mode === 'note'
    ? '以下の感想メモを、noteに投稿するエッセイ風の記事（見出し付きmarkdown、400〜800字）に整えてください。記事本文のみを出力してください。'
    : '以下の感想メモを、X（Twitter）に投稿する自然で魅力的な日本語の投稿文（140字以内、ハッシュタグ1〜2個含む）に整えてください。投稿文のみを出力してください。';

  const content = `${inst}\n\n種類:${cut(b.type, 20)}\nタイトル:${cut(b.title, 200)}\n作者/会場:${cut(b.creator, 200)}\n`
    + `評価:${cut(b.rating, 4)}/5\n印象フレーズ:${cut(b.quotes, 1000)}\n感想メモ:${cut(b.memo, 4000)}`;

  const payload = JSON.stringify({
    model: process.env.AI_MODEL || 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content }],
  });

  try {
    const out = await new Promise((resolve, reject) => {
      const r = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (resp) => {
          let body = '';
          resp.on('data', c => (body += c));
          resp.on('end', () => resolve({ status: resp.statusCode || 200, body }));
        }
      );
      r.on('error', reject);
      r.setTimeout(30000, () => { r.destroy(new Error('timeout')); });
      r.write(payload);
      r.end();
    });

    const j = JSON.parse(out.body || '{}');
    const text = (j.content || []).map(c => c.text || '').join('').trim();
    if (out.status >= 400 || !text) { res.status(502).json({ error: 'upstream', detail: (j.error && j.error.message) || '' }); return; }
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
