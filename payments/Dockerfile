# Deploys ONLY the Paj webhook receiver (payments/src/server.ts).
#
# Build context is the repo root (see railway.json) so this can copy the root
# tsconfig that payments/tsconfig.json extends. The receiver has no runtime npm
# dependencies beyond ts-node + typescript + node types — it uses Node built-ins
# and global fetch — so the Anchor/Solana toolchain is never installed here.
FROM node:20-slim
WORKDIR /app

RUN npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund ts-node@10 typescript@5 @types/node@20

COPY tsconfig.json ./
COPY payments ./payments

# Railway injects PORT at runtime; this is just a local default.
ENV PORT=8080
EXPOSE 8080

CMD ["npx", "ts-node", "--project", "payments/tsconfig.json", "payments/src/server.ts"]
