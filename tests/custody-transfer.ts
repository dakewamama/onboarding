import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  CustodyTransferConflict,
  CustodyTransferNotFound,
  CustodyTransferService,
  type CustodyTransferInput,
} from "../payments/src/custodyTransfer";
import { DepositLedger } from "../payments/src/funding/depositLedger";
import {
  InsufficientBalanceError,
  SpendLedger,
} from "../payments/src/funding/spendLedger";

function base58(bytes: Uint8Array): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;

  return (
    "1".repeat(zeroes) +
    digits
      .reverse()
      .map((d) => alphabet[d])
      .join("")
  );
}

class FakeChain {
  sent = 0;
  throwOnSend = false;
  verdict: "none" | "confirmed" | "finalized" | "failed" = "none";
  height = 100;
  blockGate: Promise<void> = Promise.resolve();

  async getLatestBlockhash() {
    await this.blockGate;
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999999999,
    };
  }

  async getBlockHeight() {
    return this.height;
  }

  async sendRawTransaction(raw: Buffer | Uint8Array) {
    this.sent++;
    const tx = Transaction.from(Buffer.from(raw));
    if (!tx.signature) throw new Error("missing transaction signature");

    const signature = base58(tx.signature);
    if (this.throwOnSend) {
      throw new Error("simulated transport timeout");
    }
    return signature;
  }

  async getSignatureStatuses() {
    if (this.verdict === "none") return { value: [null] };

    if (this.verdict === "failed") {
      return {
        value: [
          {
            err: { InstructionError: [1, "Custom"] },
            confirmationStatus: "finalized" as const,
          },
        ],
      };
    }

    return {
      value: [
        {
          err: null,
          confirmationStatus: this.verdict,
        },
      ],
    };
  }
}

function fixture(balance = 2_000_000n, abandonAfterMs?: number) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "axis-custody-transfer-"),
  );
  const user = Keypair.generate();
  const operator = Keypair.generate();
  const destination = Keypair.generate().publicKey;
  const chain = new FakeChain();

  new DepositLedger(dir).credit({
    signature: "deposit-1",
    owner: user.publicKey.toBase58(),
    baseUnits: balance.toString(),
    commitment: "finalized",
  });

  const service = new CustodyTransferService({
    connection: chain,
    storeDir: dir,
    mint: new PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ),
    commitment: "finalized",
    operator,
    walletAddressFor: () => user.publicKey.toBase58(),
    withUserKeypair: async (_store, _owner, fn) => fn(user),
    env: {},
    ...(abandonAfterMs === undefined ? {} : { abandonAfterMs }),
  });

  const input: CustodyTransferInput = {
    owner: "web:test",
    asset: "USDC",
    network: "SOLANA",
    destination: destination.toBase58(),
    amountMinor: "1000000",
    maxDebitMinor: "1100000",
    idempotencyKey: "merchant:action-1",
  };

  return {
    dir,
    user,
    chain,
    service,
    input,
    spends: new SpendLedger(dir),
    deposits: new DepositLedger(dir),
  };
}

function includes(actual: object, expected: Record<string, unknown>) {
  const picked = Object.fromEntries(Object.keys(expected).map(k => [k, (actual as Record<string, unknown>)[k]]));
  assert.deepEqual(picked, expected);
}

describe("custody transfer contract", () => {
  it("uses the same SpendLedger as wallet balance", async () => {
    const f = fixture();

    try {
      const first = await f.service.transfer(f.input);
      const second = await f.service.transfer(f.input);

      assert.equal(f.chain.sent, 1);
      assert.equal(first.requestId, second.requestId);
      assert.ok(first.signature);

      const spend = f.spends.get(
        f.user.publicKey.toBase58(),
        f.input.idempotencyKey,
      );

      assert.ok(spend);
      assert.equal(spend.paidBaseUnits, "1000000");
      assert.equal(spend.state, "IN_DOUBT");

      const spendable =
        f.deposits.balanceBaseUnits(f.user.publicKey.toBase58()) -
        f.spends.spentBaseUnits(f.user.publicKey.toBase58());

      assert.equal(spendable, 1000000n);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("fails insufficient balance before any broadcast", async () => {
    const f = fixture(500000n);

    try {
      await assert.rejects(
        () => f.service.transfer(f.input),
        InsufficientBalanceError,
      );
      assert.equal(f.chain.sent, 0);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("rejects changed amount on the same key", async () => {
    const f = fixture();

    try {
      await f.service.transfer(f.input);

      await assert.rejects(
        () =>
          f.service.transfer({
            ...f.input,
            amountMinor: "1000001",
          }),
        CustodyTransferConflict,
      );

      assert.equal(f.chain.sent, 1);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("rejects changed destination on the same key", async () => {
    const f = fixture();

    try {
      await f.service.transfer(f.input);

      await assert.rejects(
        () =>
          f.service.transfer({
            ...f.input,
            destination: Keypair.generate().publicKey.toBase58(),
          }),
        CustodyTransferConflict,
      );

      assert.equal(f.chain.sent, 1);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("never resubmits an ambiguous signed transaction", async () => {
    const f = fixture();

    try {
      f.chain.throwOnSend = true;
      const first = await f.service.transfer(f.input);

      assert.equal(first.status, "in_doubt");
      assert.ok(first.signature);
      assert.equal(f.chain.sent, 1);

      f.chain.throwOnSend = false;
      const second = await f.service.transfer(f.input);

      assert.equal(second.status, "in_doubt");
      assert.equal(second.signature, first.signature);
      assert.equal(f.chain.sent, 1);

      assert.equal(
        f.spends.get(
          f.user.publicKey.toBase58(),
          f.input.idempotencyKey,
        )?.state,
        "IN_DOUBT",
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("settles only the persisted signature at finality", async () => {
    const f = fixture();

    try {
      const submitted = await f.service.transfer(f.input);
      f.chain.verdict = "finalized";

      const settled = await f.service.status(f.input.idempotencyKey);

      assert.equal(settled.status, "settled");
      assert.equal(settled.signature, submitted.signature);
      assert.equal(f.chain.sent, 1);

      assert.equal(
        f.spends.get(
          f.user.publicKey.toBase58(),
          f.input.idempotencyKey,
        )?.state,
        "SETTLED",
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("does not treat confirmed as settled", async () => {
    const f = fixture();

    try {
      await f.service.transfer(f.input);
      f.chain.verdict = "confirmed";

      const pending = await f.service.status(f.input.idempotencyKey);

      assert.equal(pending.status, "pending");
      assert.equal(
        f.spends.get(
          f.user.publicKey.toBase58(),
          f.input.idempotencyKey,
        )?.state,
        "PENDING",
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("reverses only finalized chain failure", async () => {
    const f = fixture();

    try {
      await f.service.transfer(f.input);
      f.chain.verdict = "failed";

      const failed = await f.service.status(f.input.idempotencyKey);

      assert.equal(failed.status, "failed");
      assert.equal(
        f.spends.get(
          f.user.publicKey.toBase58(),
          f.input.idempotencyKey,
        )?.state,
        "REVERSED",
      );

      assert.equal(
        f.spends.spentBaseUnits(f.user.publicKey.toBase58()),
        0n,
      );
      assert.equal(f.chain.sent, 1);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("concurrent duplicate callers submit once", async () => {
    const f = fixture();

    try {
      const [a, b] = await Promise.all([
        f.service.transfer(f.input),
        f.service.transfer(f.input),
      ]);

      assert.equal(a.requestId, b.requestId);
      assert.equal(f.chain.sent, 1);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("voids an unknown intent so a late transfer with its key cannot move funds", async () => {
    const f = fixture();
    try {
      const status = await f.service.status("merchant:action-1");
      includes(status, { status: "failed", moneyState: "RELEASED", reason: "not_submitted" });
      await assert.rejects(() => f.service.transfer(f.input), CustodyTransferConflict);
      assert.equal(f.chain.sent, 0);
      assert.equal(f.spends.spentBaseUnits(f.user.publicKey.toBase58()).toString(), "0");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("insufficient balance is a definitive release that debits nothing", async () => {
    const f = fixture(10n);
    try {
      await assert.rejects(() => f.service.transfer(f.input), InsufficientBalanceError);
      includes(await f.service.status(f.input.idempotencyKey), { status: "failed", moneyState: "RELEASED", reason: "insufficient_balance" });
      assert.equal(f.chain.sent, 0);
      assert.equal(f.spends.spentBaseUnits(f.user.publicKey.toBase58()).toString(), "0");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("an unknown signature stays in doubt until its blockhash expires, then releases", async () => {
    const f = fixture();
    try {
      f.chain.throwOnSend = true;
      assert.equal((await f.service.transfer(f.input)).moneyState, "IN_DOUBT");
      const owner = f.user.publicKey.toBase58();
      f.chain.height = 999999999;
      assert.equal((await f.service.status(f.input.idempotencyKey)).moneyState, "IN_DOUBT");
      assert.equal(f.spends.spentBaseUnits(owner).toString(), "1000000");
      f.chain.height = 1000000000;
      includes(await f.service.status(f.input.idempotencyKey), { status: "failed", moneyState: "RELEASED", reason: "expired" });
      assert.equal(f.spends.spentBaseUnits(owner).toString(), "0");
      f.chain.verdict = "finalized";
      assert.equal((await f.service.status(f.input.idempotencyKey)).moneyState, "RELEASED", "terminal verdicts never reopen");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("a claim abandoned before signing is released and can never broadcast afterwards", async () => {
    const f = fixture(2_000_000n, 0);
    try {
      let open!: () => void;
      f.chain.blockGate = new Promise<void>(resolve => { open = resolve; });
      const inFlight = f.service.transfer(f.input);
      await new Promise(resolve => setTimeout(resolve, 20));
      includes(await f.service.status(f.input.idempotencyKey), { status: "failed", moneyState: "RELEASED", reason: "not_broadcast" });
      open();
      assert.equal((await inFlight).moneyState, "RELEASED");
      assert.equal(f.chain.sent, 0);
      assert.equal(f.spends.spentBaseUnits(f.user.publicKey.toBase58()).toString(), "0");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("a young unsigned claim is left alone while the transfer is still signing", async () => {
    const f = fixture();
    try {
      let open!: () => void;
      f.chain.blockGate = new Promise<void>(resolve => { open = resolve; });
      const inFlight = f.service.transfer(f.input);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((await f.service.status(f.input.idempotencyKey)).moneyState, "IN_DOUBT");
      open();
      await inFlight;
      assert.equal(f.chain.sent, 1);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
