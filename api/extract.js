// Vercel Serverless Function: يقرأ الملف عبر OpenRouter (مفتاح واحد لعدة موديلات).
// المتغيرات في Vercel: OPENROUTER_API_KEY  (اختياري: OPENROUTER_MODEL, ACCESS_CODE)

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROMPT = `اقرأ هذا المستند الخاص بموظف (عقد عمل موحد أو إقامة أو شهادة صحية) وأعد JSON فقط بدون أي شرح أو علامات ماركداون، بهذه المفاتيح.
ضع null لأي قيمة غير موجودة أو غير واضحة ولا تخمّن.
تنبيه مهم: في عقد العمل الموحد يوجد شخصان: "الطرف الأول" (صاحب العمل) وممثله، و"الطرف الثاني" (العامل).
كل البيانات المطلوبة عن العامل (الطرف الثاني) فقط، ولا تأخذ اسم أو رقم هوية الممثل أو صاحب العمل.
التواريخ قد تكون بصيغة 2027/08/08 حوّلها إلى YYYY-MM-DD.
المفاتيح:
docType: contract أو iqama أو health أو other
n: اسم الموظف (الطرف الثاني/العامل) بالعربية كما في المستند
nat: جنسية الموظف كاسم دولة بالعربية (مثل مصر، الهند، باكستان)
idn: رقم هوية/إقامة الموظف وليس رقم الممثل
job: المسمى الوظيفي بالعربية
co: اسم المنشأة (صاحب العمل) بالعربية
ce: تاريخ نهاية العقد (Contract end date) بصيغة YYYY-MM-DD
iq: تاريخ انتهاء الإقامة بصيغة YYYY-MM-DD فقط إذا ذُكر صراحة (عقد العمل لا يحتويه عادة، فاجعله null)`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: 'أضف OPENROUTER_API_KEY في إعدادات Vercel' });
  if (process.env.ACCESS_CODE && req.headers['x-code'] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
  const { mime, data } = req.body || {};
  if (!mime || !data) return res.status(400).json({ error: 'ملف غير صالح' });

  const isPdf = mime === 'application/pdf';
  const dataUrl = `data:${mime};base64,${data}`;
  const filePart = isPdf
    ? { type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } }
    : { type: 'image_url', image_url: { url: dataUrl } };

  // الأول هو الأساسي، والباقي احتياطي إذا فشل أو كان مضغوطاً
  const models = [...new Set([
    process.env.OPENROUTER_MODEL,
    'anthropic/claude-haiku-4.5',
    'google/gemini-3.6-flash'
  ].filter(Boolean))];

  const started = Date.now();
  const errors = [];

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > 50000) break;
      try {
        const body = {
          model,
          temperature: 0,
          max_tokens: 800,
          messages: [{ role: 'user', content: [filePart, { type: 'text', text: PROMPT }] }]
        };
        // native: يرسل الـ PDF للموديل كما هو (مهم للعربي، لأن استخراج النص من هذي العقود العربية يطلع مشوّه)
        if (isPdf) body.plugins = [{ id: 'file-parser', pdf: { engine: 'native' } }];

        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));

        if (r.ok && j.choices && j.choices[0]) {
          const txt = String(j.choices[0].message?.content || '');
          const m = txt.match(/\{[\s\S]*\}/);
          if (m) {
            try { return res.status(200).json(JSON.parse(m[0])); } catch (e) {}
          }
          errors.push(model + ': رد غير مفهوم');
          continue;
        }

        const msg = (j.error && (j.error.message || j.error.code)) || 'خطأ';
        errors.push(model + ' [' + r.status + ']: ' + String(msg).slice(0, 90));
        if ([429, 500, 502, 503, 529].includes(r.status)) { await sleep(2500); continue; }
        if (r.status === 401 || r.status === 402) return res.status(502).json({ error: 'تعذّرت القراءة. ' + errors.join(' | ') });
        break; // موديل غير موجود أو لا يدعم الملف: جرّب التالي
      } catch (e) {
        errors.push(model + ': ' + e.message);
        await sleep(1000);
      }
    }
  }
  res.status(502).json({ error: 'تعذّرت القراءة. ' + (errors.join(' | ') || 'فشل الاتصال') });
};

module.exports.config = { maxDuration: 60 };
