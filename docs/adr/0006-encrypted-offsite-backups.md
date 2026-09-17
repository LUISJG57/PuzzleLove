# ADR-0006: age-encrypted offsite backups to Cloudflare R2

**Status:** accepted

## Context
Losing the VPS must not lose the data. Backups leave the machine, so they must be unreadable to whoever holds the bucket
credentials.

## Decision
A `backup` container runs daily at 03:30 Mexico City: `pg_dump -Fc` plus a tar of the image bucket, both encrypted to an
**age public key**, uploaded with rclone to R2 with 30-day retention. The private key is kept off the server and is
piped over SSH only for restores. `restore.sh test` restores into a throwaway Postgres inside the container.

## Alternatives
- **Unencrypted uploads relying on R2 encryption at rest:** anyone holding the token could read the data.
- **rclone crypt:** a password-based remote that couples key management to rclone configuration.

## Consequences
- A leaked R2 token or a compromised VPS does not expose backup contents.
- Losing the private key makes every backup useless; it is stored in a password manager.
- The restore path was exercised against production, not just designed.
