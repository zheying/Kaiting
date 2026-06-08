import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.API_PORT ?? process.env.PORT ?? 3000}`
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
