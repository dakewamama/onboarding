import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// HTTPS is required by Privy in production; dev is allowed on http://localhost.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Optional Privy on-ramp peer dep we don't use; keep it out of the bundle.
  build: { rollupOptions: { external: ["@stripe/stripe-js"] } },
});
