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
