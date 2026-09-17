# ADR-0005: Garage for S3-compatible storage

**Status:** accepted (supersedes MinIO)

## Context
Uploaded images and the data lake need S3-compatible storage on the VPS. MinIO stopped publishing community binaries and
container images in late 2025.

## Decision
Use Garage as a single node with `replication_factor = 1`. The `--single-node --default-bucket` flags create the app
bucket and key from environment variables; `init-lake.sh` idempotently creates the `lake` bucket with a separate key for
the pipeline.

## Alternatives
- **Pinned last MinIO image:** familiar and has a console, but receives no security fixes.
- **SeaweedFS:** more features and more moving parts.
- **Local disk only:** would not exercise the S3 APIs (`s3a`, SDK) that the data stack relies on.

## Consequences
- About 5 MB of RAM at idle. No web console; administration is done with the CLI.
- The app key cannot read the lake, and the pipeline key cannot read images.
