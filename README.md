# valo-lineups

VALORANT の定点（ラインナップ）を登録・共有するツール（スマホ向け PWA）。

## できること

- マップ・攻守・エージェント・アビリティで絞り込んで、ミニマップ上に定点を表示
- 着弾点をタップすると立ち位置と軌道線、詳細（立ち位置・照準・着弾の画像、メモ、動画）を表示
- グループの仲間と定点を登録・共有（PC ではスクショを Ctrl+V で貼り付け）。グループには招待リンクで参加
- お気に入り、よく使う組み合わせのショートカット、URL で状態を共有

## 構成

- フロントエンド: 静的サイト（PWA、ビルド不要）を GitHub Pages で公開
- データ: Firebase（Firestore + Authentication）の無料プラン。画像も圧縮して Firestore に保存
- マップ・エージェントの情報: [valorant-api.com](https://valorant-api.com)（非公式）

## ローカルで動かす

```bash
python -m http.server 5174
```

ブラウザで http://localhost:5174/ を開く。

> データは本番の Firebase（プロジェクト `valo-lineups-fly`）に保存されます。
> Firebase の初期設定・設計メモは [docs/design.md](docs/design.md) を参照。

---

valo-lineups isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
