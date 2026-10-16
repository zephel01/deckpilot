# Deckpilot 導入手順 v1（Stream Deck + / Neo × Claude Code・Codex・ローカルLLM）

作成日: 2026-10-16 ／ 対象: macOS 12 以降、Stream Deck アプリ 7.6 以降、Node.js 22.18 以降

## 全体の構成

```
Claude Code ──(hooks: command)──▶ agent-meter-hook.js ──▶ agent-meter（127.0.0.1:47823）◀── Stream Deck プラグイン（1秒ごとに取得）
~/.claude/projects/*.jsonl ─┐                               ▲
~/.codex/sessions/*.jsonl ──┼── ファイルを差分で読み込み ────┘
llama-server /metrics ──────┘  （外部への通信なし）
```

## 1. デーモンのインストール

```bash
cd deckpilot
bash scripts/install-macos.sh      # ~/.agent-meter に配置し、LaunchAgent として常駐させる
cat ~/.agent-meter/agent-meter.log # 「listening on 127.0.0.1:47823」と出ていれば起動している
```

- 設定を変える場合は `agent-meter/config.example.json` を `~/.agent-meter/config.json` にコピーして編集する。
  - `permissionWaitSec`: Stream Deck での応答を待つ秒数（既定 30）。時間を過ぎると通常の確認ダイアログに戻る。
  - `claudeBlockTokenLimit`: Claude の 5時間枠の上限として扱うトークン数。設定しない場合、% は「過去で最大のブロック」に対する比率になり、`~` 付きで表示される。
  - `local`: ローカルLLM の取得先。ループバックアドレス（127.0.0.1 / localhost）以外の URL は無視される。llama-server は `--metrics` を付けて起動しておく。

## 2. Claude Code の hooks 設定

`hooks/claude-settings.hooks.json` の `hooks` の中身を、`~/.claude/settings.json` の `hooks` にマージする。既存の hooks は消さず、イベントごとに配列へ追加する。

- `PermissionRequest` だけは同期実行（timeout 45秒）。それ以外は `async: true` なので、Claude Code の動作を遅くしない。
- デーモンが止まっている場合、hook は何も出力せずに終了する。その場合は通常の確認ダイアログが出るだけで、作業は止まらない。

## 3. プラグインのインストール

`plugin/dist/com.deckpilot.streamDeckPlugin` をダブルクリックする。Stream Deck アプリの右側に「Deckpilot」カテゴリが追加される。

- **Send Keys** と **Dial Keys** を初めて使うとき、macOS の「システム設定 → プライバシーとセキュリティ → アクセシビリティ」で Stream Deck に許可を与える必要がある。
- 開発中にソースから入れる場合:
  ```bash
  cd plugin && npm install && npm run build
  npx streamdeck link com.deckpilot.sdPlugin
  ```

## 4. 推奨レイアウト

### Stream Deck +（キー8個＋ダイヤル4個）

| 位置 | アクション | 設定 |
|---|---|---|
| キー1 | Permission | Allow |
| キー2 | Permission | Deny |
| キー3 | Permission | Always |
| キー4 | Session Status | Focus app: 使っているターミナル（Terminal / iTerm / Ghostty / ptygrid など） |
| キー5 | Send Keys | `{esc}`（中断） |
| キー6 | Send Keys | `{esc}{esc}`（直前のターンに戻る） |
| キー7 | Send Keys | `/compact{enter}` |
| キー8 | Send Keys | `/clear{enter}`、または音声入力に割り当てたショートカット |
| ダイヤル1 | Dial Keys | 左右: `{shift+tab}`（権限モードの切り替え）、押す: `{esc}` |
| ダイヤル2 | Dial Keys | 左: `{up}`、右: `{down}`、押す: `{enter}`（履歴や選択肢の移動） |
| ダイヤル3 | Usage Meter | 回すと表示を切り替え（Claude 5h → 今日 → 7日 → Codex 5h → Codex 週 → Codex 今日 → ローカル）。押すと即時更新 |
| ダイヤル4 | Usage Meter | 例: Codex 5h またはローカルLLM |

### Stream Deck Neo（キー8個＋Infobar）

- キー: Allow / Deny / Session / Esc / `/compact` / Usage（Claude 5h）/ Usage（Codex 5h）/ Usage（ローカル）
- Infobar: Usage Meter をドラッグして配置する（表示専用。Claude 5h を推奨）

### Claude アプリ・Cowork 向け

Send Keys の Target app に `Claude` を指定し、よく使うプロンプトを登録する。日本語の文章はクリップボード経由で貼り付けるので、送ったあとにクリップボードの中身が置き換わる点に注意。

## 5. 検証結果（クラウド環境の Linux で確認。Stream Deck 実機での確認はまだ）

| 項目 | 結果 |
|---|---|
| agent-meter のユニットテストと HTTP 結合テスト | 20件すべて成功、`tsc --noEmit` も成功 |
| E2E: hook CLI → Deny → hook の出力 | `{"hookSpecificOutput":{…"behavior":"deny"…}}` が返り、exit 0 |
| E2E: 応答がなくタイムアウトしたとき | 3.1 秒後に何も出力せず終了（通常のダイアログに戻る） |
| E2E: デーモン停止中 | 何も出力せず exit 0 |
| トークンファイルの権限 | 0600 |
| 認証なし／外部 Host ヘッダー | 401 ／ 421 で拒否 |
| ループバック以外のローカルLLM URL | 設定から除外されることを確認 |
| プラグインのユニットテスト | 8件すべて成功（AppleScript インジェクション対策、SVG のエスケープを含む） |
| `streamdeck validate` | Validation successful |
| レイアウト JSON（ダイヤル用・Neo用）のスキーマ検証 | 2件とも VALID |
| 偽の Stream Deck（WebSocket）でプラグインを起動 | キー・ダイヤル・Neo Infobar・Permission・Session のすべてで描画命令が出ることを確認。保留中の承認がキーに表示され、ダイヤルを回すと表示が切り替わった |
| `streamdeck pack` | `.streamDeckPlugin` を生成できた |

## 6. 実機で最初に確認してほしいこと

1. **承認待ちの間、ターミナルの確認ダイアログは出るか**（自信度: LOW）
   hook が応答を待っている間はダイアログが出ない想定で作っている。30秒以内に Stream Deck で答えるか、時間切れでダイアログが出るのを待つ形になる。待ち時間が長すぎると感じたら `permissionWaitSec` を 10〜15 程度に下げる。
2. **Always で許可ルールが保存されるか**（自信度: MODERATE）
   Claude Code が提案する `permission_suggestions` をそのまま返している。保存されなかった場合は、`.claude/settings.local.json` の内容を確認する。
3. **Codex の rate_limits が表示されるか**（自信度: MODERATE）
   Codex CLI のバージョンによってログの書式が違う可能性がある。「no data」と出る場合は、最新の `~/.codex/sessions/.../rollout-*.jsonl` に `token_count` イベントがあるかを確認する。
4. **ダイヤル用レイアウトの見た目**
   文字サイズや配置は実機を見て調整する（`plugin/com.deckpilot.sdPlugin/layouts/`）。

## 7. セキュリティ上の性質

- 通信先は 127.0.0.1 のみ。Claude の OAuth トークンや API キーは読まない。
- デーモンは共有トークン（`X-Agent-Meter-Token`）と Host ヘッダーで照合する。ブラウザ経由の CSRF や DNS リバインディングでの勝手な承認はできない。
- Send Keys は AppleScript の文字列をエスケープしたうえで `execFile` で実行する（シェルを経由しない）。
