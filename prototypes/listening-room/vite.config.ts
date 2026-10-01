import { defineConfig, loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { musicPlugin } from "./server/music-plugin";

export default defineConfig(({ mode }) => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const env = loadEnv(mode, root, "PROTOTYPE_");
  const musicRoot = process.env.PROTOTYPE_MUSIC_ROOT ?? env.PROTOTYPE_MUSIC_ROOT ?? "";
  const dataDir = process.env.PROTOTYPE_DATA_DIR ?? env.PROTOTYPE_DATA_DIR ?? path.resolve(root, "../../artifacts/prototype-live-data");
  return {
  plugins: [react(), musicPlugin(musicRoot, dataDir)],
  base: "./",
  server: { host: "127.0.0.1", port: 4173, strictPort: true, watch: { usePolling: true } },
  build: { outDir: "dist", emptyOutDir: true }
  };
});
