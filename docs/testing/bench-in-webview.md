# Running the core bench in the app's webview

aria-burn-core's WebGL2 bench (`pnpm bench`) normally runs in a browser. Performance in Aria Burn depends on the app's own webview: WKWebView on macOS, WebView2 on Windows. Use this to run the bench there (BURN-33).

1. In aria-burn-core, serve the bench:

   ```sh
   pnpm bench
   ```

   It listens on port 5199. Run `npx vite bench --port <port> --strictPort` instead if another checkout already uses 5199.

2. In aria-burn, build the app once (`cargo build -p aria-burn`), then start it with the bench URL:

   ```sh
   ARIA_BURN_BENCH_URL='http://localhost:5199/?auto=live' target/debug/aria-burn
   ```

   On Windows (PowerShell):

   ```powershell
   $env:ARIA_BURN_BENCH_URL = 'http://localhost:5199/?auto=run,fine,thermal'; .\target\debug\aria-burn.exe
   ```

   The main window opens the bench page instead of the app. Only `http://localhost`, `127.0.0.1` and `[::1]` URLs are accepted.

3. `?auto=` starts the listed runs on load, one after another: `run` (full benchmark), `fine` (5 µm tiled job), `thermal` (thermal step) and `live` (live-job refresh). Each finished report is printed in the `pnpm bench` terminal between `----- bench report -----` and `----- end bench report -----`. Without `?auto=`, use the page's buttons.

Keep the window in the foreground while it runs: background pages are throttled and give inflated numbers. Save the reports under aria-burn-core's `docs/bench/`, named after the issue, platform and GPU (for example `burn-33-tauri-windows-irisxe.txt`).
