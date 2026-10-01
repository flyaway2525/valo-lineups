import * as auth from './auth.js';
import * as store from './store.js';
import * as valo from './valo.js';
import { h, setChildren, header, actionSheet, confirmSheet, askText, openSheet, toast, qrCode, userIcon, gearIcon, chartIcon } from './ui.js';
import { createMapView } from './mapview.js';
import { compressImage, imageFromTransfer } from './images.js';

// 画面の流れ
//   グループ一覧（#/groups）→ グループのマップ（#/g/{id}/v/…）→ 定点の詳細（ボトムシート）
//   アプリを開くと、前回のグループのマップを直接開く

const app = document.getElementById('app');
const LAST_GROUP_KEY = 'last-group';
const lastViewKey = (groupId) => `last-view:${groupId}`;

let master = null; // valo.js のマスタデータ（false = 読み込み失敗）
let user; // undefined = 確認中, null = 未ログイン
let authBusy = false; // ログイン処理の途中で画面が切り替わらないようにする
let groups = []; // 参加中のグループ
let groupsLoaded = false;
let prefs = { favorites: [], shortcuts: [] };
let pendingOpen = null; // 地図画面を開いたらすぐ詳細を出す定点（共有リンクや登録直後）

// グループ・お気に入りが変わったことを画面に知らせる
const subscribers = new Set();
function emit() {
  subscribers.forEach((fn) => fn());
}
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function showError(e) {
  console.error(e);
  toast(e?.code === 'permission-denied' ? '権限がありません' : e?.message && !e.code ? e.message : 'エラーが発生しました');
}

async function runAuth(fn) {
  authBusy = true;
  try {
    await fn();
  } catch (e) {
    const msg = auth.authErrorMessage(e);
    if (msg) toast(msg);
  } finally {
    authBusy = false;
    route();
  }
}

function storageGet(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても困らない
  }
}

// ---- 表示用の小さな部品 ----

function agentIcon(agentId, cls = 'agent-icon') {
  const a = valo.agentById(agentId);
  return a ? h('img', { class: cls, src: a.icon, alt: a.name, draggable: 'false' }) : h('span', { class: cls });
}

function abilityIcon(agentId, slot, cls = 'ability-icon') {
  const ab = valo.abilityOf(agentId, slot);
  return ab?.icon ? h('img', { class: cls, src: ab.icon, alt: ab.name, draggable: 'false' }) : h('span', { class: cls }, slot[0]);
}

function groupById(groupId) {
  return groups.find((g) => g.id === groupId);
}

function viewHash(groupId, { mapId, side, agentId }) {
  return `#/g/${groupId}/v/${mapId}/${side}${agentId ? `/${agentId}` : ''}`;
}

// グループの中で前回見ていたマップ・攻守・エージェント
function lastViewHash(groupId) {
  const v = storageGet(lastViewKey(groupId));
  if (v && valo.mapById(v.mapId)) return viewHash(groupId, v);
  return viewHash(groupId, { mapId: master.maps[0].id, side: 'atk' });
}

function lineupUrl(groupId, id) {
  return `${location.origin}${location.pathname}#/g/${groupId}/l/${id}`;
}

const favKey = (groupId, id) => `${groupId}/${id}`;

// YouTube のリンクなら埋め込み用 URL にする
function youtubeEmbed(url) {
  try {
    const u = new URL(url);
    let id = null;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
    else if (u.hostname.endsWith('youtube.com')) id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (!id || !/^[\w-]{6,}$/.test(id)) return null;
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    const start = t ? parseInt(t, 10) || 0 : 0;
    return `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1${start ? `&start=${start}` : ''}`;
  } catch {
    return null;
  }
}

// withText = true なら、貼り付け先（Discord など）でも内容が分かるようにタイトルを URL の前に付ける
async function share(title, url, copiedMessage, withText = false) {
  const text = withText ? `${title}
${url}` : url;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    await navigator.share(withText ? { title, text } : { title, url }).catch(() => {});
  } else {
    await navigator.clipboard.writeText(text).catch(() => {});
    toast(copiedMessage);
  }
}

// 共有用のタイトル。例：「アセント攻めソーヴァ：A サイトのワイヤー切りショック」
function shareTitle(l) {
  const map = valo.mapById(l.map)?.name ?? '';
  const agent = valo.agentById(l.agent)?.name ?? '';
  return `${map}${valo.label(valo.SIDES, l.side)}${agent}：${l.title}`;
}

// ---- アカウント ----

async function renameAccount() {
  const name = await askText({ title: 'あなたの名前', value: auth.displayName(), placeholder: '例：たろう', okLabel: '保存' });
  if (!name) return;
  try {
    await auth.setDisplayName(name);
    await store.syncMyProfile();
    toast('名前を変更しました');
  } catch (e) {
    showError(e);
  }
  route();
}

function accountActions() {
  const guest = auth.isGuest();
  return [
    { label: '名前を変更', onClick: renameAccount },
    guest && {
      label: 'Google アカウントに引き継ぐ',
      onClick: () =>
        runAuth(async () => {
          await auth.upgradeGuestToGoogle();
          await store.syncMyProfile().catch(() => {});
          toast('Google アカウントに引き継ぎました');
        }),
    },
    {
      label: 'ログアウト',
      danger: true,
      onClick: async () => {
        if (guest && !(await confirmSheet('ゲストのままログアウトすると、参加中のグループに戻れなくなります（招待リンクから再参加は可能）。ログアウトしますか？', 'ログアウト'))) return;
        await auth.signOut();
        location.hash = '#/';
      },
    },
  ].filter(Boolean);
}

// ログイン方法の表示：Google ならメールアドレス、ゲストなら「ゲスト」
function loginMethod() {
  return auth.isGuest() ? 'ゲスト' : `Google：${auth.currentUser()?.email ?? ''}`;
}

function accountMenu() {
  actionSheet(`${auth.displayName()} としてログイン中（${loginMethod()}）`, accountActions());
}

// 右上のユーザー設定ボタン（人のアイコン）
function accountButton() {
  return h('button', { class: 'topbar-btn account-btn', onClick: accountMenu, 'aria-label': 'ユーザー設定', title: 'ユーザー設定' }, userIcon());
}

// ---- 画面：読み込み中・エラー ----

function loadingView(root) {
  root.append(h('div', { class: 'center-screen' }, h('div', { class: 'spinner', 'aria-label': '読み込み中' })));
}

function messageView(root, message) {
  root.append(
    h('div', { class: 'center-screen' }, h('p', { class: 'welcome-text' }, message), h('a', { class: 'btn wide', href: '#/groups' }, 'グループ一覧へ')),
  );
}

function masterErrorView(root) {
  root.append(
    h(
      'div',
      { class: 'center-screen' },
      h('p', { class: 'welcome-text' }, 'マップ・エージェントの情報を読み込めませんでした。通信状況を確認してください。'),
      h('button', { class: 'btn primary wide', onClick: () => location.reload() }, '再読み込み'),
    ),
  );
}

// ---- 画面：ようこそ（未ログイン） ----

function welcomeView(root) {
  const nameInput = h('input', { class: 'text-input', placeholder: 'ニックネーム（例：たろう）', maxlength: 40, 'aria-label': 'ニックネーム' });
  root.append(
    h(
      'div',
      { class: 'center-screen' },
      h('img', { class: 'welcome-icon', src: 'icons/icon.svg', alt: '' }),
      h('h1', { class: 'welcome-title' }, 'valo-lineups'),
      h('p', { class: 'welcome-text' }, 'VALORANT の定点を、グループの仲間と登録・共有できます。'),
      h('button', { class: 'btn primary wide', onClick: () => runAuth(auth.signInWithGoogle) }, 'Google でログイン'),
      h('p', { class: 'welcome-note' }, 'PC とスマホで使うなら、Google ログインがおすすめです。グループを作れるのも Google ログインの人だけです。'),
      h('div', { class: 'divider' }, 'または'),
      h(
        'form',
        {
          class: 'join-form',
          onSubmit: (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (!name) {
              nameInput.focus();
              toast('ニックネームを入力してください');
              return;
            }
            runAuth(() => auth.signInAsGuest(name));
          },
        },
        nameInput,
        h('button', { type: 'submit', class: 'btn wide' }, 'ゲストで始める'),
      ),
    ),
  );
}

// ---- 画面：名前の入力（名前が未設定のとき） ----

function nameSetupView(root) {
  const input = h('input', { class: 'text-input', placeholder: '例：たろう', maxlength: 40, 'aria-label': '名前' });
  root.append(
    h(
      'div',
      { class: 'center-screen' },
      h('img', { class: 'welcome-icon', src: 'icons/icon.svg', alt: '' }),
      h('h1', { class: 'welcome-title' }, 'はじめまして'),
      h('p', { class: 'welcome-text' }, 'グループの中で表示する名前を入力してください。あとから変更できます。'),
      h(
        'form',
        {
          class: 'join-form',
          onSubmit: async (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) {
              input.focus();
              toast('名前を入力してください');
              return;
            }
            try {
              await auth.setDisplayName(name);
            } catch (err) {
              return showError(err);
            }
            route();
          },
        },
        input,
        h('button', { type: 'submit', class: 'btn primary wide' }, '決定'),
      ),
    ),
  );
  input.focus();
}

// ---- 画面：招待リンクから参加 ----

function joinView(root, { groupId, code }) {
  const status = h('p', { class: 'welcome-text' });
  const box = h('div', { class: 'center-screen' }, h('img', { class: 'welcome-icon', src: 'icons/icon.svg', alt: '' }), status);
  root.append(box);

  if (user) {
    status.textContent = 'グループに参加しています…';
    store
      .joinGroup(groupId, code)
      .then(() => location.replace(`#/g/${groupId}`))
      .catch((e) => {
        console.error(e);
        status.textContent = '招待リンクが無効です。リンクが作り直された可能性があるので、招待してくれた人に新しいリンクをもらってください。';
        box.append(h('a', { class: 'btn wide', href: '#/groups' }, 'グループ一覧へ'));
      });
    return;
  }

  status.textContent = 'グループに招待されています。';
  const nameInput = h('input', { class: 'text-input', placeholder: 'ニックネーム（例：たろう）', maxlength: 40, 'aria-label': 'ニックネーム' });
  box.append(
    h(
      'form',
      {
        class: 'join-form',
        onSubmit: (e) => {
          e.preventDefault();
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.focus();
            toast('ニックネームを入力してください');
            return;
          }
          runAuth(() => auth.signInAsGuest(name));
        },
      },
      nameInput,
      h('button', { type: 'submit', class: 'btn primary wide' }, 'ゲストとして参加'),
    ),
    h('div', { class: 'divider' }, 'または'),
    h('button', { class: 'btn wide', onClick: () => runAuth(auth.signInWithGoogle) }, 'Google でログインして参加'),
  );
}

// ---- 画面：グループ一覧 ----

function groupsView(root) {
  const body = h('main', { class: 'content' });
  root.append(header({ title: 'valo-lineups', right: accountButton() }), body);
  const last = storageGet(LAST_GROUP_KEY);

  function render() {
    if (!groupsLoaded) return setChildren(body, h('div', { class: 'spinner' }));
    setChildren(
      body,
      h(
        'button',
        { class: 'account-bar', onClick: accountMenu },
        h('span', { class: 'account-bar-icon' }, userIcon()),
        h(
          'span',
          { class: 'account-bar-main' },
          h('span', { class: 'account-bar-name' }, h('strong', {}, auth.displayName()), ' としてログイン中'),
          h('span', { class: 'account-bar-sub' }, loginMethod()),
        ),
        h('span', { class: 'chevron' }, '›'),
      ),
      h('p', { class: 'section-label' }, 'グループを選んでください'),
      groups.length
        ? h(
            'div',
            { class: 'card-list' },
            groups.map((g) =>
              h(
                'div',
                { class: `group-row${g.id === last ? ' current' : ''}` },
                h(
                  'a',
                  { class: 'group-open', href: `#/g/${g.id}` },
                  h('span', { class: 'card-icon' }, g.name.slice(0, 1)),
                  h(
                    'span',
                    { class: 'card-main' },
                    h('span', { class: 'card-title' }, g.name),
                    h('span', { class: 'card-sub' }, `${g.memberIds.length} 人${g.members[auth.currentUser().uid]?.role === 'owner' ? ' ・ オーナー' : ''}`),
                  ),
                ),
                // 定点の集計
                h('a', { class: 'group-settings', href: `#/g/${g.id}/stats`, 'aria-label': `${g.name} の集計`, title: '定点の集計' }, chartIcon()),
                // グループの設定（名前・メンバー・招待）
                h('a', { class: 'group-settings', href: `#/g/${g.id}/settings`, 'aria-label': `${g.name} の設定`, title: 'グループの設定' }, gearIcon()),
              ),
            ),
          )
        : h('p', { class: 'empty' }, 'まだグループに参加していません。仲間から届いた招待リンクを開くか、グループを作成してください。'),
      auth.isGuest()
        ? h('p', { class: 'notice' }, 'グループを作るには、Google アカウントでログインしてください（右上の ⋯ →「Google アカウントに引き継ぐ」）。')
        : h(
            'button',
            {
              class: 'add-card',
              onClick: async () => {
                const name = await askText({ title: 'グループの名前', placeholder: '例：いつものフルパ、ソロ練用', okLabel: '作成' });
                if (!name) return;
                try {
                  const id = await store.createGroup(name);
                  location.hash = `#/g/${id}`;
                } catch (e) {
                  showError(e);
                }
              },
            },
            '＋ グループを作成',
          ),
    );
  }
  render();
  return subscribe(render);
}

// グループの画面を開く前に、そのグループが読めるのを待つ
// （招待リンクから参加した直後は、グループ一覧への反映が少し遅れる）
function withGroup(root, groupId, build) {
  let inner = null;
  let timer = null;
  let unsub = null;
  const tryBuild = () => {
    if (!groupById(groupId)) return false;
    clearTimeout(timer);
    unsub?.();
    root.replaceChildren();
    storageSet(LAST_GROUP_KEY, groupId);
    inner = build(groupById(groupId)) ?? null;
    return true;
  };
  if (!tryBuild()) {
    loadingView(root);
    unsub = subscribe(tryBuild);
    timer = setTimeout(() => {
      unsub?.();
      root.replaceChildren();
      messageView(root, 'このグループは見つからないか、メンバーではありません。');
    }, groupsLoaded ? 6000 : 15000);
  }
  return () => {
    clearTimeout(timer);
    unsub?.();
    inner?.();
  };
}

// ---- 画面：グループのマップ（メイン） ----

const SOURCES = [
  { id: 'all', label: 'すべて' },
  { id: 'mine', label: '自分が登録' },
  { id: 'fav', label: '★ お気に入り' },
];

// 着弾点の近い定点を 1 つのマーカーにまとめる
function clusterByTarget(lineups) {
  const clusters = [];
  for (const l of lineups) {
    const c = clusters.find((c) => Math.hypot(c.x - l.to.x, c.y - l.to.y) < 0.02);
    if (c) c.items.push(l);
    else clusters.push({ x: l.to.x, y: l.to.y, items: [l] });
  }
  return clusters;
}

function mapView(root, { groupId, mapId, side, agentId }) {
  const map = valo.mapById(mapId);
  if (!map) {
    location.replace(viewHash(groupId, { mapId: master.maps[0].id, side: 'atk' }));
    return;
  }
  if (agentId && !valo.agentById(agentId)) agentId = null;
  storageSet(lastViewKey(groupId), { mapId, side, agentId });

  let lineups = [];
  let source = sessionStorage.getItem('source') ?? 'all';
  if (!SOURCES.some((s) => s.id === source)) source = 'all';
  const shownSlots = new Set(); // 選んだアビリティだけ表示（空 = 全部）
  // 表示する状態（有効 / 要確認 / 無効）。最初は無効だけ隠す
  const DEFAULT_STATUSES = ['ok', 'ai', 'check'];
  const shownStatuses = new Set(JSON.parse(sessionStorage.getItem('statuses2') ?? 'null') ?? DEFAULT_STATUSES);
  // 見直しモード：このマップの要確認の定点を、攻守・エージェントに関係なく一覧にする
  let reviewing = false;
  let selected = null; // 選んでいる着弾点のクラスター
  let selectedId = null; // その中で選んでいる定点（立ち位置・軌道線を押したとき）
  let pendingSelect = null; // 次の描画で選ぶ着弾点
  let mode = sessionStorage.getItem('mode') ?? 'map';
  let loaded = false;
  const me = auth.currentUser().uid;

  const go = (next) => location.replace(viewHash(groupId, { mapId, side, agentId, ...next }));

  const statusShown = (l) => shownStatuses.has(valo.statusOf(l));

  // 表示する定点（地図とリストで共通）
  function visible() {
    if (reviewing) return lineups.filter(statusShown);
    return lineups.filter(
      (l) =>
        statusShown(l) &&
        l.side === side &&
        (!agentId || l.agent === agentId) &&
        (!shownSlots.size || shownSlots.has(l.ability)) &&
        (source === 'all' ||
          (source === 'mine' && l.createdBy === me) ||
          (source === 'fav' && prefs.favorites.includes(favKey(groupId, l.id)))),
    );
  }

  // ---- 上部 ----
  // スマホではパネルのエージェント一覧の代わりに、マップ名の横のボタンから選ぶ
  const agentPicker = h('button', {
    class: 'agent-picker',
    'aria-label': 'エージェントを選ぶ',
    onClick: () => pickAgent(agentCounts(), agentId).then((r) => r && go({ agentId: r === 'all' ? null : r })),
  });
  const groupName = h('span', {});
  // グループ名を押すと：集計・設定・グループ一覧
  const groupLabel = h(
    'button',
    {
      class: 'group-label',
      onClick: () =>
        actionSheet(groupById(groupId)?.name ?? 'グループ', [
          { label: '定点の集計を見る', onClick: () => (location.hash = `#/g/${groupId}/stats`) },
          { label: 'グループの設定', onClick: () => (location.hash = `#/g/${groupId}/settings`) },
          { label: 'グループ一覧へ', onClick: () => (location.hash = '#/groups') },
        ]),
    },
    groupName,
    h('span', { class: 'caret' }, '▾'),
  );
  const topbar = h(
    'header',
    { class: 'topbar map-topbar' },
    h('a', { class: 'topbar-btn back', href: '#/groups', 'aria-label': 'グループ一覧へ' }, '‹'),
    h(
      'div',
      { class: 'map-title' },
      groupLabel,
      h(
        'div',
        { class: 'map-title-row' },
        h(
          'button',
          { class: 'map-picker', onClick: () => pickMap(mapId).then((id) => id && go({ mapId: id })) },
          h('span', { class: 'map-picker-name' }, map.name),
          h('span', { class: 'caret' }, '▾'),
        ),
        agentPicker,
      ),
    ),
    h(
      'div',
      { class: 'segmented', role: 'tablist' },
      valo.SIDES.map((sd) =>
        h('button', { class: sd.id === side ? 'active' : '', role: 'tab', 'aria-selected': sd.id === side, onClick: () => go({ side: sd.id }) }, sd.label),
      ),
    ),
    h(
      'a',
      { class: 'topbar-btn add-btn', href: `#/g/${groupId}/new/${mapId}/${side}${agentId ? `/${agentId}` : ''}`, 'aria-label': '定点を登録', title: '定点を登録' },
      '＋',
    ),
    accountButton(),
  );

  // ---- 地図 ----
  const mv = createMapView();
  mv.setMap(map);

  // ---- 下部パネル ----
  const shortcutRow = h('div', { class: 'chip-row shortcuts' });
  const agentStrip = h('div', { class: 'agent-strip' });
  const abilityRow = h('div', { class: 'ability-row' });
  const toolRow = h('div', { class: 'tool-row' });
  const statusRow = h('div', { class: 'tool-row' });
  const listBox = h('div', { class: 'lineup-list' });
  const panel = h('section', { class: 'panel' }, shortcutRow, agentStrip, abilityRow, toolRow, statusRow, listBox);

  root.append(h('div', { class: 'map-screen' }, topbar, h('div', { class: 'map-wrap' }, mv.el), panel));

  function renderHeader() {
    groupName.textContent = groupById(groupId)?.name ?? '';
  }

  function renderShortcuts() {
    const mine = prefs.shortcuts.filter((s) => s.groupId === groupId);
    const current = mine.find((s) => s.mapId === mapId && s.side === side && s.agentId === agentId);
    setChildren(
      shortcutRow,
      mine.map((s) => {
        const m = valo.mapById(s.mapId);
        if (!m) return null;
        return h(
          'a',
          { class: `chip shortcut${s === current ? ' active' : ''}`, href: viewHash(groupId, s) },
          s.agentId ? agentIcon(s.agentId, 'chip-icon') : null,
          `${m.name} ${valo.label(valo.SIDES, s.side)}`,
        );
      }),
      agentId &&
        h(
          'button',
          {
            class: 'chip ghost',
            onClick: async () => {
              const next = current
                ? prefs.shortcuts.filter((s) => s !== current)
                : [...prefs.shortcuts, { groupId, mapId, side, agentId }].slice(-12);
              await store.setShortcuts(next).catch(showError);
              toast(current ? 'ショートカットから外しました' : 'ショートカットに追加しました');
            },
          },
          current ? '− 外す' : '＋ ショートカット',
        ),
    );
    shortcutRow.hidden = !mine.length && !agentId;
  }

  // エージェントごとの有効・要確認の数（状態の絞り込みに関係なく数える）
  function agentCounts() {
    const counts = {};
    for (const l of lineups) {
      if (l.side !== side) continue;
      const st = valo.statusOf(l);
      if (st === 'invalid') continue;
      const c = (counts[l.agent] ??= { ok: 0, ai: 0, check: 0 });
      c[st] += 1;
    }
    return counts;
  }

  function renderAgents() {
    const counts = agentCounts();
    const cur = agentId && valo.agentById(agentId);
    setChildren(
      agentPicker,
      cur ? h('img', { src: cur.icon, alt: '' }) : h('span', { class: 'agent-picker-all' }, '全'),
      h('span', { class: 'agent-picker-name' }, cur ? cur.name : 'すべて'),
      h('span', { class: 'caret' }, '▾'),
    );
    setChildren(
      agentStrip,
      master.agents.map((a) =>
        h(
          'button',
          {
            class: `agent-btn${a.id === agentId ? ' active' : ''}${counts[a.id] ? '' : ' none'}`,
            onClick: () => go({ agentId: a.id === agentId ? null : a.id }),
            'aria-pressed': a.id === agentId,
            title: a.name,
          },
          h('img', { src: a.icon, alt: '', draggable: 'false' }),
          h('span', { class: 'agent-name' }, a.name),
          countBadges(counts[a.id]),
        ),
      ),
    );
  }

  // 押したアビリティを表示に加える / 外す。
  // 最後の 1 つを外したとき、全部そろったときは、最初の状態（全部表示）に戻す
  function toggleSlot(slot) {
    shownSlots.has(slot) ? shownSlots.delete(slot) : shownSlots.add(slot);
    if (shownSlots.size === valo.agentById(agentId)?.abilities.length) shownSlots.clear();
    selected = null;
    render();
  }

  function renderAbilities() {
    const agent = valo.agentById(agentId);
    abilityRow.hidden = !agent;
    if (!agent) return;
    const counts = {};
    for (const l of lineups) if (l.side === side && l.agent === agentId && statusShown(l)) counts[l.ability] = (counts[l.ability] ?? 0) + 1;
    setChildren(
      abilityRow,
      agent.abilities.map((ab) =>
        h(
          'button',
          {
            class: `ability-btn${shownSlots.has(ab.slot) ? ' active' : shownSlots.size ? ' off' : ''}`,
            'aria-pressed': shownSlots.has(ab.slot),
            title: ab.name,
            onClick: () => toggleSlot(ab.slot),
          },
          h('img', { src: ab.icon, alt: '', draggable: 'false' }),
          h('span', { class: 'ability-key' }, ab.key),
          h('span', { class: 'count' }, counts[ab.slot] ?? 0),
        ),
      ),
    );
  }

  function renderTools() {
    setChildren(
      toolRow,
      h(
        'div',
        { class: 'chip-row' },
        SOURCES.map((s) =>
          h(
            'button',
            {
              class: `chip${source === s.id ? ' active' : ''}`,
              onClick: () => {
                source = s.id;
                sessionStorage.setItem('source', source);
                selected = null;
                render();
              },
            },
            s.label,
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'chip ghost',
          onClick: () => {
            mode = mode === 'map' ? 'list' : 'map';
            sessionStorage.setItem('mode', mode);
            render();
          },
        },
        mode === 'map' ? '☰ リスト' : '◎ 地図',
      ),
    );
  }

  function saveStatuses() {
    sessionStorage.setItem('statuses', JSON.stringify([...shownStatuses]));
  }

  // 状態ボタン：押すたびに表示 / 非表示（全部は隠せない）
  function toggleStatus(id) {
    if (shownStatuses.has(id)) {
      if (shownStatuses.size === 1) return;
      shownStatuses.delete(id);
    } else {
      shownStatuses.add(id);
    }
    saveStatuses();
    selected = null;
    render();
  }

  function renderStatus() {
    const counts = Object.fromEntries(valo.STATUSES.map((st) => [st.id, 0]));
    for (const l of lineups) {
      if (reviewing || (l.side === side && (!agentId || l.agent === agentId))) counts[valo.statusOf(l)]++;
    }
    setChildren(
      statusRow,
      h(
        'div',
        { class: 'chip-row' },
        valo.STATUSES.map((st) =>
          h(
            'button',
            {
              class: `chip status-chip st-${st.id}${shownStatuses.has(st.id) ? ' active' : ''}`,
              'aria-pressed': shownStatuses.has(st.id),
              onClick: () => toggleStatus(st.id),
            },
            `${st.icon} ${st.label} ${counts[st.id]}`,
          ),
        ),
      ),
      reviewing
        ? h('button', { class: 'chip ghost', onClick: endReview }, '見直しを終える')
        : h('button', { class: 'chip ghost', onClick: reviewMenu }, '見直し'),
    );
  }

  // マップのアップデート時の見直し
  function reviewMenu() {
    const ok = lineups.filter((l) => ['ok', 'ai'].includes(valo.statusOf(l)));
    const check = lineups.filter((l) => valo.statusOf(l) === 'check');
    if (!lineups.length) return toast('このマップの定点はまだありません');
    actionSheet(`${map.name} の定点の見直し（全 ${lineups.length} 件）`, [
      ok.length && { label: `有効・AI確認済みの ${ok.length} 件をすべて「要確認」にする`, onClick: () => markAllCheck(ok) },
      check.length && { label: `要確認の ${check.length} 件を確認する`, onClick: startReview },
    ].filter(Boolean));
  }

  async function markAllCheck(targets) {
    const note = await askText({ title: '要確認にする理由（マップのアップデートなど）', value: `${map.name}のアップデート`, okLabel: '要確認にする' });
    if (!note) return;
    try {
      await store.setStatus(groupId, targets.map((l) => l.id), 'check', note);
      toast(`${targets.length} 件を要確認にしました`);
      startReview();
    } catch (e) {
      showError(e);
    }
  }

  function startReview() {
    reviewing = true;
    shownStatuses.clear();
    shownStatuses.add('check');
    saveStatuses();
    selected = null;
    render();
  }

  function endReview() {
    reviewing = false;
    shownStatuses.clear();
    DEFAULT_STATUSES.forEach((st) => shownStatuses.add(st));
    saveStatuses();
    render();
  }

  // 着弾点のまとまりの状態：全部無効なら無効、1 つでも要確認があれば要確認
  function clusterStatus(c) {
    const sts = c.items.map(valo.statusOf);
    if (sts.every((st) => st === 'invalid')) return 'invalid';
    if (sts.includes('check')) return 'check';
    return sts.includes('ok') ? 'ok' : 'ai';
  }

  function renderMap(list) {
    const clusters = clusterByTarget(list);
    if (pendingSelect) {
      const p = pendingSelect;
      pendingSelect = null;
      selected = clusters.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < 0.02) ?? null;
    } else if (selected) {
      // 選んでいたクラスターを最新の定点で作り直す
      selected = clusters.find((c) => Math.hypot(c.x - selected.x, c.y - selected.y) < 0.02) ?? null;
    }
    const markers = clusters.map((c) => {
      const l = c.items[0];
      return {
        x: c.x,
        y: c.y,
        icon: agentId ? valo.abilityOf(l.agent, l.ability)?.icon : valo.agentById(l.agent)?.icon,
        kind: `target st-${clusterStatus(c)}${agentId ? '' : ' agent'}${selected === c ? ' selected' : ''}${c.items.some((i) => i.importance === 'essential') ? ' essential' : ''}${c.items.every(valo.noFrom) ? ' placed' : ''}`,
        badge: c.items.length > 1 ? c.items.length : null,
        label: c.items.map((i) => i.title).join(' / '),
        onClick: () => {
          if (!agentId && new Set(c.items.map((i) => i.agent)).size === 1) {
            // エージェント未選択なら、まずそのエージェントに絞って、この着弾点を選んだ状態にする
            sessionStorage.setItem('pendingSelect', JSON.stringify({ x: c.x, y: c.y }));
            go({ agentId: l.agent });
            return;
          }
          // 1 回目は選ぶだけ（軌道を確かめられるように）。選んだものをもう一度押すと詳細
          if (selected === c) {
            const one = c.items.length === 1 ? c.items[0] : c.items.find((i) => i.id === selectedId);
            if (one) return openDetail(groupId, one);
            selected = null;
          } else {
            selected = c;
            selectedId = c.items.length === 1 ? c.items[0].id : null;
          }
          render();
        },
      };
    });
    // 立ち位置と軌道線は常にすべて出す。着弾点を選んでいるときは、それ以外を薄くする
    const lines = [];
    const fromMarkers = [];
    if (!selected || !selected.items.some((i) => i.id === selectedId)) selectedId = null;
    // 立ち位置・軌道線を押したとき：1 回目はその定点を選ぶ、もう一度押すと詳細
    const pick = (c, l) => {
      if (selectedId === l.id) return openDetail(groupId, l);
      selected = c;
      selectedId = l.id;
      render();
    };
    for (const c of clusters) {
      for (const l of c.items) {
        if (valo.noFrom(l)) continue; // 立ち位置なし：着弾点（置く場所）だけ
        const state = !selected
          ? ''
          : selected !== c
            ? ' dim'
            : !selectedId || selectedId === l.id
              ? ' selected'
              : '';
        lines.push({ from: l.from, to: l.to, kind: `st-${valo.statusOf(l)}${state}`, label: l.title, onClick: () => pick(c, l) });
        fromMarkers.push({
          x: l.from.x,
          y: l.from.y,
          icon: valo.agentById(l.agent)?.icon,
          kind: `from st-${valo.statusOf(l)}${state}`,
          label: `${l.title}（立ち位置）`,
          onClick: () => pick(c, l),
        });
      }
    }
    mv.render({ markers: [...fromMarkers, ...markers], lines });
  }

  function lineupCard(l) {
    const fav = prefs.favorites.includes(favKey(groupId, l.id));
    const st = valo.statusOf(l);
    const card = h(
      'button',
      { class: `lineup-card st-${st}`, onClick: () => openDetail(groupId, l) },
      h('span', { class: 'lineup-card-icons' }, agentIcon(l.agent, 'agent-icon small'), abilityIcon(l.agent, l.ability)),
      h(
        'span',
        { class: 'lineup-card-main' },
        h('span', { class: 'lineup-card-title' }, fav ? '★ ' : '', l.title),
        h(
          'span',
          { class: 'lineup-card-sub' },
          [
            reviewing ? `${valo.agentById(l.agent)?.name ?? ''} ${valo.label(valo.SIDES, l.side)}` : null,
            valo.siteLabel(l.site),
            valo.label(valo.THROW_TYPES, l.throwType),
            l.createdByName,
          ]
            .filter(Boolean)
            .join(' ・ '),
        ),
      ),
      st === 'ok'
        ? h('span', { class: `imp imp-${l.importance}` }, valo.label(valo.IMPORTANCE, l.importance))
        : h('span', { class: `status-badge st-${st}`, title: l.statusNote ?? '' }, valo.label(valo.STATUSES, st)),
    );
    if (!reviewing) return card;
    // 見直し中：その場で「有効」「無効」を決められるようにする
    const decide = (next) =>
      store.setStatus(groupId, [l.id], next, l.statusNote ?? '').then(() => toast(`「${l.title}」を${valo.label(valo.STATUSES, next)}にしました`), showError);
    return h(
      'div',
      { class: 'review-item' },
      card,
      h(
        'div',
        { class: 'review-actions' },
        h('button', { class: 'btn st-ok', onClick: () => decide('ok') }, '● 有効（使える）'),
        h('button', { class: 'btn st-invalid', onClick: () => decide('invalid') }, '✕ 無効（使えない）'),
      ),
    );
  }

  function renderList(list) {
    if (!loaded) return setChildren(listBox, h('div', { class: 'spinner small' }));
    if (reviewing) {
      return setChildren(
        listBox,
        h('p', { class: 'review-head' }, `${map.name} の見直し：画像や動画で確かめて、「有効」か「無効」を選んでください。`),
        list.length ? list.map(lineupCard) : h('p', { class: 'list-hint' }, '表示する定点はありません。見直しが終わったら「見直しを終える」を押してください。'),
      );
    }
    if (mode === 'map' && selected) {
      return setChildren(listBox, h('p', { class: 'list-label' }, `この着弾点の定点（${selected.items.length}）`), selected.items.map(lineupCard));
    }
    if (mode === 'map') {
      return setChildren(
        listBox,
        h(
          'p',
          { class: 'list-hint' },
          list.length
            ? agentId
              ? `${list.length} 件。着弾点・立ち位置・軌道の線をタップで選択、もう一度タップで詳細が出ます。`
              : `${list.length} 件。エージェントを選ぶか、地図のアイコンをタップしてください。`
            : agentId
              ? 'この条件の定点はまだありません。右上の ＋ から登録できます。'
              : lineups.length
                ? 'エージェントを選んでください。'
                : 'このマップの定点はまだありません。右上の ＋ から登録できます。',
        ),
      );
    }
    // リスト表示：サイトごとにまとめる
    const bySite = new Map();
    for (const l of [...list].sort((a, b) => a.title.localeCompare(b.title, 'ja'))) {
      const key = l.site ?? '';
      if (!bySite.has(key)) bySite.set(key, []);
      bySite.get(key).push(l);
    }
    const order = [...map.sites, 'mid', ''];
    setChildren(
      listBox,
      list.length ? null : h('p', { class: 'list-hint' }, 'この条件の定点はまだありません。'),
      [...bySite.entries()]
        .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        .map(([site, items]) => [h('p', { class: 'list-label' }, valo.siteLabel(site) || 'その他'), items.map(lineupCard)]),
    );
  }

  function render() {
    const list = visible();
    renderHeader();
    renderShortcuts();
    renderAgents();
    renderAbilities();
    renderTools();
    renderStatus();
    mv.el.classList.toggle('hidden-map', mode === 'list');
    renderMap(mode === 'map' ? list : []);
    renderList(list);
  }

  // 他の画面から渡された「この定点を開いて」「この着弾点を選んで」
  if (pendingOpen && pendingOpen.groupId === groupId && pendingOpen.lineup.map === mapId) {
    const l = pendingOpen.lineup;
    pendingOpen = null;
    pendingSelect = l.to;
    queueMicrotask(() => openDetail(groupId, l));
  }
  const saved = sessionStorage.getItem('pendingSelect');
  if (saved) {
    pendingSelect = JSON.parse(saved);
    sessionStorage.removeItem('pendingSelect');
  }

  const unwatch = store.watchLineups(
    groupId,
    mapId,
    (list) => {
      lineups = list;
      loaded = true;
      render();
    },
    showError,
  );

  render();
  // 選んでいるエージェントが横スクロールの外にあれば見える位置へ
  const activeAgent = agentStrip.querySelector('.active');
  if (activeAgent) agentStrip.scrollLeft = activeAgent.offsetLeft - agentStrip.clientWidth / 2 + activeAgent.clientWidth / 2;

  const unsub = subscribe(() => {
    // グループから抜けた・グループが消えた
    if (groupsLoaded && !groupById(groupId)) return location.replace('#/groups');
    render();
  });

  // PC 用のキー操作：1〜4 でアビリティ切り替え、M で地図 / リスト
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || document.querySelector('.sheet-backdrop')) return;
    const agent = valo.agentById(agentId);
    const n = parseInt(e.key, 10);
    if (agent && n >= 1 && n <= agent.abilities.length) {
      toggleSlot(agent.abilities[n - 1].slot);
    } else if (e.key === 'm' || e.key === 'M') {
      mode = mode === 'map' ? 'list' : 'map';
      render();
    }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    unwatch();
    unsub();
    document.removeEventListener('keydown', onKey);
  };
}

// コンペのローテーション中のマップを上に、それ以外を下に分けて出す
function pickMap(currentId) {
  const tile = (m, close) =>
    h(
      'button',
      { class: `map-tile${m.id === currentId ? ' active' : ''}`, onClick: () => close(m.id) },
      h('img', { src: m.thumb, alt: '', loading: 'lazy' }),
      h('span', {}, m.name),
    );
  const pool = master.maps.filter((m) => valo.isCompetitive(m.id));
  const others = master.maps.filter((m) => !valo.isCompetitive(m.id));
  return openSheet((close) => [
    h('div', { class: 'sheet-title' }, 'マップを選ぶ'),
    h('p', { class: 'map-group-label' }, `コンペ（ローテーション中 ${pool.length}）`),
    h('div', { class: 'map-grid' }, pool.map((m) => tile(m, close))),
    others.length ? h('p', { class: 'map-group-label muted' }, 'ローテーション外') : null,
    others.length ? h('div', { class: 'map-grid others' }, others.map((m) => tile(m, close))) : null,
    h('button', { class: 'sheet-action cancel', onClick: () => close(null) }, 'キャンセル'),
  ]);
}

// エージェントのアイコンに付けるバッジ：赤＝有効の数、その下の小さい黄色＝要確認の数
function countBadges(c) {
  if (!c) return null;
  const items = [
    c.ok ? h('span', { class: 'count', title: '有効' }, c.ok) : null,
    c.ai ? h('span', { class: 'count-ai', title: 'AI確認済み' }, c.ai) : null,
    c.check ? h('span', { class: 'count-check', title: '要確認' }, c.check) : null,
  ].filter(Boolean);
  return items.length ? h('span', { class: 'count-stack' }, items) : null;
}

// エージェントを選ぶシート。'all' は「すべて」、閉じただけなら null
function pickAgent(counts, currentId) {
  const tile = (a, close) =>
    h(
      'button',
      { class: `agent-btn${a.id === currentId ? ' active' : ''}${counts[a.id] ? '' : ' none'}`, onClick: () => close(a.id) },
      h('img', { src: a.icon, alt: '', draggable: 'false' }),
      h('span', { class: 'agent-name' }, a.name),
      countBadges(counts[a.id]),
    );
  const withLineups = master.agents.filter((a) => counts[a.id]);
  const others = master.agents.filter((a) => !counts[a.id]);
  return openSheet((close) => [
    h('div', { class: 'sheet-title' }, 'エージェントを選ぶ'),
    h('button', { class: `sheet-action${currentId ? '' : ' active'}`, onClick: () => close('all') }, 'すべてのエージェント'),
    withLineups.length ? h('p', { class: 'map-group-label' }, `定点あり（${withLineups.length}）`) : null,
    h('div', { class: 'agent-grid' }, withLineups.map((a) => tile(a, close))),
    others.length ? h('p', { class: 'map-group-label muted' }, '定点なし') : null,
    others.length ? h('div', { class: 'agent-grid' }, others.map((a) => tile(a, close))) : null,
    h('button', { class: 'sheet-action cancel', onClick: () => close(null) }, 'キャンセル'),
  ]);
}

// ---- 定点の詳細（ボトムシート） ----

function openLightbox(src) {
  const box = h('div', { class: 'lightbox', onClick: () => box.remove() }, h('img', { src, alt: '' }));
  document.body.append(box);
}

// captions：画像ごとの説明（メモの「立ち位置 : …」など）。画像の下に出して、画像と一緒に横に送る
function imageCarousel(groupId, l, captions = []) {
  const ids = l.imageIds ?? [];
  const labels = valo.imageLabels(l);
  const slots = labels.map((label, i) => ({ label, id: ids[i], text: captions[i] })).filter((s) => s.id);
  if (!slots.length) return null;

  const figs = slots.map(({ label, id, text }) => {
    const frame = h('div', { class: 'shot-frame loading' }, h('span', { class: 'shot-label' }, label));
    store
      .getImage(groupId, id)
      .then((img) => {
        frame.classList.remove('loading');
        if (!img) return frame.append(h('span', { class: 'shot-missing' }, '画像がありません'));
        frame.prepend(h('img', { src: img.data, alt: label, onClick: () => openLightbox(img.data) }));
      })
      .catch(() => frame.append(h('span', { class: 'shot-missing' }, '読み込めませんでした')));
    return h('figure', { class: 'shot' }, frame, text ? h('figcaption', { class: 'shot-text' }, text) : null);
  });
  const track = h('div', { class: 'carousel' }, figs);
  if (figs.length === 1) return track;

  // 何枚目を見ているか（ボタン・ホイール・矢印・スワイプのどれで動かしても合わせる）
  let index = 0;
  const steps = slots.map(({ label }, i) =>
    h('button', { type: 'button', class: `shot-step${i === 0 ? ' active' : ''}`, onClick: () => show(i) }, `${labels.indexOf(label) + 1} ${label}`),
  );
  const prev = h('button', { type: 'button', class: 'shot-arrow prev', 'aria-label': '前の画像', onClick: () => show(index - 1) }, '‹');
  const next = h('button', { type: 'button', class: 'shot-arrow next', 'aria-label': '次の画像', onClick: () => show(index + 1) }, '›');

  function mark(i) {
    index = i;
    steps.forEach((s, j) => s.classList.toggle('active', j === i));
    prev.disabled = i === 0;
    next.disabled = i === figs.length - 1;
  }

  // こちらから動かしている途中は、スクロール位置で番号を判定し直さない
  let movingUntil = 0;
  function show(i) {
    if (i < 0 || i >= figs.length) return;
    mark(i);
    movingUntil = Date.now() + 700;
    track.scrollTo({ left: figs[i].offsetLeft - figs[0].offsetLeft, behavior: 'smooth' });
  }
  track.addEventListener('scrollend', () => (movingUntil = 0));

  // スワイプで動かしたときも、いちばん近い画像に合わせる
  track.addEventListener('scroll', () => {
    if (Date.now() < movingUntil) return;
    const w = figs[1].offsetLeft - figs[0].offsetLeft;
    const i = Math.round(track.scrollLeft / w);
    if (i !== index && i >= 0 && i < figs.length) mark(i);
  });

  // ホイール：1 回ごとに 1 枚。端まで来たら、いつも通りシートを縦にスクロールさせる
  let wheelLock = 0;
  track.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横スクロールできるマウス・タッチパッドはそのまま
      const dir = e.deltaY > 0 ? 1 : -1;
      const target = index + dir;
      if (target < 0 || target >= figs.length) return;
      e.preventDefault();
      if (Date.now() < wheelLock) return;
      wheelLock = Date.now() + 350;
      show(target);
    },
    { passive: false },
  );

  mark(0);
  return h('div', { class: 'shots' }, h('div', { class: 'shot-steps' }, steps), h('div', { class: 'carousel-wrap' }, track, prev, next));
}

// 別のグループにコピーする
async function copyToGroup(groupId, l) {
  const others = groups.filter((g) => g.id !== groupId);
  const target = await openSheet((close) => [
    h('div', { class: 'sheet-title' }, 'どのグループにコピーしますか？'),
    others.map((g) => h('button', { class: 'sheet-action', onClick: () => close(g) }, g.name)),
    h('button', { class: 'sheet-action cancel', onClick: () => close(null) }, 'キャンセル'),
  ]);
  if (!target) return;
  try {
    await store.copyLineup(groupId, l, target.id);
    toast(`「${target.name}」にコピーしました`);
  } catch (e) {
    showError(e);
  }
}

// 詳細の「状態：有効 / 要確認 / 無効」。押すとその場で切り替わる
function statusBox(groupId, l) {
  const box = h('div', {});
  function render() {
    const st = valo.statusOf(l);
    box.className = `status-box st-${st}`;
    const when = l.statusAt ? new Date(l.statusAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '';
    setChildren(
      box,
      h(
        'div',
        { class: 'status-row' },
        h('span', { class: 'status-title' }, '状態'),
        h(
          'div',
          { class: 'segmented status-seg' },
          valo.STATUSES.map((s) =>
            h(
              'button',
              {
                class: `st-${s.id}${s.id === st ? ' active' : ''}`,
                onClick: async () => {
                  if (s.id === st) return;
                  try {
                    await store.setStatus(groupId, [l.id], s.id, s.id === 'ok' ? '' : l.statusNote ?? '');
                    Object.assign(l, { status: s.id, statusNote: s.id === 'ok' ? '' : l.statusNote ?? '', statusByName: auth.displayName(), statusAt: Date.now() });
                    render();
                    toast(`${s.label}にしました`);
                  } catch (e) {
                    showError(e);
                  }
                },
              },
              `${s.icon} ${s.label}`,
            ),
          ),
        ),
      ),
      st === 'ai'
        ? h('p', { class: 'status-note ai' }, '◆ AI が投稿や動画をもとに登録・確認した定点です。人が使って確かめたら「有効」にしてください。', l.statusNote ? `（${l.statusNote}）` : '', ` ${when}`)
        : null,
      st === 'check' || st === 'invalid'
        ? h(
            'p',
            { class: 'status-note' },
            st === 'check' ? '⚠ マップの変更などで使えなくなっている可能性があります。' : '✕ この定点は使えません。',
            l.statusNote ? `（${l.statusNote}）` : '',
            l.statusByName ? ` ${when} ${l.statusByName}` : '',
          )
        : null,
    );
  }
  render();
  return box;
}

function openDetail(groupId, l) {
  const agent = valo.agentById(l.agent);
  const ability = valo.abilityOf(l.agent, l.ability);
  const notesParts = valo.splitNotes(l);
  const embed = l.videoUrl && youtubeEmbed(l.videoUrl);
  const key = favKey(groupId, l.id);
  const byLine = [`登録：${l.createdByName}`, l.updatedBy && l.updatedBy !== l.createdBy ? `更新：${l.updatedByName}` : null].filter(Boolean).join(' ・ ');

  return openSheet((close) => {
    const favBtn = h('button', { class: 'btn' });
    const renderFav = () => {
      const on = prefs.favorites.includes(key);
      favBtn.textContent = on ? '★ お気に入り' : '☆ お気に入り';
      favBtn.classList.toggle('on', on);
    };
    renderFav();
    favBtn.addEventListener('click', async () => {
      const on = !prefs.favorites.includes(key);
      prefs = { ...prefs, favorites: on ? [...prefs.favorites, key] : prefs.favorites.filter((x) => x !== key) };
      renderFav();
      await store.setFavorite(key, on).catch(showError);
    });

    return [
      h(
        'div',
        { class: 'detail-head' },
        agentIcon(l.agent, 'agent-icon'),
        h(
          'div',
          { class: 'detail-title' },
          h('h2', {}, l.title),
          h(
            'p',
            {},
            [agent?.name, ability && `${ability.key}：${ability.name}`, valo.label(valo.SIDES, l.side), valo.siteLabel(l.site)].filter(Boolean).join(' ・ '),
          ),
        ),
        h('button', { class: 'close-btn', onClick: () => close(null), 'aria-label': '閉じる' }, '×'),
      ),
      h(
        'div',
        { class: 'badges' },
        h('span', { class: `imp imp-${l.importance}` }, valo.label(valo.IMPORTANCE, l.importance)),
        l.throwType ? h('span', { class: 'badge' }, valo.label(valo.THROW_TYPES, l.throwType)) : null,
        h('span', { class: 'badge muted' }, byLine),
      ),
      statusBox(groupId, l),
      notesParts.top ? h('p', { class: 'notes summary' }, notesParts.top) : null,
      imageCarousel(groupId, l, notesParts.captions),
      notesParts.bottom ? h('p', { class: 'notes' }, h('span', { class: 'notes-label' }, '備考'), notesParts.bottom) : null,
      embed
        ? h('div', { class: 'video' }, h('iframe', { src: embed, title: '動画', allow: 'encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, loading: 'lazy' }))
        : l.videoUrl
          ? h('a', { class: 'btn wide-link', href: l.videoUrl, target: '_blank', rel: 'noopener noreferrer' }, '▶ 動画を開く')
          : null,
      h(
        'div',
        { class: 'detail-actions' },
        favBtn,
        h('button', { class: 'btn', onClick: () =>
            actionSheet('リンクを共有', [
              { label: 'リンク＋説明', onClick: () => share(shareTitle(l), lineupUrl(groupId, l.id), '説明付きでリンクをコピーしました', true) },
              { label: 'リンクのみ', onClick: () => share(shareTitle(l), lineupUrl(groupId, l.id), 'リンクをコピーしました') },
            ]),
        }, 'リンク'),
        h('a', { class: 'btn', href: `#/g/${groupId}/edit/${l.id}`, onClick: () => close(null) }, '編集'),
        groups.length > 1
          ? h(
              'button',
              {
                class: 'btn',
                onClick: () => {
                  close(null);
                  copyToGroup(groupId, l);
                },
              },
              '別グループへ',
            )
          : null,
        h(
          'button',
          {
            class: 'btn danger',
            onClick: async () => {
              close(null);
              if (!(await confirmSheet(`「${l.title}」を削除しますか？（グループの全員から見えなくなります）`))) return;
              try {
                await store.deleteLineup(groupId, l);
                if (prefs.favorites.includes(key)) store.setFavorite(key, false).catch(() => {});
                toast('削除しました');
              } catch (e) {
                showError(e);
              }
            },
          },
          '削除',
        ),
      ),
    ];
  });
}

// #/g/{groupId}/l/{id}：共有リンク。定点を読んで、その地図画面で詳細を開く
function lineupLinkView(root, { groupId, id }) {
  loadingView(root);
  let alive = true;
  store
    .getLineup(groupId, id)
    .then((l) => {
      if (!alive) return;
      if (!l) throw new Error('not-found');
      pendingOpen = { groupId, lineup: l };
      location.replace(viewHash(groupId, { mapId: l.map, side: l.side, agentId: l.agent }));
    })
    .catch((e) => {
      if (!alive) return;
      console.error(e);
      root.replaceChildren();
      messageView(root, 'この定点は見つからないか、見る権限がありません（そのグループに参加すると見られます）。');
    });
  return () => (alive = false);
}

// ---- 画面：定点の登録・編集 ----

function editorView(root, { groupId, id, mapId, side, agentId }) {
  const group = groupById(groupId);
  const body = h('main', { class: 'editor' });
  root.append(
    header({ title: id ? '定点を編集' : '定点を登録', back: lastViewHash(groupId) }),
    h('div', { class: 'editor-group' }, '登録先のグループ：', h('strong', {}, group.name), '（メンバー全員が見られて、編集もできます）'),
    body,
  );

  let alive = true;
  let unmountPaste = null;

  const init = id
    ? store.getLineup(groupId, id).then((l) => {
        if (!l) throw new Error('定点が見つかりません');
        return l;
      })
    : Promise.resolve(null);

  body.append(h('div', { class: 'spinner' }));
  init
    .then((orig) => {
      if (!alive) return;
      unmountPaste = buildEditor(body, groupId, orig, { mapId, side, agentId });
    })
    .catch((e) => {
      if (!alive) return;
      setChildren(body, h('p', { class: 'empty' }, e.message), h('a', { class: 'btn', href: `#/g/${groupId}` }, '戻る'));
    });

  return () => {
    alive = false;
    unmountPaste?.();
  };
}

function field(label, ...children) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...children);
}

function selectEl(options, value, onChange) {
  return h(
    'select',
    { class: 'select', onChange: (e) => onChange(e.target.value) },
    options.map((o) => {
      const opt = h('option', { value: o.id }, o.label);
      opt.selected = o.id === value;
      return opt;
    }),
  );
}

function buildEditor(body, groupId, orig, defaults) {
  const f = {
    map: orig?.map ?? defaults.mapId ?? master.maps[0].id,
    side: orig?.side ?? defaults.side ?? 'atk',
    agent: orig?.agent ?? defaults.agentId ?? null,
    ability: orig?.ability ?? null,
    site: orig?.site ?? null,
    from: orig?.from ?? null,
    to: orig?.to ?? null,
    title: orig?.title ?? '',
    notes: orig?.notes ?? '',
    throwType: orig?.throwType ?? 'normal',
    importance: orig?.importance ?? 'useful',
    videoUrl: orig?.videoUrl ?? '',
    anyFrom: orig?.anyFrom === true,
  };
  const touch = matchMedia('(pointer: coarse)').matches; // スマホ・タブレット
  // 画像の 3 枠：{ id } = 保存済み、{ data, w, h } = 新しく追加、null = 空
  const slots =[0, 1, 2].map((i) => (orig?.imageIds?.[i] ? { id: orig.imageIds[i] } : null));
  let activeSlot = slots.findIndex((s) => !s);
  let placing = f.anyFrom ? (f.to ? null : 'to') : f.from ? (f.to ? null : 'to') : 'from';
  let titleTouched = !!orig;
  let siteTouched = !!orig;
  let saving = false;

  // ---- 地図 ----
  const mv = createMapView({
    onPick: (p) => {
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      const which = placing ?? 'to';
      f[which] = { x: +p.x.toFixed(4), y: +p.y.toFixed(4) };
      if (which === 'from') placing = f.to ? null : 'to';
      else placing = null;
      if (which === 'to') autoFill();
      renderAll();
    },
  });
  const placeBtns = h('div', { class: 'segmented place' });
  const mapHint = h('p', { class: 'map-hint' });

  // ---- フォーム ----
  const mapField = h('div');
  const agentGrid = h('div', { class: 'agent-grid' });
  const abilityGrid = h('div', { class: 'ability-grid' });
  const siteRow = h('div', { class: 'chip-row' });
  const titleInput = h('input', { class: 'text-input', maxlength: 80, placeholder: '例：B メインから B サイト奥のショック' });
  titleInput.value = f.title;
  titleInput.addEventListener('input', () => {
    f.title = titleInput.value;
    titleTouched = true;
  });
  const notesInput = h('textarea', { class: 'text-area', maxlength: 2000, rows: 5, placeholder: '例：\n2バウンス・フルチャージ\n立ち位置 : 箱1段目の角\n照準 : 出っ張ったツタの角\n着弾 : B サイト中\n（「立ち位置 :」などの行は各画像の下に表示）' });
  notesInput.value = f.notes;
  notesInput.addEventListener('input', () => (f.notes = notesInput.value));
  const videoInput = h('input', { class: 'text-input', type: 'url', maxlength: 300, placeholder: 'YouTube・Medal などのリンク（任意）' });
  videoInput.value = f.videoUrl;
  videoInput.addEventListener('input', () => (f.videoUrl = videoInput.value.trim()));
  const shotsBox = h('div', { class: 'shots-edit' });
  const saveBtn = h('button', { class: 'btn primary wide', onClick: save }, orig ? '保存' : '登録');

  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) setImage(activeSlot, file);
  });

  body.replaceChildren(
    h(
      'div',
      { class: 'editor-grid' },
      h('div', { class: 'editor-map' }, mapField, placeBtns, mv.el, mapHint),
      h(
        'div',
        { class: 'editor-form' },
        field(
          '攻め / 守り',
          selectEl(valo.SIDES, f.side, (v) => (f.side = v)),
        ),
        field('エージェント', agentGrid),
        field('アビリティ', abilityGrid),
        field('サイト', siteRow),
        field('タイトル', titleInput),
        field(
          '投げ方',
          selectEl(valo.THROW_TYPES, f.throwType, (v) => (f.throwType = v)),
        ),
        field(
          '重要度',
          selectEl(valo.IMPORTANCE, f.importance, (v) => (f.importance = v)),
        ),
        field(
          touch ? '画像（タップで選択）' : '画像（クリックで枠を選んで Ctrl+V・ドロップ・ダブルクリックでファイル選択）',
          shotsBox,
          fileInput,
        ),
        field('メモ', notesInput),
        field('動画', videoInput),
        saveBtn,
      ),
    ),
  );

  function autoFill() {
    const map = valo.mapById(f.map);
    if (!f.to) return;
    if (!siteTouched) f.site = valo.guessSite(map, f.to);
    if (!titleTouched) {
      const callout = valo.nearestCallout(map, f.to)?.name;
      const ab = valo.abilityOf(f.agent, f.ability)?.name;
      f.title = [callout, ab].filter(Boolean).join(' ');
      titleInput.value = f.title;
    }
  }

  function renderMapField() {
    setChildren(
      mapField,
      selectEl(
        master.maps.map((m) => ({ id: m.id, label: m.name })),
        f.map,
        (v) => {
          f.map = v;
          // マップが変わったら位置は置き直し
          f.from = null;
          f.to = null;
          placing = 'from';
          if (!siteTouched) f.site = null;
          renderAll();
        },
      ),
    );
  }

  function renderPlacing() {
    const map = valo.mapById(f.map);
    mv.setMap(map);
    if (f.anyFrom && placing === 'from') placing = 'to';
    setChildren(
      placeBtns,
      (f.anyFrom
        ? [['to', '置く場所']]
        : [
            ['from', '① 立ち位置'],
            ['to', '② 着弾点'],
          ]
      ).map(([k, label]) =>
        h('button', { class: `${placing === k ? 'active' : ''}${f[k] ? ' done' : ''}`, onClick: () => ((placing = k), renderPlacing()) }, `${f[k] ? '✓ ' : ''}${label}`),
      ),
      h(
        'label',
        { class: 'any-from' },
        h('input', {
          type: 'checkbox',
          checked: f.anyFrom,
          onChange: (e) => {
            f.anyFrom = e.target.checked;
            placing = f.anyFrom ? (f.to ? null : 'to') : f.from ? null : 'from';
            renderAll();
          },
        }),
        '立ち位置なし',
      ),
    );
    const agent = valo.agentById(f.agent);
    const markers = [];
    // 置いたマーカーはドラッグで微調整できる
    const moved = (which) => (p) => {
      f[which] = p;
      if (which === 'to') autoFill();
      renderPlacing();
      renderSites();
    };
    if (f.from && !f.anyFrom) markers.push({ ...f.from, kind: 'from', icon: agent?.icon, label: '立ち位置（ドラッグで調整）', dragKey: 'from', onDragEnd: moved('from') });
    if (f.to) markers.push({ ...f.to, kind: `target selected${f.anyFrom ? ' placed' : ''}`, icon: valo.abilityOf(f.agent, f.ability)?.icon, label: `${f.anyFrom ? '置く場所' : '着弾点'}（ドラッグで調整）`, dragKey: 'to', onDragEnd: moved('to') });
    mv.render({ markers, lines: f.from && f.to && !f.anyFrom ? [{ from: f.from, to: f.to, kind: 'selected', fromKey: 'from', toKey: 'to' }] : [] });
    mapHint.textContent = f.anyFrom
      ? 'スモークなど、どこからでも置けるスキルです。置く場所だけタップしてください（ドラッグで微調整）。'
      : placing === 'from'
        ? '地図をタップ（クリック）して立ち位置を置いてください。ホイール・ピンチで拡大できます。'
        : placing === 'to'
          ? '次に着弾点を置いてください。'
          : 'マーカーをドラッグすると微調整できます。置き直すときは ① / ② を選んでからタップします。';
  }

  function renderAgents() {
    setChildren(
      agentGrid,
      master.agents.map((a) =>
        h(
          'button',
          {
            type: 'button',
            class: `agent-btn${a.id === f.agent ? ' active' : ''}`,
            title: a.name,
            onClick: () => {
              if (f.agent !== a.id) f.ability = null;
              f.agent = a.id;
              renderAll();
            },
          },
          h('img', { src: a.icon, alt: '', draggable: 'false' }),
          h('span', { class: 'agent-name' }, a.name),
        ),
      ),
    );
  }

  function renderAbilities() {
    const agent = valo.agentById(f.agent);
    if (!agent) return setChildren(abilityGrid, h('p', { class: 'field-note' }, '先にエージェントを選んでください'));
    setChildren(
      abilityGrid,
      agent.abilities.map((ab) =>
        h(
          'button',
          {
            type: 'button',
            class: `ability-choice${ab.slot === f.ability ? ' active' : ''}`,
            onClick: () => {
              f.ability = ab.slot;
              if (!orig) f.anyFrom = valo.isPlacedAbility(f.agent, ab.slot);
              autoFill();
              renderAll();
            },
          },
          h('img', { src: ab.icon, alt: '', draggable: 'false' }),
          h('span', {}, `${ab.key}：${ab.name}`),
        ),
      ),
    );
  }

  function renderSites() {
    const map = valo.mapById(f.map);
    setChildren(
      siteRow,
      [...map.sites, 'mid', null].map((s) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${f.site === s ? ' active' : ''}`,
            onClick: () => {
              f.site = s;
              siteTouched = true;
              renderSites();
            },
          },
          s ? valo.siteLabel(s) : 'なし',
        ),
      ),
    );
  }

  // 空いている枠の案内（選んでいる枠だけ貼り付けの案内を出す）
  function emptyHint(i) {
    if (i !== activeSlot) return '＋';
    return touch ? 'タップで選択' : 'Ctrl+V で貼り付け\nダブルクリックで選択';
  }

  // 枠を選ぶ。作り直すとダブルクリックが効かなくなるので、表示だけ切り替える
  function selectSlot(i) {
    activeSlot = i;
    [...shotsBox.children].forEach((box, j) => {
      box.classList.toggle('active', j === i);
      const empty = box.querySelector('.shot-empty');
      if (empty) empty.textContent = emptyHint(j);
    });
  }

  function renderShots() {
    setChildren(
      shotsBox,
      valo.imageLabels(f).map((label, i) => {
        const slot = slots[i];
        const box = h(
          'div',
          {
            class: `shot-slot${i === activeSlot ? ' active' : ''}${slot ? ' filled' : ''}`,
            tabindex: 0,
            // PC：クリックで枠を選ぶ（そのあと Ctrl+V）、ダブルクリックでファイル選択
            // スマホ：ダブルタップしにくく貼り付けも使わないので、タップでファイル選択
            onClick: () => {
              selectSlot(i);
              if (touch && !slot) fileInput.click();
            },
            onDblclick: () => {
              if (touch) return;
              selectSlot(i);
              fileInput.click();
            },
            onDragover: (e) => {
              e.preventDefault();
              box.classList.add('drag');
            },
            onDragleave: () => box.classList.remove('drag'),
            onDrop: (e) => {
              e.preventDefault();
              box.classList.remove('drag');
              const file = imageFromTransfer(e.dataTransfer);
              if (file) setImage(i, file);
            },
          },
          h('span', { class: 'shot-label' }, `${i + 1}. ${label}`),
        );
        if (slot) {
          const img = h('img', { alt: label });
          if (slot.data) img.src = slot.data;
          else store.getImage(groupId, slot.id).then((d) => d && (img.src = d.data));
          box.append(
            img,
            h(
              'button',
              {
                type: 'button',
                class: 'shot-remove',
                'aria-label': `${label}の画像を外す`,
                onClick: (e) => {
                  e.stopPropagation();
                  slots[i] = null;
                  activeSlot = i;
                  renderShots();
                },
              },
              '×',
            ),
          );
        } else {
          box.append(h('span', { class: 'shot-empty' }, emptyHint(i)));
        }
        return box;
      }),
    );
  }

  async function setImage(i, file) {
    if (i < 0) i = 0;
    try {
      const img = await compressImage(file);
      slots[i] = img;
      // 次の空き枠へ
      const next = slots.findIndex((s) => !s);
      activeSlot = next >= 0 ? next : i;
      renderShots();
      toast(`${valo.imageLabels(f)[i]}の画像を追加しました（${Math.round((img.data.length * 0.75) / 1024)}KB）`);
    } catch (e) {
      showError(e);
    }
  }

  function renderAll() {
    renderMapField();
    renderPlacing();
    renderAgents();
    renderAbilities();
    renderSites();
    renderShots();
  }

  async function save() {
    if (saving) return;
    const title = f.title.trim();
    const problems = [
      !f.agent && 'エージェント',
      !f.ability && 'アビリティ',
      !f.anyFrom && !f.from && '立ち位置',
      !f.to && (f.anyFrom ? '置く場所' : '着弾点'),
      !title && 'タイトル',
    ].filter(Boolean);
    if (problems.length) return toast(`${problems.join('・')}を入力してください`);
    if (f.videoUrl && !/^https:\/\//.test(f.videoUrl)) return toast('動画のリンクは https:// から始まるものにしてください');

    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const imageIds = [];
      for (const s of slots) imageIds.push(!s ? null : s.id ?? (await store.putImage(groupId, s)));
      const data = {
        map: f.map,
        side: f.side,
        agent: f.agent,
        ability: f.ability,
        site: f.site,
        // 立ち位置なしでも from は必須項目なので、置く場所と同じ点を入れておく
        from: f.anyFrom ? f.to : f.from,
        to: f.to,
        anyFrom: f.anyFrom,
        title,
        notes: f.notes.trim(),
        throwType: f.throwType,
        importance: f.importance,
        videoUrl: f.videoUrl,
        imageIds,
      };
      const savedId = await store.saveLineup(groupId, orig?.id ?? null, data);
      // 外した画像を消す
      const removed = (orig?.imageIds ?? []).filter((x) => x && !imageIds.includes(x));
      if (removed.length) await store.deleteImages(groupId, removed);
      toast(orig ? '保存しました' : '登録しました');
      const me = auth.currentUser().uid;
      pendingOpen = {
        groupId,
        lineup: {
          createdBy: me,
          createdByName: auth.displayName(),
          ...orig,
          ...data,
          id: savedId,
          updatedBy: me,
          updatedByName: auth.displayName(),
        },
      };
      location.replace(viewHash(groupId, { mapId: f.map, side: f.side, agentId: f.agent }));
    } catch (e) {
      showError(e);
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = orig ? '保存' : '登録';
    }
  }

  // Ctrl+V（スマホは長押し → ペースト）で、選んでいる枠に画像を入れる
  const onPaste = (e) => {
    const file = imageFromTransfer(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    setImage(activeSlot, file);
  };
  document.addEventListener('paste', onPaste);

  renderAll();
  return () => document.removeEventListener('paste', onPaste);
}

// ---- 画面：メンバー・招待（グループ設定） ----

function groupSettingsView(root, { groupId }) {
  const body = h('main', { class: 'content' });
  const top = header({ title: 'グループの設定', back: '#/groups' });
  root.append(top, body);
  const me = auth.currentUser().uid;

  function render() {
    const g = groupById(groupId);
    if (!g) return;
    const owner = g.members[me]?.role === 'owner';
    const url = store.inviteUrl(g);
    const members = Object.entries(g.members).sort((a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0));
    setChildren(
      body,
      h('p', { class: 'section-label' }, 'グループ名'),
      h(
        'div',
        { class: 'name-row' },
        h('strong', { class: 'name-row-text' }, g.name),
        h(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              const name = await askText({ title: 'グループの名前', value: g.name, okLabel: '保存' });
              if (name) store.renameGroup(groupId, name).then(() => toast('名前を変更しました'), showError);
            },
          },
          '変更',
        ),
      ),
      h('a', { class: 'btn wide-link open-group', href: `#/g/${groupId}` }, 'このグループの定点を開く ›'),
      h('a', { class: 'btn wide-link open-group', href: `#/g/${groupId}/stats` }, '定点の集計を見る ›'),
      h('p', { class: 'section-label' }, '招待'),
      h(
        'div',
        { class: 'qr-card' },
        qrCode(url, 120),
        h(
          'div',
          { class: 'qr-card-text' },
          h('strong', {}, '招待リンク'),
          'このリンクを開くと、グループに参加できます（ゲストでも参加可）。',
          h('button', { class: 'btn', onClick: () => share(`${g.name} に参加`, url, '招待リンクをコピーしました') }, 'リンクを共有'),
        ),
      ),
      h('p', { class: 'section-label' }, `メンバー（${members.length}）`),
      h(
        'ul',
        { class: 'member-list' },
        members.map(([uid, m]) =>
          h(
            'li',
            {},
            h('span', { class: 'member-name' }, m.name, uid === me ? '（自分）' : ''),
            m.role === 'owner' ? h('span', { class: 'badge' }, 'オーナー') : null,
            m.guest ? h('span', { class: 'badge muted' }, 'ゲスト') : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'card-list group-actions' },
        owner
          ? h(
              'button',
              {
                class: 'btn',
                onClick: async () => {
                  if (!(await confirmSheet('招待リンクを作り直すと、古いリンクでは参加できなくなります。', '作り直す'))) return;
                  store.regenerateInvite(groupId).then(() => toast('招待リンクを作り直しました'), showError);
                },
              },
              '招待リンクを作り直す',
            )
          : h(
              'button',
              {
                class: 'btn danger',
                onClick: async () => {
                  if (!(await confirmSheet(`「${g.name}」から抜けますか？`, '抜ける'))) return;
                  try {
                    await store.leaveGroup(groupId);
                    location.hash = '#/groups';
                  } catch (e) {
                    showError(e);
                  }
                },
              },
              'グループから抜ける',
            ),
        owner
          ? h(
              'button',
              {
                class: 'btn danger',
                onClick: async () => {
                  if (!(await confirmSheet(`「${g.name}」を削除しますか？ グループの定点もすべて消えます。`))) return;
                  try {
                    await store.deleteGroup(groupId);
                    location.hash = '#/groups';
                  } catch (e) {
                    showError(e);
                  }
                },
              },
              'グループを削除',
            )
          : null,
      ),
    );
  }
  render();
  return subscribe(render);
}

// ---- 画面：定点の集計 ----
// どのマップ・攻守・エージェント・スキルの定点が多いか。数字＝有効＋要確認（無効は除く）、
// 色分けで有効（緑）と要確認（黄）の内訳。マス・行を押すとその条件で地図を開く

function statsView(root, { groupId }) {
  const body = h('main', { class: 'content stats' });
  root.append(header({ title: '定点の集計', back: lastViewHash(groupId) }), body);
  let lineups = null;
  let side = 'all';

  const MAP_SHORT = { abyss: 'アビ', ascent: 'アセ', haven: 'ヘイ', lotus: 'ロー', split: 'スプ', summit: 'サミ', sunset: 'サン' };
  const shortName = (m) => MAP_SHORT[m.id] ?? m.name.slice(0, 2);

  // { total, ok, check, invalid } を数える
  const tally = (list) => {
    const t = { total: 0, ok: 0, ai: 0, check: 0, invalid: 0 };
    for (const l of list) {
      const st = valo.statusOf(l);
      t[st] += 1;
      if (st !== 'invalid') t.total += 1;
    }
    return t;
  };

  // 有効・要確認の割合の細い棒
  const splitBar = (t, max) =>
    h(
      'span',
      { class: 'stat-bar', style: `width:${max ? Math.max(4, (t.total / max) * 100) : 0}%` },
      h('span', { class: 'ok', style: `flex:${t.ok}` }),
      h('span', { class: 'ai', style: `flex:${t.ai}` }),
      h('span', { class: 'check', style: `flex:${t.check}` }),
    );

  const heat = (n, max) => (n ? `background: rgb(255 70 85 / ${(0.12 + 0.6 * (n / max)).toFixed(2)})` : '');

  const open = (o) => {
    const v = storageGet(lastViewKey(groupId)) ?? {};
    location.hash = viewHash(groupId, {
      mapId: o.mapId ?? v.mapId ?? master.maps[0].id,
      side: o.side ?? (side === 'all' ? v.side ?? 'atk' : side),
      agentId: o.agentId ?? null,
    });
  };

  function render() {
    if (!lineups) return setChildren(body, h('p', { class: 'muted' }, '読み込み中…'));
    const list = lineups.filter((l) => side === 'all' || l.side === side);
    const all = tally(list);
    const maps = master.maps.filter((m) => valo.isCompetitive(m.id) || list.some((l) => l.map === m.id));
    const agents = master.agents
      .map((a) => ({ a, t: tally(list.filter((l) => l.agent === a.id)) }))
      .filter((x) => x.t.total + x.t.invalid)
      .sort((x, y) => y.t.total - x.t.total);
    const byMapSide = (mapId, sd) => tally(lineups.filter((l) => l.map === mapId && l.side === sd));
    const mapMax = Math.max(1, ...maps.flatMap((m) => ['atk', 'def'].map((sd) => byMapSide(m.id, sd).total)));
    const agentMax = Math.max(1, ...agents.map((x) => x.t.total));
    const cell = (agentId, mapId) => list.filter((l) => l.agent === agentId && l.map === mapId && valo.statusOf(l) !== 'invalid').length;
    const cellMax = Math.max(1, ...agents.flatMap((x) => maps.map((m) => cell(x.a.id, m.id))));

    setChildren(
      body,
      // 攻守の絞り込み
      h(
        'div',
        { class: 'segmented stats-side' },
        [
          ['all', 'すべて'],
          ['atk', '攻め'],
          ['def', '守り'],
        ].map(([id, label]) => h('button', { class: id === side ? 'active' : '', onClick: () => ((side = id), render()) }, label)),
      ),
      // 合計
      h(
        'div',
        { class: 'stat-cards five' },
        h('div', { class: 'stat-card' }, h('strong', {}, all.total), h('span', {}, '定点')),
        h('div', { class: 'stat-card ok' }, h('strong', {}, all.ok), h('span', {}, '有効')),
        h('div', { class: 'stat-card ai' }, h('strong', {}, all.ai), h('span', {}, 'AI確認済み')),
        h('div', { class: 'stat-card check' }, h('strong', {}, all.check), h('span', {}, '要確認')),
        h('div', { class: 'stat-card muted' }, h('strong', {}, all.invalid), h('span', {}, '無効')),
      ),
      h('p', { class: 'stats-legend' }, h('span', { class: 'dot ok' }), '有効', h('span', { class: 'dot ai' }), 'AI確認済み', h('span', { class: 'dot check' }), '要確認', '　数字は無効以外の合計'),

      // マップ × 攻守
      h('p', { class: 'section-label' }, 'マップ × 攻守'),
      h(
        'table',
        { class: 'stat-table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '攻め'), h('th', {}, '守り'))),
        h(
          'tbody',
          {},
          maps.map((m) =>
            h(
              'tr',
              { class: valo.isCompetitive(m.id) ? '' : 'off-pool' },
              h('th', {}, m.name),
              ['atk', 'def'].map((sd) => {
                const t = byMapSide(m.id, sd);
                return h(
                  'td',
                  { class: 'tap', onClick: () => open({ mapId: m.id, side: sd }) },
                  h('span', { class: 'num' }, t.total || '–'),
                  t.total ? splitBar(t, mapMax) : null,
                );
              }),
            ),
          ),
        ),
      ),

      // エージェント × スキル
      h('p', { class: 'section-label' }, `エージェント（${agents.length}）`),
      h(
        'table',
        { class: 'stat-table agents' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'bar-col' }, '件数'), valo.SLOTS.map((s) => h('th', { class: 'slot' }, s.key)))),
        h(
          'tbody',
          {},
          agents.map(({ a, t }) =>
            h(
              'tr',
              { class: 'tap', onClick: () => open({ agentId: a.id }) },
              h('th', {}, h('span', { class: 'agent-cell' }, h('img', { src: a.icon, alt: '' }), a.name)),
              h(
                'td',
                { class: 'bar-col' },
                h('span', { class: 'bar-line' }, splitBar(t, agentMax), h('span', { class: 'num' }, t.total)),
                h('span', { class: 'sub' }, `有効 ${t.ok} ・ AI ${t.ai} ・ 要確認 ${t.check}`),
              ),
              valo.SLOTS.map((s) => {
                const n = list.filter((l) => l.agent === a.id && l.ability === s.slot && valo.statusOf(l) !== 'invalid').length;
                return h('td', { class: `slot${n ? '' : ' zero'}` }, n || '·');
              }),
            ),
          ),
        ),
      ),

      // エージェント × マップ
      h('p', { class: 'section-label' }, 'エージェント × マップ'),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'stat-table heat' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), maps.map((m) => h('th', { title: m.name }, shortName(m))))),
          h(
            'tbody',
            {},
            agents.map(({ a }) =>
              h(
                'tr',
                {},
                h('th', {}, h('img', { class: 'agent-mini', src: a.icon, alt: a.name, title: a.name })),
                maps.map((m) => {
                  const n = cell(a.id, m.id);
                  return h('td', { class: n ? 'tap' : 'zero', style: heat(n, cellMax), onClick: n ? () => open({ mapId: m.id, agentId: a.id }) : null }, n || '');
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  render();
  const unsub = store.watchAllLineups(
    groupId,
    (list) => {
      lineups = list;
      render();
    },
    showError,
  );
  return unsub;
}

// ---- ルーター（URL の # 以降で画面を切り替える） ----

const G = '#\\/g\\/([\\w-]+)';
const groupRoutes = [
  [new RegExp(`^${G}\\/v\\/([a-z0-9]+)\\/(atk|def)(?:\\/([a-z0-9]+))?$`), (m) => [mapView, { mapId: m[2], side: m[3], agentId: m[4] ?? null }]],
  [new RegExp(`^${G}\\/l\\/([\\w-]+)$`), (m) => [lineupLinkView, { id: m[2] }]],
  [new RegExp(`^${G}\\/new(?:\\/([a-z0-9]+)\\/(atk|def)(?:\\/([a-z0-9]+))?)?$`), (m) => [editorView, { mapId: m[2], side: m[3], agentId: m[4] }]],
  [new RegExp(`^${G}\\/edit\\/([\\w-]+)$`), (m) => [editorView, { id: m[2] }]],
  [new RegExp(`^${G}\\/settings$`), () => [groupSettingsView, {}]],
  [new RegExp(`^${G}\\/stats$`), () => [statsView, {}]],
];

let unmount = null;

function route() {
  unmount?.();
  unmount = null;
  app.replaceChildren();
  const hash = location.hash;

  if (master === false) return masterErrorView(app);
  if (!master || user === undefined) return loadingView(app);

  const join = hash.match(/^#\/join\/([\w-]+)\/([\w-]+)$/);
  if (join) return joinView(app, { groupId: join[1], code: join[2] });

  if (!user) return welcomeView(app);
  if (auth.needsName()) return nameSetupView(app);

  if (hash === '#/groups') {
    unmount = groupsView(app);
    return;
  }

  for (const [re, make] of groupRoutes) {
    const m = hash.match(re);
    if (m) {
      const [view, params] = make(m);
      const groupId = m[1];
      unmount = withGroup(app, groupId, () => view(app, { groupId, ...params }));
      return;
    }
  }

  // #/g/{id} だけなら、そのグループで前回見ていたマップへ
  const groupOnly = hash.match(new RegExp(`^${G}$`));
  if (groupOnly) {
    location.replace(lastViewHash(groupOnly[1]));
    return;
  }

  // それ以外（#/ など）：前回のグループ、グループが 1 つだけならそこ、なければグループ一覧
  if (!groupsLoaded) return loadingView(app);
  const last = storageGet(LAST_GROUP_KEY);
  const target = groupById(last)?.id ?? (groups.length === 1 ? groups[0].id : null);
  location.replace(target ? lastViewHash(target) : '#/groups');
}

window.addEventListener('hashchange', route);

// ---- ログイン状態の監視 ----

let unwatchUserData = [];

auth.watchUser((u) => {
  user = u;
  unwatchUserData.forEach((fn) => fn());
  unwatchUserData = [];
  groups = [];
  groupsLoaded = false;
  prefs = { favorites: [], shortcuts: [] };
  if (u) {
    unwatchUserData.push(
      store.watchMyGroups(
        (g) => {
          const first = !groupsLoaded;
          groups = g;
          groupsLoaded = true;
          // 最初の読み込みを待っていた画面（#/ の振り分けなど）があれば出し直す
          if (first && !authBusy && !location.hash.match(/^#\/(g|join)\//)) route();
          else emit();
        },
        (e) => {
          console.error(e);
          groupsLoaded = true;
          emit();
        },
      ),
      store.watchPrefs((p) => {
        prefs = p;
        emit();
      }),
    );
  }
  if (!authBusy) route();
});

route();
valo
  .loadMaster()
  .then((m) => (master = m))
  .catch((e) => {
    console.error(e);
    master = false;
  })
  .finally(route);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
