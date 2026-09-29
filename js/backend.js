// Firebase の設定があれば Firebase 版、なければデモ版（このブラウザの中だけに保存）を使う。
// どちらも同じ関数名を持つ auth / store を返す。

import { configured } from './config.js';

export const demo = !configured;

const mods = configured
  ? await Promise.all([import('./auth.js'), import('./store.js')])
  : await import('./demo.js').then((m) => [m.auth, m.store]);

export const auth = mods[0];
export const store = mods[1];
