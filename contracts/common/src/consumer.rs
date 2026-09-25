//! Helpers for consumer scripts that read a Lean Oracle feed cell (docs/oracle-design.md section 9).
//!
//! A consumer reads a feed cell as a cell dep, pinned by the feed cell's type hash (unique through
//! Type ID), and checks:
//! - the data decodes, and the cell carries the expected feed and committee;
//! - the price is authentic (`publish_time_ms != 0`: only a verified update sets it);
//! - freshness, against a time the script can prove (scripts cannot read "now"), e.g. the
//!   timestamp of the block that created the consumer's own cell, loaded through a header dep.
//!
//! This module is pure (no syscalls); the consumer script loads the bytes.

use crate::price_feed::PriceFeedData;

/// Why a feed cell cannot be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedCheckError {
    /// Not a 125-byte feed cell.
    Malformed,
    /// A different feed than expected.
    WrongFeed,
    /// Anchored to a different committee (anyone can anchor a cell to their own committee).
    WrongCommittee,
    /// Never updated: carries no authenticated price.
    Uninitialized,
    /// Published before the required time.
    Stale,
}

/// Decode a feed cell and check its feed, committee and authenticity.
pub fn check_feed_cell(data: &[u8], feed_id: &[u8; 32], committee_type_hash: &[u8; 32]) -> Result<PriceFeedData, FeedCheckError> {
    let feed = PriceFeedData::from_bytes(data).ok_or(FeedCheckError::Malformed)?;
    if &feed.feed_id != feed_id {
        return Err(FeedCheckError::WrongFeed);
    }
    if &feed.publisher_set_type_hash != committee_type_hash {
        return Err(FeedCheckError::WrongCommittee);
    }
    if feed.publish_time_ms == 0 {
        return Err(FeedCheckError::Uninitialized);
    }
    Ok(feed)
}

/// The price was published strictly after `not_before_ms` (e.g. when the consumer's cell was created).
pub fn published_after(feed: &PriceFeedData, not_before_ms: u64) -> Result<(), FeedCheckError> {
    if feed.publish_time_ms > not_before_ms {
        Ok(())
    } else {
        Err(FeedCheckError::Stale)
    }
}

/// `price` rescaled from the feed's exponent to `expo`, if it fits (an exact rescale when the target
/// exponent is larger truncates toward zero).
pub fn price_at_expo(feed: &PriceFeedData, expo: i32) -> Option<i64> {
    let shift = feed.expo - expo;
    let factor = 10i64.checked_pow(shift.unsigned_abs())?;
    if shift >= 0 {
        feed.price.checked_mul(factor)
    } else {
        Some(feed.price / factor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(price: i64, expo: i32, time: u64) -> PriceFeedData {
        PriceFeedData { feed_id: [1; 32], publisher_set_type_hash: [2; 32], price, expo, publish_time_ms: time, ..Default::default() }
    }

    #[test]
    fn checks_identity_authenticity_and_freshness() {
        let ok = feed(100, -2, 5).to_bytes();
        assert!(check_feed_cell(&ok, &[1; 32], &[2; 32]).is_ok());
        assert_eq!(check_feed_cell(&ok[..124], &[1; 32], &[2; 32]), Err(FeedCheckError::Malformed));
        assert_eq!(check_feed_cell(&ok, &[9; 32], &[2; 32]), Err(FeedCheckError::WrongFeed));
        assert_eq!(check_feed_cell(&ok, &[1; 32], &[9; 32]), Err(FeedCheckError::WrongCommittee));
        assert_eq!(check_feed_cell(&feed(100, -2, 0).to_bytes(), &[1; 32], &[2; 32]), Err(FeedCheckError::Uninitialized));
        assert_eq!(published_after(&feed(1, 0, 5), 5), Err(FeedCheckError::Stale));
        assert!(published_after(&feed(1, 0, 6), 5).is_ok());
    }

    #[test]
    fn rescales_between_exponents() {
        assert_eq!(price_at_expo(&feed(8_435_937_500_000, -8, 1), -2), Some(8_435_937));
        assert_eq!(price_at_expo(&feed(84_359, 0, 1), -8), Some(8_435_900_000_000));
        assert_eq!(price_at_expo(&feed(i64::MAX, 0, 1), -8), None);
    }
}
