# Ops container: nightly backups (pg_dump + Garage images, age-encrypted, uploaded to R2 with rclone)
# and the resource guard that checks every container still fits its cgroup slice.
# Same Postgres major version as the database so pg_dump/pg_restore match.
FROM postgres:17-alpine
RUN apk add --no-cache rclone age supercronic tzdata ca-certificates musl-locales jq
COPY backup.sh resources.sh /usr/local/bin/
COPY crontab /etc/backup.crontab
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/resources.sh
# rclone remotes are configured entirely through RCLONE_CONFIG_* environment variables.
ENV TZ=America/Mexico_City \
    RCLONE_CONFIG=/dev/null
ENTRYPOINT []
CMD ["supercronic", "-passthrough-logs", "/etc/backup.crontab"]
