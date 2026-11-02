# CSI Lucky Draw

A reusable employee engagement portal with a public audience screen, employee dashboards, and a password-protected coordinator panel. Built with Node.js, Express, plain browser JavaScript, and PostgreSQL. There is no frontend build step.

The supplied CSI Solution logo is displayed in the portal header and the fullscreen draw presentation. Its original artwork and proportions are preserved in `public/company-logo.png`.

## What is included

- Name/email registration, allowed email domains, manual approval, and an IST registration deadline.
- Email-only employee sign-in, as requested. **It does not verify email ownership: knowing an approved email address is enough to view that employee's name, email, tasks, and tickets.** Do not use this access model for sensitive data or high-value events without adding real employee authentication.
- A base ticket for every registered employee; only approved entries participate in draws.
- Admin-configurable tasks, rewards, manual bonuses, and a per-event bonus cap.
- Teams-based proof verification. Admins mark tasks Done or Not done; allocations are reversible and never duplicate on repeated completion.
- Persistent unique ticket IDs and cryptographically random selection across eligible tickets.
- Choose a prize name and number of winners per roll. Distinct employees are selected, weighted by eligible tickets, and their prizes are automatically reserved regardless of attendance. Every selected employee is excluded from all later selections in that event, even within the same roll or if an admin later changes their ticket allocations.
- Optional planned rounds: configure each round's name, prize, and winner count before going Live. Plans lock permanently on Live, and a signed-in admin runs successive rounds from the public draw page. Other viewers only watch. Existing events with no prior draws can adopt a round plan; events already drawn retain manual batches.
- Multiple events with separate employees, tickets, tasks, winners, and audit trails. Titles and event rules are editable.
- Public live draw screen (one-second updates), synchronized sequential 10-second ticket-and-name reveals with a short pause between winners, responsive mobile layouts, presentation mode, winner history, CSV export, and an admin audit trail.
- Slot-machine-style rolling digits and a confetti burst for each newly revealed winner appear on both admin and audience screens. Reduced-motion preferences disable these effects; celebrations do not replay for old winners.
- Click **Enable sound** on the draw screen to hear rolling ticks and a winner fanfare, generated locally without external audio services. Browsers require this click in each tab after loading. **Mute sound** silences it immediately; leaving the draw screen also silences audio. Enable sound only on the presentation/speaker tab to avoid echoes from multiple windows.
- The designated reusable demo has an admin-only **Reset demo** button on the live draw screen (including presentation mode). Confirm to clear its winners and round progress, restore Live status, and start again with the same employees, tickets, and locked round plan. Wait for any active reveals to finish first. Previous results are retained in the demo's audit trail. Normal events cannot be reset, and the demo designation is not editable through event settings.
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
5. Before going Live, optionally open **Settings > Round planner**, add rounds in the intended order, and save. Each round has a name, prize label, and winner count. Total event prizes are automatically set to their sum (maximum 100 rounds / 1000 total prizes). Saving a new plan replaces the previous draft. An existing event can adopt rounds only while Open, before any draw and before its round plan has ever been locked.
6. Set status to **Live** to enable drawing and permanently lock any saved round plan. Returning to Open does not unlock it. Open the public draw page in your signed-in admin browser: it shows **Roll Round 1**, then the next round button after all current winners finish revealing. The saved prize and count are applied automatically. Public visitors without an admin session see the same round schedule and animations but never the roll control. Authentication and CSRF are checked on the server. Duplicate, repeated, and out-of-order round requests are rejected.
   Events without a round plan retain the manual admin flow: enter a prize label and **Number of winners** (1-1000), then click **Roll & reveal**. The server chooses a random eligible ticket, awards its employee a prize, removes all that employee's tickets from eligibility, and repeats for the requested number of distinct winners. Each ticket has an equal chance at each selection; employees with more eligible tickets have a proportionately higher chance before they win. Audience screens show names, prize labels, and selected ticket IDs, not emails.
   If fewer prizes or eligible employees remain, only the available number is awarded. A planned round is completed even if it awards zero winners; the difference is recorded visibly as **unfilled** and is not carried into later rounds. Remaining prizes count only future round prizes, not completed-round shortfalls. A manual roll with zero capacity produces an explicit error.
7. All awards are saved atomically before animation begins: no attendance check, confirmation button, or open browser is needed to keep the prize. The animation is decorative and never changes the results. Each winner's ticket rolls and settles for 10 seconds, followed by the employee's name; after a two-second pause, the next winner rolls automatically. The name remains visible in the winner list. Screens share server timestamps and resume the correct winner if reloaded or opened partway through. Network latency can slightly delay updates. Reduced-motion mode uses placeholders instead of rapidly changing digits. Names are withheld from the public response until their individual reveal ends, and future winners' tickets are hidden until their roll begins.
8. Another roll and leaving Live status are blocked until the last winner is revealed. Admin ticket changes remain available, but awards exclude winners regardless of later approval or reward changes. The remaining prize count drops as soon as the batch is saved, including for winners whose reveal is still queued.
9. Winners can collect their prizes later, even if they were offline during the draw. Export winners as CSV and coordinate distribution outside the portal. The portal records awards, not physical delivery or collection.
10. End the event when complete; **Ended is a permanent read-only archive**. Create a new event for the next celebration instead of resetting old winners.

Keep the audience link open before starting a roll, preferably in a separate window on the presentation display. Audience and admin draw screens keep requesting updates even when their tab is in the background, and immediately resynchronize when focused again. Browsers can throttle or suspend background tabs, so keep the presentation window visible for the full animation. Opening the audience page after a reveal finishes shows the recorded winners rather than replaying an already completed roll. After a portal deployment, refresh both admin and audience windows to load the latest application code.

**Presentation mode:** On the public draw page, click Presentation mode for a screen-filling dashboard: reveal on the left, compact round schedule and admin roll button below, and winners on the right. Extra explanatory content is hidden only in this mode. Winner lists use pages of eight and round schedules use pages of three so larger events remain accessible without scrolling. Click Exit presentation or press Escape to restore the normal page and full lists. The compact layout is tested at 1024x600, 1280x720, 1366x768, and 1920x1080.

### Upgrading from attendance-based draws

Startup adds the batch/reveal fields without deleting event records. Any old selection still awaiting attendance confirmation is automatically awarded exactly once and logged in the audit trail. Previously awarded winners remain excluded. Old absent selections are preserved as unawarded history; those employees remain eligible unless they subsequently won. The database retains `status='claimed'` for awarded records for compatibility, but the interface and CSV describe them as awards, not prize collection. The old attendance-resolution endpoint returns an explicit upgrade message instead of undoing an award.

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

The tests cover signup/approval, domain and deadline restrictions, cap enforcement, reversible/idempotent rewards, manual bonuses, cross-event isolation, automatic offline awards, distinct winners within/across rolls, reduced batch sizes, invalid winner counts, concurrent rolls, prize limits, pending-selection upgrades, permanent event closure, PostgreSQL session persistence, secure-cookie behaviour, and static assets. Round tests cover plan validation, automatic prize totals, permanent plan locking, ordered/duplicate/concurrent roll protection, admin/CSRF checks, award exclusion across rounds, zero-winner shortages, and compatibility with manual events. Browser tests verify planning and rolling rounds from the public page as admin, watch-only audience access, sequential ticket/name reveals, no early winner-list spoilers, attendance-free awards, late/reloaded audience screens, reduced-motion mode, and mobile layouts.

## Operations

- Back up PostgreSQL through your database provider. Render does not back up an external database for you.
- Keep the same `SESSION_SECRET` across deploys. Rotating it signs everyone out.
- Rotate the admin password through Render environment settings and redeploy. Rotate `SESSION_SECRET` too if existing admin sessions must be invalidated.
- All coordinators share one configured admin account in this version. The audit trail records actions, not individual coordinator identities.
- Activity evidence stays in Teams. Employee names/emails and event records are stored in PostgreSQL. Set an appropriate retention policy through your organization.
- For troubleshooting, use Render logs and `/healthz`. A failed startup reporting a missing variable means the environment configuration is incomplete. A failed database connection usually requires checking the connection string, SSL settings, database status, or network access.
