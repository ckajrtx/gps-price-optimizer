// ═══════════════════════════════════════════
// Firebase Configuration — QuoteIQ
// ═══════════════════════════════════════════
import { initializeApp }        from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth }              from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore }         from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage }           from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const firebaseConfig = {
  apiKey:            "AIzaSyBosVovhJjrZqEsC9Lnl2GCtxmTfMLff_M",
  authDomain:        "quoteiq-app.firebaseapp.com",
  projectId:         "quoteiq-app",
  storageBucket:     "quoteiq-app.firebasestorage.app",
  messagingSenderId: "532864065155",
  appId:             "1:532864065155:web:e0d3270da4fdccfe0cc5b6",
  measurementId:     "G-LRPB0CV27N"
};

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };
