export const MAX_PUBLISHERS = 9;
export const GOVERNANCE_LOCKED = 0x01;
export const GOVERNANCE_PAUSED = 0x02;
/** Rotate to the next set; the outgoing set becomes \`previous\`. */
export const OP_ROTATE = 1;
/** Rotate and drop every earlier set (emergency; not subject to the rotation interval). */
export const OP_ROTATE_REVOKE = 2;
export const OP_PAUSE = 3;
export const OP_UNPAUSE = 4;
/** Drop the previous set at any time. */
export const OP_REVOKE_PREVIOUS = 5;

export const PUBLISHER_SET_MAGIC = "PSET";
export const PUBLISHER_SET_VERSION = 2;
export const PRICE_UPDATE_MAGIC = "LOPU";
export const PRICE_UPDATE_VERSION = 1;
export const HEADER_LEN = 119;
export const MESSAGE_LEN = 86;
export const MESSAGE_TYPE_PRICE = 0;
export const PRICE_FEED_LEN = 129;
export const SIGNATURE_LEN = 65;
/** `leaf_count` is a u16, so no valid proof is deeper than 16 levels. */
export const MAX_PROOF_LEN = 16;
export const OBSERVATION_MAGIC = "LOOB";
export const OBSERVATION_VERSION = 1;
export const OBSERVATION_HEADER_LEN = 83;
export const OBSERVATION_ENTRY_LEN = 56;
