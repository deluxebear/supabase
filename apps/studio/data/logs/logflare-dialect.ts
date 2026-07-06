import { IS_PLATFORM } from 'common'

import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// [self-platform] M6.2 (spec D7): a non-cloud Studio talks to a Logflare
// postgres backend whose BQ→PG translator rejects `cast(… as datetime)` and
// novel group-by aliases, and SILENTLY mis-groups alias-shadowed columns —
// PG-safe variants use ordinals and no datetime casts (all equally valid
// BigQuery). Cloud (IS_PLATFORM && !IS_SELF_PLATFORM) keeps the original
// BQ text byte-identically. NOTE: a self-platform build sets BOTH flags.
export const USE_LOGFLARE_PG_SQL = IS_SELF_PLATFORM || !IS_PLATFORM

export const pickDialect = <T>(pg: T, bq: T): T => (USE_LOGFLARE_PG_SQL ? pg : bq)
