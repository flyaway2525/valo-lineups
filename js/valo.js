// マップ・エージェント・アビリティのマスタデータ。
// 非公式の valorant-api.com から取得し、1 日だけ端末に保存しておく（新エージェント・新マップは自動で反映）。
//
// 定点の座標はミニマップ画像（displayIcon、正方形）上の位置を 0〜1 に正規化した値で持つ。
// コールアウト（「A メイン」など）はゲーム内座標なので、マップごとの係数でミニマップ座標に変換する。

const API = 'https://valorant-api.com/v1';
const CACHE_KEY = 'valo-master-v1';
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

export const THROW_TYPES = [
  { id: 'normal', label: '通常' },
  { id: 'jump', label: 'ジャンプ投げ' },
  { id: 'run', label: '走り投げ' },
  { id: 'crouch', label: 'しゃがみ投げ' },
  { id: 'runjump', label: '走りジャンプ投げ' },
  { id: 'alt', label: '右クリック（下投げ）' },
  { id: 'other', label: 'その他（メモ参照）' },
];

export const IMAGE_LABELS = ['立ち位置', '照準', '着弾'];
// 立ち位置なし（スモークなどマップから置くスキル）の定点の画像 3 枠
export const PLACED_IMAGE_LABELS = ['置く画面', '外から見た様子', '補足'];

// マップを開いて置くスキル。新しく登録するとき「立ち位置なし」を最初からオンにする
const PLACED = { brimstone: ['Ability2'], omen: ['Ability2'], astra: ['Grenade', 'Ability1', 'Ability2'], clove: ['Ability2'] };
export function isPlacedAbility(agentId, slot) {
  return !!PLACED[agentId]?.includes(slot);
}

// 立ち位置なし（どこからでも置ける）定点か
export function noFrom(lineup) {
  return lineup.anyFrom === true;
}

// メモを「概要（上）／画像ごとの説明／備考（下）」に分ける。
// 「立ち位置 : …」「照準 : …」「着弾 : …」の行は対応する画像の下に出す。
// それより前の行は概要、後の行（「備考 :」も含む）は備考
const CAPTION_KEYS = [
  ['立ち位置', '置く画面'],
  ['照準', '外から見た様子', '置く場所'],
  ['着弾', '効果', '補足'],
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
  return noFrom(lineup) ? PLACED_IMAGE_LABELS : IMAGE_LABELS;
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
