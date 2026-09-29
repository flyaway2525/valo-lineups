# valo-lineups 設計メモ

## 方針

- VALORANT の定点（ラインナップ）を登録・共有する PWA。参考：strats.gg のラインナップツール
- **確認はスマホ**（ホーム画面に追加して使う）、**登録は主に PC**（スクショを Ctrl+V で貼る）
- ouchi-share と同じ構成（ビルド不要の素の JavaScript + GitHub Pages + Firebase Spark 無料プラン）。ただしリポジトリも Firebase プロジェクトも別
- 無料枠を超えても課金されない構成にする → 画像は Firebase Storage（新規は有料プラン必須）ではなく Firestore に保存

## ファイル構成

| ファイル | 役割 |
|---|---|
| `js/config.js` | Firebase の設定値。空ならデモモード |
| `js/backend.js` | 設定の有無で Firebase 版 / デモ版を切り替える |
| `js/firebase.js` | Firebase の初期化 |
| `js/auth.js` | ログイン（Google / ゲスト）、ゲスト → Google の引き継ぎ（ouchi-share から流用） |
| `js/store.js` | Firestore の読み書き |
| `js/demo.js` | デモ版の auth / store（localStorage に保存。グループ機能なし） |
| `js/valo.js` | マップ・エージェント・アビリティのマスタ（valorant-api.com）、座標変換 |
| `js/mapview.js` | ミニマップ表示（拡大・移動・マーカー・軌道線） |
| `js/images.js` | 画像の圧縮（WebP・長辺 1280px） |
| `js/ui.js` | 画面部品（ヘッダー、ボトムシート、トーストなど。ouchi-share から流用） |
| `js/app.js` | 各画面とルーター |
| `firestore.rules` | セキュリティルール（コンソールに貼り付けて反映） |

## 画面と URL

| URL | 画面 |
|---|---|
| `#/v/{map}/{atk\|def}/{agent}` | 定点マップ（メイン）。例：`#/v/ascent/atk/sova`。エージェントは省略可 |
| `#/l/{lineupId}` | 定点の共有リンク。その定点のマップを開いて詳細を出す |
| `#/new/{map}/{side}/{agent}` | 定点の登録（今見ている条件を引き継ぐ） |
| `#/edit/{lineupId}` | 定点の編集（本人だけ） |
| `#/groups`、`#/g/{groupId}` | グループ一覧・グループ |
| `#/join/{groupId}/{inviteCode}` | 招待リンク |

`#/` で開くと、前回見ていたマップ・攻守・エージェントに戻る（端末に保存）。

### 定点マップ（スマホ）

```
┌──────────────────────┐
│ アセント ▾  [攻め|守り]  ＋  ⋯ │
│                                │
│        ミニマップ               │  ピンチ・ダブルタップで拡大（拡大するとコールアウト名が出る）
│     ◉ ─ ─ ─ ─ ○               │  ◉ 着弾点（アビリティのアイコン）→ タップで立ち位置と軌道線
│                                │  ○ 立ち位置（エージェントのアイコン）→ タップで詳細
├──────────────────────┤
│ [アセント 攻め ソーヴァ] [＋ショートカット] │  ショートカット（端末をまたいで同期）
│ 🟦🟩🟥🟨🟪 → 横スクロール           │  エージェント（登録数バッジ付き）
│ [C 2] [Q 5] [E 0] [X 1]         │  アビリティの表示切り替え
│ [すべて][自分][グループ][公開][★]  ☰ │  絞り込み、地図 / リスト切り替え
│ 定点カード…                      │
└──────────────────────┘
```

- 着弾点の近い定点（ミニマップの 2% 以内）は 1 つのマーカーにまとめ、件数バッジを出す
- 1 件だけのマーカーはタップですぐ詳細を開く
- 詳細はボトムシート：画像（立ち位置 → 照準 → 着弾）を横スワイプ、タップで全画面。メモ、動画（YouTube は埋め込み）、お気に入り、共有リンク、編集 / コピー / 削除
- PC では地図を左、パネルを右に並べる。キー操作：1〜4 でアビリティ切り替え、M で地図 / リスト

### 登録（PC）

- 地図をクリックして「① 立ち位置」「② 着弾点」の順に置く
- 着弾点に一番近いコールアウトから、サイトとタイトルを自動で入れる（手で直したらそれ以降は上書きしない）
- 画像は 3 枠（立ち位置 / 照準 / 着弾）。**Ctrl+V で選択中の枠に貼り付け**、ドロップ、クリックでファイル選択。入れると次の空き枠へ進む
- 画像はブラウザで WebP・長辺 1280px に圧縮（だいたい 100〜200KB）

## データ構造

```
admins/{uid}                グループを作れる人の許可リスト（コンソールから手で追加）
groups/{groupId}
  ├─ name, createdAt, createdBy
  ├─ inviteCode             招待リンクに含める合言葉。作り直すと古いリンクは無効
  ├─ memberIds: [uid, ...]
  └─ members: { uid: { name, role, guest, joinedAt } }   role = owner / member
lineups/{lineupId}
  ├─ map                    マップの ID（英語名を小文字にしたもの。例 "ascent"）
  ├─ side                   atk / def
  ├─ agent                  エージェントの ID（例 "sova"、"kayo"）
  ├─ ability                Grenade(C) / Ability1(Q) / Ability2(E) / Ultimate(X)
  ├─ site                   A / B / C / mid / null
  ├─ from: {x, y}, to: {x, y}   立ち位置・着弾点（ミニマップ上の 0〜1）
  ├─ title, notes
  ├─ throwType              normal / jump / run / crouch / runjump / alt / other
  ├─ importance             essential / useful / niche
  ├─ videoUrl               https のリンク（任意）
  ├─ imageIds: [立ち位置, 照準, 着弾]   空き枠は null
  ├─ visibility             private / group / public
  ├─ groupId                visibility = group のとき
  ├─ ownerId, ownerName
  ├─ copiedFrom             他の人の定点をコピーしたときの元 ID
  └─ createdAt, updatedAt
images/{imageId}            { ownerId, data（data URL）, w, h, createdAt }
prefs/{uid}                 { favorites: [lineupId], shortcuts: [{ mapId, side, agentId }] }
```

- マップを開くと、そのマップの定点を 3 種類のクエリで取って手元でまとめる
  - 自分の定点（`ownerId == 自分`）
  - 全体公開（`visibility == public`）
  - 参加中のグループごと（`visibility == group && groupId == そのグループ`）
  - セキュリティルールが「クエリの条件だけで読んでよいと判断できる」形にするため分けている
- 定点のドキュメントは小さい（1 件 1KB 未満）。画像は詳細を開いたときだけ読む
- 他の人の定点の「コピー」は画像も複製し、自分だけ公開の新しい定点になる（元とは同期しない）
- 定点を消すと画像も消える。グループを消しても定点は消えない（登録した本人からは見える）

## 権限

| 操作 | 誰ができるか |
|---|---|
| 定点の登録 | ログインしている人（ゲストも可） |
| 定点の編集・削除 | 登録した本人 |
| 定点を見る | 本人 / 全体公開ならログインした人全員 / グループ公開ならそのグループのメンバー |
| 画像を見る | ログインした人（ID は推測できない値で、一覧は取れない） |
| グループ作成 | `admins/{uid}` に登録された Google ログインユーザー |
| 招待リンクの作り直し・グループ削除 | グループのオーナー |
| グループからの脱退 | オーナー以外のメンバー |

## マスタデータ（valorant-api.com）

- `/v1/maps` と `/v1/agents?isPlayableCharacter=true` を英語・日本語で取得して合わせる
  - ID（URL・データに使う）は英語名から、表示は日本語名
  - マップは `tacticalDescription`（"A/B Sites" など）があるものだけ（射撃場・TDM 用などを除く）
- 端末に 1 日保存し、古くなったら裏で取り直す。画像は Service Worker でキャッシュ
- コールアウトの座標はゲーム内座標なので、マップごとの係数でミニマップ上の 0〜1 に変換する
  - `x = location.y × xMultiplier + xScalarToAdd`、`y = location.x × yMultiplier + yScalarToAdd`
- 非公式 API なので、止まった場合は端末に保存済みのデータで動く（初回だけは取得が必要）

## 無料枠の目安（Firestore Spark）

| 項目 | 無料枠 | 見込み |
|---|---|---|
| 保存容量 | 1GB | 画像 1 枚 150KB × 3 枚 ≒ 定点 1 件 0.5MB → 約 2,000 件 |
| 読み取り | 5 万回 / 日 | マップを開く：定点の件数分。詳細を開く：画像 1〜3 回。10 人で 1 日 100 回ずつ開いても数千回 |
| 書き込み | 2 万回 / 日 | 登録 1 件で 4 回程度 |
| 転送量 | 10GB / 月 | 画像 1 枚 150KB × 6 万回分 |

足りなくなったら、画像だけ Cloudflare R2（10GB 無料・転送量無料）に移す。

## デモモード

`js/config.js` の `apiKey` が空のあいだは、ログインなしで動き、データはブラウザの localStorage に保存される。
画面の確認用。グループ・公開範囲は使えない。容量はブラウザごとに 5MB 程度なので、画像は数十枚まで。

## 初期設定（Firebase）

1. [Firebase コンソール](https://console.firebase.google.com/) で新しいプロジェクトを作る（ouchi-share とは別）
2. Authentication →「始める」→ ログイン方法で **Google** と **匿名** を有効にする
3. Firestore Database →「データベースを作成」（本番環境モード、ロケーションは `asia-northeast1` など）
4. `firestore.rules` の内容を Firestore Database → ルール に貼り付けて「公開」
5. プロジェクトの設定 → マイアプリ →「ウェブアプリを追加」→ 表示された設定値を `js/config.js` に貼り付ける
6. Authentication → 設定 → 承認済みドメイン に GitHub Pages のドメイン（`<ユーザー名>.github.io`）を追加
7. 管理者の登録：アプリで Google ログイン → メニュー →「ユーザーIDをコピー」
   → Firestore → データ →「コレクションを開始」→ ID `admins`、ドキュメント ID にユーザーID、フィールド `note`（string）に名前など
8. メニュー → グループ →「＋ グループを作成」→ 招待リンクを仲間に送る

## 今後の候補

- 定点ごとの閲覧数・「使えた」ボタン
- 文字検索（タイトル・メモ・コールアウト）
- マップの向きを攻守で回転
- ゲストの復旧 ID（ouchi-share の方式）
- 画像を Cloudflare R2 へ移す（容量が足りなくなったら）

## 注意点

- iPhone のホーム画面から起動した PWA では、Google ログインのポップアップがうまく動かない場合がある。その場合は Safari で開いてログインする
- ゲストのままログアウトしたり Safari のデータを消したりすると、同じゲストには戻れず、自分の定点を編集できなくなる。PC とスマホで使うなら Google ログインにする
- Riot Games の「Legal Jibber Jabber」に沿った非営利のファンツールとして使う。strats.gg など他サイトの定点・画像は転載しない
