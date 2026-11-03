// SPDX-License-Identifier: GPL-3.0-or-later
//! GRBL 1.1 network emulator (COD-265): the TCP endpoint LightBurn and LaserGRBL
//! stream jobs to. Rust owns the protocol and answers `?` itself; the webview
//! only receives batched sample buffers and contract events (COD-252).
//!
//! - [`machine`]: the GRBL controller as a pure state machine (bytes and time in,
//!   replies and webview traffic out).
//! - [`planner`]: the GRBL 1.1h planner port (COD-255) and sampler, behind the
//!   [`planner::Planner`] trait; [`planner::plan_job`] runs a whole parsed job.
//! - [`settings`]: the emulated `$` settings, backed by the machine profile.
//! - [`server`]: the TCP server and its threads.

pub mod machine;
pub mod planner;
pub mod protocol;
pub mod server;
pub mod settings;

pub use machine::{Machine, MachineConfig, Output, Pacing};
pub use server::{ConnectionStatus, Server, ServerConfig, Sink, UiMessage};
pub use settings::GrblSettings;

/// The core's provisional 10 W diode profile, for tests.
#[cfg(test)]
pub(crate) fn test_profile() -> aria_burn_contract::MachineProfile {
    let path =
        std::path::Path::new(aria_burn_contract::CONTRACT_DIR).join("../profiles/provisional/machine-10w-diode.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("core profile")).expect("valid profile")
}
