import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone — a self-contained server.js with only the traced modules
  // beside it — so the Docker runner stage can drop the toolchain and node_modules.
  // Vercel ignores this and builds its own way, so the two deployment paths coexist.
  output: "standalone",
};

export default nextConfig;
