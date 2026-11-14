# How Tessera talks

One voice for every word in the product: buttons, empty states, errors, toasts and the portal.

**Clear, warm, a little witty in empty states, never cute in errors.**

## Principles

1. **Say what happened, then what to do.** Every message answers "what?" and, when something is
   needed, "now what?". Nothing else.
2. **Plain words, short sentences.** "Couldn't save the title", not "An error occurred while
   persisting your changes". Name things the way the screen names them (ticket, board, column).
3. **Talk to one person.** "You", "your board". Never "the user".
4. **Warm, not chummy.** Calm and on the person's side. No "Oops", no emoji, and an exclamation
   mark only in a real celebration (the portal's "sent" screen).
5. **Specific beats general.** "ORB-12 moved to Done" beats "Ticket updated". Use names and counts.
6. **Honest.** Never promise what the product doesn't do, never invent numbers, and say when
   something only partly worked ("2 tickets not changed: …").

## Where wit is allowed

| Place | Tone | Example |
|---|---|---|
| Empty states | Warm, one light touch at most, still useful | **Inbox zero.** Reports from the public portal wait here until someone accepts them. |
| Success toasts | Plain and specific | `ORB-12 moved to Done` |
| Errors | Plain. Never cute, never blaming | `Couldn't move ORB-12: In Progress is at its limit of 4. It's back where it was.` |
| Destructive confirmations | Plain; say what is lost | `Delete Orbit Checkout? Its tickets, comments and history go with it.` |
| Celebrations (rare) | Warm, a little delight | **Thanks, it's with the team.** |

The light touch in an empty state is a turn of phrase ("A clean slate", "Nothing on your plate"),
never a joke at anyone's expense and never in place of the instruction.

## Errors

- Lead with what failed: **Couldn't** + the action, then the reason, then what happens next.
- If something was put back (an optimistic change), say so: "It's back to how it was."
- If the person can fix it, say how. If they can't, say that it's on our side.
- No stack traces, no codes in the sentence.
- `client/src/lib/api.js` words the cases the server can't: no connection, the server not
  answering, and a refusal with no reason given.

## Words we use

| Use | Not |
|---|---|
| Couldn't … | Failed to, Unable to, Error: |
| Ticket | Issue, item (GitHub issues stay "issues") |
| Sign in, sign out | Log in, log out |
| Try again | Retry |
| Saved | Successfully saved |
