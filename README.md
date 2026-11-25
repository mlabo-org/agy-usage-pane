# Usage Monitor (`agy-usage-pane`)

Google Antigravity 向けのサイドペイン / サイドバー用 Usage Monitor プラグイン（MCP App）です。

## 主な機能

- **クォータ残量表示（5h / 週次）**: 公式 `agy` CLI（`agy --print /usage --output-format json`）を単発実行して、モデルグループ別の残量バーとリセットまでのカウントダウンを表示します。
  - 定期ポーリングは行いません。パネルを開いたとき（前回取得から2分以上経過時）と「クォータ更新」ボタン押下時のみ取得します（10秒の連続更新クールダウン付き）。
- **ローカル使用量・キャッシュ集計（オフライン）**: `~/.gemini/antigravity/brain` と `~/.gemini/antigravity-cli/brain` の `transcript.jsonl` をローカルで読み取り、通信なしで10秒ごとに以下を集計・表示します。
  - 最新セッションのコンテキストサイズ推定とモデル名
  - 直近60分 / 最新セッションのキャッシュヒット率・トークン内訳・モデル別内訳
  - `/compact` 送信ボタン（ホストがメッセージ送信機能を提供しているサイドペイン上のみ表示）

## 動作要件

- Google Antigravity（MCP Apps / `aux_pane`・`global` エントリポイント対応版）
- Node.js 20 以上（`PATH` 上で `node` が実行できること）
- `agy` CLI（クォータ残量取得に使用。`ANTIGRAVITY_CLI_PATH` 環境変数、`~/.local/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy`、`PATH` の順で探索します）

## インストール

バンドル済みの `dist/server.mjs` と `ui/dist/app.html` を同梱しているため、`npm install` なしでそのまま動きます。

```bash
git clone <repository-url> ~/.gemini/config/plugins/agy-usage-pane
```

別の場所へクローンして symlink で配置しても動作します。

```bash
git clone <repository-url> ~/plugins/agy-usage-pane
ln -s ~/plugins/agy-usage-pane ~/.gemini/config/plugins/agy-usage-pane
```

配置後、Antigravity の右サイドペインの `+` メニューまたは左サイドバーに **Usage** が表示されます。

## 開発・ビルド

ソース（`server/` や `ui/`）を変更した場合は再ビルドします。

```bash
npm install
npm run build
```

- `npm run build:ui`: `ui/app.ts` と `ui/index.html` から単一 HTML `ui/dist/app.html` を生成
- `npm run build:server`: `server/index.mjs` 一式を単一 ESM バンドル `dist/server.mjs` に生成

## 既知の制限・注意点

- Antigravity のローカルログ（`transcript.jsonl` の `PLANNER_RESPONSE` 行）および `agy --print /usage --output-format json` の出力スキーマに依存しているため、Antigravity 本体の仕様変更により動作しなくなる場合があります。
- コンテキスト使用率は 1,000,000 トークンを基準に算出しています（200k 上限のモデルなどでは割合が低く表示されます）。
- UI 文言および日時表示は現在日本語（`ja-JP`）固定です。
- セッションログ内に `cwd=<path>` 行が記録されている環境では、そのディレクトリの Git ブランチ・変更件数も表示します（記録がない環境では非表示になります）。
- 外部へのテレメトリ送信や非公開エンドポイントへのアクセスは行いません。クォータキャッシュはプラグインデータ領域（`${PLUGIN_DATA}/quota-cache.json`）にのみ保存されます。

## License

MIT
