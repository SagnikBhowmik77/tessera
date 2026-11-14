# Deploying Tessera

The API runs on Render (free web service), the web app on Vercel (Hobby), the data on the existing
MongoDB Atlas cluster (database `tessera`). Everything below is free. After the first setup, pushing
`main` redeploys both halves.

| Part | Where | From |
|---|---|---|
| Web app | Vercel, root directory `client/` | `client/vercel.json` |
| Email relay | Vercel Function `/api/send-mail` (same project) | `client/api/send-mail.js` |
| API | Render, service `tessera-api` (free, Singapore) | `render.yaml` |
| Database | MongoDB Atlas, Cluster0, database `tessera` | access list already has `0.0.0.0/0` (Spendwise) |

`<api>` below is the Render address (`https://tessera-api-xxxx.onrender.com`) and `<web>` the Vercel
one (`https://tessera-xxxx.vercel.app`). Both names are assigned when the services are created.

## 1. GitHub

Push this folder as its own repository (`tessera`). Before the first push, `git status` must not list
`server/.env`; it is ignored, and the repository holds no secrets.

## 2. Render (the API first, for its address)

New > Blueprint > the `tessera` repository. Render reads `render.yaml` and asks for each secret:

| Variable | Value |
|---|---|
| `MONGODB_URI`, `JWT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `MAIL_RELAY_SECRET` | the same as `server/.env` |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | the same as `server/.env` |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | from a new GitHub OAuth app (step 4) |
| `API_URL` | `<api>` |
| `APP_URL`, `CLIENT_ORIGIN` | `<web>` (after step 3; until then leave a placeholder) |
| `MAIL_RELAY_URL` | `<web>/api/send-mail` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | leave empty (optional) |

Keep `JWT_SECRET` exactly as it is locally: two-step sign-in secrets and connected GitHub tokens in
Atlas are encrypted with a key made from it. Don't set `PORT` (Render picks it), `DNS_SERVERS` (only
for this PC's DNS) or the `SMTP_*` values (Render blocks SMTP; mail goes through the relay).

Check: `<api>/api/health` answers `"connected": true`.

## 3. Vercel (the web app and the email relay)

Add New > Project > the `tessera` repository, **Root Directory `client`** (the framework, build and
output come from `client/vercel.json`). Environment variables:

| Variable | Value | Why |
|---|---|---|
| `VITE_API_URL` | `<api>` | where the app calls the API (built into the public JavaScript, not a secret) |
| `SITE_URL` | `<web>` | absolute image address in link previews |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | the same as `server/.env` | the relay sends through Gmail |
| `MAIL_RELAY_SECRET` | the same as `server/.env` and Render | only signed requests are sent |

Then put `<web>` into Render's `APP_URL` and `CLIENT_ORIGIN`, and `<web>/api/send-mail` into
`MAIL_RELAY_URL`; Render redeploys by itself. A change to a Vercel variable needs a redeploy there.

Check: `<web>/api/send-mail` answers `{"ok":true,"configured":true}` (it never shows a value).

## 4. Sign-in with GitHub and Google

- **GitHub** allows one callback per OAuth app, so production gets its own: Settings > Developer
  settings > OAuth Apps > New. Homepage `<web>`, callback `<api>/api/auth/oauth/github/callback`.
  Its client id and secret go into Render.
- **Google** (the existing web client): add `<api>/api/auth/oauth/google/callback` to the authorised
  redirect URIs, next to the localhost one.

## 5. Check the live app

1. `<web>` shows the front page; its four demos work.
2. Sign in (password, GitHub, Google). The account and projects are the ones on Atlas.
3. A new account gets its confirmation email (through the relay).
4. Two browsers on one board: a card moved in one moves in the other.
5. A project's GitHub webhook (Settings > Integrations) delivers to `<api>/api/hooks/github/<project id>`,
   and "fixes KEY-12" in a commit closes the ticket. This is the first real delivery (it could not
   reach a laptop before).

## Free-tier limits

Render's free service sleeps after 15 minutes without requests; the first request after that takes up
to a minute. The scheduled jobs (due reminders, recurring tickets, service-level checks, digests) run
only while it is awake, and catch up when it wakes.

Render's 750 free hours a month are shared by every free service in a workspace. Spendwise's
keep-awake ping already uses about 590 of them, so Tessera has no keep-awake ping of its own. To keep
it awake too, either create it in a second Render workspace (its own 750 hours) and add a ping like
Spendwise's `.github/workflows/keep-awake.yml`, or accept the cold start.

## Email goes through a relay on Vercel

Render's free services block outgoing SMTP (ports 25, 465 and 587), so the live API can't reach Gmail
itself. It signs each email (HMAC-SHA256 with `MAIL_RELAY_SECRET`, valid for 5 minutes) and posts it
over HTTPS to `client/api/send-mail.js`, which sends it from its own address. Locally, with
`MAIL_RELAY_URL` unset, the API uses SMTP directly. `server/test/mail-relay.test.js` runs the real
relay against the real mailer.
