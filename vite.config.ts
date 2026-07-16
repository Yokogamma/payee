import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { parseTrustedOwners } from "./src/lib/trusted-owners";

export default defineConfig(({ command, mode }) => {
  // Fail-closed at build time (C2): production must pin a valid trusted wallet
  // set, otherwise restore would trust arbitrary on-chain transactions.
  // loadEnv reads .env files + process.env the same way the client build does,
  // and parseTrustedOwners is the SAME validator the runtime uses (format-checked).
  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "");
    const owners = parseTrustedOwners(env.VITE_TRUSTED_OWNERS ?? "");
    if (owners.length === 0) {
      throw new Error(
        "VITE_TRUSTED_OWNERS is empty. Set the proxy wallet address(es) before building — " +
          "restore requires a pinned root of trust.",
      );
    }
  }

  return {
    plugins: [react()],
    base: "/payee/", // ← имя репозитория на GitHub
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
