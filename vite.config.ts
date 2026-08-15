import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  // Prevent Vite from clearing the terminal so Tauri logs remain visible
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    // Tauri dev server expects the frontend on localhost
    host: false,
    // Optimize dev server performance
    hmr: {
      overlay: false,
    },
    watch: {
      // Reduce file watching overhead
      ignored: ['**/node_modules/**', '**/src-tauri/**'],
    },
  },

  // Default Vite is only VITE_; Tauri needs TAURI_* too. Both required —
  // otherwise VITE_FORCE_PLATFORM from .env.mobile never reaches the client.
  envPrefix: ["VITE_", "TAURI_"],

  build: {
    // Tauri uses Chromium on Windows/Linux and WebKit on macOS
    // chrome105 同时保留 -webkit-/无前缀 backdrop-filter，避免毛玻璃被构建剥掉
    target: "chrome105",
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    // Minify for production
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor chunks for caching
          react: ["react", "react-dom"],
          xterm: [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-web-links",
            "@xterm/addon-webgl",
          ],
        },
      },
    },
  },
});
