import { useCallback, useEffect, useState } from "react";
import { useSigner } from "../signer/useSigner";
import { buildDeposit } from "../tx/deposit";
import { buildWithdraw } from "../tx/withdraw";
import { submit } from "../tx/submit";
import { fetchPosition, type PositionView } from "../reads/position";
import { fetchPool, type PoolView } from "../reads/pool";
import { USDC_DECIMALS, config } from "../config";

const UNIT = 10n ** BigInt(USDC_DECIMALS);
const toBase = (usdc: string) => BigInt(Math.round(Number(usdc) * Number(UNIT)));
const fmt = (v: bigint) => (Number(v) / Number(UNIT)).toFixed(2);

export function App() {
  const signer = useSigner();
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [pool, setPool] = useState<PoolView | null>(null);
  const [position, setPosition] = useState<PositionView | null>(null);

  const refresh = useCallback(async () => {
    setPool(await fetchPool());
    if (signer.address) setPosition(await fetchPosition(signer.address));
  }, [signer.address]);

  useEffect(() => {
    refresh().catch((e) => setStatus(String(e)));
  }, [refresh]);

  const run = useCallback(
    async (kind: "deposit" | "withdraw") => {
      if (!signer.address) return;
      setBusy(true);
      setStatus(`building ${kind}…`);
      try {
        const base = toBase(amount);
        const tx =
          kind === "deposit"
            ? await buildDeposit(signer.address, base)
            : await buildWithdraw(signer.address, base);
        setStatus("waiting for your signature…");
        const signed = await signer.signTransaction(tx);
        setStatus("submitting via sponsor…");
        const sig = await submit(signed);
        setStatus(`${kind} confirmed: ${sig}`);
        await refresh();
      } catch (e) {
        setStatus(String(e));
      } finally {
        setBusy(false);
      }
    },
    [signer, amount, refresh],
  );

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 560, margin: "40px auto", padding: 16 }}>
      <h1>onboarding pool</h1>

      {!signer.connected ? (
        <button onClick={() => signer.connect()}>connect wallet</button>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "#555" }}>
            {signer.address}{" "}
            <button onClick={() => signer.disconnect()}>disconnect</button>
          </p>

          <section style={{ margin: "16px 0" }}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              style={{ width: 120 }}
            />{" "}
            USDC
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button disabled={busy} onClick={() => run("deposit")}>
                deposit
              </button>
              <button disabled={busy} onClick={() => run("withdraw")}>
                withdraw
              </button>
            </div>
            <p style={{ fontSize: 12, color: "#888" }}>
              a {fmt(config.feeAmount)} USDC service fee applies. withdrawing
              forfeits accrued points.
            </p>
          </section>

          <section style={{ fontSize: 14 }}>
            <div>principal: {position ? fmt(position.principal) : "0.00"} USDC</div>
            <div>points: {position ? position.projectedUnits.toString() : "0"}</div>
          </section>
        </>
      )}

      {pool?.paused && <p style={{ color: "#b00" }}>pool is paused</p>}
      {status && <p style={{ fontSize: 12, color: "#333", wordBreak: "break-all" }}>{status}</p>}
    </main>
  );
}
