import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles the UI (mcp-app.html + src/mcp-app.ts) into ONE self-contained
// file at dist/mcp-app.html, which the MCP server serves to the host.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: "mcp-app.html" },
  },
});
