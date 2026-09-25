export const MAX_PUBLISHERS = 9;
export const GOVERNANCE_LOCKED = 0x01;
export const GOVERNANCE_PAUSED = 0x02;
export const OP_ROTATE = 1;

export const PUBLISHER_SET_MAGIC = "PSET";
export const PUBLISHER_SET_VERSION = 1;
export const PRICE_UPDATE_MAGIC = "TPOU";
export const PRICE_UPDATE_VERSION = 1;
export const HEADER_LEN = 119;
export const MESSAGE_LEN = 86;
export const MESSAGE_TYPE_PRICE = 0;
export const PRICE_FEED_LEN = 125;
export const SIGNATURE_LEN = 65;
/** `leaf_count` is a u16, so no valid proof is deeper than 16 levels. */
export const MAX_PROOF_LEN = 16;
export const OBSERVATION_MAGIC = "TPOB";
export const OBSERVATION_VERSION = 1;
export const OBSERVATION_HEADER_LEN = 83;
export const OBSERVATION_ENTRY_LEN = 56;
