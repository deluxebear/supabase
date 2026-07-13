FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${VERSION} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${COMMIT}" -o /out/backup-operator ./cmd/backup-operator \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${VERSION} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${COMMIT}" -o /out/backupctl ./cmd/backupctl

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Supabase Backup Operator" \
      org.opencontainers.image.source="https://github.com/supabase/supabase/tree/master/apps/backup-operator" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"
COPY --from=build /out/backup-operator /usr/local/bin/backup-operator
COPY --from=build /out/backupctl /usr/local/bin/backupctl
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/backup-operator"]
