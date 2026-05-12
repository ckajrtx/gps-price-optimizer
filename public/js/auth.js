// ═══════════════════════════════════════════
// auth.js — Authentication helpers
// ═══════════════════════════════════════════
import { auth, db }                from './firebase-init.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Persist session across browser restarts
setPersistence(auth, browserLocalPersistence);

const googleProvider = new GoogleAuthProvider();

// ── SIGN IN (email/password) ──────────────────────────
export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// ── SIGN IN WITH GOOGLE ───────────────────────────────
export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

// ── SIGN OUT ──────────────────────────────────────────
export async function signOutUser() {
  await signOut(auth);
  window.location.href = '/index.html';
}

// ── SEND PASSWORD RESET ───────────────────────────────
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// ── GET USER FIRESTORE DOC ────────────────────────────
export async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ── REQUIRE AUTH (call at top of protected pages) ─────
// Returns { firebaseUser, userDoc } or redirects to login
export function requireAuth(callback) {
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      window.location.href = '/index.html';
      return;
    }
    const userDoc = await getUserDoc(firebaseUser.uid);
    if (!userDoc || userDoc.status === 'inactive') {
      await signOut(auth);
      window.location.href = '/index.html?error=inactive';
      return;
    }
    callback(firebaseUser, userDoc);
  });
}

// ── REQUIRE SUPERUSER ─────────────────────────────────
export function requireSuperuser(callback) {
  requireAuth((firebaseUser, userDoc) => {
    if (userDoc.role !== 'superuser') {
      window.location.href = '/app.html';
      return;
    }
    callback(firebaseUser, userDoc);
  });
}

// ── CREATE USER ACCOUNT (for invite flow) ────────────
export async function createUserFromInvite(email, password, displayName, inviteData) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await setDoc(doc(db, 'users', cred.user.uid), {
    email,
    displayName,
    companyId: inviteData.companyId,
    role: inviteData.role || 'user',
    status: 'active',
    createdAt: serverTimestamp(),
    invitedBy: inviteData.createdBy || null
  });
  return cred.user;
}

// ── WATCH AUTH STATE ─────────────────────────────────
export { onAuthStateChanged, auth };
