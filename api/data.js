// Vercel Serverless Function: /api/data  — حفظ ومزامنة بيانات اللوحة بين الأجهزة.
// يحتاج: ACCESS_CODE (رمز الدخول) + قاعدة Upstash Redis من تبويب Storage في Vercel
// (تضيف المتغيرات KV_REST_API_URL و KV_REST_API_TOKEN تلقائياً).

const KEY = 'hr-dash-v2';
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = async cmd => {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'redis ' + r.status);
  return j.result;
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // البيانات فيها هويات وجوالات موظفين: لا نعمل بدون رمز دخول أبداً
  if (!process.env.ACCESS_CODE) return res.status(503).json({ error: 'setup', message: 'أضف ACCESS_CODE في إعدادات Vercel' });
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'setup', message: 'أنشئ قاعدة Upstash Redis من تبويب Storage' });
  if (req.headers['x-code'] !== process.env.ACCESS_CODE) return res.status(401).json({ error: 'رمز الدخول غير صحيح' });

  try {
    if (req.method === 'GET') {
      const v = await redis(['GET', KEY]);
      return res.status(200).json(v ? JSON.parse(v) : { data: null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = req.body || {};
      if (!b.data || !Array.isArray(b.data.emps)) return res.status(400).json({ error: 'بيانات غير صالحة' });
      const ts = Number(b.data.ts) || Date.now();
      await redis(['SET', KEY, JSON.stringify({ data: b.data, ts })]);
      return res.status(200).json({ ok: true, ts });
    }
    return res.status(405).json({ error: 'GET/PUT only' });
  } catch (e) {
    return res.status(502).json({ error: 'تعذّر الاتصال بقاعدة البيانات: ' + e.message });
  }
};
