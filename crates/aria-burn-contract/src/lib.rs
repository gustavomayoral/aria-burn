// SPDX-License-Identifier: GPL-3.0-or-later
//! The aria-burn v1 contract on the Rust side. Every type here is generated at
//! build time from aria-burn-core (see build.rs); none is written by hand.

#[allow(clippy::all, clippy::pedantic, dead_code, unused_imports)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/contract.rs"));
}
pub use generated::*;

/// The binary sample-batch format (`sample-batch-layout.json`).
#[allow(clippy::identity_op)] // generated offsets include `+ 0`
pub mod sample_batch {
    include!(concat!(env!("OUT_DIR"), "/sample_batch.rs"));
}

/// The core's `src/contract` directory these types were generated from.
pub const CONTRACT_DIR: &str = env!("ARIA_BURN_CONTRACT_DIR");
