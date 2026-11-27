# Poker Night for Fluxer

A standalone browser table for private Texas Hold’em games. Friends stay in Fluxer voice while they play in a normal browser tab; no Activity support is required.

**Current scope:** Fluxer sign-in limited to one community, private tables with up to 10 durable seats, Texas Hold’em, and an external settlement ledger. The app never collects or moves money.

**Hosting it?** Follow the [Fluxer owner and operator guide](docs/operator.md) for deployment, backups, and live acceptance.

## How it works

- One Node.js process (Fastify) serves the React UI, the Fluxer OAuth flow, a small JSON API, and the table WebSocket, all on one origin.
- Sign-in uses Fluxer OAuth2 (authorization code with `identify`, single-use `state`, S256 PKCE). After sign-in the app discards the OAuth tokens. The app's bot checks community membership and reads display profiles over REST. Its optional Gateway connection handles text commands; play does not depend on that connection.
- Data lives in one SQLite file (built-in `node:sqlite`, WAL mode) on a persistent volume. Sessions, tables, seats and invite hashes survive restarts.
- The table creator is its **Table master**. They share an invite, `/join/<tableId>#<token>`. The token stays in the URL fragment, so it never reaches server logs. The page sends it in an authenticated request body; the server stores only a hash.
- An invite does not take a seat. The player signs in with Fluxer, sees their own profile, and presses **Buy in**; that files one idempotent request. The Table master reviews the requester's Fluxer name and avatar in the entry queue, sets that person's chip total and recorded cash separately, and approves them into the table. In **Table master**, a seated player with no chips (including yourself) is funded the same way. The settings supply defaults for those fields, not prices or automatic grants. A rebuy requires an empty stack.
- Before the first deal an approval is immediate. Once play has started, a newcomer waits until the players who had chips or were in the hand when they asked have taken the button once. Players can request a seat during a hand; the master can approve or decline only between hands. A declined request never reveals the table.
- A pending request survives refreshing the join page or the host replacing the invite. Reopen the same join page while signed in to check its status or enter once approved.
- A disconnected browser keeps its seat and stack. The master picks the first dealer once two players have chips. A server restart pauses an interrupted hand until the master resumes it.
- **Chip values** on the table shows every funded seat's stack in chip units and what each color is worth; every player sees it, not just the Table master. Set the color values, blinds and turn clock between hands. White stays at one unit so odd chips can always be awarded; changing color values does not change anyone's chip total.
- Confirm cash-outs between hands against the player's current stack. Record cash in integer minor units (e.g. `1200` for USD 12.00), independent of chips; the app never transfers funds or computes a conversion. Currency locks after the first entry, and zero is valid for play money. Existing records and stacks are preserved.
- Use **Correct a ledger entry** in the Table master panel to fix a receipt between hands while the table is open. Corrections require a reason and keep the original in **History**. A chip-count typo or wrong-seat grant can be corrected or voided only before the next deal, while those chips remain on that seat and no later settlement supersedes the grant. Later cash-amount corrections do not change stacks or undo hands. Use **Stop after hand** when you need time to review and correct records before closing.
- **History** shows completed hands and cash totals (`out − in`) from current ledger entries. The master sees all records; other players see only their own, even after leaving. Outsiders see neither. Only public hand information and cards actually shown at showdown survive into hand history.

### Table rules

- The button advances clockwise to the next seated player with chips who is not marked away. Heads-up, the dealer is the small blind and acts first preflop and last afterward. A short blind posts its stack; the full big blind is due while other players can bet.
- Your cards show your current hand rank privately. Preflop it’s a pair or high card; from the flop onward it’s the best five cards you can make from your cards and the board. Draws don’t count, and the label disappears when you fold or the hand ends.
- Bets and raises are total amounts for the street. A full raise must add at least the last full bet or raise; short all-ins do not reopen betting unless the amount raised since a player's last action totals a full raise.
- Uncalled bets are returned. Contributions form main and side pots; folded chips stay in the pot, but folded players cannot win. Odd chips in a split go to tied winners clockwise from the left of the dealer.
- At the deadline the server checks if legal, otherwise folds. Two misses in a row mark the player away; they then check or fold immediately and sit out later hands until they choose to return.
- Skipping an away player does not count as taking the button. If they were part of an entrant’s rotation, they need to return and take their dealer turn, or leave the table, before the master can approve that entrant.
- **Stop after hand** ends automatic dealing without interrupting a live hand. **Close table** is only available between hands, after all remaining stacks have been cashed out; closing invalidates the invite but keeps the authorized history.

## Configure Fluxer

1. On the Fluxer instance, create an application. Save its application ID (client ID), client secret, and bot token.
2. Register the exact redirect URI `https://poker.example.com/auth/callback`, substituting your `PUBLIC_ORIGIN`. For local development also register `http://localhost:5173/auth/callback` and `http://127.0.0.1:8080/auth/callback` on a separate development application.
3. Install the bot into the community whose members may play. Membership lookup (`GET /guilds/{id}/members/{user}`) needs no extra channel permissions.
4. Optional: choose a private text channel in that same community, set `FLUXER_CHANNEL_ID`, and grant the bot **View Channel** and **Send Messages** there. Keep it readable only by the intended audience. A host can explicitly post the current invite or a committed aggregate settlement summary (currency and totals, no player names or cards). An unconfirmed post is not retried automatically; check the channel before requesting another.
5. Copy `.env.example` to a private `.env` and fill in the required keys. Never commit `.env`.

At startup the app discovers the API, web app, and media endpoints from `FLUXER_ORIGIN/.well-known/fluxer` (preferring `api_public`, appending `/v1`). It then confirms that `FLUXER_BOT_TOKEN` belongs to a bot account. If discovery fails it retries with backoff. Meanwhile `/healthz` stays healthy and sign-in returns "Fluxer is unavailable".

### Chat commands

Set `FLUXER_BOT_COMMANDS=true` to enable the bot's Gateway connection. In the configured community:

- `!pokernight` creates a room owned by the caller and DMs two links: a **Table master** link that opens their control panel after Fluxer sign-in, and a separate shareable invite for players. The bot never posts either link to the originating channel. Allow DMs from the bot; if delivery isn't confirmed, check your DMs and the web lobby before trying again.
- `!pokerleaderboard` replies only in `FLUXER_CHANNEL_ID`. It lists names and running recorded buy-ins, cash-outs and cash net (`out − in`) per currency, only for people who `!pokerleaderboard opt-in`. The net does not value chips still in play. `!pokerleaderboard opt-out` removes your totals from future replies, not from replies already posted. Rankings are command-only; they are not published in the bot profile.

Commands ignore other communities, DMs, bots and webhooks. The bot needs to be able to read the command channel and send messages. Test the intended instance's Gateway discovery and DM policy before relying on chat commands.

### Environment

| Key | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | yes | Browser origin of this app, e.g. `https://poker.example.com`. No path, query, fragment or credentials. Must be HTTPS unless `ALLOW_INSECURE_LOCAL=true` and the host is `localhost` or a private LAN IP. |
| `FLUXER_ORIGIN` | yes | Origin of the Fluxer instance, e.g. `https://chat.example.com`. HTTPS unless insecure-local. |
| `FLUXER_GUILD_ID` | yes | Community ID; only its members may sign in. |
| `FLUXER_CHANNEL_ID` | no | Numeric ID of a private text channel for host-initiated posts and `!pokerleaderboard`. Blank disables both. The app confirms the channel belongs to `FLUXER_GUILD_ID` before sending. |
| `FLUXER_BOT_TOKEN` | yes | Bot token of the application; the bot must be in the community. |
| `FLUXER_BOT_COMMANDS` | no | `true` enables `!pokernight` and the configured private-channel leaderboard (default `false`). |
| `FLUXER_CLIENT_ID` | yes | OAuth application ID. |
| `FLUXER_CLIENT_SECRET` | yes | OAuth client secret. |
| `DATABASE_PATH` | yes | SQLite file path. Compose sets `/data/pokerbot.sqlite`. Its directory must be writable, because SQLite keeps `-wal`/`-shm` files beside it. |
| `SESSION_SECONDS` | no | Session lifetime, 300–604800 (default 28800 = 8 hours). |
| `ALLOW_INSECURE_LOCAL` | no | `true` allows plain HTTP for a local/LAN `PUBLIC_ORIGIN` and an HTTP `FLUXER_ORIGIN`. Development only. |
| `TRUSTED_PROXY_CIDRS` | no | Comma-separated proxy IPs/CIDRs whose `X-Forwarded-For` is trusted for rate limiting. Empty trusts none; `/0` is refused. |
| `HOST`, `PORT` | no | Listen address (default `127.0.0.1:8080`; the image sets `0.0.0.0`). |

The app refuses to start on missing or partial credentials or on an invalid value, and prints which key is wrong. It never logs secrets, OAuth codes, invite tokens, or session IDs.

## Development and tests

Use Node.js 26.12.1 or newer (the Node2Shell fix, CVE-2026-111497) and npm.

```sh
npm ci
npm run build          # type-check browser, server and tests; compile server; build UI
npm test               # node --test on test/**/*.test.ts (TypeScript via Node type stripping)
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser   # needs npm run build first
```

For local UI development, set `PUBLIC_ORIGIN=http://localhost:5173` and `ALLOW_INSECURE_LOCAL=true` in `.env`. Register `http://localhost:5173/auth/callback` on a development Fluxer application. Run `npm run dev:server` (Fastify on `127.0.0.1:8080`, restarting on changes) and `npm run dev` (Vite on `localhost:5173`). Then open `http://localhost:5173`. Vite proxies `/auth`, `/api` and `/ws` (with WebSocket upgrades) to the backend.

Automated tests never use `.env` or live Fluxer credentials. The fake service in `test/fake-fluxer.ts` covers discovery, OAuth, community membership and channel/message REST. Browser tests use `playwright-core` against the built app with isolated profiles; set `CHROMIUM_PATH` to an installed Chromium-compatible browser. The settlement scenario uses two mobile-width profiles and keyboard actions. `e2e/proxy.test.ts` needs `openssl` on `PATH`: it terminates TLS in front of the built app to check the secure session cookie, `no-store` headers, origin rejection and a WSS socket across the heartbeat interval. The unit/integration run includes an online SQLite backup restored into a separate app. The running app has no fake provider or demo login.

The **Release checks** workflow runs the build, unit/integration tests, and Chromium suite on each push to `main` and on the exact pull request commit. It also runs the Linux container smoke and scans that same runtime image with Trivy. Any CRITICAL finding or detection of CVE-2026-111497 blocks release. No live Fluxer access is required.

### Automated smoke checks

From the verified branch, run `npm run build` first, then:

```sh
CHROMIUM_PATH=/usr/bin/chromium node --test e2e/smoke.test.ts
E2E_TARGET=container CHROMIUM_PATH=/usr/bin/chromium node --test e2e/smoke.test.ts
```

Both use the isolated fake Fluxer provider, not `.env`. The Linux container test needs port `8080` free; it uses a temporary Compose override to bind the app to loopback alongside the fake provider, checks the read-only root and writable `/data` owned by the non-root runtime, and removes its disposable project and volume afterward. Set `E2E_IMAGE_ID_FILE` to record the tested image ID for a local scan. The operator deploys with the standard Compose file, not the test override.

### Built-app smoke

```sh
npm run build
# .env with PUBLIC_ORIGIN=http://127.0.0.1:8080, ALLOW_INSECURE_LOCAL=true, and the matching callback registered
npm start
curl -fsS http://127.0.0.1:8080/healthz      # {"status":"ok"}
```

Then sign in at `http://127.0.0.1:8080`, create a table, and open the invite link in a second browser profile. Press **Buy in** as the guest. From **Table master**, confirm the guest’s chip and cash amounts and approve the request, then fund the master’s seat. Pick a dealer, play through a hand, and restart mid-hand to verify that only the master can resume.

## Deploy with Docker Compose

Use the [operator guide](docs/operator.md#set-up-fluxer-and-the-host) to start an exact verified commit on an approved host. It covers Fluxer OAuth and bot setup, the [HTTPS reverse proxy](docs/operator.md#https-reverse-proxy), and the [upgrade and rollback procedure](docs/operator.md#upgrade-and-rollback).

### Backup and restore

Use the [backup and restore runbook](docs/operator.md#backup-and-restore). Never copy a live SQLite database without accounting for its WAL, or share the backup with players.

## Abuse limits

- Auth routes (`/auth/*`): a burst of 30 per client IP (a sign-in takes two requests, so ten friends behind one home router fit), refilling at 30/minute, plus a global budget. IPv6 clients share a /64 budget. A rate-limited sign-in step redirects to the page's "busy" notice.
- Mutations: a burst of 20 per user, refilling at 120/minute.
- Each host may have at most 3 open tables, and the server holds at most 10,000 sessions.
- Rejected requests get `429` with `Retry-After`. Request bodies are limited to 16 KiB and WebSocket messages to 4 KiB. Compressed request bodies are rejected.

These limits reduce application-level abuse; an internet-facing proxy still needs ordinary connection controls.

## Protocol

All JSON. State-changing requests need the session cookie (`__Host-pokerbot` over HTTPS, `pokerbot-local` under insecure-local) and `Origin: PUBLIC_ORIGIN`.

| Route | Purpose |
| --- | --- |
| `GET /auth/login` | Redirects to Fluxer consent. Takes no caller-supplied redirect target. |
| `GET /auth/callback` | Completes sign-in, then redirects to `/` or to `/?auth=<expired\|cancelled\|bot\|not-member\|busy\|fluxer-unavailable\|signin-failed>`. |
| `POST /auth/logout` | Deletes the session and closes its sockets (`204`). |
| `GET /api/session` | `{ user: { id, name, avatar } }`, or `401 signed-out` / `403 not-member`. |
| `GET /api/tables` | `{ tables: [{ id, hostName, host, players }] }`: open tables where you have a seat. |
| `POST /api/tables` | Creates a table, seating the host at seat 1. Returns `{ tableId, invite }`. |
| `GET /api/tables/:id` | Snapshot (below). `404` unless you are seated. |
| `POST /api/tables/:id/join` | Body `{ token }`. Idempotent; returns `{ status: "none" \| "waiting" \| "declined" \| "seated", requestId?, remaining? }` and never seats by itself. Errors include `invite-invalid`, `table-full`, `entry-queue-full`, `not-member`. |
| `GET /api/tables/:id/entry-request` | Your own entry status. Poll while waiting; `seated` means the table snapshot is now readable. |
| `POST /api/tables/:id/invite` | Host only. Replaces the invite and returns `{ invite }`. |
| `GET /api/history` | `{ tables: [{ id, hostName, closed }] }` for current seats and players with ledger entries. |
| `GET /api/history/:id?before=&beforeHand=` | `{ tableId, host, hostName, closed, botPosts, entries, next, totals, hands, nextHand }`. Journal rows identify the player, acting user, and whether an entry was corrected, voided, or superseded. Revisions reference the original entry. Totals are per player/currency with `inMinor`, `outMinor`, and `netMinor`. Omit either cursor for its latest page; otherwise use the positive integer returned by the prior response. Outsiders get `404`. |
| `POST /api/tables/:id/notifications` | Host only. `{ id, type: "invite", token }` or `{ id, type: "settlement" }` → `{ status: "pending" \| "sent" \| "unconfirmed", messageId }`. A duplicate ID with the same request returns its status without a second send; changing the request under that ID returns `409`. |
| `GET /ws/tables/:id` | WebSocket; requires `Origin`, a session, a seat, and membership. |

Errors are `{ error, code }`. Socket messages in both directions carry `v: 4` (`PROTOCOL_VERSION` in `server/protocol.ts`, which holds the exact types). Clients on the older protocol must reload.

- Server→client `snapshot`: `{ v, type, tableId, version, serverNow, hostId, closed, settings, game, seats: [10 × seat | null], hand, you, last, currencyLocked, botPosts, entryRequests }`. Sent on connect and after every committed change; `version` only increases. `you` contains your seat, own hole cards, legal options and whether you have bought in. `entryRequests` lists waiting entrants for the Table master only and is empty for everyone else. No snapshot contains another player's hidden cards; `last.shown` lists only hands live at showdown.
- Client→server `{ v, type: "command", id, command }`. `id` is 8–64 of `[A-Za-z0-9_-]`. Commands include `act` (`handId`, `turn`, `action`, optional `amount`), `settings`, `start` (optional `dealer`), `stop`, `resume`, `back`, `leave`, and `close`. Only the master can send `buyin` (`{ userId, amountMinor, currency, chips, requestId? }`), `cashout` (`{ userId, amountMinor, currency, chips }`), `correct-ledger` (`{ entryId, amountMinor, chips, reason }`) or `decline-entry` (`{ requestId }`), and only between hands. A `buyin` with `requestId` seats that waiting entrant and issues the stack in one transaction; without it, it funds an already-seated player with an empty stack. `entryId` must be the latest version of the receipt; `amountMinor: 0, chips: 0` requests a void of an eligible unplayed grant.
- The server answers `{ v, type: "ack", id, ok: true, version }` or `{ v, type: "ack", id, ok: false, code, error }`. Retrying the same ID returns the first result, also after a restart; reuse with a different payload is refused. Monetary retries are audited. An `act` for an older `handId`/`turn` is rejected as stale.
- `{ v, type: "tick", serverNow }` is sent with each heartbeat. `{ v, type: "error", code, error }` answers a malformed message or a wrong `v`.

For a cash-out correction, send `chips: 0` and the revised cash amount (which may also be zero); the recorded payout chip count is unchanged.

The client waits for an authorized socket snapshot before enabling actions. On reconnect it can retry one in-flight command with its original ID if the same turn or table version is still current; otherwise it shows the new state and asks the player to check it before acting. It never replays a queue of moves.

Close codes: `4001` signed out, `4003` no longer a community member, `4004` left the table. Others mean reconnect.

## Operator acceptance (Stage 4)

Use the [live acceptance checklist](docs/operator.md#operator-acceptance-stage-4) on the owner-approved deployment. Passing CI with fake Fluxer does not complete those checks.

## Design

[Discord Poker Night](https://support-apps.discord.com/hc/en-us/articles/26502258215703-Poker-Night-FAQ) separates the felt, personal actions, and settings. [Poker Now](https://www.pokernow.com/blog/playing-poker-on-discord-tutorial-like-discord-poker-night) is a reference for private invite links and a centered board and pot; [PokerStars’ portrait layout](https://www.pokerstars.com/poker/learn/news/mobile-portrait-tables-now-available-on-pokerstars/) shows why cards and actions belong together at the bottom. Poker Night for Fluxer uses original assets, supports ten seats, and keeps a private settlement ledger.

The Table master controls issuance, like the configurable stacks in [Poker Now private games](https://www.pokernow.com/), and the journal keeps per-player movements for review, like its [Session Ledger](https://www.pokernow.com/blog/session-ledger-buy-in-buy-out-summary). [PokerStars Live's table-stakes rules](https://www.pokerstarslive.com/poker/cashgamerules/#) and the [Poker TDA's denomination guidance](https://www.pokertda.com/view-poker-tda-rules/) inform the boundaries: no mid-hand stack adjustments, visible denomination values, and a one-unit chip for odd pots. Poker Night totals never treat live chips as cash.

- **React** renders the lobby and table from server snapshots in the browser only (no SSR, Server Components, or Next.js). Seat labels and controls are HTML.
- **External settlements only:** Confirm operator and participant consent, applicable laws and the Fluxer community’s rules before using real-money terms. The app records agreed amounts; it neither verifies that a payment occurred nor transfers funds.

## Security and licensing

Report security issues privately as described in [SECURITY.md](SECURITY.md).

Poker Night for Fluxer is licensed under the [MIT License](LICENSE). Keep its copyright and license notices when redistributing copies or substantial portions of the code; no visible credit in the app is required. Dependencies retain their own licenses; see [third-party notices](docs/third-party-notices.md).
