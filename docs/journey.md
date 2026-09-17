# How PuzzleLove was built: process, incidents and lessons

This document tells how a finished multiplayer game became a production platform with a data stack in September 2026,
working as a pair: the owner operated the VPS, GitHub, Cloudflare and Discord, and an AI coding agent (Claude Code)
wrote code, ran local tests and reviewed every command output the owner pasted back.

It records what was done in each phase, and **every incident and bug along the way**, including the ones caused by
the agent. Nothing here is rewritten to look smoother than it was.

## Timeline at a glance

| Phase | Outcome |
|---|---|
| 0. Starting point | Game finished and tested locally, nothing committed, VPS just purchased |
| 1. Server hardening (manual) | SSH keys only, firewall layers, fail2ban, swap, Docker |
| 2–3. Containerized stack | Dockerfile, Compose, Traefik, Garage, verified on Docker Desktop |
| 4. CI/CD and first deploy | GitHub Actions → GHCR → SSH deploy with rollback; Let's Encrypt staging then production |
| 5. Backups | age-encrypted daily backups to R2, restore tested against production |
| 6. Monitoring | Uptime Kuma, UptimeRobot, Discord alerts |
| 7. Ansible | Hardening codified, idempotency tested, drift found and fixed |
| 8. Event tracking | 12 gameplay event types into an append-only table |
| 9. Simulator | Live bots in production, synthetic history generator |
| 10. Data pipeline | PySpark + Delta Lake bronze/silver/gold, quality gates, warehouse |
| 11. Admin analytics | Dashboard in `/admin` backed by the warehouse |
| 12. Superset | Public dashboard as code, demo data in production |

## Phase by phase

### 0. Starting point
The game was complete and tested locally: shared engine, authoritative Socket.IO server, React/Konva client, and
24 tests. A context document captured the owner's goals: build experience in data pipelines, cloud, analytics and
architecture on a single 8 GB VPS, without AWS, GCP or Azure. Decisions were to be discussed before building.

### 1. Server hardening, by hand
The owner's checklist was: domain, app routing, TLS with renewal, OpenSSH hardening, firewall, load balancer and CI/CD,
using Traefik and Watchtower.

The agent's review changed three things before any work started:
- **No load balancer.** Game state lives in memory, so replicas would each run a different global room
  ([ADR-0003](adr/0003-single-game-instance.md)).
- **No Watchtower.** It cannot run migrations or roll back, and it is unmaintained
  ([ADR-0004](adr/0004-push-based-cicd.md)).
- **Docker bypasses UFW.** Only the reverse proxy may publish ports.

The owner ran each step on the VPS and pasted the output back for review:
1. Created a `luis` sudo user and copied the SSH key to it.
2. Hardened SSH with a drop-in whose `00-` prefix wins over Hostinger's `50-cloud-init.conf`.
3. Tested in a second terminal before closing the root session.
4. Set up UFW, the Hostinger panel firewall and fail2ban.
5. Added 4 GB of swap.
6. Installed Docker with log rotation and `live-restore`.

### 2–3. Containerized stack
- **Image:** a multi-stage Dockerfile with a separate `migrate` target for Prisma.
- **Storage:** MinIO had stopped publishing community images, so the owner chose Garage
  ([ADR-0005](adr/0005-garage-object-storage.md)).
- **Proxy:** Traefik, which reaches Docker only through a read-only socket proxy.
- **Local rehearsal:** the whole production Compose stack was brought up on Docker Desktop at `puzzlelove.localhost` and
  exercised end to end with a script. Tested: two players over WebSocket, a private room upload into Garage, a `Secure`
  admin cookie, and state persisted across restarts.

### 4. CI/CD and first deploy
- **History:** the untracked repository was split into 13 logical commits with real dates.
- **Pipeline:** GitHub Actions runs tests, builds images to GHCR, and deploys over rsync + SSH with a dedicated key and
  a pinned host key. Rollback was rehearsed locally with a deliberately broken image.
- **First deploy:** it succeeded on the first push. Let's Encrypt staging certificates were verified before switching
  to production certificates.

### 5. Backups
- Daily `pg_dump` plus an image archive, encrypted with age and uploaded to Cloudflare R2 with rclone.
- The owner created the R2 bucket, the scoped token and the age key pair; the private key stays on the owner's machine.
- `restore.sh test` was run from the owner's PC against production and restored successfully into a throwaway Postgres.

### 6. Monitoring
- **Uptime Kuma** (status page public, admin behind two logins) monitors the app, Postgres, Garage and containers, and
  receives a heartbeat from the backup job.
- **UptimeRobot** covers the case where the whole VPS is down.
- Alerts go to Discord.

### 7. Ansible
- **Roles:** eight roles reproduce the manual hardening. They run from Windows through a pinned Ansible container.
- **Idempotency test:** it runs in a privileged systemd container, and the second run must report `changed=0`.
- **Against production:** the dry run found real drift (incident 13). After applying the playbook, the next dry run
  reported `changed=0`.

### 8. Event tracking
- **Coverage:** 12 event types recorded from `RoomManager` into `analytics_events`.
- **Sink:** a buffered sink that never throws or blocks the game.
- **Tests:** integration tests follow a whole private room from creation to completion.
- **Rollout:** the migration was additive and applied automatically on deploy.

### 9. Simulator
- **Live bots:** real Socket.IO clients that play the global room and scale with an hourly curve. The owner chose to
  run them in production, labeled "🤖".
- **Backfill:** a deterministic generator replays weeks of play through the real engine and writes rows with
  `is_synthetic = true`.
- **Scale:** 28 days produce about 600k events in about 22 s.

### 10. Data pipeline
- **Image:** PySpark 4.2 + Delta Lake 4.4, with every jar resolved at image build time.
- **Local runs:** against 600k events, the first two runs failed on real bugs (incidents 14 and 15). Each failure was
  recorded in `pipeline_runs` and published nothing. The third run succeeded in 102 s.
- **Idempotency:** the successful run re-extracted what a failed run had left in bronze without duplicating it.
- **Production:** the first run failed because production had no events yet (incident 17), a case never tested
  locally.

### 11. Admin analytics
- **Charts:** hand-built SVG charts following a data-visualization checklist (validated colors, one axis per chart,
  table view, keyboard tooltips).
- **Review:** checked with screenshots at desktop and mobile widths, which surfaced two layout issues and a misleading
  partial-day drop (incident 18).

### 12. Superset
- **Bootstrap:** Superset 6.1 + Redis, bootstrapped by code through its REST API in-process. It needed two
  workarounds (incidents 19 and 20) and one chart correction (incident 21).
- **Verification:** the public dashboard was checked anonymously in a browser, and anonymous access to SQL Lab,
  databases and roles was confirmed blocked.
- **Demo data:** the owner asked for demo data in production, so 14 days of labeled synthetic history were loaded. The
  first attempt silently dropped most rows (incident 23).

## Incidents and bugs

Each entry has what happened, the root cause, the fix and the lesson. Severity: **prod** means it reached production;
**local** means it was caught before deploying; **process** means it came from how work was done.

| # | Phase | Severity | Incident |
|---|---|---|---|
| 1 | Hardening | prod | Pasted command blocks merged into one line; some steps never ran |
| 2 | Stack | local | Default global image rendered with a blank title |
| 3 | Stack | local | Test script could not resolve `*.localhost` on Windows |
| 4 | CI/CD | process | Predicted first-deploy failure did not happen |
| 5 | CI/CD | process | `ssh-keyscan` failed on Windows |
| 6 | CI/CD | process | PowerShell command run inside the Linux VPS |
| 7 | Deploy | process | Weak password attempt and a lost Traefik password |
| 8 | Backups | local | age key piped from PowerShell would carry CRLF |
| 9 | Monitoring | local | Uptime Kuma API unreachable on first start |
| 10 | Ansible | process | PowerShell refused to run `run.ps1` |
| 11 | Ansible | local | Ansible silently ignored `ansible.cfg` |
| 12 | Ansible | local | `sshd -t -o Include` is not supported |
| 13 | Ansible | prod | Swap was never persisted; two tasks were not idempotent |
| 14 | Pipeline | local | Strict cast failed on fractional durations |
| 15 | Pipeline | local | Spark JDBC rejected `TIMESTAMPTZ` |
| 16 | Pipeline | local | Shell scripts saved with CRLF on Windows |
| 17 | Pipeline | prod | Pipeline failed on a fresh install with no events |
| 18 | Dashboard | local | Charts showed a false drop on the current day |
| 19 | Superset | local | CSRF blocked in-process API calls |
| 20 | Superset | local | JWT user not visible to table-access checks |
| 21 | Superset | local | Diverging color scheme used for a magnitude heatmap |
| 22 | Superset | prod | `superset-init` pulled a non-existent image |
| 23 | Simulator | prod | Re-running the backfill silently dropped ~95% of rows |
| 24 | Operations | process | Admin credentials forgotten |

### 1. Pasted command blocks merged into one line
- **What happened:** multi-line blocks pasted into the SSH session were joined. Some commands ran with others appended
  to their arguments; some never ran. Output looked mostly fine.
- **Root cause:** terminal paste behavior combined with long blocks. The agent kept giving multi-command blocks.
- **Impact:** the lines that persisted swap in `/etc/fstab` and set `vm.swappiness` never ran. Swap was active only
  until the next reboot. This stayed hidden until incident 13.
- **Fix:** after the first merge, commands were given one per block, with a verification command after each.
  The drift was later found and fixed by Ansible.
- **Lesson:** every manual change needs an explicit verification step. Codifying the server exposes what "done by
  hand" really did.

### 2. Blank title on the default global image
- **What happened:** the generated default puzzle image showed hearts but no "PuzzleLove" title in the container.
- **Root cause:** `sharp` renders SVG text with system fonts, and the slim runtime image had none (`Fontconfig error`).
- **Fix:** install `fontconfig` and `fonts-dejavu-core` in the runtime stage.
- **Lesson:** look at generated artifacts, not only status codes.

### 3. Test script could not resolve `*.localhost` on Windows
- **What happened:** the end-to-end script failed with `ENOTFOUND puzzlelove.localhost`, while curl worked.
- **Root cause:** Node on Windows does not special-case `.localhost`, but curl does.
- **Fix:** the test script maps `*.localhost` to 127.0.0.1 through a `dns.lookup` override. Browser tests use a host
  resolver rule.

### 4. A predicted first-deploy failure did not happen
- **What happened:** the agent told the owner the first deploy would fail pulling private GHCR images. It succeeded.
- **Root cause:** an assumption that was not verified. Packages published from this public repository were already
  pullable anonymously.
- **Lesson:** the agent verified it afterwards with an anonymous registry request. State predictions as uncertain, or
  check them first.

### 5. `ssh-keyscan` failed on Windows
- **What happened:** `choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`.
- **Root cause:** Windows' bundled OpenSSH is older than the server's key exchange defaults.
- **Fix:** read the host key from the owner's existing `known_hosts` (or Git Bash's newer `ssh-keyscan`). The
  fingerprint was matched against the one the server showed on first connection.

### 6. PowerShell command run inside the Linux VPS
- **What happened:** `Get-Content ... | ssh ...` was typed in the VPS session: `Get-Content: command not found`, then
  `Permission denied`.
- **Root cause:** instructions for two machines in one message; the prompt showed where each ran, but it was easy to
  miss.
- **Fix:** later instructions labeled the machine explicitly ("PowerShell on your PC" / "on the VPS"), and the owner
  learned to check the prompt.

### 7. Weak password attempt and a lost Traefik password
- **What happened:** a 4-digit password was first used for the dashboard basic auth, and later the Traefik password was
  forgotten.
- **Fix:** passwords generated with `openssl rand`, the users file regenerated with `htpasswd`, Traefik restarted.
  Recommendation to keep every credential in a password manager.

### 8. age key piped from PowerShell would carry CRLF
- **What happened:** caught during local testing before any real restore.
- **Root cause:** PowerShell sends lines with `\r\n`; the age identity file would be malformed.
- **Fix:** the restore script strips `\r` from the key read on stdin; a test pipes a CRLF key.

### 9. Uptime Kuma API unreachable on first start
- **What happened:** the Socket.IO API answered with the HTML page, so automated setup could not connect.
- **Root cause:** Uptime Kuma 2 starts a database-selection wizard on first run and serves nothing else until someone
  picks a database.
- **Fix:** `UPTIME_KUMA_DB_TYPE=sqlite` skips the wizard.

### 10. PowerShell refused to run `run.ps1`
- **What happened:** "running scripts is disabled on this system".
- **Fix:** `powershell -ExecutionPolicy Bypass -File ...` for that invocation only, without changing the machine policy.
  Docs were updated.

### 11. Ansible silently ignored `ansible.cfg`
- **What happened:** ansible-lint warned "running in a world writable directory, ignoring it as an ansible.cfg source".
  In practice the inventory and roles path would not load from config.
- **Root cause:** Windows bind mounts appear world-writable inside Linux containers, and Ansible refuses config from such
  directories.
- **Fix:** set `ANSIBLE_CONFIG` explicitly in `run.ps1` and the test harness.

### 12. `sshd -t -o Include` is not supported
- **What happened:** the SSH hardening template failed validation on the first container test.
- **Root cause:** `Include` cannot be passed as a command-line option.
- **Fix:** validate the drop-in on its own with `sshd -t -f %s`.

### 13. Swap never persisted; two tasks not idempotent
- **What happened:** the first `--check --diff` against production reported changes on the swap tasks without showing a
  diff. After switching to exact-line tasks, the second dry run showed the real problem: `/etc/fstab` had no swap line
  and `99-swap.conf` did not exist (from incident 1).
- **Root cause:**
  - `ansible.posix.mount` and `sysctl` report changes in check mode even when the result would be identical.
  - The container test skipped the swap role (containers cannot `swapon`), so this path was untested.
- **Fix:** `lineinfile` for fstab and `copy` for the sysctl file with a reload handler. Applying fixed the drift, and
  the next dry run reported `changed=0`.
- **Lesson:** untested branches of a playbook are where drift hides. Review `--check --diff` before applying to production.

### 14. Strict cast failed on fractional durations
- **What happened:** the first full local run failed: `CAST_INVALID_INPUT '432941.205078125' ... to BIGINT`.
- **Root cause:** the synthetic generator summed fractional milliseconds. Spark 4's ANSI mode rejects the cast, where
  older defaults returned null silently.
- **Fix:** the generator floors times, and the pipeline parses JSON numbers through `double` before rounding to integer
  types, so any producer that writes `1500.0` is tolerated.
- **Lesson:** the run failed safely: marked `failed`, nothing published. Quality gates and ANSI casts surface upstream
  bugs.

### 15. Spark JDBC rejected `TIMESTAMPTZ`
- **What happened:** the warehouse load failed with `UNSUPPORTED_DATATYPE "TIMESTAMPTZ"`, and the run log showed an
  empty error summary.
- **Root cause:** `createTableColumnTypes` accepts Spark SQL types only. The exception's first line was empty.
- **Fix:** convert timestamp columns in Postgres inside the swap transaction (`ALTER COLUMN ... TYPE timestamptz USING
  ... AT TIME ZONE 'UTC'`), with the JVM pinned to UTC. Error summaries now use the first non-empty line.

### 16. Shell scripts saved with CRLF on Windows
- **What happened:** shellcheck reported `SC1017 literal carriage return` on every line of `restore.sh`.
- **Root cause:** files edited through Python in text mode on Windows were written with CRLF. Git would normalize them
  on commit (`*.sh eol=lf`), but the working copy used for local rehearsals was broken.
- **Fix:** normalized the files. Later edits preserve line endings.

### 17. Pipeline failed on a fresh install with no events
- **What happened:** in production, the 04:30 cron run and a manual run both failed:
  `PATH_NOT_FOUND s3a://lake/bronze/events`.
- **Root cause:** production had zero events (tracking had just shipped, and bots scale to zero at night). No bronze
  table was created, but the next step read it. Local tests always had data.
- **Fix:** a run with an empty source finishes as a successful no-op and keeps the watermark. Reproduced locally with
  an empty database and bucket before deploying.
- **Lesson:** test the empty state. The run history made the diagnosis quick.

### 18. Charts showed a false drop on the current day
- **What happened:** in the first dashboard screenshots, the last point of every trend plunged.
- **Root cause:** the range ended at the latest date in the warehouse, which included today's partial day.
- **Fix:** ranges end at the last complete day in Mexico City time.
- **Lesson:** render and look. Correct numbers can still tell the wrong story.

### 19. CSRF blocked in-process API calls
- **What happened:** `POST /api/v1/database/ -> 400: The CSRF token is missing`.
- **Root cause:** the bootstrap uses Superset's Flask test client, and CSRF protection applies to it.
- **Fix:** disable CSRF on that one in-process app instance only. The server keeps CSRF.

### 20. JWT user not visible to table-access checks
- **What happened:** creating virtual datasets failed with "You need access to the following tables", although the
  admin had just created the database connection.
- **Root cause:** in the test client, JWT authenticated the API layer, but Flask-Login's current user stayed anonymous
  (`/api/v1/me/roles/` returned `Public`). Dataset validation reads Flask-Login.
- **Fix:** log the admin in through Flask-Login in a `before_request` hook on the bootstrap app instance. Found by
  querying the user's roles instead of guessing.

### 21. Diverging color scheme used for a magnitude heatmap
- **What happened:** the heatmap used `blue_white_yellow`, which implies a meaningful midpoint.
- **Fix:** `schemeBlues`, a single hue from light to dark, consistent with the admin dashboard. Weekday and size
  ordering were adjusted too.

### 22. `superset-init` pulled a non-existent image
- **What happened:** `docker compose run --rm superset-init` printed nothing useful on the VPS.
- **Root cause:** image names are computed by `deploy.sh` from the release tag. Outside it, Compose falls back to the
  local default `puzzlelove-superset:local`, which only exists on the development machine. The agent had given that
  command.
- **Fix:** rerun one-shot services through `./deploy.sh` (re-applies the current release). The runbook explains which
  Compose commands are safe to run directly.

### 23. Re-running the backfill silently dropped ~95% of rows
- **What happened:** `generated 282650 events ... inserted 13607 rows`. The pipeline still passed, but the completed
  puzzle merge warning rose to 1.5%.
- **Root cause:** event ids came from the seeded random generator alone. A backfill with the same seed had already run,
  so the second run over a window a few minutes later produced the **same ids for different events**.
  `ON CONFLICT DO NOTHING` discarded them, leaving two overlapping histories mixed together.
- **Fix:**
  - Purged all synthetic rows, inserted one clean run (`inserted` = `generated` = 284,492) and fully refreshed the
    pipeline.
  - In code, ids, session ids and room slugs now also depend on the window start, with a regression test proving that
    shifted windows share no ids.
- **Lesson:** "idempotent insert" hides bugs when the key is not truly unique. Compare inserted vs generated counts, and
  treat a moving quality warning as a signal.

### 24. Admin credentials forgotten
- **What happened:** the owner could not log in to `/admin` or Superset.
- **Fix:** both are read from `/opt/puzzlelove/.env` on the server (`ADMIN_PASSWORD`, `SUPERSET_ADMIN_PASSWORD`). The
  recommendation to store them in a password manager was repeated.

## Lessons learned

1. **Verify every manual step, then codify it.** The most consequential production issue (swap not persisting) came from
   a manual step that looked successful, and Ansible found it.
2. **Rehearse locally with the production artifacts.** The same Compose files, deploy script and images ran on Docker
   Desktop first. That caught incidents 2, 9, 11, 12, 14, 15, 18, 19, 20 and 21 before production.
3. **Test the empty and the repeated cases.** Both production data bugs (17 and 23) were an empty source and a second
   run, cases the happy path never exercises.
4. **Make failures safe and visible.** The pipeline never published bad data. Every failure was recorded with its error,
   and deploys roll back automatically. That turned bugs into quick diagnoses instead of outages.
5. **Look at the output.** Screenshots, counts (inserted vs generated) and anonymous-access checks found problems that
   status codes and passing tests did not.
6. **Label anything artificial.** Bots and synthetic data made the analytics demonstrable without misrepresenting
   traffic, because every row and chart can tell them apart.
7. **Separate what each machine does.** Many process slips came from mixing PC and VPS commands. Explicit labels and
   one command per block reduced them.
