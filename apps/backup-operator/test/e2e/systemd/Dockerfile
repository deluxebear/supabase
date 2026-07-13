FROM postgres:17-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends busybox curl dbus jq openssl pgbackrest sqlite3 systemd \
    && rm -rf /var/lib/apt/lists/* \
    && systemctl mask systemd-remount-fs.service getty.target

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
