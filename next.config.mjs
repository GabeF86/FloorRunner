/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: Next.js 14 only loads next.config.js / next.config.mjs (NOT .ts).
  // A prior next.config.ts set experimental.serverActions.allowedOrigins:
  // ['localhost:3000'] but it was silently ignored, so the app has always
  // run with Next's default serverActions origins. Re-add settings HERE if
  // needed (and use the real deployed origin, not just localhost).
};

export default nextConfig;
