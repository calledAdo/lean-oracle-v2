//! Host-side tests: signed price-update fixtures, codec/Merkle/verification unit tests, and
//! `ckb-testtool` integration tests that run the compiled RISC-V contracts.

pub mod fixtures;

#[cfg(test)]
mod price_feed_type_tests;
#[cfg(test)]
mod price_trigger_lock_tests;
#[cfg(test)]
mod price_update_tests;
#[cfg(test)]
mod publisher_set_type_tests;
#[cfg(test)]
mod vectors;
