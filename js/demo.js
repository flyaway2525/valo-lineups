// デモモード（config.js に Firebase の設定がないとき）。
// auth.js / store.js と同じ関数を持ち、データはこのブラウザの localStorage だけに保存する。
// ログインは不要で、グループ機能は使えない。

const LINEUPS_KEY = 'demo-lineups';
const IMAGES_KEY = 'demo-images';
const PREFS_KEY = 'demo-prefs';
const NAME_KEY = 'demo-name';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('ブラウザの保存容量がいっぱいです（デモモードは数十枚の画像までが目安）');
  }
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

// ---- 変更通知 ----

const listeners = new Set();

function changed() {
  listeners.forEach((fn) => fn());
}

function watch(fn) {
  listeners.add(fn);
  queueMicrotask(fn);
  return () => listeners.delete(fn);
}

function demoError() {
  return Promise.reject(new Error('デモモードではグループ機能は使えません'));
}

// ---- auth ----

const user = { uid: 'demo-user', isAnonymous: false };

export const auth = {
  watchUser(cb) {
    queueMicrotask(() => cb(user));
    return () => {};
  },
  currentUser: () => user,
  isGuest: () => false,
  displayName: () => read(NAME_KEY, 'デモユーザー'),
  needsName: () => false,
  async setDisplayName(name) {
    write(NAME_KEY, name);
  },
  signInWithGoogle: demoError,
  signInAsGuest: async () => user,
  upgradeGuestToGoogle: demoError,
  async signOut() {},
  authErrorMessage: (e) => e?.message ?? 'エラーが発生しました',
};

// ---- store ----

export const store = {
  watchIsAdmin(userId, cb) {
    queueMicrotask(() => cb(false));
    return () => {};
  },
  watchMyGroups(cb) {
    queueMicrotask(() => cb([]));
    return () => {};
  },
  watchGroup(groupId, cb, onError) {
    queueMicrotask(() => onError?.(new Error('not-found')));
    return () => {};
  },
  createGroup: demoError,
  renameGroup: demoError,
  regenerateInvite: demoError,
  inviteUrl: () => '',
  deleteGroup: demoError,
  joinGroup: demoError,
  leaveGroup: demoError,
  async syncMyProfile() {
    const all = read(LINEUPS_KEY, {});
    for (const l of Object.values(all)) l.ownerName = auth.displayName();
    write(LINEUPS_KEY, all);
    changed();
  },

  watchLineups(mapId, groupIds, cb) {
    return watch(() => cb(Object.values(read(LINEUPS_KEY, {})).filter((l) => l.map === mapId)));
  },
  async getLineup(id) {
    return read(LINEUPS_KEY, {})[id] ?? null;
  },
  async saveLineup(id, data) {
    const all = read(LINEUPS_KEY, {});
    const now = Date.now();
    const lineupId = id ?? newId();
    all[lineupId] = {
      ...(all[lineupId] ?? { ownerId: user.uid, createdAt: now }),
      ...data,
      id: lineupId,
      ownerName: auth.displayName(),
      updatedAt: now,
    };
    write(LINEUPS_KEY, all);
    changed();
    return lineupId;
  },
  async deleteLineup(lineup) {
    const all = read(LINEUPS_KEY, {});
    delete all[lineup.id];
    write(LINEUPS_KEY, all);
    await store.deleteImages(lineup.imageIds ?? []);
    changed();
  },
  async copyLineup(lineup) {
    const { id, ownerId, ownerName, createdAt, updatedAt, copiedFrom, ...rest } = lineup;
    return store.saveLineup(null, { ...rest, visibility: 'private', groupId: null, copiedFrom: id });
  },

  async putImage(img) {
    const all = read(IMAGES_KEY, {});
    const id = newId();
    all[id] = img;
    write(IMAGES_KEY, all);
    return id;
  },
  async getImage(id) {
    return read(IMAGES_KEY, {})[id] ?? null;
  },
  async deleteImages(ids) {
    const all = read(IMAGES_KEY, {});
    ids.forEach((id) => delete all[id]);
    write(IMAGES_KEY, all);
  },

  watchPrefs(cb) {
    return watch(() => cb({ favorites: [], shortcuts: [], ...read(PREFS_KEY, {}) }));
  },
  async setFavorite(lineupId, on) {
    const prefs = read(PREFS_KEY, {});
    const favs = new Set(prefs.favorites ?? []);
    on ? favs.add(lineupId) : favs.delete(lineupId);
    write(PREFS_KEY, { ...prefs, favorites: [...favs] });
    changed();
  },
  async setShortcuts(shortcuts) {
    write(PREFS_KEY, { ...read(PREFS_KEY, {}), shortcuts });
    changed();
  },
};
