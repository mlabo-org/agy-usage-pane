# agy-usage-pane Local Contract

このファイルは `~/plugins/agy-usage-pane` 配下におけるホストエージェント（Antigravity、Claude Code、Codex）の局所 `AGENTS.md` であり、本プラグイン固有の配置・ビルド・検証条件を定義する SSOT である。
共通規則は親の `~/plugins/AGENTS.md` および作業中ホストの上位規約に従う。

## Scope & Ownership

- 本リポジトリは Antigravity 専用プラグイン（MCP App）の正本である。`.claude-plugin/` や `.codex-plugin/` は置かない。
- Antigravity からは `~/.gemini/config/plugins/agy-usage-pane` の symlink 経由で直接読み込まれる。
- クォータキャッシュなどのランタイム出力は `${PLUGIN_DATA}`（既定 `~/.gemini/config/plugin-data/agy-usage-pane`）に置き、本リポジトリ内へ混ぜない。

## Build & Distribution

- `dist/server.mjs` と `ui/dist/app.html` は、`git clone` のみ（`npm install` なし）で動作させるための追跡対象バンドル出力である。
- `server/` または `ui/` を編集した場合は、完了前に `npm run build` を実行し、`dist/server.mjs` と `ui/dist/app.html` を最新化する。
- `mcp_config.json` に端末固有の絶対パスを書かない（`"command": "node"` と `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` を使用する）。

## Verification

- ビルド後、バンドル済み `dist/server.mjs` を直接起動し、MCP `initialize`・`tools/list`・`resources/read`（`ui://agy-usage-pane/app.html`）がエラーなく応答することを確認する。
- 公開前チェックとして、個人情報・端末固有パス・秘密情報が追跡対象ファイルに含まれないことを確認する。
