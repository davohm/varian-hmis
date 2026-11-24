import type { NextConfig } from "next";

// Keep the dev server's chunks out of the production build directory. Running
// `next build` while `next dev` is live previously left both sharing `.next`,
// which caused "Cannot find module './4887.js'" at runtime.
const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
};

export default nextConfig;
