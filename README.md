# Free Vidz - Cloudflare Worker 動画アップローダー

アカウント登録なしで動画をアップロード → `https://<your-worker>/videos/aEMsI` のリンクを発行。
動画本体は **D1** に保存（D1 は 1行 2MB 制限なので 768KB ごとのチャンクに分割して保存）。

## 機能
- 動画アップロード（ドラッグ&ドロップ、進捗バー、サムネ自動生成、最大100MB）
- `/videos/xxxxx` のランダム5文字URL / Range対応ストリーミング（シーク可）
- 高評価 / 低評価（ブラウザごとの匿名IDで1人1票・取り消し可）
- シェア（リンクコピー、直リンク、X / Reddit / WhatsApp / Telegram、端末の共有シート）
- コメント（名前は任意）、再生数、検索、自分がアップした動画の削除
- OGP タグ付きなので Discord / X などでリンクプレビューが出る

## セットアップ
```bash
npm install
npx wrangler login
npx wrangler d1 create video-uploader
```
出力された `database_id` を `wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` に貼り付け。

```bash
npm run dev      # ローカル起動 (http://localhost:8787)。テーブルは初回アクセス時に自動作成
npm run deploy   # 本番デプロイ。テーブルは初回アクセス時に自動作成
```

## 仕様メモ
- 削除権限は「アップロードしたブラウザの localStorage に保存されたトークン」。ブラウザデータを消すと削除できなくなります。
- 最大サイズは `src/index.js` の `MAX_SIZE` で変更可能。D1 の容量上限（無料 5GB / 1DB 500MB、有料 10GB）に注意。
- 動画のチャンクは base64 で保存するため、実容量は約 1.33 倍になります。
- ブラウザで再生できる形式（MP4/H.264, WebM など）を推奨。
- 公開サービスにする場合は Cloudflare の Rate Limiting / Turnstile などで乱用対策を入れてください。
