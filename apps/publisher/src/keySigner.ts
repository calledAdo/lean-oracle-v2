//! Where the publisher key lives. Everything the publisher signs goes through a `KeySigner`, so the
//! key can stay in a file or inside a KMS/HSM.

import { readFileSync } from "node:fs";

import { hexToBytes, isHex, type Hex } from "lean-oracle-sdk/protocol";
import { compressPublicKey, publicKeyOf, signDigest, toRecoverableSignature } from "lean-oracle-sdk/publisher";

export interface KeySigner {
  readonly publicKey: Hex;
  /** 65-byte recoverable low-S signature over a 32-byte digest. */
  sign(digest: Hex): Promise<Hex>;
}

export type KeyConfig =
  | { type: "file"; path: string }
  /** AWS KMS asymmetric key with key spec ECC_SECG_P256K1 and usage SIGN_VERIFY. */
  | { type: "aws-kms"; keyId: string; region?: string };

export class FileKeySigner implements KeySigner {
  readonly publicKey: Hex;
  private readonly key: Hex;

  constructor(path: string) {
    const key = readFileSync(path, "utf8").trim().toLowerCase();
    if (!isHex(key) || key.length !== 66) throw new Error("key file must contain a 32-byte 0x-hex private key");
    this.key = key;
    this.publicKey = publicKeyOf(key);
  }

  async sign(digest: Hex): Promise<Hex> {
    return signDigest(digest, this.key);
  }
}

/** Minimal slice of the AWS KMS client used here (lets tests supply a fake). */
export interface KmsLike {
  send(command: unknown): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array }>;
}

export class AwsKmsSigner implements KeySigner {
  private constructor(
    readonly publicKey: Hex,
    private readonly kms: KmsLike,
    private readonly keyId: string,
    private readonly commands: { Sign: new (input: unknown) => unknown },
  ) {}

  static async create(keyId: string, region?: string, client?: KmsLike): Promise<AwsKmsSigner> {
    const sdk = await import("@aws-sdk/client-kms");
    const kms = client ?? (new sdk.KMSClient(region ? { region } : {}) as unknown as KmsLike);
    const { PublicKey } = await kms.send(new sdk.GetPublicKeyCommand({ KeyId: keyId }));
    if (!PublicKey) throw new Error("KMS returned no public key");
    return new AwsKmsSigner(compressPublicKey(PublicKey), kms, keyId, { Sign: sdk.SignCommand as never });
  }

  async sign(digest: Hex): Promise<Hex> {
    const { Signature } = await this.kms.send(
      new this.commands.Sign({ KeyId: this.keyId, Message: hexToBytes(digest), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
    );
    if (!Signature) throw new Error("KMS returned no signature");
    return toRecoverableSignature(Signature, digest, this.publicKey);
  }
}

export async function createKeySigner(config: KeyConfig): Promise<KeySigner> {
  return config.type === "aws-kms" ? AwsKmsSigner.create(config.keyId, config.region) : new FileKeySigner(config.path);
}
