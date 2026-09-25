//! Token-bucket rate limits per client: an API key's own limit, else the anonymous limit per IP.

export interface Limit {
  /** Sustained requests per second. */
  rps: number;
  /** Bucket size (short bursts). */
  burst: number;
  /** Concurrent websocket streams. */
  maxStreams: number;
}

export interface RateLimitConfig {
  anonymous: Limit;
  /** API key → its limit (sent as `x-api-key` or `?apiKey=`). */
  keys?: Record<string, Limit & { name?: string }>;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { anonymous: { rps: 10, burst: 20, maxStreams: 2 } };

interface Bucket {
  tokens: number;
  updatedMs: number;
  streams: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** The client identity and limit for a request: a known API key, else the IP. Unknown keys are rejected. */
  identify(ip: string, apiKey: string | undefined): { client: string; limit: Limit } | undefined {
    if (apiKey === undefined) return { client: `ip:${ip}`, limit: this.config.anonymous };
    const limit = this.config.keys?.[apiKey];
    return limit && { client: `key:${apiKey}`, limit };
  }

  /** Take one token. Returns 0 if allowed, else the seconds until the next token. */
  take(client: string, limit: Limit): number {
    const bucket = this.bucket(client, limit);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / limit.rps);
  }

  openStream(client: string, limit: Limit): boolean {
    const bucket = this.bucket(client, limit);
    if (bucket.streams >= limit.maxStreams) return false;
    bucket.streams++;
    return true;
  }

  closeStream(client: string): void {
    const bucket = this.buckets.get(client);
    if (bucket) bucket.streams = Math.max(0, bucket.streams - 1);
  }

  /** Forget idle, full buckets (call periodically). */
  sweep(): void {
    const now = this.now();
    for (const [client, bucket] of this.buckets) if (bucket.streams === 0 && now - bucket.updatedMs > 60_000) this.buckets.delete(client);
  }

  private bucket(client: string, limit: Limit): Bucket {
    const now = this.now();
    let bucket = this.buckets.get(client);
    if (!bucket) {
      bucket = { tokens: limit.burst, updatedMs: now, streams: 0 };
      this.buckets.set(client, bucket);
    }
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((now - bucket.updatedMs) / 1000) * limit.rps);
    bucket.updatedMs = now;
    return bucket;
  }
}
