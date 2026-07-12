/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: Next.js 14 only loads next.config.js / next.config.mjs (NOT .ts).
  // A prior next.config.ts set experimental.serverActions.allowedOrigins:
  // ['localhost:3000'] but it was silently ignored, so the app has always
  // run with Next's default serverActions origins. Re-add settings HERE if
  // needed (and use the real deployed origin, not just localhost).
  experimental: {
    // The LLM system prompts are .md files read with fs at runtime
    // (loadSystemPrompt in scheduleAssistant/assistant.ts and
    // gridCalculator/rulesNormalizer.ts). Vercel's file tracing can't follow
    // those dynamic paths, so without this the files are missing from the
    // serverless bundle (/var/task) and the routes 500 in production.
    outputFileTracingIncludes: {
      '/api/**/*': [
        './src/lib/scheduleAssistant/prompts/**/*',
        './src/lib/gridCalculator/prompts/**/*',
      ],
    },
  },
};

export default nextConfig;
