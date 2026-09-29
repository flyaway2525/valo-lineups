// Firebase の設定値。
// ブラウザに配る公開用のもの（秘密ではない）。データの保護は firestore.rules で行う。
//
// apiKey が空のあいだは「デモモード」（データはこのブラウザの中だけに保存）で動く。
// Firebase プロジェクトを作ったら、コンソールの「プロジェクトの設定」→「マイアプリ」の値を貼り付ける。

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export const configured = !!firebaseConfig.apiKey;
