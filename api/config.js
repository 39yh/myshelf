// 運営側の公開設定を返す（秘密情報は返さない）
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).json({
    amazonTag: process.env.AMAZON_ASSOCIATE_TAG || '',
    ai: !!process.env.ANTHROPIC_API_KEY,
    rakuten: !!process.env.RAKUTEN_APP_ID,
  });
};
