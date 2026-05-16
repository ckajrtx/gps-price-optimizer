// setSuperuser.js — run once with: node setSuperuser.js
// Sets ckajrtx@gmail.com as superuser in Firestore.

const admin = require('firebase-admin');
const serviceAccount = require('C:/Users/ckajr/Downloads/quoteiq-app-firebase-adminsdk-fbsvc-a56c28373c.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db   = admin.firestore();
const auth = admin.auth();
const EMAIL = 'ckajrtx@gmail.com';

(async () => {
  try {
    const user = await auth.getUserByEmail(EMAIL);
    const uid  = user.uid;

    await db.collection('users').doc(uid).set({
      email:       EMAIL,
      displayName: user.displayName || 'Admin',
      role:        'superuser',
      status:      'active',
      companyId:   '',
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`✅  Superuser doc set for uid: ${uid}`);
    console.log(`    email: ${EMAIL}, role: superuser, status: active`);
  } catch (e) {
    console.error('❌  Failed:', e.message);
  } finally {
    process.exit(0);
  }
})();
