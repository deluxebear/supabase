// [self-platform] Single definition of the self-hosted-platform-mode flag.
// True only when this Studio build runs its own in-repo platform API
// (IS_PLATFORM=true against pages/api/platform/**). Build-time inlined.
export const IS_SELF_PLATFORM = process.env.NEXT_PUBLIC_SELF_PLATFORM === 'true'
