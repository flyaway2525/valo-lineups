// ミニマップ表示。拡大（ピンチ・ホイール・ダブルタップ）と移動、マーカー・軌道線の表示を受け持つ。
// 座標はすべてミニマップ上の 0〜1。
//
//   const mv = createMapView({ onPick });   // onPick を渡すと、空いている所のタップで座標を返す（登録画面用）
//   mv.setMap(map);                          // valo.js のマップ
//   mv.render({ markers, lines });           // markers: [{ x, y, icon, kind, label, onClick }]
//                                            // lines:   [{ from: {x,y}, to: {x,y}, kind }]

import { h } from './ui.js';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const TAP_SLOP = 8; // これ以上動いたらタップではなくドラッグ

export function createMapView({ onPick } = {}) {
  const img = h('img', { class: 'map-img', alt: '', draggable: 'false' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'map-lines');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  const calloutLayer = h('div', { class: 'map-callouts' });
  const markerLayer = h('div', { class: 'map-markers' });
  const stage = h('div', { class: 'map-stage' }, img, calloutLayer, svg, markerLayer);
  const el = h('div', { class: `map-view${onPick ? ' picking' : ''}` }, stage);

  let s = 1;
  let tx = 0;
  let ty = 0;

  const size = () => el.clientWidth || 1;

  function clamp() {
    s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    const w = size();
    tx = Math.min(0, Math.max(w - w * s, tx));
    ty = Math.min(0, Math.max(w - w * s, ty));
  }

  function apply() {
    clamp();
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    stage.style.setProperty('--s', s);
    el.classList.toggle('zoomed', s > 1.6);
  }

  // 画面上の点（コンテナ内の px）を中心に拡大率を変える
  function zoomAt(px, py, next) {
    const wx = (px - tx) / s;
    const wy = (py - ty) / s;
    s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    tx = px - wx * s;
    ty = py - wy * s;
    apply();
  }

  function local(e) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- ポインター操作 ----
  const pointers = new Map();
  let gesture = null; // { kind: 'pan' | 'pinch', ... }
  let moved = false;
  let lastTap = 0;
  let suppressClick = false;

  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, local(e));
    moved = false;
    if (pointers.size === 1) {
      const p = local(e);
      gesture = { kind: 'pan', sx: p.x, sy: p.y, tx0: tx, ty0: ty };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, wx: (cx - tx) / s, wy: (cy - ty) / s };
      moved = true;
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (gesture?.kind === 'pan') {
      const p = local(e);
      const dx = p.x - gesture.sx;
      const dy = p.y - gesture.sy;
      if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      if (!moved) {
        // 動き始めてから捕まえる（最初から捕まえるとマーカーのクリックが効かなくなる）
        el.setPointerCapture?.(e.pointerId);
        moved = true;
      }
      tx = gesture.tx0 + dx;
      ty = gesture.ty0 + dy;
      apply();
    } else if (gesture?.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.d0));
      tx = cx - gesture.wx * s;
      ty = cy - gesture.wy * s;
      apply();
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.delete(e.pointerId);
    if (pointers.size > 0) {
      // ピンチの片方の指を離したら、残りの指で移動を続けられるようにする
      const q = [...pointers.values()][0];
      gesture = { kind: 'pan', sx: q.x, sy: q.y, tx0: tx, ty0: ty };
      return;
    }
    gesture = null;
    if (moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      return;
    }
    if (e.type !== 'pointerup' || e.target.closest('.marker, .map-line-hit')) return;
    if (onPick) {
      onPick({ x: (p.x - tx) / s / size(), y: (p.y - ty) / s / size() });
      return;
    }
    // ダブルタップで拡大 / 元に戻す
    const now = Date.now();
    if (now - lastTap < 300) {
      zoomAt(p.x, p.y, s > 1.5 ? 1 : 2.5);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // ドラッグの終わりでマーカーを押したことにならないようにする
  el.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, s * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  new ResizeObserver(apply).observe(el);

  // ---- 表示 ----

  function setMap(map) {
    if (img.dataset.id !== map.id) {
      img.dataset.id = map.id;
      img.src = map.minimap;
      s = 1;
      tx = 0;
      ty = 0;
      apply();
    }
    calloutLayer.replaceChildren(
      ...map.callouts.map((c) => h('span', { class: 'callout', style: `left:${c.x * 100}%;top:${c.y * 100}%` }, c.name)),
    );
  }

  function render({ markers = [], lines = [] }) {
    svg.replaceChildren(
      ...lines.flatMap((l) => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', l.from.x);
        line.setAttribute('y1', l.from.y);
        line.setAttribute('x2', l.to.x);
        line.setAttribute('y2', l.to.y);
        line.setAttribute('class', `map-line ${l.kind ?? ''}`);
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        if (!l.onClick) return line;
        // 細い線は押しにくいので、透明な太い線を重ねて当たり判定にする
        const hit = line.cloneNode();
        hit.setAttribute('class', 'map-line-hit');
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          l.onClick();
        });
        if (l.label) {
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          t.textContent = l.label;
          hit.append(t);
        }
        return [line, hit];
      }),
    );
    markerLayer.replaceChildren(
      ...markers.map((m) =>
        h(
          m.onClick ? 'button' : 'span',
          {
            type: m.onClick ? 'button' : null,
            class: `marker ${m.kind ?? ''}`,
            style: `left:${m.x * 100}%;top:${m.y * 100}%`,
            'aria-label': m.label,
            title: m.label,
            onClick: m.onClick,
          },
          m.icon ? h('img', { src: m.icon, alt: '', draggable: 'false' }) : null,
          m.badge ? h('span', { class: 'marker-badge' }, m.badge) : null,
        ),
      ),
    );
  }

  function resetZoom() {
    s = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  apply();
  return { el, setMap, render, resetZoom };
}
