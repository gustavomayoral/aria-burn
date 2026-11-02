# aria-burn

Laser Sim desktop app: a Tauri app with a Rust shell (GRBL planner port, TCP emulator) and a web UI.

The simulation core lives in the sibling repo [aria-burn-core](../aria-burn-core) (MIT). During development the app consumes it via `"aria-burn-core": "link:../aria-burn-core"`.

## Layout

- `docs/design/` — design documents (COD-250)
- `aria-burn.code-workspace` — opens this repo and `../aria-burn-core` in one editor window

## License

GPLv3 — see [LICENSE](LICENSE).
