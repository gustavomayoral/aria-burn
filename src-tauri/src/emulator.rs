// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri side of the GRBL network emulator (crate `aria-burn-grbl`): starts and
//! stops the server from the network settings, and forwards its traffic to the
//! webview on four Channels: contract events (JSON `ChannelEvent`), binary
//! sample batches, the connection state, and machine profiles changed by a
//! sender's `$x=` writes (the profile is the emulated `$` settings, COD-255).
//!
//! The connection state and the emulator settings are app-local types for now:
//! the contract's `emulator.set` command has no bind address or pacing, and
//! there is no connection-state event yet (see COD-265 in Linear).

use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use aria_burn_contract::{ChannelEvent, Event, HelloEvent, HelloEventType, MachineProfile};
use aria_burn_grbl::{ConnectionStatus, MachineConfig, Pacing, Server, ServerConfig, Sink, UiMessage};
use serde::Deserialize;
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody},
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BindMode {
    Localhost,
    Lan,
}

/// The webview's network settings plus the machine profile the emulator runs.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmulatorSettings {
    pub enabled: bool,
    pub bind_mode: BindMode,
    pub port: u16,
    pub pacing: Pacing,
    pub profile: MachineProfile,
}

impl EmulatorSettings {
    fn bind(&self) -> SocketAddr {
        let ip = match self.bind_mode {
            BindMode::Localhost => Ipv4Addr::LOCALHOST,
            BindMode::Lan => Ipv4Addr::UNSPECIFIED,
        };
        SocketAddr::from((ip, self.port))
    }
}

struct Subscribers {
    events: Channel<ChannelEvent>,
    batches: Channel<InvokeResponseBody>,
    status: Channel<ConnectionStatus>,
    profile: Channel<MachineProfile>,
    seq: u32,
}

/// Forwards emulator traffic to whichever Channels the webview last subscribed.
struct ChannelSink {
    subscribers: Mutex<Option<Subscribers>>,
    last_status: Mutex<ConnectionStatus>,
}

impl ChannelSink {
    fn send_event(subs: &mut Subscribers, event: Event) {
        let msg = ChannelEvent { seq: subs.seq, event };
        subs.seq = subs.seq.wrapping_add(1);
        let _ = subs.events.send(msg);
    }
}

impl Sink for ChannelSink {
    fn send(&self, message: UiMessage) {
        if let UiMessage::Connection(status) = &message {
            *self.last_status.lock().unwrap() = status.clone();
        }
        let mut guard = self.subscribers.lock().unwrap();
        let Some(subs) = guard.as_mut() else { return };
        match message {
            UiMessage::Event(event) => Self::send_event(subs, *event),
            UiMessage::Batch(bytes) => {
                let _ = subs.batches.send(InvokeResponseBody::Raw(bytes));
            }
            UiMessage::Connection(status) => {
                let _ = subs.status.send(status);
            }
            UiMessage::Profile(profile) => {
                let _ = subs.profile.send(*profile);
            }
        }
    }
}

struct Running {
    server: Server,
    bind: SocketAddr,
}

pub struct EmulatorState {
    sink: Arc<ChannelSink>,
    running: Mutex<Option<Running>>,
}

impl Default for EmulatorState {
    fn default() -> Self {
        Self {
            sink: Arc::new(ChannelSink {
                subscribers: Mutex::new(None),
                last_status: Mutex::new(ConnectionStatus::Stopped),
            }),
            running: Mutex::new(None),
        }
    }
}

impl EmulatorState {
    fn configure(&self, settings: EmulatorSettings) -> Result<ConnectionStatus, String> {
        let mut running = self.running.lock().unwrap();
        let bind = settings.bind();
        match running.as_ref() {
            Some(r) if settings.enabled && r.bind == bind => {
                r.server.set_pacing(settings.pacing);
                r.server.set_profile(settings.profile);
            }
            _ => {
                if let Some(r) = running.take() {
                    r.server.stop();
                }
                if settings.enabled {
                    let mut machine = MachineConfig::new(settings.profile);
                    machine.pacing = settings.pacing;
                    let sink: Arc<dyn Sink> = self.sink.clone();
                    let server = Server::start(ServerConfig { bind, machine }, sink).map_err(|e| e.to_string())?;
                    *running = Some(Running { server, bind });
                }
            }
        }
        Ok(self.sink.last_status.lock().unwrap().clone())
    }
}

/// Connects the webview's Channels. The event channel opens with `hello`, and
/// the status channel gets the current state at once. `profile` carries the
/// machine profile whenever a sender's `$x=` write changes it.
#[tauri::command]
pub fn emulator_subscribe(
    state: State<'_, Arc<EmulatorState>>,
    events: Channel<ChannelEvent>,
    batches: Channel<InvokeResponseBody>,
    status: Channel<ConnectionStatus>,
    profile: Channel<MachineProfile>,
) {
    let mut subs = Subscribers { events, batches, status, profile, seq: 0 };
    ChannelSink::send_event(
        &mut subs,
        Event::HelloEvent(HelloEvent {
            type_: HelloEventType::Hello,
            contract_version: 1.0.try_into().expect("contract version 1"),
            app_version: env!("CARGO_PKG_VERSION").into(),
        }),
    );
    let _ = subs.status.send(state.sink.last_status.lock().unwrap().clone());
    *state.sink.subscribers.lock().unwrap() = Some(subs);
}

/// Applies the network settings: starts, restarts (new address) or stops the
/// server, or updates pacing and profile in place. Returns the connection state.
#[tauri::command]
pub async fn emulator_configure(
    state: State<'_, Arc<EmulatorState>>,
    settings: EmulatorSettings,
) -> Result<ConnectionStatus, String> {
    // Stopping joins the server's threads; keep it off the main thread.
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.configure(settings)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `emulatorSettings()` in src/lib/emulator.ts sends.
    #[test]
    fn settings_from_the_webview() {
        let profile = std::fs::read_to_string(
            std::path::Path::new(aria_burn_contract::CONTRACT_DIR)
                .join("../profiles/provisional/machine-10w-diode.json"),
        )
        .unwrap();
        let json = format!(r#"{{"enabled":true,"bindMode":"lan","port":2323,"pacing":"instant","profile":{profile}}}"#);
        let s: EmulatorSettings = serde_json::from_str(&json).unwrap();
        assert_eq!((s.bind(), s.pacing), ("0.0.0.0:2323".parse().unwrap(), Pacing::Instant));
        let local = EmulatorSettings { bind_mode: BindMode::Localhost, ..s };
        assert_eq!(local.bind(), "127.0.0.1:2323".parse().unwrap());
    }

    /// The shape `ConnectionStatus` in src/lib/emulator.ts expects.
    #[test]
    fn connection_status_json() {
        let s = ConnectionStatus::Connected { address: "127.0.0.1:23".into(), peer: "127.0.0.1:50000".into() };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"state":"connected","address":"127.0.0.1:23","peer":"127.0.0.1:50000"}"#
        );
        assert_eq!(serde_json::to_string(&ConnectionStatus::Stopped).unwrap(), r#"{"state":"stopped"}"#);
    }

    #[test]
    fn configure_starts_updates_and_stops() {
        let profile: MachineProfile = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(aria_burn_contract::CONTRACT_DIR)
                    .join("../profiles/provisional/machine-10w-diode.json"),
            )
            .unwrap(),
        )
        .unwrap();
        // Port 0 can't be told apart from a restart, so find a free one first.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let state = EmulatorState::default();
        let settings =
            EmulatorSettings { enabled: true, bind_mode: BindMode::Localhost, port, pacing: Pacing::Realtime, profile };
        let status = state.configure(settings.clone()).unwrap();
        assert_eq!(status, ConnectionStatus::Listening { address: format!("127.0.0.1:{port}") });
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
        // Same address: updated in place, still listening.
        let status = state.configure(EmulatorSettings { pacing: Pacing::Instant, ..settings.clone() }).unwrap();
        assert!(matches!(status, ConnectionStatus::Listening { .. } | ConnectionStatus::Connected { .. }));
        let status = state.configure(EmulatorSettings { enabled: false, ..settings }).unwrap();
        assert_eq!(status, ConnectionStatus::Stopped);
    }
}
