# Testing Tessera with real repositories

A checklist for testing the GitHub, Slack and Discord features on real projects in the live app
(https://tessera-eight-gamma.vercel.app), using Spendwise, Wardline and Hopin. Each step says
what to do and what you should see. Tick it when it works.

**One rule:** only close a ticket when its work is actually done. To show a ticket closing, first
create a small real task, do it for real, then let the commit or merge close it. Don't close
"Custom domain" with a commit that doesn't add a custom domain.

Ticket numbers in the live app:

| Project | Tickets |
|---|---|
| Spendwise (SPE) | 1 Freelance income · 2 Tax-filing pack · 3 Email-forwarded statements · 4 Custom domain · 5 PDF statements · 6 API sleeps overnight |
| Wardline (WAR) | 1 Vite "403 Restricted" on Windows · 2 Grow the corpus |
| Hopin (HOP) | 1 Always-on server · 2 Bengali · 3 Flood-aware routing · 4 UPI on Razorpay · 5 Ride insurance · 6 Ambulance tie-up |

What is already set up: each project's real commits as finished tickets (label `from-git-history`, numbers SPE-7..22, WAR-3..16, HOP-7..11; start times estimated), GitHub webhooks on all three repos (pings returned 200), a GitHub token
and Slack plus Discord alerts on Spendwise and Wardline.

---

## 0. Setup (once, about 10 minutes)

- [ ] **Board filter.** On any board, switch off **Assigned to me**. All tickets show.
- [ ] **Hopin chat alerts.** Hopin → Settings → **Alerts and webhooks** → **Chat alerts** → add a Slack
      alert and a Discord alert with the same links as Spendwise. Tick *ticket created* and
      *ticket done*, plus *moved* and *commented* if you want more messages. Press **Send a test** on
      each one. **Check:** a message arrives in Slack and in Discord.
- [ ] **Hopin GitHub token.** Hopin → Settings → GitHub → **GitHub token**. Paste a fine-grained
      token you create on GitHub (Settings → Developer settings → Fine-grained tokens, only the
      `hopin` repo, permissions Contents: read, Issues: read and write, Pull requests: read,
      Metadata: read). **Check:** it shows *Connected*.
- [ ] **Card moves.** In each project's GitHub settings, set **branch created → In Progress**.
      Optional: add an **In Review** column under Settings → Workflow, then set
      **pull request opened → In Review**.
- [x] **Deploys.** Already set: production is `main - spendwise-api` (Spendwise) and `main - hopin-api` (Hopin), and their real past Render deploys are recorded.
- [ ] **Two windows.** Open the board in a second browser, or a private window, so you can watch
      changes arrive live.

## 1. Chat alerts (Slack and Discord)

- [ ] Create a ticket in Spendwise, e.g. **"Link the Tessera board from the README"** (task, low).
      **Check:** within seconds, "New task, low priority" appears in Slack and in Discord, with the
      ticket's title and link. This ticket is the one you'll close for real in step 2.
- [ ] In Settings → Alerts, set one alert to **critical only**, then create a low-priority ticket.
      **Check:** that alert stays silent and the other posts.
- [ ] **Check:** each alert shows its last delivery as successful (200 for Slack, 204 for Discord).

## 2. A commit closes a ticket (push to the default branch)

- [ ] On GitHub, edit Spendwise's README and add one line linking to its Tessera board. Commit
      to `main` with the message **`Link the Tessera board, fixes SPE-23`** (use the number your new
      ticket got).
- [ ] **Check, in Tessera:** SPE-23 moves to **Done** by itself and shows the commit under
      **Linked to GitHub**. The second window updates without a refresh.
- [ ] **Check, in Slack and Discord:** a "Finished" message for SPE-23.
- [ ] **Check:** a commit that only mentions a ticket (e.g. `refs SPE-6`) links the commit and does
      **not** close the ticket.

## 3. Branch → pull request → merge (the full developer flow)

Pick (or create) a small real task you'll actually do, e.g. **"Explain the overnight sleep
window in the README"**, which is part of SPE-6.

- [ ] On GitHub, create a branch named **`docs/SPE-6-sleep-window`**.
      **Check:** SPE-6 moves to **In Progress** on its own.
- [ ] Commit the README note on that branch with **`Explain the night sleep window, refs SPE-6`**.
      **Check:** the commit is linked on SPE-6. It isn't closed, because the branch isn't the
      default one.
- [ ] Open a pull request titled **"Explain the overnight sleep window (SPE-6)"**.
      **Check:** the card shows the pull request with its state (review requested, CI running /
      passing / failing, or *No test changes*), and moves to In Review if you set that.
- [ ] Approve or comment on the pull request on GitHub. **Check:** the badge on the card updates.
- [ ] Merge it. If the pull request says "fixes SPE-6", SPE-6 closes on merge. Only use "fixes"
      if the whole ticket is really done; otherwise keep "refs" and it stays open with the merged
      pull request linked.

## 4. Deployments

- [ ] After the merge in step 2 or 3, Render deploys Spendwise and reports to GitHub.
      **Check:** Spendwise → **Deploys** lists the deploy, and the tickets it shipped show as
      **live**, not just merged.
- [ ] **Check:** the DORA numbers (deploy frequency, lead time) are filled in, and the README badge
      and status page (Deploys settings) show the latest release.

## 5. GitHub Issues, both ways (Spendwise or Wardline, where the token is set)

- [ ] On GitHub, open an issue in `spendwise`, e.g. "CSV import: show which row failed".
      **Check:** it appears in Tessera as a new ticket (source GitHub), and Slack and Discord post it.
- [ ] Close that issue on GitHub. **Check:** the ticket closes in Tessera.
- [ ] On a Tessera ticket, press **Open a GitHub issue for this**. **Check:** the issue appears on
      GitHub with "Tracked in Tessera as SPE-n". The repos are public, so the issue is public too.
- [ ] Settings → GitHub → **Import open issues now**. **Check:** it reports what was imported and
      skips issues it already has.

## 6. Code health (needs the token)

- [ ] On a project with the token, open **Code health**. **Check:** **Bug hotspots** and knowledge
      risk load from the repo's real history. With few bug-fix pull requests they say so honestly
      ("No crash or bug-fix pull request points at a file yet").
- [ ] Run the TODO scan. **Check:** it lists real `TODO` comments with file and line. **Make ticket**
      turns one into a ticket.
- [ ] Paste a real stack trace from the project into a new ticket. **Check:** frames from the
      repo's own files link to the file and line on GitHub. **Suspect commit** names the last
      commit that touched that line.

## 7. Wardline (the same checks)

- [ ] Repeat step 2 on Wardline with a small real change, committing to `main`.
      **Check:** the ticket closes, and Slack and Discord post it. Wardline has no deploys, so step 4
      doesn't apply.

## 8. Hopin (after setup step 0)

- [ ] Repeat steps 1–4 on Hopin. Render deploys `hopin-api`, so Deploys works as it does for
      Spendwise.

---

## If something doesn't happen

- **Nothing within a minute:** the free API was probably asleep. Open the app first, then push
  again. GitHub → repo → Settings → Webhooks → **Recent Deliveries** shows each delivery and its
  response. Use **Redeliver** to send one again.
- **Ticket didn't close:** the message needs "fixes", "closes" or "resolves" before the key, and
  the push must be to the default branch (`main` on all three repos).
- **No chat message:** check that alert's events and priorities in Settings → Alerts, and press
  **Send a test**.
