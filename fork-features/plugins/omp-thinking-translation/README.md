# OMP thinking translation

A local Paseo plugin for the operator's Mac. It replaces the presentation of reasoning rows without changing daemon history or OMP session files. Completed OMP thinking is shown in the configured translation language (currently Simplified Chinese), with an expandable body and a **查看原文 / 查看中文翻译** toggle. Streaming and non-OMP thinking remain original text.

The client resolves the provider from the connected host's agent snapshot. It sends completed original text only to its own plugin RPC. The server sends that text to the configured translator model; credentials never enter the client bundle or plugin source.

## Install on the existing Mac daemon

The daemon's `pluginsEnabled` setting must be true. Apply that setting with config reload, not a daemon restart. Install dependencies inside this directory, then install the absolute directory source:

```sh
npm install --prefix /Users/mouriya/Ext/code/paseo/fork-features/plugins/omp-thinking-translation --ignore-scripts --workspaces=false
npm run cli -- plugin install /Users/mouriya/Ext/code/paseo/fork-features/plugins/omp-thinking-translation --host 127.0.0.1:6767 --json
npm run cli -- plugin ls --host 127.0.0.1:6767 --json
npm run cli -- plugin logs omp-thinking-translation --host 127.0.0.1:6767 --json
```

If the source is already configured, use `plugin reload omp-thinking-translation` rather than install again. The transformer, renderer, host-agent SDK and typed RPC APIs used here were exercised on daemon versions 0.9.1 and 0.11.0-beta.3 with the hosted 0.10.3 frontend. The manifest declares `requirements.paseo >=0.9.1`. The package-subpath hash import is intentional: the client compiler uses esbuild's neutral platform, which does not resolve packages using only a `main` field.

## Configuration and cache lifetime

The server reads the existing OMP global files from `PI_CODING_AGENT_DIR`, or `~/.omp/agent`:

- `thinking-translator.json`: enabled, targetLanguage, translatorModel provider/id.
- `models.yml`: selected provider's OpenAI-completions API, baseUrl, apiKey and optional headers.

Literal/environment values and `!command` credential values are resolved on the server. This implementation targets the Mac's configured OpenAI-compatible translator provider; it does not introduce another model, credential store or fallback provider. It does not load project-level translator overrides.

The strict prompt, output cleanup and token limit match `omp-thinking-translator` 0.7.0. Unlike the TUI's per-visible-line streaming renderer, this plugin translates each completed Paseo reasoning row as one request, including history rows. Paseo may merge several OMP thinking blocks into one row before this plugin sees it.

The server's memory cache includes SHA-256 of source text, model selection, language and endpoint, and shares in-flight requests. Failed requests are not retained in the server cache. The installation-owned client query cache is keyed by host and source SHA-256, with one request per completed text while the installation remains loaded. Reload the plugin after changing translator configuration to invalidate the client cache. Reload/unload aborts server translation requests and clears server memory; no translations are persisted.

Translation errors display a diagnostic plus the original, never blank thinking. All reasoning rows use this plugin's collapsed presentation; only the provider identified as `omp` gets translation or an original/translation toggle. No network retries or model fallbacks are added.

## View and verify

Use the configured allowed web origin `https://app.paseo.sh` and connect to the Mac daemon; this does not require the daemon to serve a web app at `/`. Open an OMP agent, expand **思考翻译 · 简体中文**, and toggle **查看原文**. Check a Codex reasoning row remains **thinking** with its original body and no translation toggle. Browser local-network access must be permitted for the loopback connection. This is a browser permission, not an application/daemon configuration change.
