/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output as standalone for Vercel deployment
  output: 'standalone',
  // Allow Firebase Storage images
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
      },
    ],
  },
};

module.exports = nextConfig;
