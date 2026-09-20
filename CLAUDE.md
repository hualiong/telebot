# Telebot — Project Guide for LLMs

A Telegram bot on Cloudflare Workers with Telegraf. Its one job: you forward meme images to it
one at a time; once 9 are collected it publishes an AcFun moment (动态) containing them.
This document describes the project structure, conventions, and how to extend the bot.

## What the bot does

```
Telegram photo/document → POST /webhook
  ├─ download → validate (≤1 MiB, JPEG/PNG/WebP, read dimensions + size)
  ├─ sendMessage "📥 收到，正在上传…"            ← only after validation passes
  ├─ AcFun upload (getToken → resume → fragment → complete → getUrlAfterUpload)
  ├─ editMessageText: that same message becomes the result
  │    └─ on failure: editMessageText: same message becomes an error + 🔄 重试 button
  └─ when X reaches 9: postMoment() → one new message with the AcFun link

Telegram callback_query (retry:<token>) → POST /webhook
  ├─ answerCallbackQuery immediately (3 s deadline)
  ├─ consume the KV ticket (single use)
  └─ re-run the upload, editing that same message again
```

**One photo = one message.** The receipt is edited in place rather than followed by a second
message, so the chat stays clean — and **failures are edited in place too**, for the same
reason. Result format:

```
✅ [上传成功](<原图直链>) · 84 KB（3 / 9）
```

`上传成功` is the hyperlink text — the raw URL is never printed, and the image is not echoed
back. On failure the same message becomes:

```
<blockquote>服务器繁忙，请稍后再试</blockquote>
❌ 把这张图重发一次即可。
[🔄 重试]
```

Four consequences worth knowing:

- Telegram does **not** push a notification for an edit (only for new messages), so the result
  of a single upload **and of a failure** is silent. That's the accepted trade-off; the final
  "已发布" message *is* a new message and does notify. (This is the one real cost of editing
  errors instead of sending them: you won't hear your phone when an upload fails.)
- The Bot API has no read-receipt concept at all — a bot cannot mark a message as read. What the
  user sees as "已读" is a **client-side** badge driven by the bot's *new* messages. Because an
  upload ends in an `editMessageText` and not a new message, that badge may not appear even
  though the bot replied correctly. This is expected, not a bug: if a receipt is missing
  entirely, it's a delivery problem, not a read-state one.
- Progress counts belong only in the result, never in the receipt: at receipt time the current
  photo isn't uploaded yet, so any number would be stale or a lie.
- The error text shown to the user is **only the raw `error_msg` from AcFun's response**
  (`err.rawMsg`, attached in `acfun.ts`). The `getToken 失败:` / `fragment 2 失败:` prefixes are
  diagnostic scaffolding this project adds — they go to the log, not to the screen.

### The 🔄 重试 button

Any upload failure (not just rate limiting — timeouts and network blips benefit equally) gets a
retry button. Two constraints shape the design:

- **`callback_data` is capped at 64 bytes**, and a Telegram `file_id` is typically 60–90 chars,
  so it cannot be embedded. The button carries only `retry:<16 hex>`; the real parameters
  (file_id, width, height, ext, chatId) live in KV under `retry:<token>` with a 24 h TTL.
- **`answerCallbackQuery` has a ~3 s deadline** while an upload takes 3–5 s, so the callback is
  answered **before** any work starts.

The ticket is consumed (deleted) on read, which is what makes double-tapping safe: the second
tap finds nothing. `bot.action()` is a **new external entry point**, so it must go through
`withOwner()` like every command — otherwise guessing a token is enough to trigger an upload.

### parse_mode: two of them

Most messages use legacy `parse_mode: "Markdown"` (single `*` for bold — **not** `**`, that's
MarkdownV2 and would render literal asterisks). Because one unpaired `*`/`_`/`` ` `` makes
Telegram reject the whole message, every send goes through `sendWithFallback()`, which retries
as plain text on failure.

⚠️ **Legacy Markdown has no blockquote.** The error message therefore uses
`parse_mode: "HTML"` plus `htmlBlockquote()` — a per-message setting, so the two modes coexist
without conflict. Reach for HTML (never MarkdownV2, whose escaping rules would break every
error string that contains a `-` or `.`) whenever you need a quote.

Everything runs **serially in one Worker invocation** (~5 s, ≤7 subrequests). There is
deliberately no queue, cron or background task: Telegraf's `Context` has **no** `waitUntil`
(verified against telegraf@4.16.3), and Workers cancel pending work once the event loop drains.

## Tech Stack

- **Runtime**: Cloudflare Workers (edge, serverless)
- **Bot Framework**: Telegraf v4 (Telegram Bot API wrapper)
- **Language**: TypeScript (strict mode, ES2022 target)
- **Build/Deploy**: Wrangler CLI
- **Package Manager**: npm (package-lock.json)

## Project Structure

```
telebot/
├── worker.ts                    # Entry point. fetch() routing + Env interface
├── src/
│   ├── bot/
│   │   ├── index.ts             # Bot class — wraps Telegraf, webhook lifecycle, flush()
│   │   ├── commands.ts          # /start /help /status /post /clear + retry button + fallback
│   │   └── photo.ts             # handlePhoto() / handleRetry() — validate → upload → edit in place
│   ├── config/
│   │   └── index.ts             # Config interface + factory that reads from env
│   ├── services/
│   │   ├── acfun.ts             # AcFun upload + moment/add (the reverse-engineered protocol)
│   │   ├── collection.ts        # KV state: collected links, dedupe, acPasstoken lookup
│   │   └── poster.ts            # flushIfReady() — publish when 9 collected, roll back on failure
│   ├── types/
│   │   └── acfun.ts             # AcfunImage / Collection / PendingPhoto
│   └── utils/
│       ├── logger.ts            # Structured console logger with [INFO], [ERROR], etc.
│       ├── markdown.ts          # Markdown/HTML helpers + sendWithFallback() plain-text retry
│       ├── retry.ts             # 🔄 重试 button tickets (KV-backed, single-use)
│       └── time.ts              # Beijing-time formatting (no ICU dependency)
├── scripts/
│   ├── acfun-smoke.mjs          # Zero-dep manual smoke test for the AcFun chain
│   ├── flow-check.mjs           # Offline interaction test (stubs Telegram + AcFun)
│   └── tg-diag.mjs              # Recover stuck Telegram updates + inspect webhook state
├── worker-configuration.d.ts    # Generated by `npm run cf-typegen` — do not hand-edit
├── wrangler.jsonc               # Cloudflare Workers config (name, KV bindings)
├── tsconfig.json                # TypeScript config
├── package.json                 # Dependencies and scripts
├── .dev.vars.example            # Example local secrets file
└── .gitignore
```

## Architecture

### Request flow

```
Telegram API → POST /webhook → worker.ts fetch() → Bot.handleWebhook() → Telegraf
                                                              ├─ on("photo")  → bot/photo.ts
                                                              └─ commands.ts handlers
```

### Key classes and modules

- **`worker.ts`** — Worker entry point. Routes `/` (status page + a real Telegram round-trip),
  `/health` (cheap probe: KV bindings + `acPasstoken` only, no Telegram call — it may be polled
  often), and `/webhook` (POST updates; GET with `?setup=1` re-registers the webhook). Declares `Env`.
- **`Bot` (src/bot/index.ts)** — Wraps Telegraf. Registers the photo **and** document handlers
  **before** `registerCommands`, so images aren't swallowed by the `on("message")` fallback.
  Also exposes `flush()` and `notify()`.
- **`handlePhoto` (src/bot/photo.ts)** — The core flow. Validates, sends the receipt, downloads,
  uploads to AcFun, stores the link, edits the receipt into the result, and posts at 9.
- **`handleRetry` (src/bot/photo.ts)** — The 🔄 重试 button. Answers the callback, consumes the KV
  ticket, then re-runs the *same* `runUpload()` core (shared with `handlePhoto`, so validation,
  error text and storage can't drift apart) against the existing error message.
- **`acfun.ts` (src/services/acfun.ts)** — All AcFun protocol knowledge lives here. Pure Web-standard APIs (`fetch`/`FormData`/`URLSearchParams`/`btoa`/`crypto`), no Node dependencies. Its `fail()` helper attaches the raw server `error_msg` as `err.rawMsg` for user-facing display.
- **`poster.ts` (src/services/poster.ts)** — `flushIfReady()`: publishes when `QUOTA` reached, **clears the collection optimistically then writes it back on failure**, so images are never lost.
- **`markdown.ts` (src/utils/markdown.ts)** — `formatBytes`, `imageLink`, `escapeMarkdown`,
  `escapeHtml`, `htmlBlockquote`, and `sendWithFallback`. Read its header before writing any
  user-facing text.
- **`retry.ts` (src/utils/retry.ts)** — `saveTicket` / `consumeTicket`: maps a short token to the
  parameters needed to re-upload, because `callback_data` can't hold a `file_id`.
- **`getConfig` (src/config/index.ts)** — Factory that reads `Env` and returns a typed `Config`.
- **`logger` (src/utils/logger.ts)** — Simple structured logger.

### KV schema

**One namespace, one binding.** `STATE_KV` points at the user's existing **`cloud-mail`**
namespace (`441e17faef8e4a66b6f7b6fb04b9363f`), which holds both this bot's state *and* the
credentials:

| Key | Value | Notes |
|---|---|---|
| `acfun:collection` | `{images: AcfunImage[], chatId?, postingAt?}` | `AcfunImage` = `{url, width, height, size, fileId, at}`. No TTL. |
| `seen:<file_unique_id>` | `"1"` | 24 h TTL. Idempotency guard against Telegram redelivery. |
| `retry:<16 hex>` | `RetryTicket` = `{fileId, fileUniqueId, ext, width, height, chatId}` | 24 h TTL. Single-use backstop for the 🔄 button. Deleted on read. |
| `token` | bare `acPasstoken` (~239 bytes) | Written/rotated by the separate **`acfun-sign-in`** Worker. **Not ours** — never overwrite it. |

Sharing one namespace is deliberate: the token sits right next to the state that needs it, so
rotation needs no redeploy and there is one fewer binding to keep in sync. The trade-off is that
this namespace is shared with another Worker's data — **never bulk-clear it**, and only touch the
`acfun:` / `seen:` / `retry:` keys.

⚠️ **KV limits to respect**: same key is limited to **1 write/second**, and the free tier to
1,000 writes/day. The write paths are arranged so `acfun:collection` is written at most twice
per post (optimistic clear → restore-on-failure), never twice within the same second. A `retry:`
ticket is its own key and only exists after a failure, so it doesn't contend with that budget.

### AcFun protocol gotchas (all verified by test)

1. Step ⑤ `getUrlAfterUpload` **must** use the App host (`api-ipv6.acfunchina.com`). The PC
   host returns `preview.ndcsk.com` links that expire in 3–4 h. `acfun.ts` throws on those.
2. `fragment` body must be **raw bytes** with a manually set `Content-Range`. Wrapping it in
   `FormData` makes it multipart and the server rejects it.
3. `moment/add`'s `params` must be encoded via `URLSearchParams`, never a hand-built JSON body.
4. `moment/add` is rate limited to roughly 1 post per few minutes → `result: 140011`.
5. On any `moment/add` failure, log the **raw response body** — it's the only diagnostic.
6. The published moment's **web** URL is `https://www.acfun.cn/moment/am<momentId>` — note the
   `am` prefix (momentId `5091765` → `/moment/am5091765`). ⚠️ Do **not** use the App-side address
   `https://m.acfun.cn/communityCircle/moment/<id>`: it is a different host and path, and opening
   it in a browser is wrong. The response's `shareUrl` is treated as **untrusted** — it may carry
   share/utm parameters or point at that App address — so it is only used when it already matches
   `https://www.acfun.cn/moment/`, and the URL is otherwise derived from `momentId`. The
   `动态已发布` log line records `source: "api" | "derived"` plus the raw `apiShareUrl`, which is
   the only way to tell which branch ran.
7. `imgs[]` needs `{url, width, height}`. `photo` messages give both in the metadata; `document`
   messages (what forwarding often produces) have neither, so `imageSize()` reads them out of
   the file header — JPEG (incl. EXIF orientation 5–8, which swaps them), PNG and WebP.
   Only JPEG/PNG/WebP are accepted; the detected format also sets the upload filename extension,
   which becomes the extension of the AcFun CDN URL.

## Conventions

### File and folder placement

| What you're adding | Where it goes |
|---|---|
| New bot command or message handler | `src/bot/commands.ts` — add handler function + register it in `registerCommands()` |
| New bot capability (e.g. sending media, managing groups) | Add a method to `Bot` class in `src/bot/index.ts` |
| New service/API integration | Create `src/services/<name>.ts`, export a class. Import in `worker.ts` or pass to Bot. |
| Scheduled/cron job logic | Create `src/jobs/<name>.ts`. Wire it in the `scheduled()` handler in `worker.ts`. |
| TypeScript interfaces/types | Create `src/types/index.ts` or `src/types/<domain>.ts` |
| Utility functions | Add to `src/utils/` as a new file (e.g. `src/utils/format.ts`) |
| New environment variable | Add to `Env` interface in `worker.ts` + `Config` interface in `src/config/index.ts` |
| New KV namespace or binding | Add to `wrangler.jsonc`, then update the `Env` interface, then run `npm run cf-typegen` |
| New HTTP route | Add a path check in the `fetch()` handler in `worker.ts` |

### Naming conventions

- **Files**: lowercase kebab-case (e.g. `my-service.ts`). Index files export the module's public API.
- **Classes**: PascalCase (e.g. `Bot`, `ApiService`)
- **Functions**: camelCase (e.g. `handleStart`, `registerCommands`)
- **Interfaces/Types**: PascalCase (e.g. `Config`, `Env`)
- **Constants**: UPPER_SNAKE_CASE for env vars, camelCase for runtime constants

### Code patterns

- **No Express/Hono** — routing is manual path matching in `worker.ts`. Keep it simple.
- **One Bot instance per request** — Workers are stateless. Bot is created fresh in each `fetch()` or `scheduled()` call.
- **Telegraf for bot logic** — Use `bot.command()`, `bot.on()`, `bot.action()` for Telegram interactions. Don't manually call the Telegram HTTP API.
- **Config via factory** — Always read env through `getConfig(env)`, not directly from `env`.
- **Logging** — Use `logger` from `src/utils/logger.ts`, not raw `console.log`.

### Environment and secrets

Bindings live in `wrangler.jsonc`; the generated types in `worker-configuration.d.ts` come from
`npm run cf-typegen` — **re-run it after changing bindings**, or typechecking will not see them.

- **Plain variables**: `[vars]` section of `wrangler.jsonc` — **but be careful, this repo is
  public**, so nothing identifying goes here
- **Secrets** (tokens, keys): `npx wrangler secret put SECRET_NAME`, never in `wrangler.jsonc`.
  Current secrets: `BOT_TOKEN`, `OWNER_CHAT_ID`. ⚠️ `wrangler secret bulk` crashes on this
  machine (libuv assertion, and it leaves the binding unset) — use individual `secret put`.
  Note a name cannot be a `vars` entry and a secret at the same time (API error 10053); to move
  one, deploy once without the `vars` entry, then `secret put` it.
- **Local dev secrets**: `.dev.vars` (gitignored), one `KEY=value` per line. Never put real
  values in `.dev.vars.example` — it is tracked and this repo is public.
- **AcFun credentials**: intentionally **not** a secret. `STATE_KV` *is* the user's `cloud-mail`
  namespace and the token is read from its `token` key at request time, so the periodic rotation
  needs no redeploy. `ACFUN_COOKIE` exists only as a local/debug override and takes precedence.

### Whitelist behaviour

`OWNER_CHAT_ID` guards **everything**, via a single `withOwner()` gate in `registerCommands`
plus the same check at the top of `handlePhoto`. Non-owner input of any kind — photos,
documents, plain text, any command, **and retry-button taps** — is **silently ignored: no reply
at all**, not even a rejection notice, so outsiders can't tell the bot exists. If you add a new
entry point, route it through `withOwner()` so this property holds. (`handleRetry` re-checks the
owner too, so the property survives even if a future refactor forgets the wrapper.)

## Extending the bot

### Adding a new command

1. Open `src/bot/commands.ts`
2. Write an async handler function: `async function handleMyCommand(ctx: Context): Promise<void> { ... }`
3. Register it in `registerCommands()` **wrapped in `withOwner`**, so the allowlist applies:
   `bot.command("mycommand", (ctx) => withOwner(ctx, deps, handleMyCommand));`

### Adding a handler that must not be swallowed

Telegraf picks the **first** matching handler, so register narrower handlers earlier.
`on("photo")` is registered in the `Bot` constructor precisely to stay ahead of the
`on("message")` fallback in `commands.ts`.

### Adding an external API integration

1. Create `src/services/my-api.ts` and keep the protocol details inside it
2. Add any needed env vars to the `Env` interface and `Config`
3. Add the binding to `wrangler.jsonc`, then run `npm run cf-typegen`

### Adding persistent storage (KV)

1. Run `npx wrangler kv namespace create MY_KV`
2. Add the binding to `kv_namespaces` in `wrangler.jsonc`
3. Add `MY_KV: KVNamespace` to the `Env` interface in `worker.ts` and run `npm run cf-typegen`
4. Use `env.MY_KV.get()` / `.put()` / `.delete()` — and remember the **1 write/second per key**
   limit before writing to the same key twice in one request

## Scripts

```bash
npm run dev              # Start local dev server (requires .dev.vars)
npm run deploy           # Deploy to Cloudflare Workers
npm run cf-typegen       # Regenerate worker-configuration.d.ts after binding changes
npm test                 # Run tests with Vitest (no test files committed yet)

# Manual smoke test of the AcFun chain (run from a network that can reach acfun.cn)
node scripts/acfun-smoke.mjs "<acPasstoken>" path/to/image.jpg [--post]

# Telegram-side diagnostics (needs TG_BOT_TOKEN; curls Telegram via the local HTTP proxy)
node scripts/tg-diag.mjs info       # full getWebhookInfo, including last delivery error
node scripts/tg-diag.mjs forward    # recover updates Telegram couldn't deliver, re-post them
                                    # to /webhook, then restore the webhook

# Offline interaction test — drives the real Bot with a local fake Telegram server,
# so it has no real side effects. Must be bundled first (see its header for why CJS).
npx esbuild scripts/flow-check.mjs --bundle --platform=node --format=cjs \
  --outfile=scripts/.flow-check.bundle.cjs && node scripts/.flow-check.bundle.cjs
```

⚠️ **`flow-check.mjs` is the only verification available on this machine** (`wrangler tail` and
the Observability API both fail here — see Operating notes). It covers the whitelist, the happy
path, oversize, `document`+PNG, dedupe, the 9-photo publish (**including the `/moment/am<id>` URL
and the case where AcFun's `shareUrl` is the wrong App address**), **and the whole retry surface**:
failure-edits-in-place, blockquote + raw `error_msg`, button presence, `callback_data` ≤ 64 bytes,
a successful retry, a retry that fails again, ticket single-use, and non-owner taps. When you
touch `photo.ts`, `markdown.ts`, `retry.ts`, `acfun.ts` or `commands.ts`, run it before pushing —
a push *is* a production deploy and there is no way to see logs afterwards.

### Two domains — don't mix them up

| Domain | Role |
|---|---|
| `telebot.hualiang.workers.dev` | **Production webhook target.** This is what is registered with Telegram via `setWebhook`. |
| `telebot.hualiang.fun` | **Local debugging only** (a custom domain with CN acceleration). Reachable directly from this machine. |

`*.workers.dev` is **DNS-poisoned on this machine** (resolves to Facebook IPs — the `face:b00c`
in the AAAA record is the tell), so neither direct nor proxied requests to it work here. Use
`telebot.hualiang.fun` for local probes, but **never point the production webhook at it** — the
custom domain exists only so this machine can reach the Worker.

`scripts/tg-diag.mjs` therefore keeps two separate constants: `WORKER` (local probes →
`.fun`) and `WEBHOOK` (re-registration → `.workers.dev`).

⚠️ **Revoking a token in BotFather detaches the webhook** (`getWebhookInfo` returns `url: ""`)
and updates start queueing. After any token rotation, always re-check and re-register:
`curl "https://api.telegram.org/bot<token>/setWebhook?url=https://telebot.hualiang.workers.dev/webhook"`.

### Continuous deployment via Cloudflare Workers Builds

This Worker is connected to `github.com/hualiong/telebot` (**public**, branch `main`). **Pushing
to `main` triggers a Cloudflare build that runs `npm run deploy` and redeploys this Worker** —
so a push is also a production deploy, and whatever is committed *is* what goes live.

- `build_command` is deliberately empty; `wrangler deploy` bundles TypeScript itself via esbuild.
- **`package-lock.json` must stay committed** — it was previously gitignored, which made every
  build resolve dependencies from scratch.
- The Git build does **not** carry over anything uncommitted, so `git status` must be clean
  before pushing.
- Verify with `GET https://telebot.hualiang.fun/`; the version ID should change.

⚠️ **When querying builds via the API, use the script *tag*, not the Worker name.** The correct
path is `/accounts/{id}/builds/workers/{script_tag}/builds` where `script_tag` is the value from
`GET /workers/scripts` (a hex tag, *not* `"telebot"`). Querying with the Worker name returns an
empty array — which looks exactly like "no builds exist" and is easy to misread as a missing
trigger. The trigger has existed since 2026-08-21 and fires correctly on `push_event`.

### Operating notes

- **Check health after deploying**: `GET /health` is the cheap probe (KV bindings +
  `acPasstoken`). `GET /` additionally does a **real Telegram round-trip** and reports
  `telegram: "✅ @hualiong_bot"` — use that one after touching `BOT_TOKEN`.
- **Local dev cannot reach `api.telegram.org`** from mainland China; the deployed Worker can.
  To exercise the real end-to-end path, just message the bot on Telegram.
- **`wrangler tail` does not work here** — it needs a WebSocket to Cloudflare, which the local
  network blocks. The Workers Observability *query* API also rejects this account's token (400),
  so there is currently **no log access from this machine**. When debugging, temporarily
  instrument the Worker (e.g. return diagnostics in the response body) instead, then remove it.
- **`wrangler deploy` needs no proxy** — it reaches Cloudflare directly and has always worked
  that way here. Only *local* probes need one: `api.telegram.org` is blocked outright, and
  `telebot.hualiang.workers.dev` is DNS-poisoned. `telebot.hualiang.fun` usually works directly
  but can be slow; `curl -x http://127.0.0.1:7890` is the reliable fallback for any of them.
- ⚠️ **Setting secrets in PowerShell**: `Write-Output -NoNewline $v | wrangler secret put NAME`
  stores the literal string `-NoNewline<value>` — PowerShell accepts `-NoNewline` as a
  positional argument and the flag text ends up in the secret. Symptom: every Telegram call
  404s with a URL like `.../bot-NoNewline<token>/getMe`. Write the value to a file with
  `[System.IO.File]::WriteAllText` and pipe it with `Get-Content -Raw`, then confirm the byte
  count before uploading, and verify with `GET /`.
- ⚠️ **Never write test fixtures into the production `STATE_KV`.** `acfun:collection` holds the
  user's real pending images; an overwrite loses them. Read the current value first, and if you
  must experiment, add a guard that aborts unless the shape matches exactly.
