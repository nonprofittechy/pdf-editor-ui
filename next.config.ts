import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  distDir: 'dist',
  basePath: '/pdf-editor-ui',
  assetPrefix: '/pdf-editor-ui/',
  images: {
    unoptimized: true
  }
};

export default nextConfig;
