# To be run in the root of the turbo monorepo
# NOTE: It's highly recommended to use the new builder, Buildkit. https://docs.docker.com/build/buildkit/
## USAGE:
# Build:        docker build . -f apps/studio/Dockerfile --target production -t studio:latest
# Run:          docker run -p 3000:3000 supabase/studio
# Deploy:       docker push supabase/studio:latest
# Clean build:
#    docker builder prune
#    docker build . -f apps/studio/Dockerfile --target production -t studio:latest --no-cache

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Fixes issues with Sentry CLI and SSL certificates during build
# TODO: Git is added because it's needed to build libpg, remove it once they publish a binary on the S3 bucket
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  git \
  python3 \
  ca-certificates \
  build-essential && \
  rm -rf /var/lib/apt/lists/* && \
  update-ca-certificates

RUN npm install -g pnpm@10.24.0

WORKDIR /app

# Prune unneeded dependencies with turbo (from apps/ for example)
FROM base AS turbo
COPY . .

RUN pnpm dlx turbo@2.9.14 prune studio --docker

# Install dev dependencies (only if needed)
FROM base AS deps
COPY --from=turbo /app/out/json ./
COPY --from=turbo /app/out/pnpm-lock.yaml ./
COPY ./patches/ ./patches

# No need to clean cache because production uses standalone build
RUN pnpm install --frozen-lockfile

# dev contains dependencies and source code not compiled
FROM deps AS dev
COPY --from=turbo /app/out/full ./
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 8082
CMD ["pnpm", "dev:studio"]

# Compile Next.js
FROM dev AS builder

# Self-hosted-platform build flags. Next.js inlines NEXT_PUBLIC_* at build time,
# so the platform variant must be compiled with the platform flags set. Left
# unset (the default) the image builds as plain self-hosted Studio — identical
# to the upstream supabase/studio image.
#   NEXT_PUBLIC_IS_PLATFORM      "true" enables platform (control-plane) mode
#   NEXT_PUBLIC_SELF_PLATFORM    "true" enables the in-repo platform API
#   NEXT_PUBLIC_STUDIO_AUTH_MODE studio auth mode (optional)
#
# The platform URLs are DEPLOY-TIME config: they default to absolute placeholder
# URLs so the build (which statically prerenders pages — a relative "/api" throws
# "Invalid URL" during SSR) succeeds, and docker-entrypoint.sh rewrites the
# placeholders to the real NEXT_PUBLIC_API_URL / NEXT_PUBLIC_GOTRUE_URL from the
# container's runtime env. So a single platform image works for any deployment —
# set the URLs when you `docker run` it, not at build time.
#   NEXT_PUBLIC_API_URL          platform API base   (runtime env at deploy)
#   NEXT_PUBLIC_GOTRUE_URL       platform login GoTrue (runtime env at deploy)
#   NEXT_PUBLIC_SITE_URL         dashboard site URL  (optional)
ARG NEXT_PUBLIC_IS_PLATFORM
ARG NEXT_PUBLIC_SELF_PLATFORM
ARG NEXT_PUBLIC_API_URL=https://studio-runtime-origin.invalid/api
ARG NEXT_PUBLIC_GOTRUE_URL=https://gotrue-runtime-origin.invalid
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_STUDIO_AUTH_MODE
ENV NEXT_PUBLIC_IS_PLATFORM=${NEXT_PUBLIC_IS_PLATFORM} \
    NEXT_PUBLIC_SELF_PLATFORM=${NEXT_PUBLIC_SELF_PLATFORM} \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_GOTRUE_URL=${NEXT_PUBLIC_GOTRUE_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_STUDIO_AUTH_MODE=${NEXT_PUBLIC_STUDIO_AUTH_MODE}

RUN pnpm --filter studio exec next build

# Copy only compiled code and dependencies
FROM base AS production
COPY --from=builder /app/apps/studio/public ./apps/studio/public
COPY --from=builder /app/apps/studio/.next/standalone ./
COPY --from=builder /app/apps/studio/.next/static ./apps/studio/.next/static
# The standalone build never bundles apps/studio/docker-entrypoint.sh, and it is not
# on PATH, so the bare `docker-entrypoint.sh` below silently resolved to the node base
# image's own entrypoint — our script never ran. Copy it onto PATH (overriding node's)
# so the runtime NEXT_PUBLIC_* substitution and file_env secret handling execute at
# container start.
COPY --chmod=0755 apps/studio/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
HEALTHCHECK --interval=5s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/api/platform/profile').then((r) => {if (r.status !== 200) throw new Error(r.status)})"
CMD ["node", "apps/studio/server.js"]
