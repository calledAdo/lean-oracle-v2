//! Always-success lock for committee cells (docs/oracle-design.md section 3.2).
//!
//! Anyone may spend a cell under this lock, so it must only guard cells whose type script protects
//! them. `publisher_set_type` does: every spend is a quorum-authorized operation, the cell continues
//! under the same lock with at least the same capacity, and it can never be burned. With this lock no
//! single key can block or veto governance. Never send plain CKB to this lock: anyone can take it.

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
ckb_std::default_alloc!(4096, 4096, 64);

pub fn program_entry() -> i8 {
    0
}
