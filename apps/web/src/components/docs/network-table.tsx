import { DEPLOYMENTS, leanOracleTestnetPreset } from "lean-oracle-sdk/presets";
import { CopyValue } from "./copy";

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <tr className="border-t border-border">
    <td className="w-[38%] px-4 py-2.5 text-muted-foreground">{label}</td>
    <td className="px-3 py-2">{children}</td>
  </tr>
);

/** The live testnet deployment, straight from the SDK's deployment record (deployments/testnet.json). */
export function NetworkTable() {
  const d = DEPLOYMENTS.testnet;
  if (!d) return null;
  const contracts = [
    ["price_feed_type", d.contracts.priceFeedType],
    ["publisher_set_type", d.contracts.publisherSetType],
  ] as const;
  return (
    <div className="not-prose my-6 space-y-6">
      {contracts.map(([name, c]) => (
        <div key={name} className="overflow-x-auto rounded-xl border border-border">
          <div className="bg-card px-4 py-2.5 font-mono text-[13px]">{name} <span className="text-muted-foreground">· version {c.version}</span></div>
          <table className="w-full text-sm">
            <tbody>
              <Row label="Code hash"><CopyValue value={c.codeHash} /></Row>
              <Row label="Hash type"><span className="px-1 font-mono text-[13px]">{c.hashType}</span></Row>
              <Row label="Cell dep tx hash"><CopyValue value={c.cellDep.outPoint.txHash} /></Row>
              <Row label="Cell dep index / type"><span className="px-1 font-mono text-[13px]">{String(c.cellDep.outPoint.index)} · {c.cellDep.depType}</span></Row>
            </tbody>
          </table>
        </div>
      ))}
      <div className="overflow-x-auto rounded-xl border border-border">
        <div className="bg-card px-4 py-2.5 text-[13px] font-medium">Committees</div>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(d.committees).map(([name, c]) => (
              <Row key={name} label={`${name} · type hash`}><CopyValue value={c.typeHash} /></Row>
            ))}
            <Row label="Mirror"><span className="px-1 font-mono text-[13px]">{leanOracleTestnetPreset.mirrorUrls[0]}</span></Row>
            <Row label="CKB RPC"><span className="px-1 font-mono text-[13px]">{leanOracleTestnetPreset.ckbRpcUrl}</span></Row>
          </tbody>
        </table>
      </div>
    </div>
  );
}
