# OMP thinking translation

A local Paseo plugin for the operator's Mac. It replaces the presentation of completed reasoning rows without changing daemon history or OMP session files. Completed OMP thinking is shown in the configured translation language (currently Simplified Chinese), with an expandable body and a **查看原文 / 查看中文翻译** toggle. Streaming reasoning stays in Paseo's native renderer, including its automatic expansion setting. Non-OMP thinking remains original text.

The client resolves the provider from the connected host's agent snapshot. It sends completed original text only to its own plugin RPC. The server sends that text through the configured translator model chain; credentials never enter the client bundle or plugin source.

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

- `thinking-translator.json`: enabled, targetLanguage, and ordered `translatorModels: [{ provider, id, effort? }]` (the OMP extension's current format). The old `translatorModel` key is ignored. An empty chain or invalid entry produces a visible configuration error.
- `models.yml`: each provider's OpenAI-completions API, baseUrl, apiKey and optional headers. Command Code's completion API and `https://api.commandcode.ai/provider/v1` endpoint default to OMP's route when omitted.

Literal/environment values and `!command` credential values are resolved on the server. This implementation targets the Mac's configured OpenAI-compatible translator providers. It does not load project-level translator overrides or OMP's full model registry. `effort` is sent as `reasoning_effort`; `off` sends `none`, and unset/null uses the endpoint default.

Every translation starts at the first configured model. HTTP errors, invalid/empty responses, source-marker echoes and the per-attempt 60-second deadline advance to the next model. Exhausting the chain exposes each model's diagnostic. No model success or failure changes the order of later requests.

Unlike the TUI's per-visible-line streaming renderer, this plugin translates each completed Paseo reasoning row, including history rows. Paseo may merge several OMP thinking blocks into one row before this plugin sees it. The strict prompt, output cleanup and token limit follow the OMP extension. Pending work returns immediately and is polled once per second, since a model chain can outlast Paseo's 30-second plugin RPC deadline.

The server's memory cache includes SHA-256 of source text, the whole ordered model chain with efforts, language and provider configuration. Polls and concurrent readers share one job. Failed requests leave the cache when their error is read. The installation-owned client query cache is keyed by host and source SHA-256. Reload the plugin after changing translator configuration to invalidate the client cache. Reload/unload aborts server translation requests and clears server memory; no translations are persisted.

Translation errors display a diagnostic, the original and **重试翻译**. Retrying starts a fresh chain without reloading the plugin. Completed reasoning rows use this plugin's collapsed presentation; only the provider identified as `omp` gets translation or an original/translation toggle.

## View and verify

Use the production origin `https://paseo.237575.xyz`, complete SSO, and select the Mac host. Verify live OMP thinking through the native thinking row, then expand the completed **思考翻译 · 简体中文** row and toggle **查看原文**. Check a Codex reasoning row remains **thinking** with its original body and no translation toggle. Repeat after reloading the plugin with the page already open. The upstream hosted app is a separate frontend and does not verify the production deployment.

Codex needs provider-exposed summaries before this renderer can display thinking. On the Mac's Codex 0.162.1 / `gpt-6.1-sol`, the production configuration uses `model_reasoning_summary = "detailed"` and `[features] concurrent_reasoning_summaries = true`. The latter is a Codex development feature. Verify a sustained turn: a short turn can finish without emitting a summary. Refresh each idle Codex agent after changing these settings so its app-server reloads them; never restart the main Paseo daemon for this. Encrypted history with an empty summary cannot be reconstructed by the plugin.

Mobile layout verification uses the same production origin at 390 × 844. Check both the live Thinking sheet and the completed expandable row, then reload the page and verify the saved summary remains available. Browser emulation does not establish physical iOS or Android PWA behavior.

Run the plugin's client/server typechecks with `npm run typecheck --prefix fork-features/plugins/omp-thinking-translation`. Regression tests use the repository's Vitest runner: `npx vitest run fork-features/plugins/omp-thinking-translation/server/translator.test.ts --bail=1`.
