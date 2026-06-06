import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-ignore process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss({
    // Tailwind CSS v4 不需要配置文件路径，配置通过 CSS 中的 @config 指令指定
  })],

  resolve: {
    alias: {
      "@": "/src",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
   // ✅ 新增：显式指定构建输出目录（关键！）
  build: {
    outDir: "dist",       // 强制输出到 ./dist
    emptyOutDir: true,    // 构建前清空目录，避免旧文件残留
    sourcemap: false,     // CI 无需 sourcemap，加快构建
  },
}));
