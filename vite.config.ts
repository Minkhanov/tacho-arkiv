import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The inspector is a static site: relative base so it works on GitHub Pages under /<repo>/.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  server: { port: 5173 },
})
