// Vercel Serverless Function: قراءة العقد مجاناً.
// 1) Mistral OCR (مجاني، يقرأ العربي ويستخرج الحقول مباشرة)  ->  MISTRAL_API_KEY
// 2) احتياطي: Gemini المجاني (موديلات متعددة)                 ->  GEMINI_API_KEY (موجود عندك)
// اختياري: ACCESS_CODE

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROMPT = `هذا مستند خاص بموظف (عقد عمل موحد أو إقامة أو شهادة صحية). استخرج البيانات.
اكتب "" (نص فارغ) لأي قيمة غير موجودة أو غير واضحة، ولا تخمّن.
تنبيه مهم: في عقد العمل الموحد يوجد شخصان: "الطرف الأول" (صاحب العمل) وممثله، و"الطرف الثاني" (العامل).
كل البيانات المطلوبة عن العامل (الطرف الثاني) فقط، ولا تأخذ اسم أو رقم هوية الممثل أو صاحب العمل.
التواريخ قد تكون بصيغة 2027/08/08 حوّلها إلى YYYY-MM-DD.
تاريخ نهاية العقد هو Contract end date وليس تاريخ البداية.
الجوال والبريد الإلكتروني: للعامل (الطرف الثاني) فقط.
تاريخ انتهاء الإقامة: فقط إذا ذُكر صراحة (عقد العمل لا يحتويه عادة، فاتركه "").`;

const FIELDS = {
  docType: 'نوع المستند: contract أو iqama أو health أو other',
  n: 'اسم الموظف (الطرف الثاني/العامل) بالعربية كما هو مكتوب في المستند',
  nat: 'جنسية الموظف كاسم دولة بالعربية مثل مصر، الهند، باكستان',
  idn: 'رقم هوية/إقامة الموظف (الطرف الثاني) وليس رقم الممثل',
  job: 'المسمى الوظيفي بالعربية',
  co: 'اسم المنشأة (صاحب العمل) بالعربية',
  ce: 'تاريخ نهاية العقد بصيغة YYYY-MM-DD',
  iq: 'تاريخ انتهاء الإقامة بصيغة YYYY-MM-DD فقط إذا ذُكر صراحة',
  msd: 'تاريخ مباشرة العمل (Commencement date) بصيغة YYYY-MM-DD',
  cs: 'تاريخ بداية العقد الحالي (Starting date) بصيغة YYYY-MM-DD',
  cn: 'رقم العقد (Contract number)',
  wc: 'مدينة/مكان العمل (Work location) بالعربية',
  ph: 'رقم جوال الموظف (الطرف الثاني) فقط، وليس جوال المنشأة',
  em: 'البريد الإلكتروني للموظف (الطرف الثاني) فقط، وليس بريد المنشأة',
  al: 'عدد أيام الإجازة السنوية كرقم فقط'
};

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(Object.entries(FIELDS).map(([k, d]) => [k, { type: 'string', description: d }])),
  required: Object.keys(FIELDS),
  additionalProperties: false
};

// تنظيف الناتج: القيم الفارغة تصير null، والتواريخ تُوحّد
function clean(o) {
  const empty = v => v === undefined || v === null || /^\s*(|null|none|n\/a|غير واضح|غير موجود)\s*$/i.test(String(v));
  const s = v => (empty(v) ? null : String(v).trim());
  const date = v => {
    const t = s(v); if (!t) return null;
    const m = t.replace(/[\/.]/g, '-').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
  };
  const dt = s(o.docType);
  return {
    docType: ['contract', 'iqama', 'health', 'other'].includes(dt) ? dt : 'other',
    n: s(o.n), nat: s(o.nat),
    idn: s(o.idn) ? String(o.idn).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '') || null : null,
    job: s(o.job), co: s(o.co), ce: date(o.ce), iq: date(o.iq),
    msd: date(o.msd), cs: date(o.cs),
    cn: s(o.cn) ? String(o.cn).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '') || null : null,
    wc: s(o.wc),
    ph: s(o.ph) ? String(o.ph).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d+]/g, '') || null : null,
    em: s(o.em) ? String(o.em).toLowerCase() : null,
    al: parseInt(String(o.al || '').replace(/\D/g, ''), 10) || null
  };
}

async function viaMistral(mime, data, key, errors) {
  const url = `data:${mime};base64,${data}`;
  const isPdf = mime === 'application/pdf';
  const document = isPdf ? { type: 'document_url', document_url: url } : { type: 'image_url', image_url: url };
  const base = {
    model: 'mistral-ocr-latest',
    document,
    document_annotation_format: { type: 'json_schema', json_schema: { name: 'employee', schema: SCHEMA, strict: true } },
    document_annotation_prompt: PROMPT,
    include_image_base64: false
  };
  // أول 3 صفحات تكفي (بيانات العقد والطرفين والمهنة). إذا الملف أقصر نعيد بدون تحديد الصفحات.
  const tries = isPdf ? [{ ...base, pages: [0, 1, 2] }, base] : [base];
  for (let i = 0; i < tries.length; i++) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch('https://api.mistral.ai/v1/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(tries[i])
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.document_annotation) {
          try { return clean(JSON.parse(j.document_annotation)); } catch (e) { errors.push('mistral: رد غير مفهوم'); return null; }
        }
        const msg = j.message || (j.detail && JSON.stringify(j.detail)) || (j.error && j.error.message) || 'خطأ';
        errors.push('mistral [' + r.status + ']: ' + String(msg).slice(0, 110));
        if ([429, 500, 502, 503].includes(r.status)) { await sleep(2500); continue; }
        if (r.status === 401 || r.status === 403) return null;
        break; // خطأ طلب: جرّب النسخة التالية (بدون pages) أو انتقل للاحتياطي
      } catch (e) { errors.push('mistral: ' + e.message); await sleep(1000); }
    }
  }
  return null;
}

async function viaGemini(mime, data, key, errors, started) {
  const models = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'].filter(Boolean))];
  const geminiPrompt = PROMPT + '\nأعد JSON فقط بهذه المفاتيح: ' + Object.entries(FIELDS).map(([k, d]) => `${k} (${d})`).join(' ، ');
  for (const model of models) {
    if (Date.now() - started > 100000) break;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: geminiPrompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        })
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { return clean(JSON.parse(m[0])); } catch (e) {} }
        errors.push(model + ': رد غير مفهوم'); continue;
      }
      errors.push(model + ' [' + r.status + ']: ' + String((j.error && j.error.message) || '').slice(0, 60));
      if (r.status === 503 || r.status === 429) await sleep(1500);
      if (r.status === 401 || r.status === 403) return null;
    } catch (e) { errors.push(model + ': ' + e.message); }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const mk = process.env.MISTRAL_API_KEY, gk = process.env.GEMINI_API_KEY;
  if (!mk && !gk) return res.status(500).json({ error: 'أضف MISTRAL_API_KEY في إعدادات Vercel' });
  if (process.env.ACCESS_CODE && req.headers['x-code'] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
  const { mime, data } = req.body || {};
  if (!mime || !data) return res.status(400).json({ error: 'ملف غير صالح' });

  const started = Date.now(), errors = [];
  let out = null;
  if (mk) out = await viaMistral(mime, data, mk, errors);
  if (!out && gk) out = await viaGemini(mime, data, gk, errors, started);
  if (out) return res.status(200).json(out);
  res.status(502).json({ error: 'تعذّرت القراءة. ' + (errors.join(' | ') || 'فشل الاتصال') });
};

module.exports.config = { maxDuration: 120 };
