# Backup job: pg_dump + Garage images, encrypted with age, uploaded to Cloudflare R2 with rclone.
# Same Postgres major version as the database so pg_dump/pg_restore match.
FROM postgres:17-alpine
RUN apk add --no-cache rclone age supercronic tzdata ca-certificates
COPY backup.sh /usr/local/bin/backup.sh
COPY crontab /etc/backup.crontab
RUN chmod +x /usr/local/bin/backup.sh
# rclone remotes are configured entirely through RCLONE_CONFIG_* environment variables.
ENV TZ=America/Mexico_City \
    RCLONE_CONFIG=/dev/null
ENTRYPOINT []
CMD ["supercronic", "-passthrough-logs", "/etc/backup.crontab"]
