# aria-burn

Aria Burn desktop app: a Tauri 2 app with a Rust shell (GRBL planner port, TCP emulator) and a Svelte 5 web UI.

The simulation core lives in the sibling repo [aria-burn-core](../aria-burn-core) (MIT). The app consumes it via `"aria-burn-core": "link:../aria-burn-core"`, so check both repos out side by side.

## Layout

- `src/` — webview front end (Svelte 5 + TypeScript, three.js for the Height view)
  - `lib/ipc.ts` — typed wrappers over the Rust commands and Channels
  - `lib/stream-check.ts` — decodes sample batches with the core's decoder and checks them against `plan.done`
  - `lib/settings.ts` — persisted live machine profile, UI preferences and the machine library (`tauri-plugin-store`)
  - `lib/machines.ts`, `lib/machine-session.ts` — machine picker and user machine library (BURN-31): built-ins (Default and every catalog frame × module from aria-burn-core) are read-only, so editing one, or a sender's `$x=` write to one, saves a copy; same flow as Aria Studio's Preferences → Machines
  - `lib/machine-import.ts` — `$$` paste and LightBurn `.lbdev` import, each reporting what it applied, ignored and refused
- `src-tauri/` — the Rust shell
  - `emulator.rs` — starts/stops the GRBL emulator from the network settings and forwards its traffic to the webview Channels
  - `stream.rs` — dummy sample stream for the IPC smoke test
  - `smoke.rs` — in-app IPC throughput smoke test
- `crates/aria-burn-contract/` — Rust contract types, **generated** at build time from the core's `contract.schema.json` (typify) and `sample-batch-layout.json` (binary codec). Never write these by hand. `tests/fixtures.rs` round-trips every fixture in the core's `src/contract/fixtures/`.
- `crates/aria-burn-gcode/` — GRBL laser G-code parser (COD-263): file bytes or a live byte stream → the contract's `JobModel`, with per-line GRBL `error:N` codes for the emulator. `tests/corpus/` holds the parser corpus.
- `crates/aria-burn-grbl/` — GRBL 1.1 network emulator (COD-265): TCP server for LightBurn / LaserGRBL, line protocol with GRBL-sized RX and planner buffers, real-time commands, and `$` settings backed by the machine profile (COD-255). `planner.rs` is a port of GRBL 1.1h's planner and stepper velocity profiles (COD-255; GPL, per COD-261), which also samples the motion for the sim; `plan_job` plans a whole parsed job. `tests/tcp.rs` drives it with scripted TCP senders.
- `docs/design/` — design documents (COD-250)
- `docs/testing/` — manual test procedures (`grbl-emulator-manual.md`: LightBurn / LaserGRBL on macOS and Windows)
- `aria-burn.code-workspace` — opens this repo and `../aria-burn-core` in one editor window

## Development

Toolchain: Node 26 (`.nvmrc`), pnpm 9.15.9 (`packageManager`; Node 26 has no corepack, so `npm i -g pnpm@9.15.9`), Rust stable.

```sh
pnpm install            # also run it once in ../aria-burn-core
pnpm tauri dev          # the app, with hot reload
pnpm check              # svelte-check, vitest, vite build, cargo test
```

The contract crate reads the schema from `../aria-burn-core`; set `ARIA_BURN_CORE_DIR` to use another checkout.

### GRBL emulator

The app listens on `127.0.0.1:2323` by default (Settings → Network emulator: bind address, port, pacing; ports below 1024, such as GRBL's usual 23, need admin rights on macOS and Linux). In LightBurn, add a GRBL device with an Ethernet/TCP connection to that address; in LaserGRBL, use the Telnet protocol. **Real time** pacing answers `ok` as the emulated planner frees space, so the job takes as long as on the machine; **Instant** answers at once and the preview completes as fast as the sender streams.

### IPC

Rust talks to the webview over Tauri Channels, never one message per G-code line (COD-252). Sample batches travel as raw binary buffers in the core's sample-batch layout, and contract events (`ChannelEvent`) travel as JSON on a second channel.

The smoke test streams full batches (256 × 16384 samples, about 117 MB) through the real webview and checks every batch against `plan.done`. CI runs it on macOS (WKWebView) and Windows (WebView2):

```sh
pnpm tauri build --debug --no-bundle
pnpm smoke              # optional batch count: pnpm smoke 1024
```

## License

GPLv3 — see [LICENSE](LICENSE). Code may flow in from the MIT core, never the other way.
