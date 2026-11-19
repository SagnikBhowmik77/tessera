# Tessera demo script (for the video)

Follow this in order and every feature gets shown once. Each step says **where to click**, **what to type** and
**what it proves**. All example values are made up; use them as they are, or change them.

- **Site:** https://tessera-eight-gamma.vercel.app · **API:** https://tessera-api-7hwj.onrender.com/api/health
- **Sample files:** [`demo/sample-crash.txt`](demo/sample-crash.txt) (a crash to paste, with a fake password, token and
  email in it) and [`demo/sample-tickets.csv`](demo/sample-tickets.csv) (8 tickets to import). Download both first.
- **Length:** about 30–35 minutes if you show everything. For the 7–10 minute video, record the parts marked ⭐ and see
  [the short cut](#the-short-cut-710-minutes) at the end.

## Before you record

1. **Wake the server.** Open https://tessera-api-7hwj.onrender.com/api/health and wait for `"connected":true` (up to
   a minute if it was asleep). Then open the site.
2. **Two accounts, two windows.** Your own account in normal Chrome. For the teammate, a **Chrome Incognito** window
   (Ctrl+Shift+N) signed up as `yourname+teammate@gmail.com`: Gmail delivers `+` addresses to your normal inbox, so its
   confirmation and invite emails reach you too. Put the two windows side by side for Part 8.
3. **Keep Gmail open** in a tab. Several steps send real emails; they arrive in a few seconds.
4. **Give the project a day or two of history** before recording Part 7: create the tickets and move some of them
   through the columns. Analytics and forecasts are built only from real history.
5. **For Part 10 (optional):** one of your GitHub repositories you can push a commit to.
6. Close other tabs and turn off notifications from other apps.

---

## Part 1: First look and sign-up (3 min) ⭐

| # | Where | What to do | What it shows |
|---|---|---|---|
| 1.1 | Front page `/` | Scroll slowly: headline, the four feature cards | What Tessera is and its four signature features |
| 1.2 | Front page, **Paste a stack trace** demo | Click **Paste it again from the next build** | Line numbers change, the fingerprint doesn't: "Same crash". It runs the server's own parser in the browser |
| 1.3 | Front page, **When will it be done?** demo | Pick **A bursty team**, drag **Tickets still open** | A Monte Carlo forecast at 50/85/95%; **A brand-new team** refuses to guess |
| 1.4 | Top right | **Create an account** → Name `Riya Sharma`, Email `yourname+demo@gmail.com`, Password `DemoVideo2026!` → **Create account** | You land on Projects |
| 1.5 | Your inbox | Open the confirmation email → click the link | Email confirmed; the "Confirm your email" note disappears |
| 1.6 | Sign out → **Sign in** | **Continue with GitHub** (or **Continue with Google**) | Sign-in with GitHub and Google |
| 1.7 | *(optional)* Sign-in page | **Forgot password?** → your email → open the email → set a new password | One-time reset link by email |

## Part 2: A project and a team (3 min)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 2.1 | Projects | **New project** → Name `Shop Checkout`, Key `SHOP`, template **Scrum** → **Create project** | Columns and labels from a template |
| 2.2 | Board | **Set up this project** → **Show steps** | A checklist worked out from what is really in the project |
| 2.3 | Settings → Project → **Invite people** | Email `yourname+teammate@gmail.com`, role **Developer** → **Invite** | A real invite email |
| 2.4 | Incognito window | Sign up as the teammate, open the invite email, accept | The teammate joins the project |
| 2.5 | Settings → **Members** | Make the teammate **Viewer**; in Incognito, try to edit a ticket; make them **Developer** again | Roles: viewers can look and comment, not change |
| 2.6 | Settings → Board and tickets → **Board columns** | Give **In Progress** a WIP limit of `2` → save | Work-in-progress limits |

## Part 3: Tickets and the board (5 min) ⭐

| # | Where | What to do | What it shows |
|---|---|---|---|
| 3.1 | Board | Press **C** → Title `Checkout button does nothing on Safari 17`, Type **Bug**, Priority **Critical** → **Create ticket** | Keyboard shortcut + a new ticket |
| 3.2 | List | **Import CSV** → choose `sample-tickets.csv` → check the preview (8 valid) → import | Import with a preview; 8 tickets appear |
| 3.3 | Board | Drag three cards into **In Progress** | Drag and drop; the third breaks the WIP limit and the column warns you |
| 3.4 | Board | Click a card's key, press **Space**, **→**, **Space** | The board works from the keyboard and says where the card went |
| 3.5 | Board | **No swimlanes** → **Lanes by priority**; then **Assigned to me** | Swimlanes and quick filters (remembered with your account) |
| 3.6 | Open `SHOP-1` | Set assignee, due date, labels; **Add a sub-task** `Reproduce on iOS 17.4`; under **Blocked by** enter `SHOP-3` → **Add** | Planning inside a ticket; the card shows it is blocked |
| 3.7 | `SHOP-1` comments | Type `@`, pick the teammate, send | Mentions: a notification and an email for them |
| 3.8 | `SHOP-1` files | Paste a screenshot (Ctrl+V) → draw a box on it → save | Screenshot annotator |
| 3.9 | `SHOP-1` | Scroll to the history | Every change is recorded |
| 3.10 | `SHOP-1` | Reassign it to the teammate → write a **Handoff note** | Handoffs carry context |
| 3.11 | `SHOP-1` | **Follow** (bell) and **Snooze** until tomorrow | Following and snoozing; snoozed work moves to My work → Snoozed |
| 3.12 | A ticket's menu | Delete it → List → **Bin** → restore it | Nothing is lost by accident |

## Part 4: Bug intelligence (4 min) ⭐ (the strongest part)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 4.1 | Board | Press **C** → **Paste an error** → paste `sample-crash.txt` | Read as you paste: JavaScript `TypeError`, 5 frames, your code vs library |
| 4.2 | Same dialog | Point at **Removed before saving: 1 password in URL, 1 JWT, 1 email** | Secrets are removed before anything is saved |
| 4.3 | Same dialog | **Create bug from error** → open the new bug | The description shows `[redacted: …]`; the frames and the error panel |
| 4.4 | Board | **C** → **Paste an error** → paste the same file again | "Seen before as SHOP-…"; creating it counts on the same ticket (reported 2 times) |
| 4.5 | The bug | Move it to **Done**; then paste the crash a third time | The ticket **reopens itself** as a regression and notifies the team |
| 4.6 | The bug → Reproduction | **Write the steps…** → `1. Add item 2. Apply coupon 3. Pay`; then **I reproduced it**, where `Chrome on Windows` | Reproduction tracking |
| 4.7 | The bug's error panel | **Mute** for 1 day with a reason; then unmute | Known crashes can be silenced on purpose |
| 4.8 | New ticket | Type the title `Coupon codes fail in lowercase` slowly | Similar existing tickets appear while typing (duplicate finder) |
| 4.9 | Analytics | Scroll to the error groups | Crashes ranked by impact |

## Part 5: List, search and My work (3 min)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 5.1 | List | **Filter** → Priority **High**; then remove the chip | One row of filters; the ones in use as chips |
| 5.2 | List search | Type `type:bug priority>=high` | The search language (it shows what it understood) |
| 5.3 | List | **Save view** → `High bugs` | Saved views |
| 5.4 | List | Tick three rows → change their priority together | Bulk edit |
| 5.5 | List | **Export CSV** | The same rows as a spreadsheet |
| 5.6 | My work | The groups by status, due dates, last change | Your work across all projects |
| 5.7 | Anywhere | **Ctrl+K** → type `SHOP-3` → Enter; then press **?** | Command palette and keyboard shortcuts |

## Part 6: Planning (3 min)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 6.1 | Sprints | **New sprint** → `Sprint 1`, two weeks → add 4 tickets → **Start** | A running sprint; the board can show only its tickets |
| 6.2 | Sprints → Milestones | **New milestone** → `Checkout v2`, three weeks ahead; put 2 tickets in it | Milestones |
| 6.3 | A ticket | Make one ticket an **Epic**; set 3 tickets' **Epic** to it | Epics with progress |
| 6.4 | Timeline | Give a few tickets start and due dates | Bars from start to due, with the sprint and milestone on the same axis |
| 6.5 | Calendar | Drag a ticket to another day | Rescheduling by drag |
| 6.6 | *(later)* Sprints | **Complete** → carry unfinished work → **Report** | What was committed, added, finished and carried over |

## Part 7: Analytics, forecasts and time travel (3 min) ⭐

| # | Where | What to do | What it shows |
|---|---|---|---|
| 7.1 | Analytics | Cycle time, cumulative flow, time in each column | Flow metrics from the history of every change |
| 7.2 | Any chart | Click **Table** | Every chart has a table view (accessibility) |
| 7.3 | More → **Flow** | **When will it be done?**; change the what-if (add tickets, pace) | A forecast at 50/85/95% confidence (needs 5 finished tickets) |
| 7.4 | Flow | **What to work on next** and **Why work is slow** | Plain-English reasons, each checkable |
| 7.5 | Board | **Time travel** → drag back a few days (or Page Down) → **Replay** | The board exactly as it was on any past day |
| 7.6 | More → **Release notes** | Pick this week → copy | Notes written from the tickets finished |

## Part 8: Live collaboration (3 min) ⭐ (both windows side by side)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 8.1 | Both on the same board | In one window drag a card to another column | It moves in the other window at once, with a short glow |
| 8.2 | Both | In one window pick a card up with **Space** | The other shows "… is moving this" |
| 8.3 | Both open `SHOP-2` | Start typing a comment in one | Avatars of who is here; "… is typing" in the other |
| 8.4 | `SHOP-2` | **Estimate together** → both vote → **Show votes** → pick a value | Planning poker sets the story points |
| 8.5 | More → **Together** | **New retro** → notes from both, vote, make a ticket from an action | A live retro board |
| 8.6 | Together | **Start an incident** → add a note → **Resolve** | A banner on both boards, a timeline and a postmortem |
| 8.7 | Both edit `SHOP-2`'s title at once and save | | The second save shows both versions side by side instead of overwriting |

## Part 9: Outside-in (4 min) ⭐

| # | Where | What to do | What it shows |
|---|---|---|---|
| 9.1 | Settings → Sharing → **Public bug-report page** | Tick **Accept reports from the public** → **Copy** the link | A public page for clients |
| 9.2 | Incognito, **signed out** | Open the link → title `The pay button spins forever`, details, email `yourname+client@gmail.com` → **Send report** | No account needed; three short steps |
| 9.3 | Inbox | The receipt email | Reporters hear back |
| 9.4 | Public page | Language → **हिन्दी** or **বাংলা** | Six languages |
| 9.5 | Your window → More → **Triage** | Press **2** (high) → **Enter** | The report is accepted onto the board with single keys |
| 9.6 | Incognito → **Follow your report** | Write a message | A private tracking page with a conversation |
| 9.7 | The ticket | Comment with **Reply to reporter** | It appears on their tracking page (and by email) |
| 9.8 | The ticket | Move it to **Done** | The reporter gets the "fixed" email |
| 9.9 | Tracking page | **No, still broken** | The ticket reopens and its assignee is told |
| 9.10 | *(optional)* Settings → Sharing | **Public roadmap** and **Read-only board links** | Plans and the board shared without accounts |

## Part 10: Integrations (3 min, optional)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 10.1 | Settings → Integrations → **GitHub** | **Connect GitHub** → copy the **Payload URL** and **Secret** | A signed webhook |
| 10.2 | GitHub repo → Settings → Webhooks | Add webhook: that URL, content type `application/json`, that secret | GitHub sends commits and pull requests to Tessera |
| 10.3 | Your repo | Commit `fix coupon parsing, fixes SHOP-3` to the main branch and push | SHOP-3 closes by itself and the commit shows on it |
| 10.4 | Account → **API tokens** | **New token** (read only) | Personal API tokens for scripts and the CLI |
| 10.5 | Browser | Open https://tessera-api-7hwj.onrender.com/api/docs | Every endpoint, documented from the running code |

## Part 11: Your account and the app everywhere (2 min)

| # | Where | What to do | What it shows |
|---|---|---|---|
| 11.1 | Account → **Two-factor authentication** | Scan the QR code with an authenticator app, enter the code, save the backup codes | Two-step sign-in |
| 11.2 | Account | The signed-in devices | Sign out one device, or everywhere |
| 11.3 | Account → Preferences | Dark/light, compact density, an accent colour | A personal look, saved with the account |
| 11.4 | Account → Notifications | Quiet hours or a daily digest; **Turn on for this device** | Control over email and push notifications |
| 11.5 | Phone | Open the site; browser menu → install | Works on a phone and installs like an app |
| 11.6 | Settings → Data → **Backup** | **Download backup** | The whole project as one file (**Import backup** on Projects restores it) |

## Part 12: Proof it is built properly (1 min) ⭐ (examiners like this)

| # | Where | What to show | What it proves |
|---|---|---|---|
| 12.1 | https://github.com/SagnikBhowmik77/tessera/actions | The green **CI** run | Server tests, a dependency audit, a load test, the build and browser tests on every push |
| 12.2 | Terminal, in `server/` | `npm test` → **269 pass, 0 fail** | 269 automated tests on a throwaway database |
| 12.3 | README → Research | Lighthouse 86–100, axe finds no accessibility problems, 500 live watchers at 21 ms | Measured, not claimed |

---

## The short cut (7–10 minutes)

Your video order is: you, the project, tech stack and why, use cases, research, then the app. The README covers the
first five; for the app (about 5 minutes), record:

1. **1.1–1.2** front page and one demo (30 s)
2. **3.1, 3.3, 3.5** a ticket, drag with the WIP warning, swimlanes (60 s)
3. **4.1–4.5** paste a crash, secrets removed, same crash, regression (90 s)
4. **8.1, 8.3** two windows, a live move and typing (40 s)
5. **7.1, 7.5** analytics and time travel (30 s)
6. **9.2, 9.5, 9.8** a client's report → triage → fixed email (60 s)
7. **12.1** the green CI run (10 s)

## If something goes wrong while recording

- **The first click takes a minute:** the free server was asleep. Open the health link first next time.
- **An email doesn't arrive:** wait 10 seconds and check spam; reset and confirmation links work once.
- **Analytics look empty:** the project is too new; record Part 7 on a project with a few days of moves.
- **Never show on screen:** `server/.env`, the Render or Vercel environment pages, or your Gmail app password.
