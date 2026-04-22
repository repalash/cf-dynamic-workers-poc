import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  base: "/_teeny/admin/",
  plugins: [react(), cloudflare(), tailwindcss()],
  server: {
    // Allow tunnel hosts (cloudflared / ngrok / etc.) during dev.
    allowedHosts: true,
  },
})
