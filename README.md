# deckpilot

Stream Deck + / Neo control surface for Claude Code, Codex and local LLMs.

- `agent-meter/` — local-only daemon (127.0.0.1): Claude Code hook receiver (status + permission answers), usage collectors for Claude Code / Codex transcripts and llama-server / Ollama.
- `plugin/` — Stream Deck plugin (SDK v3): Permission keys, Session status, Usage meter (key / dial strip / Neo infobar), Send Keys, Dial Keys.
- `hooks/claude-settings.hooks.json` — hooks to merge into `~/.claude/settings.json`.
- `scripts/install-macos.sh` — installs the daemon as a LaunchAgent.

```bash
cd agent-meter && npm install && npm test && npm run typecheck
cd ../plugin && npm install && npm test && npm run typecheck && npm run build && npm run validate
```

No network access beyond loopback; Claude OAuth credentials are never read.

Docs (Japanese): [setup](docs/setup.ja.md) / [research notes](docs/research.ja.md)
