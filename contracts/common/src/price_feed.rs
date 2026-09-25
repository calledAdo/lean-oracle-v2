//! Price feed cell data (docs/oracle-design.md section 7.1), mirroring lean-oracle's oracle cell.

use alloc::vec::Vec;

use crate::price_update::VerifiedPrice;

pub const PRICE_FEED_LEN: usize = 125;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PriceFeedData {
    pub feed_id: [u8; 32],
    pub publisher_set_type_hash: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    /// Committee-signed time of the stored price; zero until the first authenticated update.
    pub publish_time_ms: u64,
    pub prev_publish_time_ms: u64,
    pub ema_price: i64,
    pub ema_conf: u64,
    pub source_time_ms: u64,
    pub num_publishers: u8,
}

impl PriceFeedData {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() != PRICE_FEED_LEN {
            return None;
        }
        let mut offset = 0usize;
        Some(Self {
            feed_id: array(data, &mut offset)?,
            publisher_set_type_hash: array(data, &mut offset)?,
            price: i64::from_le_bytes(array(data, &mut offset)?),
            conf: u64::from_le_bytes(array(data, &mut offset)?),
            expo: i32::from_le_bytes(array(data, &mut offset)?),
            publish_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            prev_publish_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            ema_price: i64::from_le_bytes(array(data, &mut offset)?),
            ema_conf: u64::from_le_bytes(array(data, &mut offset)?),
            source_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            num_publishers: data[offset],
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(PRICE_FEED_LEN);
        out.extend_from_slice(&self.feed_id);
        out.extend_from_slice(&self.publisher_set_type_hash);
        out.extend_from_slice(&self.price.to_le_bytes());
        out.extend_from_slice(&self.conf.to_le_bytes());
        out.extend_from_slice(&self.expo.to_le_bytes());
        out.extend_from_slice(&self.publish_time_ms.to_le_bytes());
        out.extend_from_slice(&self.prev_publish_time_ms.to_le_bytes());
        out.extend_from_slice(&self.ema_price.to_le_bytes());
        out.extend_from_slice(&self.ema_conf.to_le_bytes());
        out.extend_from_slice(&self.source_time_ms.to_le_bytes());
        out.push(self.num_publishers);
        out
    }

    /// A newly created cell carries configuration only; every price/time field is zero.
    pub fn is_uninitialized(&self) -> bool {
        self.price == 0
            && self.conf == 0
            && self.expo == 0
            && self.publish_time_ms == 0
            && self.prev_publish_time_ms == 0
            && self.ema_price == 0
            && self.ema_conf == 0
            && self.source_time_ms == 0
            && self.num_publishers == 0
    }

    pub fn static_fields_unchanged(&self, other: &Self) -> bool {
        self.feed_id == other.feed_id && self.publisher_set_type_hash == other.publisher_set_type_hash
    }

    /// The cell must equal the authenticated message exactly.
    pub fn matches(&self, verified: &VerifiedPrice) -> bool {
        let m = &verified.message;
        self.feed_id == m.feed_id
            && self.price == m.price
            && self.conf == m.conf
            && self.expo == m.expo
            && self.publish_time_ms == verified.header.publish_time_ms
            && self.prev_publish_time_ms == m.prev_publish_time_ms
            && self.ema_price == m.ema_price
            && self.ema_conf == m.ema_conf
            && self.source_time_ms == m.source_time_ms
            && self.num_publishers == m.num_publishers
    }
}

fn array<const N: usize>(data: &[u8], offset: &mut usize) -> Option<[u8; N]> {
    let end = offset.checked_add(N)?;
    let result = data.get(*offset..end)?.try_into().ok()?;
    *offset = end;
    Some(result)
}
