//! Committee cell reads over CKB JSON-RPC (indexer `get_cells`), without a CKB SDK dependency.

import { decodePublisherSetData, type Hex, type PublisherSetData } from "lean-oracle-sdk/protocol";

export interface ScriptJson {
  codeHash: Hex;
  hashType: "type" | "data" | "data1" | "data2";
  args: Hex;
}

/** The live committee cell's data for `typeScript`; throws unless exactly one exists. */
export async function fetchCommitteeData(rpcUrl: string, typeScript: ScriptJson, fetchFn: typeof fetch = fetch): Promise<{ data: PublisherSetData; outPoint: string }> {
  const response = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "get_cells",
      params: [
        { script: { code_hash: typeScript.codeHash, hash_type: typeScript.hashType, args: typeScript.args }, script_type: "type", script_search_mode: "exact" },
        "asc",
        "0x2",
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: { objects: { output_data: Hex; out_point: { tx_hash: string; index: string } }[] }; error?: unknown };
  if (!body.result) throw new Error(`get_cells failed: ${JSON.stringify(body.error)}`);
  if (body.result.objects.length !== 1) throw new Error(`expected one committee cell, found ${body.result.objects.length}`);
  const cell = body.result.objects[0]!;
  return { data: decodePublisherSetData(cell.output_data), outPoint: `${cell.out_point.tx_hash}:${cell.out_point.index}` };
}
