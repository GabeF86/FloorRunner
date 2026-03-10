import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Required for Supabase real-time websockets
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
}

export default nextConfig
