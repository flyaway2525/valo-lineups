// データの読み書きをまとめた層（Firestore）。
//
// データ構造（詳しくは docs/design.md）
//   groups/{groupId}                     グループ。memberIds / members でメンバーを管理
//   groups/{groupId}/lineups/{lineupId}  定点（グループのメンバー全員が見られて、編集もできる）
//   groups/{groupId}/images/{imageId}    定点の画像（圧縮した WebP を data URL で 1 枚 1 ドキュメント）
//   prefs/{uid}                          お気に入り・ショートカット（本人だけ読み書き）
//
// watch〜 は変更があるたびに cb を呼ぶ。戻り値の関数を呼ぶと監視をやめる。

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { db } from './firebase.js';
import { currentUser, displayName, isGuest } from './auth.js';

const groupRef = (groupId) => doc(db, 'groups', groupId);
const lineupsCol = (groupId) => collection(db, 'groups', groupId, 'lineups');
const lineupRef = (groupId, id) => doc(db, 'groups', groupId, 'lineups', id);
const imagesCol = (groupId) => collection(db, 'groups', groupId, 'images');
const imageRef = (groupId, id) => doc(db, 'groups', groupId, 'images', id);
const prefsRef = () => doc(db, 'prefs', uid());

function newId() {
  return doc(collection(db, '_')).id;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

function uid() {
  const user = currentUser();
  if (!user) throw new Error('ログインしていません');
  return user.uid;
}

function byCreatedAt(a, b) {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

function withId(snap) {
  return { id: snap.id, ...snap.data() };
}

// 1 回のバッチは 500 件まで
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

// ---- グループ ----

export function watchMyGroups(cb, onError) {
  const q = query(collection(db, 'groups'), where('memberIds', 'array-contains', uid()));
  return onSnapshot(q, (snap) => cb(snap.docs.map(withId).sort(byCreatedAt)), onError);
}

export async function createGroup(name) {
  const me = uid();
  const id = newId();
  await setDoc(groupRef(id), {
    name,
    createdAt: Date.now(),
    createdBy: me,
    inviteCode: randomCode(),
    memberIds: [me],
    members: { [me]: { name: displayName(), role: 'owner', guest: false, joinedAt: Date.now() } },
  });
  return id;
}

export async function renameGroup(groupId, name) {
  await updateDoc(groupRef(groupId), { name });
}

// 招待リンクを作り直す（古いリンクでは参加できなくなる）
export async function regenerateInvite(groupId) {
  await updateDoc(groupRef(groupId), { inviteCode: randomCode() });
}

export function inviteUrl(group) {
  return `${location.origin}${location.pathname}#/join/${group.id}/${group.inviteCode}`;
}

// グループの定点・画像もまとめて消す（Firestore はサブコレクションを自動では消さない）
export async function deleteGroup(groupId) {
  const [lineups, images] = await Promise.all([getDocs(lineupsCol(groupId)), getDocs(imagesCol(groupId))]);
  await commitInChunks([...lineups.docs, ...images.docs].map((d) => (b) => b.delete(d.ref)));
  await deleteDoc(groupRef(groupId));
}

// 招待リンクから参加する。すでにメンバーならそのまま true を返す
export async function joinGroup(groupId, inviteCode) {
  const me = uid();
  try {
    const snap = await getDoc(groupRef(groupId));
    if (snap.exists()) return true; // 読めた = すでにメンバー
  } catch {
    // メンバーでなければ読めないので、参加処理へ進む
  }
  await updateDoc(groupRef(groupId), {
    memberIds: arrayUnion(me),
    [`members.${me}`]: { name: displayName(), role: 'member', guest: isGuest(), joinedAt: Date.now(), inviteCode },
  });
  return true;
}

export async function leaveGroup(groupId) {
  const me = uid();
  await updateDoc(groupRef(groupId), { memberIds: arrayRemove(me), [`members.${me}`]: deleteField() });
}

// 名前を変えたとき・Google に引き継いだときに、各グループでの表示をそろえる
export async function syncMyProfile() {
  const me = uid();
  const groups = await getDocs(query(collection(db, 'groups'), where('memberIds', 'array-contains', me)));
  await commitInChunks(
    groups.docs.map((g) => (b) => b.update(g.ref, { [`members.${me}.name`]: displayName(), [`members.${me}.guest`]: isGuest() })),
  );
}

// ---- 定点 ----

// グループの、あるマップの定点を監視する
export function watchLineups(groupId, mapId, cb, onError) {
  return onSnapshot(
    query(lineupsCol(groupId), where('map', '==', mapId)),
    (snap) => cb(snap.docs.map(withId)),
    onError,
  );
}

export async function getLineup(groupId, id) {
  const snap = await getDoc(lineupRef(groupId, id));
  return snap.exists() ? withId(snap) : null;
}

// id が null なら新規作成。戻り値は定点の ID
export async function saveLineup(groupId, id, data) {
  const me = uid();
  const now = Date.now();
  const stamp = { updatedBy: me, updatedByName: displayName(), updatedAt: now };
  if (id) {
    await updateDoc(lineupRef(groupId, id), { ...data, ...stamp });
    return id;
  }
  const newLineupId = newId();
  await setDoc(lineupRef(groupId, newLineupId), {
    ...data,
    ...stamp,
    createdBy: me,
    createdByName: displayName(),
    createdAt: now,
  });
  return newLineupId;
}

// imageIds は [立ち位置, 照準, 着弾] の 3 枠。空いている枠は null
export async function deleteLineup(groupId, lineup) {
  const batch = writeBatch(db);
  (lineup.imageIds ?? []).filter(Boolean).forEach((imgId) => batch.delete(imageRef(groupId, imgId)));
  batch.delete(lineupRef(groupId, lineup.id));
  await batch.commit();
}

// 別のグループにコピーする（画像も複製。元の定点とは同期しない）
export async function copyLineup(fromGroupId, lineup, toGroupId) {
  const imageIds = [];
  for (const imgId of lineup.imageIds ?? []) {
    const img = imgId && (await getImage(fromGroupId, imgId));
    imageIds.push(img ? await putImage(toGroupId, img) : null);
  }
  const { id, createdBy, createdByName, createdAt, updatedBy, updatedByName, updatedAt, ...rest } = lineup;
  return saveLineup(toGroupId, null, { ...rest, imageIds });
}

// ---- 画像 ----

const imageCache = new Map();

export async function putImage(groupId, { data, w, h }) {
  const id = newId();
  await setDoc(imageRef(groupId, id), { createdBy: uid(), data, w, h, createdAt: Date.now() });
  imageCache.set(`${groupId}/${id}`, { data, w, h });
  return id;
}

export async function getImage(groupId, id) {
  const key = `${groupId}/${id}`;
  if (imageCache.has(key)) return imageCache.get(key);
  const snap = await getDoc(imageRef(groupId, id));
  if (!snap.exists()) return null;
  const { data, w, h } = snap.data();
  imageCache.set(key, { data, w, h });
  return { data, w, h };
}

export async function deleteImages(groupId, ids) {
  await Promise.all(ids.map((id) => deleteDoc(imageRef(groupId, id)).catch(() => {})));
  ids.forEach((id) => imageCache.delete(`${groupId}/${id}`));
}

// ---- お気に入り・ショートカット ----
// お気に入りは "groupId/lineupId" の形で持つ

export function watchPrefs(cb) {
  return onSnapshot(
    prefsRef(),
    (snap) => cb({ favorites: [], shortcuts: [], ...(snap.exists() ? snap.data() : {}) }),
    () => cb({ favorites: [], shortcuts: [] }),
  );
}

export async function setFavorite(key, on) {
  await setDoc(prefsRef(), { favorites: on ? arrayUnion(key) : arrayRemove(key) }, { merge: true });
}

export async function setShortcuts(shortcuts) {
  await setDoc(prefsRef(), { shortcuts }, { merge: true });
}
