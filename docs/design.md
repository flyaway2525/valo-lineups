# valo-lineups 設計メモ

## 方針

- VALORANT の定点（ラインナップ）を**グループの仲間と**登録・共有する PWA。参考：strats.gg のラインナップツール
- **確認はスマホ**（ホーム画面に追加して使う）、**登録は主に PC**（スクショを Ctrl+V で貼る）
- ouchi-share と同じ構成（ビルド不要の素の JavaScript + GitHub Pages + Firebase Spark 無料プラン）。ただしリポジトリも Firebase プロジェクトも別
- 無料枠を超えても課金されない構成にする → 画像は Firebase Storage（新規は有料プラン必須）ではなく Firestore に保存

## グループ中心の考え方

- 定点は必ずどれか 1 つのグループに入っている。「自分だけ」「全体公開」はない
  - 個人用が欲しければ、1 人だけのグループを作る
- グループのメンバーは全員、定点を見る・登録する・編集する・削除することができる
- 別のグループでも使いたい定点は「別グループへ」でコピーする（画像も複製。元とは同期しない）
- 画面の上部には常に今いるグループ名を出す

## 画面と URL

```
アプリを開く（#/）
  └→ 前回のグループのマップへ（グループが 1 つだけならそこ、なければグループ一覧）

グループ一覧（#/groups）
  ├ ⚙ → グループの設定（#/g/{groupId}/settings）：名前の変更 / 招待 / メンバー / 抜ける・削除
  └→ グループのマップ（#/g/{groupId}/v/{map}/{atk|def}/{agent}）
        ├ ＋ → 定点の登録（#/g/{groupId}/new/…）
        ├ 人アイコン → ユーザー設定（名前変更 / Google に引き継ぐ / ログアウト）
        ├ ‹ → グループ一覧
        └ アイコン → 定点の詳細（ボトムシート）→ 編集（#/g/{groupId}/edit/{id}）
```

| URL | 画面 |
|---|---|
| `#/groups` | グループ一覧（作成もここ）。上部に「○○ としてログイン中」とログイン方法を表示 |
| `#/g/{groupId}` | そのグループで前回見ていたマップへ |
| `#/g/{groupId}/v/{map}/{atk\|def}/{agent}` | グループのマップ（メイン）。例：`#/g/xxxx/v/ascent/atk/sova`。エージェントは省略可 |
| `#/g/{groupId}/l/{lineupId}` | 定点の共有リンク。その定点のマップを開いて詳細を出す |
| `#/g/{groupId}/new/{map}/{side}/{agent}` | 定点の登録（今見ている条件を引き継ぐ） |
| `#/g/{groupId}/edit/{lineupId}` | 定点の編集 |
| `#/g/{groupId}/settings` | グループの設定（名前の変更・招待・メンバー・抜ける / 削除）。グループ一覧の ⚙ から |
| `#/join/{groupId}/{inviteCode}` | 招待リンク |

### グループのマップ（スマホ）

```
┌──────────────────────┐
│ ‹ いつものフルパ        [攻め|守り] ＋ 👤 │  ← 今いるグループ名（小さく。表示だけ）
│   アセント ▾                        │
│        ミニマップ               │  ピンチ・ダブルタップで拡大（拡大するとコールアウト名が出る）
│     ◉ ─ ─ ─ ─ ○               │  ◉ 着弾点（アビリティのアイコン）→ タップで立ち位置と軌道線
│                                │  ○ 立ち位置（エージェントのアイコン）→ タップで詳細
├──────────────────────┤
│ [アセント 攻め ソーヴァ] [＋ショートカット] │  ショートカット（グループごと・端末をまたいで同期）
│ 🟦🟩🟥🟨🟪 → 横スクロール           │  エージェント（登録数バッジ付き）
│ [C 2] [Q 5] [E 0] [X 1]         │  アビリティの表示切り替え
│ [すべて][自分が登録][★お気に入り]  ☰ │  絞り込み、地図 / リスト切り替え
│ 定点カード…                      │
└──────────────────────┘
```

- 着弾点の近い定点（ミニマップの 2% 以内）は 1 つのマーカーにまとめ、件数バッジを出す
- 1 件だけのマーカーはタップですぐ詳細を開く
- 詳細はボトムシート：画像（立ち位置 → 照準 → 着弾）を横スワイプ、タップで全画面。メモ、動画（YouTube は埋め込み）、登録者・更新者、お気に入り、共有リンク、編集、別グループへコピー、削除
- PC では地図を左、パネルを右に並べる。キー操作：1〜4 でアビリティ切り替え、M で地図 / リスト

### 登録（PC）

- 上部に「登録先のグループ」を表示する
- 地図をクリックして「① 立ち位置」「② 着弾点」の順に置く
- 着弾点に一番近いコールアウトから、サイトとタイトルを自動で入れる（手で直したらそれ以降は上書きしない）
- 画像は 3 枠（立ち位置 / 照準 / 着弾）。**Ctrl+V で選択中の枠に貼り付け**、ドロップ、クリックでファイル選択。入れると次の空き枠へ進む
- 画像はブラウザで WebP・長辺 1280px に圧縮（だいたい 100〜200KB）

## ファイル構成

| ファイル | 役割 |
|---|---|
| `js/config.js` | Firebase の設定値 |
| `js/firebase.js` | Firebase の初期化 |
| `js/auth.js` | ログイン（Google / ゲスト）、ゲスト → Google の引き継ぎ（ouchi-share から流用） |
| `js/store.js` | Firestore の読み書き |
| `js/valo.js` | マップ・エージェント・アビリティのマスタ（valorant-api.com）、座標変換 |
| `js/mapview.js` | ミニマップ表示（拡大・移動・マーカー・軌道線） |
| `js/images.js` | 画像の圧縮（WebP・長辺 1280px） |
| `js/ui.js` | 画面部品（ヘッダー、ボトムシート、トーストなど。ouchi-share から流用） |
| `js/app.js` | 各画面とルーター |
| `firestore.rules` | セキュリティルール（`firebase deploy --only firestore:rules` で反映） |

## データ構造

```
groups/{groupId}
  ├─ name, createdAt, createdBy
  ├─ inviteCode             招待リンクに含める合言葉。作り直すと古いリンクは無効
  ├─ memberIds: [uid, ...]
  ├─ members: { uid: { name, role, guest, joinedAt } }   role = owner / member
  ├─ lineups/{lineupId}
  │    ├─ map                    マップの ID（英語名を小文字にしたもの。例 "ascent"）
  │    ├─ side                   atk / def
  │    ├─ agent                  エージェントの ID（例 "sova"、"kayo"）
  │    ├─ ability                Grenade(C) / Ability1(Q) / Ability2(E) / Ultimate(X)
  │    ├─ site                   A / B / C / mid / null
  │    ├─ from: {x, y}, to: {x, y}   立ち位置・着弾点（ミニマップ上の 0〜1）
  │    ├─ title, notes
  │    ├─ throwType              normal / jump / run / crouch / runjump / alt / other
  │    ├─ importance             essential / useful / niche
  │    ├─ videoUrl               https のリンク（任意）
  │    ├─ imageIds: [立ち位置, 照準, 着弾]   空き枠は null
  │    ├─ createdBy, createdByName, createdAt
  │    └─ updatedBy, updatedByName, updatedAt
  └─ images/{imageId}       { createdBy, data（data URL）, w, h, createdAt }
prefs/{uid}                 { favorites: ["groupId/lineupId"], shortcuts: [{ groupId, mapId, side, agentId }] }
```

- マップを開くと、そのグループ・そのマップの定点を 1 つのクエリで取る（1 件 1KB 未満と小さい）
- 画像は詳細を開いたときだけ読む
- 定点を消すと画像も消える。グループを消すと、中の定点・画像もまとめて消す（Firestore はサブコレクションを自動では消さないため、アプリ側で消してからグループを消す）

## 権限

| 操作 | 誰ができるか |
|---|---|
| グループ作成 | Google ログインの人（ゲストは不可。ゲストは端末を替えると戻れず、オーナー不在になるため） |
| グループへの参加 | 正しい招待コードを持っている人（ゲスト / Google） |
| 定点・画像を見る・登録・編集・削除 | グループのメンバー全員 |
| グループ名の変更 | グループのメンバー |
| 招待リンクの作り直し・グループ削除 | グループのオーナー |
| グループからの脱退 | オーナー以外のメンバー |

- 以前はグループを作れる人を `admins/{uid}` の許可リストで絞っていたが、やめた（`admins` コレクションは残っていても使われない）
  - 無料枠を他人に使われるリスクはあるが、URL を知っているのは仲間だけ、かつ超えても課金されず止まるだけなので許容

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

## 初期設定（Firebase）

Firebase プロジェクト：`valo-lineups-fly`（`valo-lineups` は他の人が使用済みだった）。
Firebase CLI（`npm install -g firebase-tools` → `firebase login`）で作成した。

1. `firebase projects:create valo-lineups-fly` でプロジェクトを作る（ouchi-share とは別）
2. `firebase apps:create web` → `firebase apps:sdkconfig` の値を `js/config.js` に入れる
3. `firebase deploy --only firestore:rules`
   - Firestore API の有効化と、データベース（`asia-northeast1`）の作成も自動で行われる
   - ルールを直したときも、このコマンドで反映する（`firebase.json` / `.firebaserc` に設定済み）
4. **コンソールで**：Authentication →「始める」→ ログイン方法で **Google** と **匿名** を有効にする
5. **コンソールで**：Authentication → 設定 → 承認済みドメイン に `flyaway2525.github.io` を追加
6. アプリで Google ログイン →「＋ グループを作成」→ ⋯ →「メンバー・招待」から招待リンクを仲間に送る

## 今後の候補

- 定点ごとの閲覧数・「使えた」ボタン
- 文字検索（タイトル・メモ・コールアウト）
- マップの向きを攻守で回転
- ゲストの復旧 ID（ouchi-share の方式）
- 画像を Cloudflare R2 へ移す（容量が足りなくなったら）

## 注意点

- iPhone のホーム画面から起動した PWA では、Google ログインのポップアップがうまく動かない場合がある。その場合は Safari で開いてログインする
- ゲストのままログアウトしたり Safari のデータを消したりすると、同じゲストには戻れない（招待リンクから新しいゲストとして再参加は可能）。PC とスマホで使うなら Google ログインにする
- Riot Games の「Legal Jibber Jabber」に沿った非営利のファンツールとして使う。strats.gg など他サイトの定点・画像は転載しない
