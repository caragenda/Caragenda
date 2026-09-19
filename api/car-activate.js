// api/car-activate.js  (Vercel Serverless Function)
// ─────────────────────────────────────────────────────────────
// تفعيل مفاتيح تطبيق "أجندة السيارة" (CAR-XXXX-XXXX)
// المتصفح يبعت POST بـ { key, pin, deviceId, deviceInfo }
// السيرفر يرجع { success, exp } أو { success:false, code, error }
// لازم يقرأ من مشروع Firebase اللي فيه لوحة المفاتيح (collection: keys) — بيانات الدخول في Environment Variables بس
// ─────────────────────────────────────────────────────────────

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

// بيانات الـ service account: متغير واحد Base64 (الأفضل) أو التلاتة القديمة
// أي مشكلة في الإعداد بترجع رسالة واضحة بدل ما الـ function تقع وهي بتتحمّل
function loadCreds() {
  const b64 = (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (b64) {
    let j;
    try { j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); }
    catch { throw new Error('قيمة FIREBASE_SERVICE_ACCOUNT_BASE64 مش Base64 لملف JSON صحيح — حوّل الملف من الأداة تاني'); }
    const miss = ['project_id', 'client_email', 'private_key'].filter(k => !j || !j[k]);
    if (miss.length) throw new Error('الـ JSON ناقص: ' + miss.join(', '));
    return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
  }
  const c = {
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
  if (!c.projectId || !c.clientEmail || !c.privateKey) {
    throw new Error('المتغير FIREBASE_SERVICE_ACCOUNT_BASE64 مش موجود على السيرفر (أو فاضي) — راجع اسمه وأعد النشر Redeploy');
  }
  return c;
}

let _db = null, _projectId = '';
function getDb() {
  if (_db) return _db;
  if (!getApps().length) {
    const creds = loadCreds();
    try { initializeApp({ credential: cert(creds) }); }
    catch (e) { throw new Error('فشل تهيئة Firebase: ' + String(e && e.message).slice(0, 120)); }
    _projectId = creds.projectId;
  }
  _db = getFirestore();
  return _db;
}

const PROJECT_NAME = 'Car Agenda';
const DAY = 24 * 60 * 60 * 1000;
const FOREVER = new Date('2099-01-01').getTime();

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

// مدة الصلاحية (null = دائم)
function computeExp(data) {
  if (data.expiry_date && data.expiry_date !== '') {
    const e = new Date(data.expiry_date).getTime();
    return Number.isNaN(e) ? null : e;
  }
  if (data.duration_days && data.duration_days > 0) {
    const a = data.activated_at ? new Date(data.activated_at).getTime() : Date.now();
    return (Number.isNaN(a) ? Date.now() : a) + data.duration_days * DAY;
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 405, 'bad-request', 'Method not allowed');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch { return fail(res, 400, 'bad-request', 'Invalid JSON'); }
  }
  body = body || {};

  const cleanKey = clip(body.key, 64).trim().toUpperCase();
  const pin      = clip(body.pin, 32).trim();
  const deviceId = clip(body.deviceId, 200).trim();
  const info     = (body.deviceInfo && typeof body.deviceInfo === 'object') ? body.deviceInfo : {};

  // نسمح بأربع حقول بس من جهاز المستخدم — مفيش حاجة تانية تتكتب في مستند المفتاح
  const deviceInfo = {
    device_type: clip(info.device_type, 30),
    browser:     clip(info.browser, 60),
    os:          clip(info.os, 60),
    user_agent:  clip(info.user_agent, 200),
  };

  if (!cleanKey.startsWith('CAR-') || cleanKey.length < 8) {
    return fail(res, 401, 'not-found', '❌ مفتاح غير صحيح');
  }
  if (!deviceId) return fail(res, 400, 'bad-request', 'Device ID مفقود');

  let db;
  try { db = getDb(); }
  catch (e) { console.error('car-activate config:', e.message); return fail(res, 500, 'config', '⚙️ ' + e.message); }

  try {
    const q = await db.collection('keys').where('key', '==', cleanKey).limit(1).get();
    if (q.empty) return fail(res, 401, 'not-found', '❌ مفتاح غير صحيح');
    const docRef = q.docs[0].ref;

    // Transaction عشان جهازين مايفعّلوش نفس المفتاح في نفس اللحظة
    const out = await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) return { status: 401, code: 'not-found', error: '❌ مفتاح غير صحيح' };
      const data = snap.data();

      const isCarKey = data.project ? data.project === PROJECT_NAME : true; // المفتاح CAR- أصلاً
      if (!isCarKey) return { status: 403, code: 'wrong-project', error: '❌ هذا المفتاح غير خاص بهذا التطبيق' };

      if (String(data.pin_code || '') !== pin) {
        return { status: 401, code: 'invalid', error: '❌ المفتاح أو الرقم السري غير صحيح' };
      }
      if (data.status === 'revoked' || data.status === 'disabled') {
        return { status: 403, code: 'revoked', error: '⛔ تم إلغاء هذا المفتاح' };
      }

      const exp = computeExp(data);
      if (exp !== null && exp < Date.now()) {
        return { status: 403, code: 'expired', error: '⏰ انتهت صلاحية هذا المفتاح' };
      }

      const nowIso  = new Date().toISOString();
      const maxUses = Number(data.max_uses) || 0;

      if (maxUses === 0) {
        // جهاز واحد
        if (data.device_id && data.device_id !== deviceId) {
          return { status: 403, code: 'other-device', error: '⛔ هذا المفتاح مفعّل على جهاز آخر' };
        }
        if (!data.device_id) {
          t.update(docRef, {
            device_id: deviceId, activated_at: nowIso, status: 'used', use_count: 1, ...deviceInfo,
          });
        }
      } else {
        // أجهزة متعددة
        const devices = Array.isArray(data.devices) ? data.devices : [];
        const idx = devices.findIndex(d => d && d.id === deviceId);
        if (idx >= 0) {
          const updated = devices.map((d, i) => i === idx ? { ...d, activated_at: nowIso, ...deviceInfo } : d);
          t.update(docRef, { devices: updated });
        } else {
          if (devices.length >= maxUses) {
            return { status: 403, code: 'exhausted', error: `⛔ وصل المفتاح للحد الأقصى (${maxUses} أجهزة)` };
          }
          const updated = [...devices, { id: deviceId, activated_at: nowIso, ...deviceInfo }];
          t.update(docRef, {
            devices: updated,
            use_count: updated.length,
            activated_at: data.activated_at || nowIso,
            status: updated.length >= maxUses ? 'used' : 'active',
          });
        }
      }

      return { ok: true, exp: exp || FOREVER };
    });

    if (!out.ok) return fail(res, out.status, out.code, out.error);
    return res.status(200).json({ success: true, exp: out.exp });

  } catch (err) {
    console.error('car-activate error:', err);
    return fail(res, 500, 'server', '⚠️ خطأ في الخادم — حاول مجدداً');
  }
};
