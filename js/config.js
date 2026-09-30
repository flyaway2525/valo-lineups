// Firebase の設定値。
// ブラウザに配る公開用のもの（秘密ではない）。データの保護は firestore.rules で行う。
//
// apiKey が空のあいだは「デモモード」（データはこのブラウザの中だけに保存）で動く。
// Firebase プロジェクトを作ったら、コンソールの「プロジェクトの設定」→「マイアプリ」の値を貼り付ける。

export const firebaseConfig = {
  apiKey: 'AIzaSyCp6BGXI2gU9H3lkHSRT_nGKH1gwhYNB2I',
  authDomain: 'valo-lineups-fly.firebaseapp.com',
  projectId: 'valo-lineups-fly',
  storageBucket: 'valo-lineups-fly.firebasestorage.app',
  messagingSenderId: '261713397926',
  appId: '1:261713397926:web:8b3aac158f592f3f750c67',
};

export const configured = !!firebaseConfig.apiKey;
