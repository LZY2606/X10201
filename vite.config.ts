import { defineConfig } from "vite";
import { clinicApi } from "./src/server/api.js";

export default defineConfig({
  root: "src/web",
  publicDir: false,
  plugins: [clinicApi()],
  server: {
    host: "127.0.0.1",
    port: 5261,
    strictPort: true,
  },
  build: {
    outDir: "../../dist",
  },
});
