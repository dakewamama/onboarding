# Deploys payments/src/server.ts: the Paj webhook receiver AND (when
# SOLANA_RPC_URL is set) the additive USDC-on-Solana crypto-funding routes.
#
# Build context is the repo root (see railway.json) so this can copy the root
# tsconfig that payments/tsconfig.json extends. The Paj receiver itself uses only
# Node built-ins + fetch, but the crypto-funding flow reads the chain and builds
# transfer transactions, so @solana/web3.js + @solana/spl-token are installed as
# runtime deps here. The Anchor toolchain is still never installed.
FROM node:20-slim
WORKDIR /app

RUN npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund \
     ts-node@10 typescript@5 @types/node@20 \
     @solana/web3.js@1 @solana/spl-token@0.4

COPY tsconfig.json ./
COPY payments ./payments

# Railway injects PORT at runtime; this is just a local default.
ENV PORT=8080
EXPOSE 8080

# The crypto-funding deposit ledger is money: it must survive redeploys, not just
# process restarts. Default its store to /data and mark that a volume, so on
# Railway you attach a persistent volume at /data (Service -> Variables/Volumes ->
# mount path /data) and the ledger persists across deploys. Without a volume this
# path is still just ephemeral container disk, so DO attach one before mainnet.
# Override with FUNDING_STORE_DIR if you mount elsewhere.
ENV FUNDING_STORE_DIR=/data
VOLUME ["/data"]

CMD ["npx", "ts-node", "--project", "payments/tsconfig.json", "payments/src/server.ts"]
