# aria-burn

Laser Sim desktop app: a Tauri 2 app with a Rust shell (GRBL planner port, TCP emulator) and a Svelte 5 web UI.

The simulation core lives in the sibling repo [aria-burn-core](../aria-burn-core) (MIT). The app consumes it via `"aria-burn-core": "link:../aria-burn-core"`, so check both repos out side by side.

## Layout

- `src/` — webview front end (Svelte 5 + TypeScript, three.js for the Height view)
  - `lib/ipc.ts` — typed wrappers over the Rust commands and Channels
  - `lib/stream-check.ts` — decodes sample batches with the core's decoder and checks them against `plan.done`
  - `lib/settings.ts` — persisted machine profile and UI preferences (`tauri-plugin-store`)
- `src-tauri/` — the Rust shell
  - `stream.rs` — dummy sample stream (stands in for the planner until COD-255)
  - `smoke.rs` — in-app IPC throughput smoke test
- `crates/aria-burn-contract/` — Rust contract types, **generated** at build time from the core's `contract.schema.json` (typify) and `sample-batch-layout.json` (binary codec). Never write these by hand. `tests/fixtures.rs` round-trips every fixture in the core's `src/contract/fixtures/`.
- `docs/design/` — design documents (COD-250)
- `aria-burn.code-workspace` — opens this repo and `../aria-burn-core` in one editor window

## Development

Toolchain: Node 26 (`.nvmrc`), pnpm 9.15.9 (`packageManager`; Node 26 has no corepack, so `npm i -g pnpm@9.15.9`), Rust stable.

```sh
pnpm install            # also run it once in ../aria-burn-core
pnpm tauri dev          # the app, with hot reload
pnpm check              # svelte-check, vitest, vite build, cargo test
```

The contract crate reads the schema from `../aria-burn-core`; set `ARIA_BURN_CORE_DIR` to use another checkout.

### IPC

Rust talks to the webview over Tauri Channels, never one message per G-code line (COD-252). Sample batches travel as raw binary buffers in the core's sample-batch layout, and contract events (`ChannelEvent`) travel as JSON on a second channel.

The smoke test streams full batches (256 × 16384 samples, about 117 MB) through the real webview and checks every batch against `plan.done`. CI runs it on macOS (WKWebView) and Windows (WebView2):

```sh
pnpm tauri build --debug --no-bundle
pnpm smoke              # optional batch count: pnpm smoke 1024
```

## License

GPLv3 — see [LICENSE](LICENSE). Code may flow in from the MIT core, never the other way.
