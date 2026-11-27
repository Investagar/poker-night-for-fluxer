# Fluxer owner and operator guide

Use this guide on an owner-approved Linux host with Docker Compose v2, an HTTPS reverse proxy, and encrypted off-host backup storage. Use play money for acceptance. Poker Night records external settlements; it does not move funds.

## Set up Fluxer and the host

1. Start from the exact commit in the release handoff and verify that its **Release checks** passed. With repository read access, clone the repository and check out that commit (not a moving branch). If this replaces an existing installation, follow [Upgrade and rollback](#upgrade-and-rollback) before starting it.
2. Create a Fluxer OAuth application and install its bot in the community that may play. Register the exact callback `https://poker.example.com/auth/callback`, replacing the example with the deployed browser origin. Do not use the Fluxer owner's user session as a bot credential.
3. Copy `.env.example` to `.env` on the host if it does not exist, restrict it to the operator (`chmod 600 .env`), and fill in the [environment keys](../README.md#environment). `PUBLIC_ORIGIN` is the poker site, `FLUXER_ORIGIN` is the Fluxer instance, and `FLUXER_GUILD_ID` is the allowed community. Keep `ALLOW_INSECURE_LOCAL=false`. Do not share the client secret, bot token, `.env`, or backups in the handoff.
4. Leave `FLUXER_BOT_COMMANDS=false` and `FLUXER_CHANNEL_ID` blank for the first sign-in test. If you want chat commands or host posts, then follow [Configure Fluxer](../README.md#configure-fluxer) and [Chat commands](../README.md#chat-commands) for the private channel, permissions, and opt-in rules.

## Start and verify the service

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 pokerbot
curl -fsS http://127.0.0.1:8080/healthz
```

Wait for `healthy` and `Fluxer discovery complete; bot account verified`. `/healthz` alone proves the app is running, not that Fluxer OAuth works. Scan the deployed runtime image before allowing use; the release gate is no CRITICAL findings and no CVE-2026-111497.

- Keep the app port on host loopback. Compose publishes `127.0.0.1:8080` by default; change `POKERBOT_HOST_PORT` if necessary and use that port in the proxy and checks. Set `POKERBOT_ENV_FILE` to load a different env file.
- Keep the non-root user, read-only root, dropped capabilities, `no-new-privileges`, and 16 MiB `/tmp` tmpfs. SQLite needs a writable `/data`. Compose uses the `pokerbot-data` volume; keep the same Compose project name on upgrades. For a dedicated bind mount, give UID 1000 ownership (`chown 1000:1000 ./data` for rootful Docker, `podman unshare chown 1000:1000 ./data` for default rootless Podman mappings).
- Verify that the runtime and `/data` owner IDs match and neither is zero:

```sh
docker compose exec -T pokerbot node -e 'console.log(process.getuid(), require("node:fs").statSync("/data").uid)'
```

### HTTPS reverse proxy

Terminate HTTPS on the poker subdomain and forward to `http://127.0.0.1:8080`. Example for a proxy on the same host:

```caddy
poker.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

- Preserve `Host` and `Origin`. Mutations and the WebSocket handshake require the exact `PUBLIC_ORIGIN`. Forward WebSocket upgrades on `/ws/` over HTTP/1.1 and set idle/read timeouts to at least 60 seconds; the server pings every 25 seconds. Caddy forwards upgrades and the original headers by default.
- Append the client's address to `X-Forwarded-For`. Trust only the proxy's address or narrow CIDR as seen by the container in `TRUSTED_PROXY_CIDRS`. Without it, users behind the proxy share its rate-limit budget.
- Do not cache `/api/`, `/auth/`, or `/ws/`; the app uses `Cache-Control: no-store` on these routes. The proxy must be the only public entry point.

## Upgrade and rollback

Record the deployed commit and Compose project. Stop new play, take a verified standalone backup with the currently deployed image, then check out the reviewed new commit and rebuild with the same project, configuration, and data volume. Reload open browser tabs. Protocol v3 databases migrate in place; the old application cannot read the migrated schema.

For rollback, stop the new app. Keep its database and sidecars together and separate from the rollback copy. Restore the **pre-upgrade** backup under the previous release into its own database path or volume; never point the old image at the migrated file. Restoring a backup discards writes made after that backup.

### Backup and restore

The database is `/data/pokerbot.sqlite`. Do not copy the live SQLite file by itself: committed pages can still be in `-wal`. Use the app's backup CLI on a filesystem that supports hard links. It verifies SQLite integrity and foreign keys before publishing a standalone file at a fresh path.

Run from the deployment checkout. Set `backup_dir` to an existing, access-controlled directory outside the repository.

```sh
: "${backup_dir:?set backup_dir to your private backup directory}"
backup="pokerbot-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker compose exec -T pokerbot node dist/server/backup.js backup /data/pokerbot.sqlite "/data/$backup" &&
  (umask 077; set -C; docker compose exec -T pokerbot cat "/data/$backup" > "$backup_dir/$backup" &&
    (cd "$backup_dir" && sha256sum "$backup" > "$backup.sha256"))
```

Copy the backup and checksum to access-controlled, encrypted off-host storage. Verify the copy before removing temporary files. Backups contain sessions, settlement records, and private state from interrupted hands. Treat them like credentials. For an acceptance drill, use a separate private instance and volume; never point two running apps at one database. Session cookies are host-only, so a restore on a different hostname requires signing in again.

For recovery, run from the target deployment checkout. Set `backup_dir` to the absolute path containing the downloaded backup and checksum, and `backup` to the original filename. The command stops the target instance, validates the backup, and preserves the old database and sidecars together before restoring:

```sh
: "${backup_dir:?set backup_dir to the downloaded backup directory}"
: "${backup:?set backup to the original backup filename}"
test -r "$backup_dir/$backup" && (cd "$backup_dir" && sha256sum -c "$backup.sha256") &&
docker compose stop pokerbot &&
docker compose run --rm --no-deps -T --entrypoint sh pokerbot -ec '
  umask 077
  staging=$(mktemp -d /data/.restore-XXXXXX)
  cat > "$staging/backup.sqlite"
  if ! node dist/server/backup.js restore "$staging/backup.sqlite" "$staging/validated.sqlite"; then
    rm -r "$staging"
    exit 1
  fi
  previous=$(mktemp -d /data/previous-XXXXXX)
  printf "Previous database and sidecars: %s\n" "$previous"
  for file in /data/pokerbot.sqlite /data/pokerbot.sqlite-wal /data/pokerbot.sqlite-shm /data/pokerbot.sqlite-journal; do
    if [ -e "$file" ]; then mv "$file" "$previous/"; fi
  done
  node dist/server/backup.js restore "$staging/backup.sqlite" /data/pokerbot.sqlite
  rm -r "$staging"
' < "$backup_dir/$backup"
```

Run `docker compose up -d` only after restore succeeds. Verify health, sessions at the intended origin, seats, stacks, ledger totals, and command deduplication. An interrupted hand must stay paused until the Table master resumes it. If restore fails after moving the previous files, leave the app stopped; move any new database and sidecars aside together, and recover the preserved files together. Keep the previous copy until verification is complete.

## Operator acceptance (Stage 4)

Run this on the approved deployment. Fake Fluxer, local TLS, and a local database restore are useful CI coverage, not substitutes for the live checks:

- [ ] Test member sign-in and non-member rejection. Verify that only the master can post an invite or settlement summary to the configured channel and that an invalidated invite cannot file a new request.
- [ ] If chat commands are enabled, verify `!pokernight` sends the two links only to the caller and an invited guest cannot use the management link. Test the private-channel leaderboard with opt-in and opt-out accounts; no names or amounts should be posted elsewhere.
- [ ] Check `/healthz`, image scan, non-root `/data` write access, read-only root, and loopback-only binding behind the public HTTPS proxy.
- [ ] Through the intended proxy, check secure session cookies, origin checks, WSS upgrades and idle heartbeat. Play with ten clients across desktop and mobile, reject an eleventh, and verify touch and keyboard play and that nobody receives another player's unrevealed cards.
- [ ] Reconnect while facing a bet and verify the seat, stack, and legal actions return without accepting a stale action. Restart mid-hand and verify that only the master can resume it.
- [ ] Confirm an invite alone does not take a seat. The guest presses **Buy in**; the master sees the requester's Fluxer profile and approves with the chosen chip and cash amounts. Start play and repeat with a late entrant: approval waits for the funded or in-hand players at request time to take the button or leave. Skipping an away player must not count as their turn.
- [ ] Using play money, verify that only the creator can issue chips, confirm cash-outs, or correct receipts. Check the chip-value legend, a correction that preserves the original receipt, private player totals, settlement retry deduplication, and an optional aggregate post with no names or cards. Confirm that a provider failure does not stop gameplay.
- [ ] Take an online backup, verify the off-host copy and checksum, then restore into an independent private instance. Confirm sessions, stacks, paused hand, ledger totals, and deduplication before relying on backups.

Report the tested commit, image scan result, and any failed checklist items in the release handoff. Do not include credentials, invite tokens, private settlement details, or database files.
