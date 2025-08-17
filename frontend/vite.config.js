import { defineConfig } from "vite";

export default defineConfig({
  root: ".",             // where your index.html lives
  publicDir: "public",   // static assets (earth.jpg, geojson, centroids.json)
  build: {
    outDir: "dist",      // Vercel expects dist/
    sourcemap: true
  },
  server: {
    port: 5173
  }
});
