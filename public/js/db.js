// ═══════════════════════════════════════════
// db.js — Firestore read/write helpers
// ═══════════════════════════════════════════
import { db, storage }    from './firebase-init.js';
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, orderBy,
  serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  ref, uploadString, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// ── DEBOUNCE HELPER ──────────────────────────────────
const debounceTimers = {};
export function debounce(key, fn, delay = 800) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(fn, delay);
}

// ══════════════════════════════════════════════════════
// COMPANY
// ══════════════════════════════════════════════════════
export async function getCompany(companyId) {
  const snap = await getDoc(doc(db, 'companies', companyId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getAllCompanies() {
  const snap = await getDocs(collection(db, 'companies'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createCompany(name, createdBy) {
  const ref2 = await addDoc(collection(db, 'companies'), {
    name, status: 'active', createdAt: serverTimestamp(), createdBy
  });
  return ref2.id;
}

export async function updateCompanyStatus(companyId, status) {
  await updateDoc(doc(db, 'companies', companyId), { status });
}

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
export async function getAllUsers() {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getUsersByCompany(companyId) {
  const q = query(collection(db, 'users'), where('companyId', '==', companyId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function updateUserStatus(uid, status) {
  await updateDoc(doc(db, 'users', uid), { status });
}

// ══════════════════════════════════════════════════════
// INVITES
// ══════════════════════════════════════════════════════
export async function createInvite(email, companyId, createdBy, role = 'user') {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await setDoc(doc(db, 'invites', token), {
    email, companyId, createdBy,
    role,
    createdAt: serverTimestamp(),
    expiresAt, used: false
  });
  return token;
}

export async function getInvite(token) {
  const snap = await getDoc(doc(db, 'invites', token));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function markInviteUsed(token) {
  await updateDoc(doc(db, 'invites', token), { used: true });
}

// ══════════════════════════════════════════════════════
// COMPANY SETTINGS
// ══════════════════════════════════════════════════════
export async function getSettings(companyId) {
  const snap = await getDoc(doc(db, 'companies', companyId, 'settings', 'main'));
  return snap.exists() ? snap.data() : {
    epsilon: 3, minPoints: 5,
    quantityDiscount: 0.30, extraChargePerMile: 15,
    priceIncreaseRate: 0.10, prefBuffer: 0.40, orsKey: ''
  };
}

export async function saveSettings(companyId, settings) {
  await setDoc(doc(db, 'companies', companyId, 'settings', 'main'), settings, { merge: true });
}

// ══════════════════════════════════════════════════════
// PRICING TABLES (compAreas, minPrices, prefPrices)
// ══════════════════════════════════════════════════════
async function getSubcollection(companyId, name) {
  const snap = await getDocs(collection(db, 'companies', companyId, name));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

async function saveSubcollection(companyId, name, items) {
  const colRef = collection(db, 'companies', companyId, name);
  // Delete existing, re-write all (simple but effective for small tables)
  const existing = await getDocs(colRef);
  const batch = writeBatch(db);
  existing.docs.forEach(d => batch.delete(d.ref));
  items.forEach(item => {
    const { _id, ...data } = item;
    batch.set(doc(colRef), data);
  });
  await batch.commit();
}

export const getCompAreas  = (cid) => getSubcollection(cid, 'compAreas');
export const getMinPrices  = (cid) => getSubcollection(cid, 'minPrices');
export const getPrefPrices = (cid) => getSubcollection(cid, 'prefPrices');
export const saveCompAreas  = (cid, d) => saveSubcollection(cid, 'compAreas', d);
export const saveMinPrices  = (cid, d) => saveSubcollection(cid, 'minPrices', d);
export const savePrefPrices = (cid, d) => saveSubcollection(cid, 'prefPrices', d);

// ══════════════════════════════════════════════════════
// SERVICE CODE TABLE
// ══════════════════════════════════════════════════════
export const getServiceCodes  = (cid) => getSubcollection(cid, 'serviceCodeTable');
export const saveServiceCodes = (cid, d) => saveSubcollection(cid, 'serviceCodeTable', d);

export async function clearServiceCodes(companyId) {
  await saveSubcollection(companyId, 'serviceCodeTable', []);
}

// ══════════════════════════════════════════════════════
// UPLOADS (features stored in Firebase Storage)
// ══════════════════════════════════════════════════════
export async function saveUpload(companyId, uid, fileName, features) {
  const storageRef = `uploads/${companyId}/${Date.now()}_features.json`;
  const storageFileRef = ref(storage, storageRef);
  await uploadString(storageFileRef, JSON.stringify(features), 'raw', { contentType: 'application/json' });
  const uploadRef = await addDoc(collection(db, 'companies', companyId, 'uploads'), {
    fileName, rowCount: features.length,
    uploadedAt: serverTimestamp(), uploadedBy: uid, storageRef
  });
  return uploadRef.id;
}

export async function getLatestUpload(companyId) {
  const q = query(
    collection(db, 'companies', companyId, 'uploads'),
    orderBy('uploadedAt', 'desc')
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const meta = { id: snap.docs[0].id, ...snap.docs[0].data() };
  // Download features JSON from Storage
  const url = await getDownloadURL(ref(storage, meta.storageRef));
  const resp = await fetch(url);
  const features = await resp.json();
  return { meta, features };
}

// ══════════════════════════════════════════════════════
// SESSIONS (named, user-selectable)
// ══════════════════════════════════════════════════════
export async function getSessions(companyId) {
  const q = query(
    collection(db, 'companies', companyId, 'sessions'),
    orderBy('updatedAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createSession(companyId, uid, { name, fileName, rowCount, features }) {
  const sRef = `sessions/${companyId}/${Date.now()}.json`;
  await uploadString(ref(storage, sRef), JSON.stringify(features), 'raw',
    { contentType: 'application/json' });
  const docRef = await addDoc(collection(db, 'companies', companyId, 'sessions'), {
    name, fileName, rowCount, storageRef: sRef,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: uid,
  });
  return { id: docRef.id, storageRef: sRef };
}

export async function updateSessionData(companyId, sessionId, { name, rowCount, features, storageRef }) {
  await uploadString(ref(storage, storageRef), JSON.stringify(features), 'raw',
    { contentType: 'application/json' });
  await updateDoc(doc(db, 'companies', companyId, 'sessions', sessionId),
    { name, rowCount, updatedAt: serverTimestamp() });
}

export async function renameSession(companyId, sessionId, newName) {
  await updateDoc(doc(db, 'companies', companyId, 'sessions', sessionId),
    { name: newName, updatedAt: serverTimestamp() });
}

export async function deleteSession(companyId, sessionId, storageRef) {
  await deleteDoc(doc(db, 'companies', companyId, 'sessions', sessionId));
  try { await deleteObject(ref(storage, storageRef)); } catch (_) {}
}

export async function loadSessionFeatures(storageRef) {
  const url = await getDownloadURL(ref(storage, storageRef));
  const resp = await fetch(url);
  return resp.json();
}
