/**
 * Minimal HTTP wrapper around the custody service (devnet prototype). Uses the
 * built-in http module to avoid extra deps; in production this would be a proper
 * framework behind auth, TLS, rate limiting, and per-route authorization.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com yarn run custody-server
 *
 * Routes:
 *   POST /users                       { userId }
 *   POST /users/:id/authorize         { scope: [...], maxAmountPerTx? }
 *   POST /users/:id/deposit           { mint, pool, amount }
 *   POST /users/:id/withdraw          { mint, pool, amount }
 *   GET  /users/:id/position?pool=... -> { principal }
 */
import * as http from "http";
import { PublicKey } from "@solana/web3.js";
import { connection, loadOperatorKeypair } from "./config";
import { CustodyService } from "./service";

const svc = new CustodyService(connection(), loadOperatorKeypair());
const PORT = Number(process.env.PORT ?? 8787);

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "POST" && parts.length === 1 && parts[0] === "users") {
      const { userId } = await readBody(req);
      return send(res, 201, svc.createUser(userId));
    }

    if (parts[0] === "users" && parts.length === 3) {
      const userId = parts[1];
      const action = parts[2];
      if (method === "POST" && action === "authorize") {
        const { scope, maxAmountPerTx } = await readBody(req);
        return send(res, 200, svc.authorize(userId, scope, maxAmountPerTx ?? 0));
      }
      if (method === "POST" && (action === "deposit" || action === "withdraw")) {
        const { mint, pool, amount } = await readBody(req);
        const mintPk = new PublicKey(mint);
        const poolPk = new PublicKey(pool);
        const sig =
          action === "deposit"
            ? await svc.deposit(userId, mintPk, poolPk, Number(amount))
            : await svc.withdraw(userId, mintPk, poolPk, Number(amount));
        return send(res, 200, { sig });
      }
      if (method === "GET" && action === "position") {
        const pool = new PublicKey(url.searchParams.get("pool") ?? "");
        return send(res, 200, {
          principal: await svc.positionPrincipal(userId, pool),
        });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`custody service listening on http://localhost:${PORT}`);
});
