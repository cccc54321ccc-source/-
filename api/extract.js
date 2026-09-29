// Vercel Serverless Function: يقرأ الملف عبر Gemini. المفتاح يبقى في Vercel ولا يظهر للمتصفح.
// نسخة مقاومة للضغط: تعيد المحاولة وتنتقل لموديل احتياطي عند خطأ 503 / 429 / 404.
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'أضف GEMINI_API_KEY في إعدادات Vercel' });
  if (process.env.ACCESS_CODE && req.headers['x-code'] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
  const { mime, data } = req.body || {};
  if (!mime || !data) return res.status(400).json({ error: 'ملف غير صالح' });

  const prompt = `اقرأ هذا المستند الخاص بموظف (عقد عمل موحد أو إقامة أو شهادة صحية) وأعد JSON فقط بهذه المفاتيح.
ضع null لأي قيمة غير موجودة أو غير واضحة ولا تخمّن.
تنبيه مهم: في عقد العمل الموحد يوجد شخصان: "الطرف الأول" (صاحب العمل) وممثله، و"الطرف الثاني" (العامل).
كل البيانات المطلوبة عن العامل (الطرف الثاني) فقط، ولا تأخذ اسم أو رقم هوية الممثل أو صاحب العمل.
التواريخ في المستند قد تكون بصيغة 2027/08/08 حوّلها إلى YYYY-MM-DD.
المفاتيح:
docType: contract أو iqama أو health أو other
n: اسم الموظف (الطرف الثاني / العامل) بالعربية كما هو مكتوب في المستند
nat: جنسية الموظف كاسم دولة بالعربية (مثل مصر، الهند، باكستان)
idn: رقم هوية/إقامة الموظف (الطرف الثاني) وليس رقم الممثل
job: المسمى الوظيفي بالعربية
co: اسم المنشأة (صاحب العمل) بالعربية
ce: تاريخ نهاية العقد (Contract end date) بصيغة YYYY-MM-DD
iq: تاريخ انتهاء الإقامة بصيغة YYYY-MM-DD، فقط إذا ذُكر صراحة (عقد العمل لا يحتوي عادة على هذا التاريخ، فاجعله null)`;

  // الترتيب: الموديل المحدد في Vercel أولاً ثم بدائل
  const models = [...new Set([
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite'
  ].filter(Boolean))];
  const errors = [];

  const started = Date.now();
  let lastErr = 'فشل الاتصال بـ Gemini';
  const note = (model, st, msg) => errors.push(model + ' [' + st + ']: ' + String(msg || '').slice(0, 90));

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > 50000) break; // لا نتجاوز مهلة الدالة
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 }
          })
        });
        const j = await r.json().catch(() => ({}));

        if (r.ok) {
          const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '{}';
          try {
            return res.status(200).json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
          } catch (e) {
            lastErr = 'رد غير مفهوم من Gemini، أعد المحاولة';
            continue;
          }
        }

        lastErr = (j.error && j.error.message) || lastErr;
        note(model, r.status, lastErr);
        // ضغط أو خطأ مؤقت: أعد المحاولة بعد ثانيتين ثم انتقل للموديل التالي
        if (r.status === 503 || r.status === 429 || r.status === 500) { await sleep(3000); continue; }
        // موديل غير موجود أو غير متاح لحسابك: انتقل للتالي مباشرة
        if (r.status === 404 || r.status === 400) break;
        // مفتاح خاطئ أو ممنوع: لا فائدة من التكرار
        if (r.status === 401 || r.status === 403) return res.status(502).json({ error: lastErr });
      } catch (e) {
        lastErr = e.message;
        await sleep(1000);
      }
    }
  }
  res.status(502).json({ error: 'تعذّرت القراءة. ' + (errors.join(' | ') || lastErr) });
};

module.exports.config = { maxDuration: 60 };
