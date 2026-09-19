// api/car-verify.js  (Vercel Serverless Function)
// ─────────────────────────────────────────────────────────────
// فحص دوري لمفتاح "أجندة السيارة" (بيتنادى مرة في اليوم من التطبيق)
// المتصفح يبعت POST بـ { key, deviceId } — السيرفر يرجع { valid, exp }
// ─────────────────────────────────────────────────────────────

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

const PROJECT_NAME = 'Car Agenda';
const DAY = 24 * 60 * 60 * 1000;
const FOREVER = new Date('2099-01-01').getTime();

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
  if (req.method !== 'POST') return res.status(405).json({ valid: false });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch { return res.status(400).json({ valid: false }); }
  }
  body = body || {};

  const key      = String(body.key || '').slice(0, 64).trim().toUpperCase();
  const deviceId = String(body.deviceId || '').slice(0, 200).trim();
  if (!key.startsWith('CAR-') || !deviceId) return res.status(400).json({ valid: false });

  try {
    const snapshot = await db.collection('keys').where('key', '==', key).limit(1).get();

    // المفتاح اتمسح من لوحة الإدارة
    if (snapshot.empty) return res.status(200).json({ valid: false });

    const data = snapshot.docs[0].data();

    if (data.project && data.project !== PROJECT_NAME) return res.status(200).json({ valid: false });
    if (data.status === 'revoked' || data.status === 'disabled') return res.status(200).json({ valid: false });

    const maxUses = Number(data.max_uses) || 0;
    if (maxUses === 0) {
      if (data.device_id && data.device_id !== deviceId) return res.status(200).json({ valid: false });
    } else {
      const devices = Array.isArray(data.devices) ? data.devices : [];
      if (!devices.some(d => d && d.id === deviceId)) return res.status(200).json({ valid: false });
    }

    const exp = computeExp(data);
    if (exp !== null && exp < Date.now()) return res.status(200).json({ valid: false });

    return res.status(200).json({ valid: true, exp: exp || FOREVER });

  } catch (err) {
    console.error('car-verify error:', err);
    // مشكلة في السيرفر — متطردش المستخدم
    return res.status(200).json({ valid: true, exp: null });
  }
};
