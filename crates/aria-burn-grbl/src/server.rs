// SPDX-License-Identifier: GPL-3.0-or-later
//! TCP server for the emulator: one sender at a time.
//!
//! Threads:
//! - accept: takes connections; while one is open, further ones are closed at once.
//! - reader (one per connection): blocking reads, handed to the protocol thread.
//! - protocol: owns the [`Machine`], answers the sender, runs the clock. It
//!   never waits on the webview: what it produces for the UI goes through a
//!   queue to
//! - forwarder: calls the [`Sink`] (Tauri Channels in the app).

use std::{
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use aria_burn_contract::{Event, MachineProfile};
use serde::Serialize;

use crate::machine::{Machine, MachineConfig, Output, Pacing};

/// Protocol thread tick when no bytes arrive: motion and `ok` pacing resolution.
const TICK: Duration = Duration::from_millis(2);
/// Tick with no sender connected.
const IDLE_TICK: Duration = Duration::from_millis(50);
/// machine.status push interval (contract STATUS_PUSH_HZ = 20).
const STATUS_PUSH: Duration = Duration::from_millis(50);
const ACCEPT_POLL: Duration = Duration::from_millis(20);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Connection state for the UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ConnectionStatus {
    Stopped,
    Listening {
        address: String,
    },
    Connected {
        address: String,
        peer: String,
    },
    /// The server couldn't start (port in use, no permission…).
    Failed {
        address: String,
        message: String,
    },
}

/// Everything the emulator sends towards the webview.
#[derive(Clone, Debug)]
pub enum UiMessage {
    Event(Box<Event>),
    Batch(Vec<u8>),
    Connection(ConnectionStatus),
    /// A sender's `$x=` write changed the machine profile; the settings follow it.
    Profile(Box<MachineProfile>),
}

/// Receives the emulator's UI traffic, on the forwarder thread.
pub trait Sink: Send + Sync + 'static {
    fn send(&self, message: UiMessage);
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub machine: MachineConfig,
}

enum Msg {
    Connected(TcpStream, SocketAddr, u64),
    Bytes(Vec<u8>, u64),
    Closed(u64),
    Pacing(Pacing),
    Profile(Box<MachineProfile>),
    Stop,
}

/// A running emulator. Dropping it stops it.
pub struct Server {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    tx: Sender<Msg>,
    threads: Vec<JoinHandle<()>>,
}

impl Server {
    /// Binds and starts serving. A bind failure is reported to the sink as
    /// [`ConnectionStatus::Failed`] and returned.
    pub fn start(config: ServerConfig, sink: Arc<dyn Sink>) -> io::Result<Self> {
        let listener = match TcpListener::bind(config.bind).and_then(|l| l.set_nonblocking(true).map(|()| l)) {
            Ok(l) => l,
            Err(e) => {
                let message = bind_error_message(&e, config.bind);
                sink.send(UiMessage::Connection(ConnectionStatus::Failed {
                    address: config.bind.to_string(),
                    message: message.clone(),
                }));
                return Err(io::Error::new(e.kind(), message));
            }
        };
        let address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let busy = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let (ui_tx, ui_rx) = mpsc::channel::<UiMessage>();

        // Sent before any thread runs, so it is in place when `start` returns and precedes everything else.
        sink.send(UiMessage::Connection(ConnectionStatus::Listening { address: address.to_string() }));
        let forwarder = thread::Builder::new().name("grbl-ui-forward".into()).spawn(move || {
            for message in ui_rx {
                sink.send(message);
            }
        })?;

        let protocol = {
            let (busy, tx) = (busy.clone(), tx.clone());
            let machine = Machine::new(config.machine);
            thread::Builder::new()
                .name("grbl-protocol".into())
                .spawn(move || ProtocolLoop { machine, rx, tx, ui: ui_tx, busy, address, client: None }.run())?
        };

        let accept = {
            let (stop, tx) = (stop.clone(), tx.clone());
            thread::Builder::new().name("grbl-accept".into()).spawn(move || accept_loop(listener, stop, busy, tx))?
        };

        Ok(Self { address, stop, tx, threads: vec![accept, protocol, forwarder] })
    }

    /// The bound address (useful with port 0).
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn set_pacing(&self, pacing: Pacing) {
        let _ = self.tx.send(Msg::Pacing(pacing));
    }

    pub fn set_profile(&self, profile: MachineProfile) {
        let _ = self.tx.send(Msg::Profile(Box::new(profile)));
    }

    /// Closes the connection (the job closes as on a disconnect) and the listener.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn bind_error_message(e: &io::Error, addr: SocketAddr) -> String {
    match e.kind() {
        io::ErrorKind::AddrInUse => format!("Port {} is already in use by another program", addr.port()),
        io::ErrorKind::PermissionDenied => {
            format!("No permission to listen on port {}; try a port above 1024", addr.port())
        }
        _ => format!("Couldn't listen on {addr}: {e}"),
    }
}

fn accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, busy: Arc<AtomicBool>, tx: Sender<Msg>) {
    let mut next_id = 0u64;
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if busy.swap(true, Ordering::SeqCst) {
                    // One sender at a time: refuse by closing.
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                // Accepted sockets inherit the listener's non-blocking mode on BSD/macOS.
                if stream.set_nonblocking(false).is_err() {
                    busy.store(false, Ordering::SeqCst);
                    continue;
                }
                next_id += 1;
                if tx.send(Msg::Connected(stream, peer, next_id)).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => thread::sleep(ACCEPT_POLL),
        }
    }
}

fn read_loop(mut stream: TcpStream, id: u64, tx: Sender<Msg>) {
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(Msg::Bytes(buf[..n].to_vec(), id)).is_err() {
                    return;
                }
            }
        }
    }
    let _ = tx.send(Msg::Closed(id));
}

struct Client {
    id: u64,
    stream: TcpStream,
}

struct ProtocolLoop {
    machine: Machine,
    rx: Receiver<Msg>,
    /// For the reader threads.
    tx: Sender<Msg>,
    ui: Sender<UiMessage>,
    busy: Arc<AtomicBool>,
    address: SocketAddr,
    client: Option<Client>,
}

impl ProtocolLoop {
    fn run(mut self) {
        let mut last = Instant::now();
        let mut last_status = last;
        loop {
            let msg = self.rx.recv_timeout(if self.client.is_some() { TICK } else { IDLE_TICK });
            let now = Instant::now();
            // Bring motion up to now first, so `?` reports the present.
            self.machine.step(now.duration_since(last).as_secs_f64());
            last = now;
            match msg {
                Ok(Msg::Connected(stream, peer, id)) => self.connect(stream, peer, id),
                Ok(Msg::Bytes(bytes, id)) if self.client.as_ref().is_some_and(|c| c.id == id) => {
                    self.machine.receive(&bytes);
                    // Instant pacing: run what just arrived before answering further.
                    self.machine.step(0.0);
                }
                Ok(Msg::Bytes(..)) => {}
                Ok(Msg::Closed(id)) if self.client.as_ref().is_some_and(|c| c.id == id) => self.disconnect(),
                Ok(Msg::Closed(_)) => {}
                Ok(Msg::Pacing(p)) => self.machine.set_pacing(p),
                Ok(Msg::Profile(p)) => self.machine.set_profile(*p),
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    if self.client.is_some() {
                        self.disconnect();
                    }
                    self.forward();
                    let _ = self.ui.send(UiMessage::Connection(ConnectionStatus::Stopped));
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.flush();
            if self.client.is_some() && now.duration_since(last_status) >= STATUS_PUSH {
                last_status = now;
                let _ = self.ui.send(UiMessage::Event(Box::new(self.machine.status_event())));
            }
        }
    }

    fn connect(&mut self, stream: TcpStream, peer: SocketAddr, id: u64) {
        let reader = stream.try_clone();
        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let spawned = reader.and_then(|reader| {
            let tx = self.tx.clone();
            thread::Builder::new().name("grbl-read".into()).spawn(move || read_loop(reader, id, tx))
        });
        if spawned.is_err() {
            let _ = stream.shutdown(Shutdown::Both);
            self.busy.store(false, Ordering::SeqCst);
            return;
        }
        self.client = Some(Client { id, stream });
        self.machine.connect();
        let _ = self.ui.send(UiMessage::Connection(ConnectionStatus::Connected {
            address: self.address.to_string(),
            peer: peer.to_string(),
        }));
    }

    fn disconnect(&mut self) {
        if let Some(client) = self.client.take() {
            let _ = client.stream.shutdown(Shutdown::Both);
        }
        self.machine.disconnect();
        let _ = self.ui.send(UiMessage::Event(Box::new(self.machine.status_event())));
        self.forward();
        self.busy.store(false, Ordering::SeqCst);
        let _ = self.ui.send(UiMessage::Connection(ConnectionStatus::Listening { address: self.address.to_string() }));
    }

    /// Replies to the sender, then UI traffic to the forwarder.
    fn flush(&mut self) {
        let out = self.machine.take_output();
        if !out.is_empty()
            && let Some(client) = &mut self.client
            && client.stream.write_all(&out).is_err()
        {
            self.disconnect();
        }
        self.forward();
    }

    fn forward(&mut self) {
        for o in self.machine.take_outputs() {
            let _ = self.ui.send(match o {
                Output::Event(e) => UiMessage::Event(e),
                Output::Batch(b) => UiMessage::Batch(b),
                Output::Profile(p) => UiMessage::Profile(p),
            });
        }
    }
}
