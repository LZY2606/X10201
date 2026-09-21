import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: { host: "127.0.0.1", port: 5261, strictPort: true },
  test: { include: ["tests/**/*.test.ts"] },
});
