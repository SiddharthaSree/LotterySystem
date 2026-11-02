# CSI Lucky Draw

A reusable employee engagement portal with a public audience screen, employee dashboards, and a password-protected coordinator panel. Built with Node.js, Express, plain browser JavaScript, and PostgreSQL. There is no frontend build step.

## What is included

- Name/email registration, allowed email domains, manual approval, and an IST registration deadline.
- Email-only employee sign-in, as requested. **It does not verify email ownership: knowing an approved email address is enough to view that employee's name, email, tasks, and tickets.** Do not use this access model for sensitive data or high-value events without adding real employee authentication.
- A base ticket for every registered employee; only approved entries participate in draws.
- Admin-configurable tasks, rewards, manual bonuses, and a per-event bonus cap.
- Teams-based proof verification. Admins mark tasks Done or Not done; allocations are reversible and never duplicate on repeated completion.
- Persistent unique ticket IDs and cryptographically random selection across eligible tickets.
- Pending selections must be confirmed as Claimed or Absent. Absent selections do not consume prizes and remain eligible. Claimed winners never win again in the same event, even if an admin later changes their ticket allocations.
- Multiple events with separate employees, tickets, tasks, winners, and audit trails. Titles and event rules are editable.
- Public live draw screen (one-second updates), a synchronized 10-second rolling ticket reveal, responsive mobile layouts, presentation mode, winner history, CSV export, and an admin audit trail.
- PostgreSQL-backed production sessions, CSRF protection, admin login rate limiting, secure production cookies, parameterized database queries, and protective HTTP headers.

## Local preview without a database account

Use Node.js 24 LTS:

```powershell
npm ci
npm run demo
```

Open `http://127.0.0.1:3000`. The terminal prints a temporary admin password and the admin email. Select **Admin** to sign in.

The demo uses embedded PostgreSQL in `.demo-data` and binds only to localhost. Data survives demo restarts, but sessions and the temporary admin password reset. This is a local preview, **not the Render deployment**. It does not read or overwrite an existing `.env` file.

## Publish the source on GitHub

Use a private repository unless you intentionally want the source to be public. GitHub stores the source; **GitHub Pages cannot run this backend**.

1. Install Git for Windows if `git` is unavailable, then reopen the terminal.
2. Create an empty GitHub repository, for example `csi-lucky-draw`. Do not initialize it with another README.
3. In this project directory, initialize and push. The explicit file list avoids accidentally including unrelated workspace files:

```powershell
git init
git branch -M main
git add .gitignore .env.example package.json package-lock.json eslint.config.js server.js schema.sql lib public scripts test render.yaml README.md .github
git diff --cached --stat
git status --short
git commit -m "Build employee engagement and lucky draw portal" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git remote add origin https://github.com/YOUR-ACCOUNT/csi-lucky-draw.git
git push -u origin main
```

Review the staged files before committing. **Never upload `.env`, API-key text files, `.demo-data`, or `node_modules`.** These paths are ignored. The existing workspace `.env` and API-key file are not needed by this project and must remain private.

The included GitHub Actions workflow runs lint, PostgreSQL-backed tests, and a Chromium desktop/mobile workflow test. Browser tests use an isolated embedded PostgreSQL database, not your hosted database.

## Create the persistent database

Recommended: create a free PostgreSQL project at [Neon](https://neon.com). Supabase PostgreSQL also works. Provider quotas and free-plan availability can change.

1. Create a database project in a region close to your Render service.
2. Copy its Node.js PostgreSQL connection string from the provider's **Connect** panel.
3. Keep the provider's SSL parameters. Use TLS certificate verification, for example `sslmode=verify-full` where supported. Do not disable certificate validation.
4. Put the connection string directly in Render's private `DATABASE_URL` setting, never in the browser, repository, or chat.

The app creates its tables and first demo event automatically on startup. It needs a dedicated database/user with permission to create tables, indexes, and the session table. The first event is seeded only if no events exist.

Do not use a local SQLite file on Render Free: local files disappear on restarts and redeploys. Render's free PostgreSQL databases currently expire after 30 days, so use a separate persistent provider for a reusable portal.

## Deploy to Render Free

1. Sign in to [Render](https://dashboard.render.com) and connect your GitHub account.
2. Choose **New > Blueprint**, select this repository, and use the included `render.yaml`. The service requests the Free instance plan.
3. Supply the private values requested by the Blueprint:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Your external PostgreSQL connection string |
| `ADMIN_EMAIL` | The email used for coordinator login |
| `ADMIN_PASSWORD` | A unique password of at least 12 characters |

`SESSION_SECRET` is generated by Render. `NODE_ENV=production` and Node.js 24 are configured by the Blueprint. Render supplies `PORT`.

Alternatively, create a **Node Web Service** manually:

| Setting | Value |
| --- | --- |
| Instance | Free |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Additional environment | `NODE_ENV=production`, `NODE_VERSION=24`, `SESSION_SECRET` with at least 32 random characters |

For manual setup, generate a session secret locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and enter it privately in Render. Set the three private variables listed above as well.

4. Wait for deployment and verify `https://YOUR-SERVICE.onrender.com/healthz` returns `{"ok":true}`.
5. Open the portal, sign into **Admin**, and configure the event before sharing the URL.

**Render Free limitations:** an idle service sleeps after 15 minutes; waking it can take about a minute. Free services have quotas, no persistent disk, and are not recommended by Render for production applications. Open and test the portal ahead of the live draw. For an important live event, consider a paid web service and an appropriately sized database. See [Render's free-service documentation](https://render.com/docs/free).

## Configure and run the first event

1. **Settings:** set the title, exact allowed email domains, bonus cap, prize count, and cutoff. The starter title is `CSI Solution 2026 Lucky Draw`, domain is `gmail.com`, and cutoff is **4 November 2026, 6:00 AM IST**. Replace the demo domain before inviting employees.
2. **Activities:** update the six reference activities, rewards, and participation windows. Treat LinkedIn and its internal alternative as one activity. Dates in activity instructions are informational; admins decide completion after checking evidence in Teams.
3. **People & tickets:** approve signups, mark verified tasks, and resolve missing-ticket concerns. Admins can add approved employees after the cutoff and bypass the public email-domain restriction.
4. Tickets are recalculated whenever completion, rewards, task availability, manual bonuses, or the cap changes. Active completed tasks are allocated in task-creation order; manual bonuses use the remaining cap. Every employee has one base ticket, and no allocation can exceed `1 + bonus cap`.
5. Set status to **Live** to enable drawing. Open the audience screen in another window and share its event-specific link. Audience screens show names, prize labels, and selected ticket IDs, not emails.
6. Enter a prize label and click **Roll & reveal**. Only admins can start a draw. The server first selects the ticket using the existing fair random selection; the animation is decorative and does not change the result. For roughly 10 seconds, ticket digits roll and settle one by one on the admin and audience screens, followed by the selected employee's name. Screens use the same server-timed reveal, including when reloaded or opened partway through; network latency can slightly delay audience updates. Reduced-motion mode uses placeholders instead of rapidly changing digits. The employee name is withheld from the public response until the reveal ends, and attendance confirmation is blocked during the reveal. Confirm **Present & claimed**, or choose **Absent - keep prize** and draw again. The same absent employee can legitimately be selected again because they remain eligible.
7. Admin ticket changes remain available during the live event, as requested. Resolve pending selections before changing event status. Confirmed claims exclude the winner regardless of later approval or reward changes.
8. Export claimed winners as CSV. End the event when complete; **Ended is a permanent read-only archive**. Create a new event for the next celebration instead of resetting old winners.

Public registration closes at the configured timestamp regardless of Open/Live status. Admin additions are allowed until the event ends. Status Open does not pause registration before the cutoff.

## Standard local development with external PostgreSQL

Do not overwrite an existing `.env`. Add the four values from `.env.example` privately to your local environment or existing `.env`, then run:

```powershell
npm ci
npm run dev
```

Use `NODE_ENV=development` for local HTTP. Production requires HTTPS for session cookies, which Render provides.

## Checks

```powershell
npm ci
npx playwright install chromium
npm run lint
npm test
```

The tests cover signup/approval, domain and deadline restrictions, cap enforcement, reversible/idempotent rewards, manual bonuses, cross-event isolation, absent/claimed rules, concurrent draw and claim requests, permanent event closure, PostgreSQL session persistence, secure-cookie behaviour, static assets, and the browser workflow including a mobile audience screen.

## Operations

- Back up PostgreSQL through your database provider. Render does not back up an external database for you.
- Keep the same `SESSION_SECRET` across deploys. Rotating it signs everyone out.
- Rotate the admin password through Render environment settings and redeploy. Rotate `SESSION_SECRET` too if existing admin sessions must be invalidated.
- All coordinators share one configured admin account in this version. The audit trail records actions, not individual coordinator identities.
- Activity evidence stays in Teams. Employee names/emails and event records are stored in PostgreSQL. Set an appropriate retention policy through your organization.
- For troubleshooting, use Render logs and `/healthz`. A failed startup reporting a missing variable means the environment configuration is incomplete. A failed database connection usually requires checking the connection string, SSL settings, database status, or network access.
