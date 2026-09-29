// データの読み書きをまとめた層（Firestore 版）。同じ関数を demo.js も持っている。
//
// データ構造（詳しくは docs/design.md）
//   admins/{uid}          グループを作れる人の許可リスト（コンソールから手で追加）
//   groups/{groupId}      グループ。memberIds / members でメンバーを管理
//   lineups/{lineupId}    定点。visibility = private（自分だけ）/ group（グループ）/ public（全体）
//   images/{imageId}      定点の画像（圧縮した WebP を data URL で 1 枚 1 ドキュメント）
//   prefs/{uid}           お気に入り・ショートカット（本人だけ読み書き）
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
const lineupsCol = () => collection(db, 'lineups');
const lineupRef = (id) => doc(db, 'lineups', id);
const imageRef = (id) => doc(db, 'images', id);
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

// ---- 許可リスト ----

export function watchIsAdmin(userId, cb) {
  return onSnapshot(
    doc(db, 'admins', userId),
    (snap) => cb(snap.exists()),
    () => cb(false),
  );
}

// ---- グループ ----

export function watchMyGroups(cb, onError) {
  const q = query(collection(db, 'groups'), where('memberIds', 'array-contains', uid()));
  return onSnapshot(q, (snap) => cb(snap.docs.map(withId).sort(byCreatedAt)), onError);
}

export function watchGroup(groupId, cb, onError) {
  return onSnapshot(
    groupRef(groupId),
    (snap) => (snap.exists() ? cb(withId(snap)) : onError?.(new Error('not-found'))),
    onError,
  );
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

// グループを消しても、グループ公開にしていた定点は消えない（登録した本人からは引き続き見える）
export async function deleteGroup(groupId) {
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

// 名前を変えたとき・Google に引き継いだときに、グループでの表示と登録した定点の作者名をそろえる
export async function syncMyProfile() {
  const me = uid();
  const name = displayName();
  const [groups, lineups] = await Promise.all([
    getDocs(query(collection(db, 'groups'), where('memberIds', 'array-contains', me))),
    getDocs(query(lineupsCol(), where('ownerId', '==', me))),
  ]);
  const writes = [
    ...groups.docs.map((g) => [g.ref, { [`members.${me}.name`]: name, [`members.${me}.guest`]: isGuest() }]),
    ...lineups.docs.filter((l) => l.data().ownerName !== name).map((l) => [l.ref, { ownerName: name }]),
  ];
  // 1 回のバッチは 500 件まで
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(db);
    writes.slice(i, i + 400).forEach(([ref, data]) => batch.update(ref, data));
    await batch.commit();
  }
}

// ---- 定点 ----

// あるマップの「見てよい定点」をまとめて監視する
//   自分の定点 + 所属グループに公開された定点 + 全体公開の定点
// （セキュリティルールで検証できるよう、クエリを 3 種類に分けて手元で 1 つにまとめる）
export function watchLineups(mapId, groupIds, cb, onError) {
  const me = uid();
  const parts = new Map(); // クエリごとの結果
  const emit = () => {
    const all = new Map();
    for (const list of parts.values()) for (const l of list) all.set(l.id, l);
    cb([...all.values()]);
  };
  const queries = [
    ['mine', query(lineupsCol(), where('ownerId', '==', me), where('map', '==', mapId))],
    ['public', query(lineupsCol(), where('visibility', '==', 'public'), where('map', '==', mapId))],
    ...groupIds.map((g) => [
      `g:${g}`,
      query(lineupsCol(), where('visibility', '==', 'group'), where('groupId', '==', g), where('map', '==', mapId)),
    ]),
  ];
  const unsubs = queries.map(([key, q]) =>
    onSnapshot(
      q,
      (snap) => {
        parts.set(key, snap.docs.map(withId));
        emit();
      },
      onError,
    ),
  );
  return () => unsubs.forEach((u) => u());
}

export async function getLineup(id) {
  const snap = await getDoc(lineupRef(id));
  return snap.exists() ? withId(snap) : null;
}

// id が null なら新規作成。戻り値は定点の ID
export async function saveLineup(id, data) {
  const me = uid();
  const now = Date.now();
  if (id) {
    await updateDoc(lineupRef(id), { ...data, ownerName: displayName(), updatedAt: now });
    return id;
  }
  const newLineupId = newId();
  await setDoc(lineupRef(newLineupId), { ...data, ownerId: me, ownerName: displayName(), createdAt: now, updatedAt: now });
  return newLineupId;
}

// imageIds は [立ち位置, 照準, 着弾] の 3 枠。空いている枠は null
export async function deleteLineup(lineup) {
  const batch = writeBatch(db);
  (lineup.imageIds ?? []).filter(Boolean).forEach((imgId) => batch.delete(imageRef(imgId)));
  batch.delete(lineupRef(lineup.id));
  await batch.commit();
}

// 他の人の定点を自分の定点としてコピーする（画像も複製。元の定点とは同期しない）
export async function copyLineup(lineup) {
  const imageIds = [];
  for (const imgId of lineup.imageIds ?? []) {
    const img = imgId && (await getImage(imgId));
    imageIds.push(img ? await putImage(img) : null);
  }
  const { id, ownerId, ownerName, createdAt, updatedAt, copiedFrom, ...rest } = lineup;
  return saveLineup(null, { ...rest, imageIds, visibility: 'private', groupId: null, copiedFrom: id });
}

// ---- 画像 ----

const imageCache = new Map();

export async function putImage({ data, w, h }) {
  const id = newId();
  await setDoc(imageRef(id), { ownerId: uid(), data, w, h, createdAt: Date.now() });
  imageCache.set(id, { data, w, h });
  return id;
}

export async function getImage(id) {
  if (imageCache.has(id)) return imageCache.get(id);
  const snap = await getDoc(imageRef(id));
  if (!snap.exists()) return null;
  const { data, w, h } = snap.data();
  imageCache.set(id, { data, w, h });
  return { data, w, h };
}

export async function deleteImages(ids) {
  await Promise.all(ids.map((id) => deleteDoc(imageRef(id)).catch(() => {})));
  ids.forEach((id) => imageCache.delete(id));
}

// ---- お気に入り・ショートカット ----

export function watchPrefs(cb) {
  return onSnapshot(
    prefsRef(),
    (snap) => cb({ favorites: [], shortcuts: [], ...(snap.exists() ? snap.data() : {}) }),
    () => cb({ favorites: [], shortcuts: [] }),
  );
}

export async function setFavorite(lineupId, on) {
  await setDoc(prefsRef(), { favorites: on ? arrayUnion(lineupId) : arrayRemove(lineupId) }, { merge: true });
}

export async function setShortcuts(shortcuts) {
  await setDoc(prefsRef(), { shortcuts }, { merge: true });
}
