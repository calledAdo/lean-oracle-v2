export type Hex = `0x${string}`;
export interface Script { codeHash: Hex; hashType: "type" | "data" | "data1" | "data2"; args: Hex }
export interface CellDepInfo { outPoint: { txHash: Hex; index: number }; depType: "code" | "depGroup" }
export interface OracleDeployment {
  publisherSetTypeCodeHash: Hex;
  priceFeedTypeCodeHash: Hex;
}
