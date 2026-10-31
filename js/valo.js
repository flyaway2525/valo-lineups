// マップ・エージェント・アビリティのマスタデータ。
// 非公式の valorant-api.com から取得し、1 日だけ端末に保存しておく（新エージェント・新マップは自動で反映）。
//
// 定点の座標はミニマップ画像（displayIcon、正方形）上の位置を 0〜1 に正規化した値で持つ。
// コールアウト（「A メイン」など）はゲーム内座標なので、マップごとの係数でミニマップ座標に変換する。

const API = 'https://valorant-api.com/v1';
const CACHE_KEY = 'valo-master-v2';
const TTL = 24 * 60 * 60 * 1000;

// アビリティの枠とキーの対応（C / Q / E / X の順に並べる）
export const SLOTS = [
  { slot: 'Grenade', key: 'C' },
  { slot: 'Ability1', key: 'Q' },
  { slot: 'Ability2', key: 'E' },
  { slot: 'Ultimate', key: 'X' },
];

export const SIDES = [
  { id: 'atk', label: '攻め' },
  { id: 'def', label: '守り' },
];

export const IMPORTANCE = [
  { id: 'essential', label: '必須' },
  { id: 'useful', label: '便利' },
  { id: 'niche', label: 'ネタ' },
];

// 投げ方は「使い方（アビリティごとに違う）」×「動き（共通）」の組み合わせ。
// 使い方は throwType、動きは throwMove に入れる
const ACTIONS = {
  throw: '投げ（左クリック）',
  lob: '下投げ（右クリック）',
  toss: '投げる',
  place: '設置',
  through: '壁越しに設置（右クリック）',
  launch: '発射',
  bounce: 'バウンド付き（右クリック）',
  send: '前に送り出す',
  steer: '曲げる（長押しで誘導）',
  hold: '長押しで距離調整',
  drop: '途中で落とす（再使用）',
  prepare: '構えて誘導（右クリック→再使用）',
  curveL: '左カーブ（左クリック）',
  curveR: '右カーブ（右クリック）',
  b0: 'バウンドなし',
  b1: '1 バウンド',
  b2: '2 バウンド',
  map: 'マップで指定',
  view: '視点で置く（距離調整）',
  tp: 'テレポート先を指定',
  plant: '設置・解除させる（右クリック）',
  marker: 'その場にマーカー（右クリック）',
  slow: '遅い壁（右クリック）',
  dash2: '2 回ダッシュ（左クリック）',
  dash1: '1 回ダッシュ（右クリック）',
  shoot: '撃つ',
  instant: 'その場で発動',
  other: 'その他（メモ参照）',
};

export const MOVES = [
  { id: 'stand', label: '止まって' },
  { id: 'jump', label: 'ジャンプ' },
  { id: 'run', label: '走り' },
  { id: 'runjump', label: '走りジャンプ' },
  { id: 'walk', label: '歩き' },
  { id: 'crouch', label: 'しゃがみ' },
  { id: 'crouchjump', label: 'しゃがみジャンプ' },
];

// エージェント → スキル → 使い方（先頭がいちばんよく使うもの）。「その他」はどれにも付く
const ABILITY_ACTIONS = {
  astra: { Grenade: ['map'], Ability1: ['map'], Ability2: ['map'], Ultimate: ['map'] },
  breach: { Grenade: ['send'], Ability1: ['send'], Ability2: ['hold'], Ultimate: ['send'] },
  brimstone: { Grenade: ['toss'], Ability1: ['launch'], Ability2: ['map'], Ultimate: ['map'] },
  chamber: { Grenade: ['place'], Ability1: ['shoot'], Ability2: ['place'], Ultimate: ['shoot'] },
  clove: { Grenade: ['instant'], Ability1: ['throw'], Ability2: ['map'], Ultimate: ['instant'] },
  cypher: { Grenade: ['place'], Ability1: ['toss'], Ability2: ['place'], Ultimate: ['instant'] },
  deadlock: { Grenade: ['throw'], Ability1: ['place'], Ability2: ['throw', 'lob'], Ultimate: ['launch'] },
  fade: { Grenade: ['send', 'steer'], Ability1: ['throw', 'drop'], Ability2: ['throw', 'drop'], Ultimate: ['send'] },
  gekko: { Grenade: ['throw', 'lob'], Ability1: ['send', 'plant'], Ability2: ['throw'], Ultimate: ['steer'] },
  harbor: { Grenade: ['throw'], Ability1: ['send', 'steer'], Ability2: ['view'], Ultimate: ['send'] },
  hush: { Grenade: ['instant'], Ability1: ['throw', 'prepare'], Ability2: ['throw', 'prepare'], Ultimate: ['steer'] },
  iso: { Grenade: ['send', 'slow'], Ability1: ['send'], Ability2: ['instant'], Ultimate: ['send'] },
  jett: { Grenade: ['toss', 'steer'], Ability1: ['instant'], Ability2: ['instant'], Ultimate: ['shoot'] },
  kayo: { Grenade: ['throw', 'lob'], Ability1: ['throw', 'lob'], Ability2: ['throw'], Ultimate: ['instant'] },
  killjoy: { Grenade: ['throw', 'lob'], Ability1: ['place'], Ability2: ['place'], Ultimate: ['place'] },
  miks: { Grenade: ['throw'], Ability1: ['instant'], Ability2: ['map'], Ultimate: ['send'] },
  neon: { Grenade: ['send'], Ability1: ['toss'], Ability2: ['instant'], Ultimate: ['shoot'] },
  omen: { Grenade: ['tp'], Ability1: ['send'], Ability2: ['view'], Ultimate: ['map'] },
  phoenix: { Grenade: ['send', 'steer'], Ability1: ['throw', 'lob'], Ability2: ['curveL', 'curveR'], Ultimate: ['instant'] },
  raze: { Grenade: ['send'], Ability1: ['toss'], Ability2: ['throw', 'lob'], Ultimate: ['launch'] },
  reyna: { Grenade: ['send'], Ability1: ['instant'], Ability2: ['instant'], Ultimate: ['instant'] },
  sage: { Grenade: ['place'], Ability1: ['throw'], Ability2: ['instant'], Ultimate: ['instant'] },
  skye: { Grenade: ['instant'], Ability1: ['steer'], Ability2: ['send', 'steer'], Ultimate: ['send'] },
  sova: { Grenade: ['steer'], Ability1: ['b0', 'b1', 'b2'], Ability2: ['b0', 'b1', 'b2'], Ultimate: ['shoot'] },
  tejo: { Grenade: ['steer'], Ability1: ['launch', 'bounce'], Ability2: ['map'], Ultimate: ['map'] },
  veto: { Grenade: ['place'], Ability1: ['throw'], Ability2: ['place'], Ultimate: ['instant'] },
  viper: { Grenade: ['launch'], Ability1: ['throw', 'lob'], Ability2: ['send'], Ultimate: ['instant'] },
  vyse: { Grenade: ['throw'], Ability1: ['place'], Ability2: ['place', 'through'], Ultimate: ['place'] },
  waylay: { Grenade: ['throw'], Ability1: ['dash2', 'dash1'], Ability2: ['instant'], Ultimate: ['send'] },
  yoru: { Grenade: ['send', 'marker'], Ability1: ['throw'], Ability2: ['send', 'place'], Ultimate: ['instant'] },
};
// 一覧にない新しいエージェント用
const FALLBACK_ACTIONS = ['throw', 'lob', 'place'];

// マップで指定するスキルは動きが関係ない
const NO_MOVE = ['map', 'view', 'tp'];

export function throwActions(agentId, slot) {
  const ids = ABILITY_ACTIONS[agentId]?.[slot] ?? FALLBACK_ACTIONS;
  return [...ids, 'other'].map((id) => ({ id, label: ACTIONS[id] }));
}

export function hasMove(action) {
  return !NO_MOVE.includes(action);
}

// 古い throwType（通常・ジャンプ投げ・右クリック など 1 つで持っていたもの）も読めるようにする
const OLD_MOVES = ['jump', 'run', 'crouch', 'runjump'];
export function throwActionOf(l) {
  const list = throwActions(l.agent, l.ability).map((a) => a.id);
  const t = l.throwType;
  if (list.includes(t)) return t;
  if (t === 'alt') return list.includes('lob') ? 'lob' : 'other';
  if (t === 'other') return 'other';
  return list[0];
}
export function throwMoveOf(l) {
  if (l.throwMove) return l.throwMove;
  return OLD_MOVES.includes(l.throwType) ? l.throwType : 'stand';
}

// 「ジャンプ・下投げ（右クリック）」のような表示。投げ方が入っていない定点は空
export function throwLabel(l) {
  if (!l.throwType) return '';
  const action = throwActionOf(l);
  const move = throwMoveOf(l);
  const a = ACTIONS[action];
  if (!hasMove(action) || move === 'stand') return a;
  return `${label(MOVES, move)}・${a}`;
}

export const IMAGE_LABELS = ['立ち位置', '照準', '着弾'];

// 定点の種類。スキルによって、マップに置く点・画像の枠の名前が変わる
//   throw  投げる（ふつうの定点）：立ち位置 → 着弾点
//   placed 置く（スモークなど、どこからでもマップで置ける）：置く場所だけ
//   setup  設置（トラップワイヤーなど）：始点 → 終点（設置したものそのもの）
export const MODES = [
  { id: 'throw', label: '投げる', from: '立ち位置', to: '着弾点', images: ['立ち位置', '照準', '着弾'] },
  { id: 'placed', label: '置く（立ち位置なし）', from: null, to: '置く場所', images: ['置く画面', '外から見た様子', '補足'] },
  { id: 'setup', label: '設置（ワイヤーなど）', from: '始点', to: '終点', images: ['始点', '全体像', '引っかかった時'] },
];
export const PLACED_IMAGE_LABELS = MODES[1].images;

// 新しく登録するとき、スキルに合わせて最初に選んでおく種類
const DEFAULT_MODES = {
  brimstone: { Ability2: 'placed' },
  omen: { Ability2: 'placed' },
  astra: { Grenade: 'placed', Ability1: 'placed', Ability2: 'placed' },
  clove: { Ability2: 'placed' },
  cypher: { Grenade: 'setup' },
  deadlock: { Grenade: 'setup' },
};
export function defaultMode(agentId, slot) {
  return DEFAULT_MODES[agentId]?.[slot] ?? 'throw';
}
export function isPlacedAbility(agentId, slot) {
  return defaultMode(agentId, slot) === 'placed';
}

export function modeOf(lineup) {
  return lineup.mode ?? (lineup.anyFrom === true ? 'placed' : 'throw');
}
export function modeInfo(lineup) {
  return MODES.find((m) => m.id === modeOf(lineup)) ?? MODES[0];
}

// 立ち位置なし（どこからでも置ける）定点か
export function noFrom(lineup) {
  return modeOf(lineup) === 'placed';
}

// メモを「概要（上）／画像ごとの説明／備考（下）」に分ける。
// 「立ち位置 : …」「照準 : …」「着弾 : …」の行は対応する画像の下に出す。
// それより前の行は概要、後の行（「備考 :」も含む）は備考
const CAPTION_KEYS = [
  ['立ち位置', '置く画面', '始点'],
  ['照準', '外から見た様子', '置く場所', '全体像'],
  ['着弾', '効果', '補足', '引っかかった時'],
];
export function splitNotes(lineup) {
  const caps = [[], [], []];
  const top = [];
  const bottom = [];
  let seenCaption = false;
  for (const raw of (lineup.notes ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]{1,12}?)\s*[:：]\s*(.*)$/);
    const slot = m ? CAPTION_KEYS.findIndex((keys) => keys.includes(m[1].trim())) : -1;
    if (slot >= 0 && lineup.imageIds?.[slot]) {
      caps[slot].push(m[2]);
      seenCaption = true;
    } else if (m && m[1].trim() === '備考') {
      bottom.push(m[2]);
    } else {
      (seenCaption ? bottom : top).push(line);
    }
  }
  return { top: top.join('\n'), captions: caps.map((c) => c.join('\n')), bottom: bottom.join('\n') };
}

export function imageLabels(lineup) {
  return modeInfo(lineup).images;
}

// コンペのマップローテーション（API で取れないので手で更新する）
// 更新日：2026-09-30、パッチ 13.04（V26 Act 5）
// 出典：https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-13-04/
export const COMPETITIVE_MAPS = ['abyss', 'ascent', 'haven', 'lotus', 'split', 'summit', 'sunset'];

export function isCompetitive(mapId) {
  return COMPETITIVE_MAPS.includes(mapId);
}

// 定点の状態。有効＝人が確認、AI確認済み＝AI が投稿・動画から確認（人は未確認）、
// 要確認＝マップのアップデートなどで使えなくなったかもしれない
export const STATUSES = [
  { id: 'ok', label: '有効', icon: '●' },
  { id: 'ai', label: 'AI確認済み', icon: '◆' },
  { id: 'check', label: '要確認', icon: '⚠' },
  { id: 'invalid', label: '無効', icon: '✕' },
];

// 状態がない定点（古いデータ）は「有効」
export function statusOf(lineup) {
  return lineup.status ?? 'ok';
}

// "KAY/O" → "kayo" のように URL に使える形にする
export function slug(name) {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

async function getJson(path, lang) {
  const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}language=${lang}`);
  if (!res.ok) throw new Error(`valorant-api ${res.status}`);
  return (await res.json()).data;
}

function convertMap(en, ja) {
  const calloutsJa = ja?.callouts ?? [];
  return {
    id: slug(en.displayName),
    uuid: en.uuid,
    name: ja?.displayName ?? en.displayName,
    nameEn: en.displayName,
    minimap: en.displayIcon,
    thumb: en.listViewIcon,
    sites: (en.tacticalDescription.match(/[ABC](?=[/ ])/g) ?? ['A', 'B']).filter((s, i, a) => a.indexOf(s) === i),
    callouts: (en.callouts ?? []).map((c, i) => ({
      name: calloutsJa[i] ? `${calloutsJa[i].superRegionName} ${calloutsJa[i].regionName}` : `${c.superRegionName} ${c.regionName}`,
      region: c.superRegionName,
      // ゲーム内座標 → ミニマップ上の 0〜1（x と y が入れ替わるのは仕様）
      x: c.location.y * en.xMultiplier + en.xScalarToAdd,
      y: c.location.x * en.yMultiplier + en.yScalarToAdd,
    })),
  };
}

function convertAgent(en, ja) {
  const abilitiesJa = Object.fromEntries((ja?.abilities ?? []).map((a) => [a.slot, a]));
  return {
    id: slug(en.displayName),
    uuid: en.uuid,
    name: ja?.displayName ?? en.displayName,
    nameEn: en.displayName,
    icon: en.displayIconSmall ?? en.displayIcon,
    role: ja?.role?.displayName ?? en.role?.displayName ?? '',
    abilities: SLOTS.map(({ slot, key }) => {
      const a = en.abilities.find((x) => x.slot === slot);
      return a && { slot, key, name: abilitiesJa[slot]?.displayName ?? a.displayName, icon: a.displayIcon };
    }).filter(Boolean),
  };
}

async function fetchMaster() {
  const [mapsEn, mapsJa, agentsEn, agentsJa] = await Promise.all([
    getJson('/maps', 'en-US'),
    getJson('/maps', 'ja-JP'),
    getJson('/agents?isPlayableCharacter=true', 'en-US'),
    getJson('/agents?isPlayableCharacter=true', 'ja-JP'),
  ]);
  const byUuid = (list) => Object.fromEntries(list.map((x) => [x.uuid, x]));
  const mj = byUuid(mapsJa);
  const aj = byUuid(agentsJa);
  return {
    // A/B サイトのある通常マップだけ（射撃場・チームデスマッチ用などは除く）
    maps: mapsEn
      .filter((m) => m.tacticalDescription && m.displayIcon)
      .map((m) => convertMap(m, mj[m.uuid]))
      .sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
    agents: agentsEn.map((a) => convertAgent(a, aj[a.uuid])).sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
  };
}

let master = null;

// 保存済みがあればそれをすぐ返し、古ければ裏で取り直す
export async function loadMaster() {
  if (master) return master;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY));
  } catch {
    // 壊れていたら取り直す
  }
  const refresh = () =>
    fetchMaster().then((m) => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ...m }));
      } catch {
        // 保存できなくても動作には困らない
      }
      return m;
    });
  if (cached?.maps?.length) {
    if (Date.now() - cached.at > TTL) refresh().catch(() => {});
    master = cached;
  } else {
    master = await refresh();
  }
  return master;
}

export function mapById(id) {
  return master?.maps.find((m) => m.id === id);
}

export function agentById(id) {
  return master?.agents.find((a) => a.id === id);
}

export function abilityOf(agentId, slot) {
  return agentById(agentId)?.abilities.find((a) => a.slot === slot);
}

export function label(list, id) {
  return list.find((x) => x.id === id)?.label ?? '';
}

// 指定した位置にいちばん近いコールアウト
export function nearestCallout(map, p) {
  let best = null;
  let bestD = Infinity;
  for (const c of map?.callouts ?? []) {
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// 着弾点からサイト（A / B / C / mid）を推測する。攻め側・守り側の陣地なら null
export function guessSite(map, p) {
  const r = nearestCallout(map, p)?.region;
  if (r === 'A' || r === 'B' || r === 'C') return r;
  if (r === 'Mid') return 'mid';
  return null;
}

export function siteLabel(site) {
  return site === 'mid' ? 'ミッド' : site ? `${site} サイト` : '';
}
