import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  distDir: 'dist',
  // Only use basePath in production for GitHub Pages
  basePath: isProd && isGitHubPages ? '/pdf-editor-ui' : '',
  assetPrefix: isProd && isGitHubPages ? '/pdf-editor-ui/' : '',
  images: {
    unoptimized: true
  }
};

export default nextConfig;
