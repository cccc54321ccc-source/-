// Vercel Serverless Function: يقرأ الملف عبر Gemini. المفتاح يبقى في Vercel ولا يظهر للمتصفح.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'أضف GEMINI_API_KEY في إعدادات Vercel' });
  if (process.env.ACCESS_CODE && req.headers['x-code'] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
  const { mime, data } = req.body || {};
  if (!mime || !data) return res.status(400).json({ error: 'ملف غير صالح' });
  const prompt = `اقرأ هذا المستند الخاص بموظف (عقد عمل موحد أو إقامة أو شهادة صحية) وأعد JSON فقط بهذه المفاتيح.
ضع null لأي قيمة غير موجودة أو غير واضحة ولا تخمّن:
docType: contract أو iqama أو health أو other
n: اسم الموظف (الطرف الثاني / العامل) بالعربية، وليس صاحب العمل ولا الممثل
nat: جنسية الموظف كاسم دولة بالعربية (مثل مصر، الهند، باكستان)
idn: رقم هوية/إقامة الموظف (الطرف الثاني)
job: المسمى الوظيفي بالعربية
co: اسم المنشأة (صاحب العمل)
ce: تاريخ نهاية العقد بصيغة YYYY-MM-DD
iq: تاريخ انتهاء الإقامة بصيغة YYYY-MM-DD، فقط إذا ذُكر صراحة`;
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'فشل الاتصال بـ Gemini' });
    const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '{}';
    res.status(200).json(JSON.parse(txt.replace(/```json|```/g, '')));
  } catch (e) {
    res.status(500).json({ error: 'تعذّرت القراءة: ' + e.message });
  }
};
