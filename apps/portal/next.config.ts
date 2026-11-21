import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@aleph-connector/identity'],
  webpack: (config) => {
    // Workspace packages export `.js` paths that resolve to `.ts` sources (Bun-style).
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx']
    }
    return config
  }
}

export default nextConfig
