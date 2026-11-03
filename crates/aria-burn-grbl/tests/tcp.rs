// SPDX-License-Identifier: GPL-3.0-or-later
//! Scripted TCP senders against a real emulator server on a loopback port:
//! handshake, both streaming styles, both pacings, real-time commands, errors
//! and disconnects, checked on the wire and on the webview side.

use std::{
    collections::VecDeque,
    io::{ErrorKind, Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use aria_burn_contract::{
    Event, JobModel, JobProgressEvent, MachineProfile, PlanDoneEvent,
    sample_batch::{MotionSample, SampleBatchHeader, decode_sample_batch},
};
use aria_burn_grbl::{
    ConnectionStatus, GrblSettings, MachineConfig, Pacing, Server, ServerConfig, Sink, UiMessage, planner::plan_job,
};

const TIMEOUT: Duration = Duration::from_secs(20);

fn profile() -> MachineProfile {
    let path =
        std::path::Path::new(aria_burn_contract::CONTRACT_DIR).join("../profiles/provisional/machine-10w-diode.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[derive(Default)]
struct Collect(Mutex<Vec<UiMessage>>);

impl Sink for Collect {
    fn send(&self, message: UiMessage) {
        self.0.lock().unwrap().push(message);
    }
}

impl Collect {
    fn events(&self) -> Vec<Event> {
        let all = self.0.lock().unwrap();
        all.iter().filter_map(|m| if let UiMessage::Event(e) = m { Some((**e).clone()) } else { None }).collect()
    }

    fn profiles(&self) -> Vec<MachineProfile> {
        let all = self.0.lock().unwrap();
        all.iter().filter_map(|m| if let UiMessage::Profile(p) = m { Some((**p).clone()) } else { None }).collect()
    }

    fn connections(&self) -> Vec<ConnectionStatus> {
        let all = self.0.lock().unwrap();
        all.iter().filter_map(|m| if let UiMessage::Connection(c) = m { Some(c.clone()) } else { None }).collect()
    }

    fn batches(&self) -> Vec<(SampleBatchHeader, Vec<MotionSample>)> {
        let all = self.0.lock().unwrap();
        all.iter()
            .filter_map(|m| if let UiMessage::Batch(b) = m { Some(decode_sample_batch(b).unwrap()) } else { None })
            .collect()
    }

    fn wait_for<T>(&self, what: &str, mut f: impl FnMut(&Self) -> Option<T>) -> T {
        let start = Instant::now();
        loop {
            if let Some(v) = f(self) {
                return v;
            }
            assert!(start.elapsed() < TIMEOUT, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn plan_done(&self, job_id: u32) -> PlanDoneEvent {
        self.wait_for("plan.done", |c| {
            c.events().into_iter().find_map(|e| match e {
                Event::PlanDoneEvent(d) if d.job_id == job_id => Some(d),
                _ => None,
            })
        })
    }

    fn job_loaded(&self, job_id: u32) -> JobModel {
        self.wait_for("job.loaded", |c| {
            c.events().into_iter().find_map(|e| match e {
                Event::JobLoadedEvent(j) if j.job_id == job_id => Some(j.job),
                _ => None,
            })
        })
    }

    /// Batches of a job, checked: contiguous, one last flag, counts and energy
    /// agree with plan.done (as the webview's StreamReceiver checks them), and
    /// the job's events come in the contract order:
    /// job.streaming → plan.started → job.progress* → error? → job.loaded → plan.done,
    /// each job.progress after the batches it counts.
    fn verified_job(&self, job_id: u32) -> (PlanDoneEvent, Vec<MotionSample>) {
        let done = self.plan_done(job_id);
        let batches: Vec<_> = self.batches().into_iter().filter(|(h, _)| h.job_id == job_id).collect();
        assert_eq!(batches.len() as u32, done.batch_count);
        for (i, (h, _)) in batches.iter().enumerate() {
            assert_eq!(h.sequence, i as u32);
            assert_eq!(h.last, i + 1 == batches.len());
        }
        let samples: Vec<MotionSample> = batches.into_iter().flat_map(|(_, s)| s).collect();
        assert_eq!(samples.len() as u32, done.sample_count);
        let energy: f64 = samples.iter().map(|s| s.power_w as f64 * s.dt_s as f64).sum();
        assert_eq!(energy, done.energy_j);

        let mut kinds = String::new();
        let mut batches_sent = 0u32;
        let mut last_progress: Option<JobProgressEvent> = None;
        for m in self.0.lock().unwrap().iter() {
            let e = match m {
                UiMessage::Batch(b) => {
                    batches_sent += u32::from(decode_sample_batch(b).unwrap().0.job_id == job_id);
                    continue;
                }
                UiMessage::Event(e) => e,
                UiMessage::Connection(_) | UiMessage::Profile(_) => continue,
            };
            kinds.push(match &**e {
                Event::JobStreamingEvent(j) if j.job_id == job_id => 's',
                Event::PlanStartedEvent(p) if p.job_id == job_id => 'p',
                Event::JobProgressEvent(p) if p.job_id == job_id => {
                    assert!(p.batch_count <= batches_sent, "job.progress ran ahead of the batches");
                    if let Some(prev) = &last_progress {
                        assert!(p.planned_s >= prev.planned_s && p.sample_count >= prev.sample_count);
                        assert!(p.line_count >= prev.line_count);
                    }
                    last_progress = Some(p.clone());
                    'g'
                }
                Event::ErrorEvent(e) if e.job_id == Some(job_id) => 'e',
                Event::JobLoadedEvent(j) if j.job_id == job_id => 'l',
                Event::PlanDoneEvent(d) if d.job_id == job_id => 'd',
                _ => continue,
            });
        }
        let body =
            kinds.strip_prefix("sp").and_then(|k| k.strip_suffix("ld")).unwrap_or_else(|| panic!("order {kinds}"));
        let body = body.strip_suffix('e').unwrap_or(body);
        assert!(body.chars().all(|c| c == 'g'), "order {kinds}");
        if let Some(p) = last_progress {
            assert!(
                p.planned_s <= done.duration_s && p.sample_count <= done.sample_count && p.energy_j <= done.energy_j
            );
        }
        (done, samples)
    }

    /// The job's progress events (verified_job checks their order).
    fn progress(&self, job_id: u32) -> Vec<JobProgressEvent> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::JobProgressEvent(p) if p.job_id == job_id => Some(p),
                _ => None,
            })
            .collect()
    }

    /// The error code a job was closed with, if it was cut short.
    fn abort_code(&self, job_id: u32) -> Option<String> {
        self.events().into_iter().find_map(|e| match e {
            Event::ErrorEvent(e) if e.job_id == Some(job_id) => Some(e.code.to_string()),
            _ => None,
        })
    }
}

fn start(pacing: Pacing) -> (Server, Arc<Collect>) {
    let sink = Arc::new(Collect::default());
    let machine = MachineConfig { pacing, profile: profile(), job_idle_end_s: 0.5 };
    let server = Server::start(ServerConfig { bind: "127.0.0.1:0".parse().unwrap(), machine }, sink.clone()).unwrap();
    (server, sink)
}

struct Client {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Client {
    /// Connects and reads the start-up banner.
    fn connect(addr: SocketAddr) -> Self {
        let stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let mut c = Self { stream, buf: Vec::new() };
        assert_eq!(c.line(), "");
        assert_eq!(c.line(), "Grbl 1.1h ['$' for help]");
        c
    }

    fn send(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).unwrap();
    }

    fn try_line(&mut self, wait: Duration) -> Option<String> {
        let start = Instant::now();
        loop {
            if let Some(i) = self.buf.windows(2).position(|w| w == b"\r\n") {
                let line = String::from_utf8(self.buf[..i].to_vec()).unwrap();
                self.buf.drain(..i + 2);
                return Some(line);
            }
            if start.elapsed() > wait {
                return None;
            }
            let mut chunk = [0u8; 4096];
            match self.stream.read(&mut chunk) {
                Ok(0) => return None,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(e) => panic!("read: {e}"),
            }
        }
    }

    fn line(&mut self) -> String {
        self.try_line(TIMEOUT).expect("a line from the emulator")
    }

    /// Sends one line and collects the reply up to `ok` / `error:N` (inclusive).
    fn command(&mut self, cmd: &str) -> Vec<String> {
        self.send(format!("{cmd}\n").as_bytes());
        let mut lines = Vec::new();
        loop {
            let l = self.line();
            let end = l == "ok" || l.starts_with("error:");
            lines.push(l);
            if end {
                return lines;
            }
        }
    }

    fn status(&mut self) -> Status {
        self.send(b"?");
        loop {
            let l = self.line();
            if l.starts_with('<') {
                return Status::parse(&l);
            }
            assert!(l.is_empty() || l == "ok", "unexpected line while waiting for status: {l}");
        }
    }

    fn wait_state(&mut self, state: &str) -> Status {
        let start = Instant::now();
        loop {
            let s = self.status();
            if s.state == state {
                return s;
            }
            assert!(start.elapsed() < TIMEOUT, "state {} never became {state}", s.state);
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Send-response streaming: one line, wait for its reply, next line.
    fn stream_send_response(&mut self, lines: &[String]) -> Vec<String> {
        lines.iter().map(|l| self.command(l).pop().unwrap()).collect()
    }

    /// Character-counting streaming (127 bytes in flight at most, as LightBurn
    /// and LaserGRBL do). Returns each line's reply and the lowest planner
    /// free-block count seen in `Bf:` (needs $10=3).
    fn stream_char_counting(&mut self, lines: &[String]) -> (Vec<String>, usize) {
        let mut in_flight: VecDeque<usize> = VecDeque::new();
        let mut replies = Vec::new();
        let mut next = 0;
        let mut min_free = usize::MAX;
        let mut last_poll = Instant::now();
        while replies.len() < lines.len() {
            while next < lines.len() && in_flight.iter().sum::<usize>() + lines[next].len() < 128 {
                self.send(format!("{}\n", lines[next]).as_bytes());
                in_flight.push_back(lines[next].len() + 1);
                next += 1;
            }
            if last_poll.elapsed() > Duration::from_millis(20) {
                self.send(b"?");
                last_poll = Instant::now();
            }
            let Some(l) = self.try_line(TIMEOUT) else { panic!("emulator went quiet") };
            if let Some(bf) = l.strip_prefix('<').and_then(|s| s.split('|').find_map(|f| f.strip_prefix("Bf:"))) {
                min_free = min_free.min(bf.split(',').next().unwrap().parse().unwrap());
            } else if l == "ok" || l.starts_with("error:") {
                in_flight.pop_front().expect("a reply for a line in flight");
                replies.push(l);
            } else if !l.starts_with('<') {
                panic!("unexpected line: {l}");
            }
        }
        (replies, min_free)
    }
}

#[derive(Debug)]
struct Status {
    state: String,
    pos: (f64, f64),
    feed: f64,
    fields: Vec<String>,
}

impl Status {
    fn parse(line: &str) -> Self {
        let inner = line.trim_start_matches('<').trim_end_matches('>');
        let fields: Vec<String> = inner.split('|').map(str::to_owned).collect();
        let field = |key: &str| fields.iter().find_map(|f| f.strip_prefix(key)).map(str::to_owned);
        let pos = field("MPos:").expect("MPos");
        let xyz: Vec<f64> = pos.split(',').map(|v| v.parse().unwrap()).collect();
        let fs = field("FS:").expect("FS");
        Status {
            state: fields[0].clone(),
            pos: (xyz[0], xyz[1]),
            feed: fs.split(',').next().unwrap().parse().unwrap(),
            fields,
        }
    }

    fn field(&self, key: &str) -> Option<&str> {
        self.fields.iter().find_map(|f| f.strip_prefix(key))
    }
}

/// A small raster: `rows` serpentine rows of `cols` 0.5 mm M4 segments with
/// varying S, LightBurn style (S on every segment, G0 between rows).
fn raster(rows: usize, cols: usize, feed: u32) -> Vec<String> {
    let mut lines = vec!["G00 G17 G40 G21 G54".to_owned(), "G90".to_owned(), "M4".to_owned()];
    for r in 0..rows {
        let y = 10.0 + r as f64 * 0.1;
        let (x0, dir) = if r % 2 == 0 { (10.0, 1.0) } else { (10.0 + cols as f64 * 0.5, -1.0) };
        lines.push(format!("G0 X{x0:.3} Y{y:.3}"));
        lines.push(format!("G1 F{feed}"));
        for c in 1..=cols {
            lines.push(format!("G1 X{:.3} S{}", x0 + dir * c as f64 * 0.5, 100 + (c * 37 + r * 11) % 900));
        }
    }
    lines.extend(["M5".to_owned(), "G0 X0 Y0".to_owned(), "M2".to_owned()]);
    lines
}

#[test]
fn handshake_and_settings() {
    let (server, sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    assert_eq!(c.command("$I"), ["[VER:1.1h.20190825:Laser Sim]", "[OPT:V,15,128]", "ok"]);
    let settings = c.command("$$");
    assert_eq!(settings.len(), 35);
    assert!(settings.contains(&"$30=1000".to_owned()) && settings.contains(&"$32=1".to_owned()));
    assert!(settings.contains(&"$110=10000.000".to_owned()));
    assert_eq!(c.command("$G"), ["[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]", "ok"]);
    assert_eq!(c.command("$#").len(), 12);
    assert_eq!(c.command("$N"), ["$N0=", "$N1=", "ok"]);
    assert!(c.command("$")[0].starts_with("[HLP:"));
    assert_eq!(c.command("$X"), ["ok"]);
    assert_eq!(c.command(""), ["ok"]);
    assert_eq!(c.command("; just a comment"), ["ok"]);

    let s = c.status();
    assert_eq!((s.state.as_str(), s.pos, s.feed), ("Idle", (0.0, 0.0), 0.0));
    assert_eq!(s.field("WCO:"), Some("0.000,0.000,0.000"));
    assert_eq!(c.status().field("Ov:"), Some("100,100,100"));
    // $10 writes are kept and change the report.
    assert_eq!(c.command("$10=3"), ["ok"]);
    assert_eq!(c.status().field("Bf:"), Some("15,128"));
    assert!(c.command("$$").contains(&"$10=3".to_owned()));

    assert!(matches!(
        &sink.connections()[..],
        [ConnectionStatus::Listening { .. }, ConnectionStatus::Connected { .. }]
    ));
    // `$` commands don't start a job.
    assert!(sink.events().iter().all(|e| matches!(e, Event::MachineStatusEvent(_))));
}

#[test]
fn send_response_streaming_in_real_time() {
    let (server, sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    let job = raster(6, 20, 6000);
    let started = Instant::now();
    let replies = c.stream_send_response(&job);
    assert!(replies.iter().all(|r| r == "ok"), "{replies:?}");
    c.wait_state("Idle");
    let (done, samples) = sink.verified_job(1);
    // 6 rows × 10 mm at 100 mm/s plus moves: a fraction of a second, in real time.
    assert!(done.duration_s > 0.6 && done.duration_s < 3.0, "{}", done.duration_s);
    let wall = started.elapsed().as_secs_f64();
    assert!(wall > done.duration_s * 0.9);
    // Live progress while it streamed, at most JOB_PROGRESS_HZ = 10.
    let progress = sink.progress(1);
    assert!(!progress.is_empty() && progress.len() as f64 <= wall * 10.0 + 1.0, "{} in {wall}s", progress.len());
    assert!(progress.last().unwrap().line_count > 0);
    assert_eq!(sink.abort_code(1), None);
    let streaming = sink.events().into_iter().find_map(|e| match e {
        Event::JobStreamingEvent(j) => Some(j.name),
        _ => None,
    });
    assert_eq!(streaming.as_deref(), Some("Network job 1"));
    // Samples cover the raster and carry their source lines.
    assert!(samples.iter().all(|s| (9.99..=20.01).contains(&s.x_mm) && (9.99..=10.6).contains(&s.y_mm)));
    // Every segment burns, except where M4 scales a row's first segment (a
    // short ramp up from rest) below the power curve's 5 % threshold.
    let lines: std::collections::BTreeSet<u32> = samples.iter().map(|s| s.line).collect();
    assert!(lines.iter().all(|&l| job[l as usize - 1].contains(" S")));
    assert!(lines.len() >= 6 * 19, "{}", lines.len());
    let model = sink.job_loaded(1);
    assert_eq!(model.source.name, "Network job 1");
    assert_eq!(model.source.line_count as usize, job.len());
    assert_eq!(model.moves.len(), 6 * 21 + 1);
}

#[test]
fn character_counting_fills_the_planner_in_real_time() {
    let (server, sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    assert_eq!(c.command("$10=3"), ["ok"]);
    let job = raster(8, 30, 6000);
    let (replies, min_free) = c.stream_char_counting(&job);
    assert!(replies.iter().all(|r| r == "ok"));
    // The sender kept the 15-block planner full: GRBL-sized buffers pace it.
    assert_eq!(min_free, 0);
    c.wait_state("Idle");
    let (done, _) = sink.verified_job(1);
    assert!(done.duration_s > 1.2, "{}", done.duration_s);
    // 127 bytes in flight never overflows the 128-byte RX buffer.
    assert!(!sink.events().iter().any(|e| matches!(e, Event::ErrorEvent(_))));
}

#[test]
fn instant_pacing_answers_at_once_and_keeps_job_time() {
    let (server, sink) = start(Pacing::Instant);
    let mut c = Client::connect(server.address());
    // 40 rows × 15 mm at 600 mm/min ≈ 60 s of machine time.
    let job = raster(40, 30, 600);
    let started = Instant::now();
    let (replies, _) = c.stream_char_counting(&job);
    assert!(replies.iter().all(|r| r == "ok"));
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    let (done, samples) = sink.verified_job(1);
    assert!(done.duration_s > 55.0, "{}", done.duration_s);
    // However the stream was chunked, motion is GRBL's with full buffers: the
    // same as planning the whole job in one go.
    let model = sink.job_loaded(1);
    let planned = plan_job(&model, &GrblSettings::new(profile()), &mut |_, _| {});
    assert!((done.duration_s - planned).abs() < 1e-6, "{} vs {planned}", done.duration_s);
    assert!(samples.len() > 100_000, "{}", samples.len());
    assert!(done.batch_count > 1, "a long job is split into full batches");

    // Send-response works the same way.
    let replies = c.stream_send_response(&raster(2, 4, 600));
    assert!(replies.iter().all(|r| r == "ok"));
    sink.verified_job(2);
}

#[test]
fn hold_resume_and_reset() {
    let (server, sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    // 100 mm at 600 mm/min: ten seconds of burning.
    assert_eq!(c.command("G1 X100 F600 S500 M3"), ["ok"]);
    c.wait_state("Run");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(c.status().feed, 600.0);

    c.send(b"!");
    let held = c.wait_state("Hold:0");
    thread::sleep(Duration::from_millis(200));
    let still = c.status();
    assert_eq!((still.state.as_str(), still.pos), ("Hold:0", held.pos));
    // Lines are still accepted during a hold.
    assert_eq!(c.command("G1 Y5"), ["ok"]);

    c.send(b"~");
    thread::sleep(Duration::from_millis(200));
    let resumed = c.status();
    assert_eq!(resumed.state, "Run");
    assert!(resumed.pos.0 > held.pos.0 + 0.5, "{:?} → {:?}", held.pos, resumed.pos);

    // Feed override: +10 % twice; the next report that has room shows it.
    c.send(&[0x91, 0x91]);
    let ov = (0..3).find_map(|_| c.status().field("Ov:").map(str::to_owned));
    assert_eq!(ov.as_deref(), Some("120,100,100"));

    // Ctrl-X while moving: ALARM:3, banner, unlock hint; G-code is locked out.
    c.send(&[0x18]);
    assert_eq!(c.line(), "ALARM:3");
    assert_eq!(c.line(), "");
    assert_eq!(c.line(), "Grbl 1.1h ['$' for help]");
    assert_eq!(c.line(), "[MSG:'$H'|'$X' to unlock]");
    let alarm = c.status();
    assert_eq!(alarm.state, "Alarm");
    assert_eq!(c.command("G0 X0"), ["error:9"]);
    assert_eq!(c.command("$X"), ["[MSG:Caution: Unlocked]", "ok"]);
    let idle = c.status();
    assert_eq!((idle.state.as_str(), idle.pos), ("Idle", alarm.pos), "the head stays where it stopped");
    // Overrides are back to 100 % after a reset.
    let ov = (0..12).find_map(|_| c.status().field("Ov:").map(str::to_owned));
    assert_eq!(ov.as_deref(), Some("100,100,100"));

    // The reset closed the job; the preview keeps what was burned.
    let (done, samples) = sink.verified_job(1);
    assert!(done.duration_s > 0.1 && done.duration_s < 5.0, "{}", done.duration_s);
    assert_eq!(sink.abort_code(1).as_deref(), Some("job-reset"));
    let max_x = samples.iter().map(|s| s.x_mm).fold(0.0, f32::max);
    assert!((max_x as f64 - alarm.pos.0).abs() < 0.5, "{max_x} vs {:?}", alarm.pos);

    // Reset during a completed hold keeps position and raises no alarm.
    assert_eq!(c.command("G1 X0 F600"), ["ok"]);
    c.wait_state("Run");
    c.send(b"!");
    c.wait_state("Hold:0");
    c.send(&[0x18]);
    assert_eq!(c.line(), "");
    assert_eq!(c.line(), "Grbl 1.1h ['$' for help]");
    assert_eq!(c.status().state, "Idle");
}

#[test]
fn error_replies_and_jogging() {
    let (server, _sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    assert_eq!(c.command("G1 X5"), ["error:22"], "feed move with no F");
    assert_eq!(c.command("G28"), ["error:20"]);
    assert_eq!(c.command("G1 X1 Y"), ["error:2"]);
    assert_eq!(c.command("G20"), ["error:20"]);
    assert_eq!(c.command("G21"), ["ok"]);
    assert_eq!(c.command(&format!("G0 X1 {}", "Y1".repeat(40))), ["error:11"]);
    assert_eq!(c.command("$Q"), ["error:3"]);
    assert_eq!(c.command("$H"), ["error:5"]);
    assert_eq!(c.command("$J=G91 X1"), ["error:22"]);
    assert_eq!(c.command("$J=G91 X1 M3 F100"), ["error:16"]);
    // An error changes nothing; the next line runs normally.
    assert_eq!(c.command("G0 X2 Y3"), ["ok"]);
    assert_eq!(c.wait_state("Idle").pos, (2.0, 3.0));

    // Jog, then cancel it mid-way.
    assert_eq!(c.command("$J=G91 X50 F600"), ["ok"]);
    c.wait_state("Jog");
    assert_eq!(c.command("G0 X0"), ["error:9"], "G-code is locked while jogging");
    thread::sleep(Duration::from_millis(100));
    c.send(&[0x85]);
    let s = c.wait_state("Idle");
    assert!(s.pos.0 > 2.0 && s.pos.0 < 52.0, "{:?}", s.pos);
    // G-code continues from where the jog stopped.
    assert_eq!(c.command("G91 G0 X1"), ["ok"]);
    let after = c.wait_state("Idle");
    assert!((after.pos.0 - (s.pos.0 + 1.0)).abs() < 2e-3, "{:?} → {:?}", s.pos, after.pos);
    // `$$` is refused while a job runs.
    assert_eq!(c.command("G90 G1 X100 F600"), ["ok"]);
    c.wait_state("Run");
    assert_eq!(c.command("$$"), ["error:8"]);
}

#[test]
fn disconnect_mid_job_keeps_every_received_line() {
    let (server, sink) = start(Pacing::Realtime);
    let job = raster(10, 20, 3000);
    {
        let mut c = Client::connect(server.address());
        // A second sender is refused while one is connected.
        let mut other = TcpStream::connect(server.address()).unwrap();
        other.set_read_timeout(Some(TIMEOUT)).unwrap();
        assert_eq!(other.read(&mut [0u8; 64]).unwrap_or(0), 0, "second client closed without a banner");

        let replies = c.stream_send_response(&job[..60]);
        assert!(replies.iter().all(|r| r == "ok"));
        c.wait_state("Run");
    }
    // Closed mid-job: what was received still runs, then the job closes.
    let done = sink.plan_done(1);
    let model = sink.job_loaded(1);
    assert_eq!(model.source.line_count, 60);
    let (_, samples) = sink.verified_job(1);
    assert_eq!(samples.last().unwrap().line, 60);
    assert_eq!(sink.abort_code(1).as_deref(), Some("sender-disconnected"));
    assert!(done.duration_s > 0.0);
    sink.wait_for("listening again", |c| {
        matches!(c.connections().last(), Some(ConnectionStatus::Listening { .. })).then_some(())
    });

    // The next sender gets a fresh start, and its job is a new one.
    let mut c = Client::connect(server.address());
    assert_eq!(c.status().state, "Idle");
    let replies = c.stream_send_response(&raster(1, 4, 3000));
    assert!(replies.iter().all(|r| r == "ok"));
    sink.verified_job(2);
    assert_eq!(sink.abort_code(2), None, "a job that ended with M2 wasn't cut short");

    drop(c);
    server.stop();
    assert!(matches!(sink.connections().last(), Some(ConnectionStatus::Stopped)));
}

#[test]
fn idle_sender_closes_the_job_and_framing_leaves_no_job() {
    let (server, sink) = start(Pacing::Instant);
    let mut c = Client::connect(server.address());
    // A beam-off frame: no samples, so the webview never hears of it.
    for l in ["G0 X10 Y10", "G1 X20 F3000 S0 M4", "G1 Y20", "M5"] {
        assert_eq!(c.command(l), ["ok"]);
    }
    thread::sleep(Duration::from_millis(800));
    assert!(sink.events().iter().all(|e| matches!(e, Event::MachineStatusEvent(_))));
    // A burn without M2 closes after the idle timeout (0.5 s here).
    for l in ["G1 X30 S500 M4", "G1 Y30"] {
        assert_eq!(c.command(l), ["ok"]);
    }
    let (done, _) = sink.verified_job(2);
    assert!(done.sample_count > 0);
}

#[test]
fn bind_failure_is_reported() {
    let (server, _) = start(Pacing::Realtime);
    let sink = Arc::new(Collect::default());
    let machine = MachineConfig::new(profile());
    let err = Server::start(ServerConfig { bind: server.address(), machine }, sink.clone()).err().unwrap();
    assert_eq!(err.kind(), ErrorKind::AddrInUse);
    assert!(matches!(&sink.connections()[..], [ConnectionStatus::Failed { .. }]));
}

#[test]
fn dollar_settings_are_the_machine_profile() {
    let (server, sink) = start(Pacing::Instant);
    let mut c = Client::connect(server.address());
    assert!(c.command("$$").contains(&"$11=0.010".to_owned()));
    // Writes to profile settings change the profile and reach the webview.
    assert_eq!(c.command("$11=0.2"), ["ok"]);
    assert_eq!(c.command("$120=2000"), ["ok"]);
    assert_eq!(c.command("$32=0"), ["ok"]);
    let settings = c.command("$$");
    for expected in ["$11=0.200", "$120=2000.000", "$32=0"] {
        assert!(settings.contains(&expected.to_owned()), "{expected} in {settings:?}");
    }
    let p = sink.wait_for("profile", |c| c.profiles().last().cloned().filter(|p| !p.laser_mode));
    assert_eq!((p.junction_deviation_mm, p.accel_mm_per_s2.x), (0.2, 2000.0));
    // Other settings are kept but aren't part of the profile.
    let before = sink.profiles().len();
    assert_eq!(c.command("$100=100"), ["ok"]);
    assert_eq!(sink.profiles().len(), before);
    // GRBL's write errors.
    assert_eq!(c.command("$110=-5"), ["error:4"]);
    assert_eq!(c.command("$99=1"), ["error:3"]);
    assert_eq!(c.command("$0=1"), ["error:6"]);
    assert_eq!(c.command("$30=0"), ["error:3"]);
    // Saving the settings screen replaces the profile, not the other writes.
    server.set_profile(profile());
    let settings = c.command("$$");
    assert!(settings.contains(&"$11=0.010".to_owned()) && settings.contains(&"$100=100.000".to_owned()));
    // Not while moving.
    assert_eq!(c.command("$J=G91 X50 F600"), ["ok"]);
    assert_eq!(c.command("$11=0.1"), ["error:8"]);
}

#[test]
fn junction_deviation_writes_change_the_job_time() {
    // A zigzag, so every corner is limited by $11.
    let mut job = vec!["G90".to_owned(), "G0 X0 Y0".to_owned(), "M4 S500".to_owned(), "G1 F6000".to_owned()];
    for i in 1..=40 {
        job.push(format!("G1 X{} Y{}", i * 2, if i % 2 == 0 { 0 } else { 2 }));
    }
    job.extend(["M5".to_owned(), "M2".to_owned()]);
    let (server, sink) = start(Pacing::Instant);
    let mut c = Client::connect(server.address());
    assert!(c.stream_send_response(&job).iter().all(|r| r == "ok"));
    let (tight, _) = sink.verified_job(1);
    c.wait_state("Idle");
    assert_eq!(c.command("$11=0.5"), ["ok"]);
    assert!(c.stream_send_response(&job).iter().all(|r| r == "ok"));
    let (loose, _) = sink.verified_job(2);
    assert!(loose.duration_s < tight.duration_s * 0.9, "{} vs {}", loose.duration_s, tight.duration_s);
    let mut settings = GrblSettings::new(profile());
    settings.set(11, 0.5).unwrap();
    let planned = plan_job(&sink.job_loaded(2), &settings, &mut |_, _| {});
    assert!((loose.duration_s - planned).abs() < 1e-6, "{} vs {planned}", loose.duration_s);
}

#[test]
fn feed_hold_decelerates_before_it_reports_hold_complete() {
    let (server, _sink) = start(Pacing::Realtime);
    let mut c = Client::connect(server.address());
    // 100 mm/s: 0.1 s and 5 mm to stop at 1000 mm/s².
    assert_eq!(c.command("G1 X200 F6000"), ["ok"]);
    thread::sleep(Duration::from_millis(400));
    c.send(b"!?");
    let decelerating = Status::parse(&c.line());
    assert_eq!(decelerating.state, "Hold:1");
    let held = c.wait_state("Hold:0");
    assert!(held.pos.0 > decelerating.pos.0 + 2.0, "{:?} → {:?}", decelerating.pos, held.pos);
    assert_eq!(held.feed, 0.0);
    c.send(b"~");
    c.wait_state("Idle");
}

#[test]
fn spindle_syncs_and_dwells_stop_motion() {
    // X0 → X10 → X20 at 100 mm/s, then a rapid back. Through X10 without a stop
    // that's 0.3 s (two 5 mm ramps and 10 mm of cruise); stopping at X10 adds 0.1 s.
    let job = |middle: &str| {
        ["G90", "M3 S500 G1 F6000", "G1 X10", middle, "G1 X20", "M5", "G0 X0", "M2"].map(str::to_owned).to_vec()
    };
    let (server, sink) = start(Pacing::Instant);
    let mut c = Client::connect(server.address());
    let mut id = 0;
    let mut time = |c: &mut Client, middle: &str| {
        assert!(c.stream_send_response(&job(middle)).iter().all(|r| r == "ok"));
        id += 1;
        let (done, _) = sink.verified_job(id);
        c.wait_state("Idle");
        done.duration_s
    };
    // The rapid back: 20 mm, a triangle at 1000 mm/s².
    let rapid = 2.0 * (20.0f64 / 1000.0).sqrt();
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    // An S change on a motion line rides along in laser mode: no stop.
    let t = time(&mut c, "G1 X15 S800");
    assert!(close(t, 0.3 + rapid), "{t}");
    // On its own line it syncs.
    let t = time(&mut c, "S800");
    assert!(close(t, 0.4 + rapid), "{t}");
    // M3 → M4 always syncs.
    let t = time(&mut c, "M4");
    assert!(close(t, 0.4 + rapid), "{t}");
    // G4 syncs, then waits.
    let t = time(&mut c, "G4 P0.5");
    assert!(close(t, 0.9 + rapid), "{t}");
}
