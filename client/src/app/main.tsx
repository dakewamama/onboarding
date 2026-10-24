import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { config } from "../config";

// Privy provides the embedded Solana wallet (phone login, no seed phrase).
// In dev-signer mode there's no app id and Privy is inert; the dev keypair drives
// signing instead (see signer/useSigner).
const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <PrivyProvider
      appId={config.privyAppId ?? "dev"}
      config={{ embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } } }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
