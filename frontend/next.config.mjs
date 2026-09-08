import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
    outputFileTracingRoot: repoRoot,
    async rewrites() {
        return { beforeFiles: [{ source: "/", destination: "/site/index.html" }], afterFiles: [
            {
                source: '/api/hunter/:path*',
                destination: `${process.env.HUNTER_INTERNAL_URL ?? 'http://localhost:3002'}/:path*`,
            },
            {
                source: '/api/registry/:path*',
                destination: `${process.env.REGISTRY_INTERNAL_URL ?? 'http://localhost:3003'}/:path*`,
            },
            {
                source: '/api/auditor/:path*',
                destination: `${process.env.WRITER_INTERNAL_URL ?? 'http://localhost:3001'}/:path*`,
            },
        ], fallback: [] };
    },
};

export default nextConfig;
