//! Optional DNS-over-HTTPS resolution for exchange connections.
//!
//! Some networks block exchange domains at the resolver: lookups never answer, and because Node's
//! default `dns.lookup` runs on a small thread pool, hung lookups also delay every other lookup.
//! The DoH resolver queries a public resolver by IP (default `https://1.1.1.1/dns-query`), with a
//! hard timeout and a TTL cache.

import https from "node:https";
import type { LookupFunction } from "node:net";

export interface DnsConfig {
  mode: "system" | "doh";
  /** DoH JSON endpoint. Use an IP-addressed URL so the resolver itself needs no DNS. */
  dohUrl?: string;
  timeoutMs?: number;
}

interface Answer {
  addresses: { address: string; family: 4 | 6 }[];
  expiresAt: number;
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "application/dns-json" }, timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("DoH timeout")));
    request.on("error", reject);
  });
}

export class DohResolver {
  private readonly cache = new Map<string, Answer>();

  constructor(private readonly url = "https://1.1.1.1/dns-query", private readonly timeoutMs = 5000) {}

  async resolve(hostname: string): Promise<Answer["addresses"]> {
    const cached = this.cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;
    const query = async (type: "A" | "AAAA") => {
      const body = (await getJson(`${this.url}?name=${encodeURIComponent(hostname)}&type=${type}`, this.timeoutMs)) as { Answer?: { type: number; data: string; TTL: number }[] };
      return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => ({ address: a.data, family: (type === "A" ? 4 : 6) as 4 | 6, ttl: a.TTL }));
    };
    const [v4, v6] = await Promise.all([query("A"), query("AAAA").catch(() => [])]);
    const all = [...v4, ...v6];
    if (all.length === 0) throw new Error(`DoH: no address for ${hostname}`);
    const ttl = Math.min(...all.map((a) => a.ttl), 300);
    const addresses = all.map(({ address, family }) => ({ address, family }));
    this.cache.set(hostname, { addresses, expiresAt: Date.now() + Math.max(ttl, 30) * 1000 });
    return addresses;
  }

  /** A `lookup` for `net`/`tls`/`https`/`ws` options. */
  lookup: LookupFunction = (hostname, options, callback) => {
    this.resolve(hostname).then(
      (addresses) => {
        const family = typeof options === "object" ? options.family : undefined;
        const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0) return callback(Object.assign(new Error(`DoH: no IPv${family} address for ${hostname}`), { code: "ENOTFOUND" }), "", 4);
        if (typeof options === "object" && options.all) return (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
        callback(null, usable[0]!.address, usable[0]!.family);
      },
      (error: Error) => callback(Object.assign(error, { code: "ENOTFOUND" }), "", 4),
    );
  };
}

/** The lookup to use for exchange connections, or undefined for the system resolver. */
export function exchangeLookup(config: DnsConfig | undefined): LookupFunction | undefined {
  return config?.mode === "doh" ? new DohResolver(config.dohUrl, config.timeoutMs).lookup : undefined;
}

/** GET JSON over HTTPS with an optional custom lookup (for REST venues). */
export function httpsGetJson(url: string, lookup: LookupFunction | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: timeoutMs, ...(lookup ? { lookup } : {}) }, (response) => {
      if ((response.statusCode ?? 500) >= 400) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}
