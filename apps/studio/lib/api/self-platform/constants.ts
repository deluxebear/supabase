// [self-platform] Server-side env for the platform control-plane stack.
// Hosts are as seen FROM the pg-meta container (docker network DNS).
export const PLATFORM_POSTGRES_HOST = process.env.PLATFORM_POSTGRES_HOST || 'platform-db'
export const PLATFORM_POSTGRES_PORT = parseInt(process.env.PLATFORM_POSTGRES_PORT || '5432', 10)
export const PLATFORM_POSTGRES_DB = process.env.PLATFORM_POSTGRES_DB || 'platform'
export const PLATFORM_POSTGRES_USER = process.env.PLATFORM_POSTGRES_USER || 'postgres'
export const PLATFORM_POSTGRES_PASSWORD = process.env.PLATFORM_POSTGRES_PASSWORD || ''
// As seen from the Studio server process (host in dev, container in docker).
export const PLATFORM_GOTRUE_URL = process.env.PLATFORM_GOTRUE_URL || 'http://localhost:8110'
