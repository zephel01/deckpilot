# Stream Deck（+ / Neo）× Claude Code・Codex・ローカルLLM 調査メモ v1

作成日: 2026-10-16 ／ 対象: Stream Deck +（主）・Stream Deck Neo（副）、macOS

## 結論

- 構成は **自作プラグイン（SDK v3）＋ローカル集計デーモン（agent-meter）** とする。（自信度: HIGH）
- 使用量はすべて **ローカルファイル／localhost のみ** から取得する。Claude の OAuth トークンは読まない。（自信度: HIGH）
- 権限確認への Allow/Deny は Claude Code の `PermissionRequest` hook で実現できる。ただし `Always` の書式は実機での確認が必要。（自信度: MODERATE）

## 1. Stream Deck SDK

| 項目 | 内容 | 自信度 |
|---|---|---|
| SDK | `@elgato/streamdeck` 3.0.2 ／ `@elgato/cli` 1.10.2（2026-10-16 時点で npm 確認済み） | HIGH |
| コントローラ種別 | マニフェストの `Controllers` に `Keypad` / `Encoder` / `Neo` を指定。`Neo` は Stream Deck 7.6 以降 | HIGH |
| + のタッチストリップ | ダイヤル1つにつき 200×100px のレイアウト。ストリップ全幅には描けない | HIGH |
| Neo Infobar | 232×50px。表示専用で入力イベントなし。`setTitle` は使えない。マニフェストでレイアウトを宣言できないため、`willAppear` で `setFeedbackLayout()` を呼ぶ | HIGH |
| 型の絞り込み | v3 では Action が key / dial / infobar のユニオン型になる。`isKey()` / `isDial()` / `isNeoInfobar()` で絞り込む | HIGH |
| 最低バージョン | Neo に対応させる場合は `Software.MinimumVersion` を "7.6" にする（下げると CLI が拒否する） | HIGH |

## 2. Claude Code hooks

- hook の種類は `command` / `http` / `mcp_tool` / `prompt` / `agent`。既定のタイムアウトは command と http が 600 秒。
- `PermissionRequest` の応答形式:
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny", ...}}}`
  - 終了コード 2 では拒否できない。拒否する場合は必ず JSON で返す。
  - 何も出力せずに終了すると、通常の確認ダイアログに戻る。デーモンが落ちていても安全側に倒れる。
- 「常に許可」は、入力に含まれる `permission_suggestions` をそのまま `decision.updatedPermissions` に入れて返す方式にする。既製品（Agent Vitals）も同じ方式。ただし UI 側の候補と食い違う不具合報告がある。（自信度: MODERATE）
- 状態を把握するための hook: `UserPromptSubmit` / `PreToolUse`（作業中）、`Stop`（待機）、`Notification`（`permission_prompt` / `idle_prompt`）、`SessionEnd`（終了）。
- hook はターミナルなし・Claude Code と同じ環境変数で実行される。http hook のヘッダーに環境変数を展開するには `allowedEnvVars` が必要になる。デスクトップアプリから起動したセッションでは環境変数が渡らない可能性があるため、**トークンファイルを読む command hook（node スクリプト）を採用**する。

### 未確認・要注意点（実機で確認する）

1. hook が Stream Deck の応答を待っている間、ターミナルの確認ダイアログが出るかどうか。出ない前提で、待ち時間（既定 30 秒）を過ぎたら通常のダイアログに戻す設計にした。（自信度: LOW）
2. `updatedPermissions` に `permission_suggestions` をそのまま渡したとき、ルールが保存されるかどうか。（自信度: MODERATE）

## 3. 使用量データの取得元

| 対象 | 取得元 | 取れる値 | 自信度 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` の `type:"assistant"` 行にある `message.usage` | トークン数（入力／出力／キャッシュ書き込み／キャッシュ読み込み）。`message.id`＋`requestId` で重複を除く | HIGH |
| Claude の 5時間枠 | 上記ログから 5時間ブロックを推定（ccusage と同じ方式） | ブロック内のトークン数、リセット時刻、消費ペース。% は「設定した上限値」または「過去の最大ブロック」に対する推定値 | MODERATE |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` の `event_msg` / `token_count` | `info.total_token_usage` はセッションごとの累計値（差分を取って集計）。`rate_limits.primary`（5時間）と `rate_limits.secondary`（週）の `used_percent` | MODERATE |
| llama-server | `--metrics` を付けて起動し、`/metrics`（Prometheus 形式）を読む | `llamacpp:predicted_tokens_seconds`、`requests_processing`、`tokens_predicted_total`、`prompt_tokens_total` | HIGH |
| Ollama | `GET /api/ps` | ロード中のモデル | HIGH |
| Claude アプリ／Cowork | ローカルにトークンのログがない | 起動キーのみ。使用量を見るには非公式の OAuth API が必要なため見送り | MODERATE |

- Codex の `rate_limits` は、新しいバージョンでは `resets_at`（UNIX 秒）の場合と、`resets_in_seconds` の場合がある。両方に対応する。

## 4. 既製品との比較

| 製品 | 方式 | 採用しない理由 |
|---|---|---|
| Agent Vitals / Claude Deck / Claude Usage 系 | Claude Code の OAuth トークンを読み取り、非公式の `/api/oauth/usage` を呼ぶ | 認証情報を第三者のコードに渡すことになる。API が非公式で壊れやすい |
| Claude Code Shortcut Profile（Marketplace） | キー送信のみ | キー割り当ての参考にする |
| Claude Code Usage（Marketplace） | Windows 専用 | Mac では使えない |

## 5. セキュリティ設計

- デーモンは `127.0.0.1` のみで待ち受け、`Host` ヘッダーを検証する（DNS リバインディング対策）。
- 共有トークンは `~/.agent-meter/token`（パーミッション 0600）に置き、`X-Agent-Meter-Token` ヘッダーで照合する。ブラウザからの CSRF やローカルの他プロセスからの勝手な承認を防ぐ。
- 外部への通信はしない。ローカルLLM の URL もループバックアドレスのみ許可する。

## 出典

- Elgato SDK: Actions / Manifest / Neo Infobar / Layouts / v3 Upgrading（docs.elgato.com）
- Elgato: Stream Deck 7.6 Infobar Actions for Stream Deck Neo
- Claude Code Hooks reference（code.claude.com/docs/en/hooks）
- Codex の rollout 形式: xiangz19/codex-ratelimit、agent-top-core（docs.rs）、tokr（docs.rs）
- llama.cpp server metrics: simplified.guide、ggml-org/llama.cpp PR #17386
- 既製品: Agent Vitals / Claude Deck（notes.nicolasdeville.com）、saeedkolivand/claude-usage-streamdeck-plugin PR #14
