# GRBL emulator: manual test procedure (COD-265)

Automated tests (`crates/aria-burn-grbl/tests/tcp.rs`) drive the emulator with scripted TCP senders. They cannot cover:
- the real senders, LightBurn and LaserGRBL;
- the real webviews, WKWebView on macOS and WebView2 on Windows;
- OS firewalls.

Run this procedure on **macOS and Windows** before releases that touch the emulator, the parser or the IPC path. Save the G-code from each run (LightBurn: *File → Save GCode*; LaserGRBL: *File → Save program*). These files are wanted as real-sender test files for the parser (COD-269).

Watch three places while testing:
- The top bar shows the connection state and machine state, plus the line and job while streaming.
- The info panel shows Machine (state, position, feed, line) and the live job (name, batches, samples, lines). When a job finishes it shows the duration and `plan.done ✓`.
- The timeline follows `job.progress` and shows the job length once it ends.

## 0. Setup
1. Start the app with `pnpm tauri dev`, or run a debug build.
2. Open Settings → Network emulator. Set **Listen for senders** on, Bind address **Localhost only**, Port **23**, Pacing **Real time**. Click **Save**.
3. The pill should read `Listening on 127.0.0.1:2323`. If your Settings still say port 23 (from an older build), change it to 2323 and Save: macOS and Linux deny ports below 1024 to normal users.
4. Switch the top bar to **Live (GRBL)**.

## 1. LightBurn: connect and handshake
1. In Devices, choose *Create Manually* → **GRBL** → **Ethernet/TCP**, address `127.0.0.1`, port `2323`. Set the origin to front-left, matching your real machine.
2. Connect. Expected:
   - the console shows `Grbl 1.1h ['$' for help]`;
   - LightBurn reports *Ready*;
   - the top bar says `Sender connected from 127.0.0.1:…`.
3. In the console, type `$I`, `$$`, `$G` and `?`. Expected:
   - `$I` returns `[VER:1.1h.20190825:Laser Sim]` and `[OPT:V,15,128]`;
   - `$$` lists the settings, with `$11`, `$30`, `$32` and `$110`–`$131` taken from the machine profile;
   - `?` returns `<Idle|MPos:…>`.

## 2. LightBurn: jobs (Real time pacing)
1. **Vector:** a 30 mm square and a 20 mm circle, Line mode, 1000 mm/min, 50 %. Start the job.
   - Progress advances at machine speed, and the preview builds live.
   - At the end, the info panel shows `plan.done ✓`.
   - The job duration matches LightBurn's estimate closely (the planner is GRBL's, COD-255). Write down both numbers.
2. **Raster:** a 20 × 20 mm image, 0.1 mm interval, 3000 mm/min. Run it twice, once with Grayscale and once with Dither. Same checks as the vector job. Bright areas burn less, and M4 rows fade at the row ends.
3. **Frame:** the head moves and the preview does **not** change or clear.
4. **Jog:** use the arrow buttons. LightBurn and the info panel both show the new position.

## 3. LightBurn: hold, resume, stop
1. Start the raster, then click **Pause**. The head slows to a stop along the path (`Hold:1`, then `Hold:0`) and the preview stops growing.
2. Click **Resume**. The job continues where it stopped.
3. Click **Stop** mid-job. Record exactly what LightBurn shows, including whether `ALARM:3` appears.
   - If an alarm appears, **Unlock** (`$X`) clears it.
   - The info panel shows the job error `job-reset`, and the preview keeps what burned before the stop.
4. Start a new job. The preview clears and the new job builds.

## 4. Pacing: Instant
1. In Settings, set Pacing to **Instant** and Save. The connection stays up.
2. Rerun the raster. LightBurn finishes almost at once, the preview is complete, and the timeline shows the full machine time.
3. Set Pacing back to **Real time**.

## 5. Disconnects
1. Start a long job, then click LightBurn's *Disconnect* or quit LightBurn mid-job.
   - The preview keeps everything sent so far.
   - The info panel shows `sender-disconnected`.
   - The top bar returns to `Listening on …`.
2. Reconnect. You get a fresh banner and the state is `Idle`, even if the machine was in alarm before.
3. While LightBurn is connected, try to connect LaserGRBL. The connection is refused, and LightBurn keeps working.

## 6. LaserGRBL (Windows)
1. *Grbl → Settings*: set the protocol to **Telnet** and the address to `127.0.0.1:2323`, then connect. The banner shows. LaserGRBL may send a soft reset (Ctrl-X) on connect, which is fine.
2. Repeat section 2 (one raster and one vector job) twice: once with streaming mode **Buffered** and once with **Synchronous**.
3. Use the feed and power **override** sliders during a job.
   - Feed changes apply at once: the head slows down or speeds up mid-move.
   - Power changes show in the preview. With M4, a lower feed override also lowers power (GRBL scales by programmed feed).
4. Try Pause/Resume and Abort, as in section 3.
5. Check the console for stray extra `ok`s. Those would mean CRLF line endings, which GRBL answers twice.
6. Open *Grbl Configuration*. It reads `$$`. Change `$11` and `$120` and write them.
   - Each write returns `ok`, and the app's Settings screen shows the new values (they are saved with the machine profile).
   - A negative value returns `error:4`.
   - Writes to other settings (`$100`, `$31`, …) are kept until the app quits and are not part of the profile.

## 7. Network and errors
1. Set Bind address to **All interfaces**, Save, and accept the OS firewall prompt. Connect LightBurn from another machine to `<this machine's LAN IP>:2323` and run a small job.
2. Set the port to one another program already uses, such as one bound by `nc -l 2323`. The pill shows the error, and the app keeps running.
3. Turn **Listen for senders** off and Save. The pill reads `Emulator off`, and LightBurn can't connect.

## 8. Windows-specific
- Run an Instant-pacing raster of at least 50 × 50 mm. WebView2 stays responsive, and the info panel shows `plan.done ✓`.
- With no sender connected, the app's idle CPU use stays negligible.

## Reporting
For each step, note pass/fail, the OS, the sender and its version, and any sender console output that looks wrong. Add the results to the issue, along with the saved G-code files for COD-269.

## Known limitations
- The work offset (WCO) is always 0.
- `$C`, `$SLP` and `$RST` give `error:3`.
- `$G` is approximate.
- `$12` (arc tolerance) applies from the next connect or reset.
- A stationary laser (M3 during a sync or G4 dwell) doesn't burn in the preview.
- The preview is a 60 × 50 mm window centred where the job starts burning. Larger jobs are clipped until COD-264's live tiling is wired in.
- A job streamed straight after M2, with no idle gap, merges into the previous job.
