import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": target,
      "/admin": target,
      "/healthz": target,
    },
  },
});
