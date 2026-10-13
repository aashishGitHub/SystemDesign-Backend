# Teach Script: Server-Sent Events (SSE)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`sse-deep-dive-qa.md`](./sse-deep-dive-qa.md) (the full Q&A, with real production Go/React code) or [`diagrams.md`](./diagrams.md) (the one-page master diagram). This is the narrated version.
> **Every fact, number, and code shape below is pulled from this repo's own [`sse-deep-dive-qa.md`](./sse-deep-dive-qa.md)** — nothing here is a new claim.

---

## 1. The symptom

Alice was removed from project `proj-abc` three days ago. An admin clicked "remove collaborator," she got kicked out, and her UI even updated to show she no longer has the project in her list.

**She's still watching it update live, right now, in real time.** Someone on the team creates a new cluster in that project, and Alice's browser tab — the one she never closed — receives the event and could render it if the frontend code let it. Nothing crashed. No error fired. No log line looks suspicious. A connection that should have gone silent three days ago is still faithfully delivering data about a resource its owner is no longer authorized to see.

That's the sentence worth sitting with: **a long-lived connection doesn't automatically know that the world changed underneath it.** If you only decide "can this person see this" once, at the moment they connect, you've decided it for the entire lifetime of a connection that might stay open for fifteen minutes — or, if nobody's watching, indefinitely.

## 2. Why you should care

Any product with a live-updating UI — a dashboard, a collaborative tool, a project management app — eventually needs a server-push mechanism instead of polling every few seconds, and the moment that mechanism sits on top of anything with per-resource permissions, this exact bug is one line of "check once at connect time" away from becoming a real authorization leak. This is production code from this repo's own material (Couchbase Capella's `cp-api`), not a textbook exercise — the person who owns the real-time layer in a multi-tenant product owns exactly this problem.

## 3. What / Why / How

1. **What is SSE actually doing over the wire** that a normal request/response isn't?
2. **Why can't you just check "can this user see this" once, when the connection opens** — what specifically goes wrong if you do?
3. **How do you build a live-push system that's fast, works across multiple servers, and can't leak data to someone who's been removed?**

## 4. Umbrella words — kill them before using them

**"Real-time."** Decompose it into what's actually measured in this system: the full round trip from *someone else's* action to *your* UI updating is **under 500ms** end-to-end (versus up to 30 seconds for the old polling approach); a heartbeat comment is sent **every 10 seconds** specifically to stop proxies and load balancers from deciding an idle-looking connection is dead; and a single stream has a **maximum lifetime of around 15 minutes** by design, which is a number that turns out to drive an entire later design decision (section 5, last box).

**"Reliable" / "guaranteed delivery."** Here the honest answer is the opposite of message-queues' answer, and saying that contrast out loud is a strong signal. This system is explicitly **fire-and-forget** — at-most-once, no durability, no retry guarantee. That's not a shortcut; it's a deliberate, licensed choice, because the event carries **no actual data**, only a nudge that says "go refetch." Losing one is survivable specifically because the source of truth is a normal, cacheable HTTP GET the client calls right after — this reasoning falls apart the instant the event payload *is* the data itself, which is exactly [message-queues](../message-queues/teach.md)'s job instead.

**"Scale."** Decompose it into concrete numbers from this repo's own estimates: each connection costs **~5.5 KB** (a ~300-byte map entry plus a ~5 KB goroutine stack), so 10,000 connections is a target of **~55 MB per pod**; each user is capped at **2 connections** (enforced with an HTTP 429 on the third), because tabs, not users, are what the broker actually tracks; and browsers cap you at roughly **6 connections per domain on HTTP/1.1** — a real, concrete argument for moving to HTTP/2 once a handful of tabs can otherwise starve ordinary API calls.

## 5. The boxes — built one need at a time

**A browser needs to know the instant something changes** — a new project, a cluster finishing provisioning — without hammering the server with a request every few seconds. Regular HTTP is request-then-close; what you need instead is a connection the client opens **once** and the server can write to **whenever it wants**, indefinitely.

```
Regular HTTP:  GET /projects → 200 OK { data } [connection closes] → repeat every 30s
SSE:           GET /sse/stream → 200 OK (headers flushed, stays open)
                                → event: project_created\ndata: {...}\n\n
                                → : heartbeat\n\n
                                → ...connection stays open...
```

**That's Server-Sent Events**, and the browser has a built-in class, `EventSource`, that opens the connection, parses the `event:`/`data:` lines, and auto-reconnects if it drops.

**Gap: `EventSource` can't send custom headers — so how do you attach a JWT to authenticate the stream?** This is a real, concrete limitation, not a hypothetical: `new EventSource(url, { headers: {...} })` simply isn't supported. The fix is a library (`@microsoft/fetch-event-source`) that wraps `fetch` — which *does* support headers — and makes it behave like `EventSource` underneath.

**Gap: the server needs to hold this connection open and write to it whenever an event shows up, without one slow browser tab blocking every other one.** One goroutine per connected client, sitting in a loop, waiting on whichever of three things happens first: a heartbeat tick, an incoming event for that client, or the connection closing.

```go
for {
    select {
    case <-r.Context().Done():        // browser closed the tab
        return
    case <-heartbeat.C:                // every 10s — keeps proxies from killing an idle-looking stream
        fmt.Fprintf(w, ": heartbeat\n\n"); flusher.Flush()
    case event, ok := <-client.Chan:    // an event arrived for THIS client specifically
        fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, payload); flusher.Flush()
    }
}
```

Why per-client and not one shared loop for everyone? If one goroutine pushed to all 10,000 clients in a `for` loop, one slow client would block that send — and therefore block every client behind it in the loop. Per-client channels mean a slow client's channel fills up and gets dropped, and nobody else even notices.

**Gap: when an event happens, who needs to receive it?** You need a directory of everyone currently connected — and it needs enough structure to answer "everyone in this org," not just "everyone," or every publish becomes an `O(all clients everywhere)` scan. A nested map — `tenant → user → clientID → channel` — answers "who's in this org" in one lookup, and "how many tabs does this user have open" with a simple `len()`.

```go
clients map[string]map[string]map[string]chan Event
//         tenantID     userID     clientID   the channel to that exact tab
```

**Now — the gap that produces the symptom.** When an event fires for a resource, does the broker check "is this specific user still allowed to see this" — or did it only check that once, back when the connection first opened? **This is the entire bug from section 1.** If access is only verified at connect time, then removing someone from a project days later changes nothing about their already-open connection — it just keeps delivering. The fix: **re-check authorization on every single event, at the moment of fan-out, against current permissions** — not the permissions that were true when the connection opened.

```go
for userID, userClients := range tenantClients {
    authorized := rbac.CanAccess(userID, event.ResourceID, event.ResourceType)  // LIVE check, every time
    if !authorized {
        continue  // this user does not receive this event, full stop
    }
    for _, ch := range userClients {
        ch <- event
    }
}
```

**One sharp edge worth naming unprompted:** what about the event that *announces* someone's removal? If you apply the same rule literally, the moment Alice is removed, `CanAccess` immediately returns false for her — which means the `collaborator_removed` event itself would be withheld from the one person whose UI most needs it, and her project list would never update. The fix is a narrow, explicit bypass: if the event *is* a removal event *for that specific user*, deliver it anyway, so her UI can react and drop the stale card. Every other event for that resource, from that moment on, is correctly withheld.

**Gap: your API runs on multiple pods behind a load balancer. Bob's request that creates a project lands on Pod B. Alice's open SSE connection lives on Pod A.** If Pod B's in-memory broker only knows about Pod B's own connected clients, Alice's tab — sitting on a different pod — never hears about Bob's change. No error. The feature simply, silently, doesn't work for a chunk of your users depending on which pod they happened to land on.

```
Bob's request → Pod B: saves to DB, then publishes locally
                                ↓
                Pod A's broker never hears about it
                                ↓
                Alice's tab (connected to Pod A) never updates
```

The fix is a lightweight message bus between pods (this system uses **NATS Core pub/sub**, specifically *not* Kafka — worth naming why: the events here are signals, not durable data; a missed one is fine because the next heartbeat or manual refresh recovers it, and Kafka's partitioning, consumer groups, and retention exist to solve a durability problem this system doesn't have). Every pod subscribes; a publish from any pod reaches every pod; each pod does its own local fan-out from there.

```
Bob's request → any pod → DB write → publish to NATS topic
                                            ↓
                         every subscribed pod receives it
                          ↙          ↓          ↘
                      Pod A       Pod B       Pod C
                        ↓           ↓           ↓
                  local broker does local fan-out (with the RBAC check above)
```

**Gap: does publishing this event block Bob's HTTP response while it waits for every subscriber to actually receive it?** No — publish is **fire-and-forget**, run in a separate goroutine, so Bob's `POST /projects` returns as soon as the database write succeeds. This is safe *specifically* because the event is a hint, not the data: if the publish silently fails, the project still exists in the database, and the next time anyone loads the page, they see it via a normal GET.

**Last gap: Kubernetes wants to replace this pod with a new version — what happens to every open 15-minute stream it's holding?** If you let connections drain naturally, a pod holding even one long-lived stream can block a deployment for the stream's entire remaining lifetime. The fix is to **actively close every connection on `SIGTERM`** — cancel the broker's context, which closes every client channel, which makes every handler goroutine's `select` see a closed channel and exit cleanly, which closes every HTTP connection immediately. `EventSource` on the browser side notices the drop and reconnects — automatically, to whatever pod is alive now — typically within a few seconds.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **every event is re-checked against live permissions at the moment it's about to be delivered, not at the moment the connection opened; it carries no data, only a nudge to refetch, so a missed one is recoverable; and a lightweight pub/sub bus between pods means any pod can serve any subscriber, because every pod's local broker hears the same event.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the literal SSE wire syntax (`event:`, `data:`, the blank line that ends an event, `:` for a comment) — once you know it exists and why, you look up the exact punctuation, you don't memorize it; the specific `X-Accel-Buffering: no` header name (know it exists to stop nginx from buffering your stream, look up the exact spelling when you need it).

**Understand once, then trust it:** the ~5.5 KB-per-connection memory math and the "single goroutine owns the map" concurrency rule (all registration/unregistration flows through channels into one `Run()` loop specifically to avoid Go's "concurrent map write" panic) — know *that* this constraint exists and *why*, you don't need to re-derive Go's memory model from scratch each time; the exact `MaxConnectionsPerUser = 2` constant — a tuned number, not a law.

**This is the actual idea — think hard here:** (1) per-event, not per-connection, authorization — this is the actual security property of the whole system, and it's the answer to "why not just check once at connect time"; (2) fire-and-forget as a *deliberate, licensed* choice that only works because the payload is a hint, never the data itself — the moment someone asks you to make an event carry the actual state, this whole design's safety argument stops applying; (3) the pub/sub hop between pods as the thing that makes "any pod can serve any subscriber" literally true, rather than "usually true if you're lucky with load-balancer routing"; (4) active close on `SIGTERM` — a connection that can legitimately live 15 minutes will hold a deploy hostage unless something forces it closed.

## 7. The build — the smallest thing that actually shows the mechanism

No real Go server or NATS cluster here — that's genuine infrastructure, and standing it up just to have something to type would teach you `docker compose`, not the idea. The one mechanism from bucket three above — per-event authorization versus connect-time-only authorization — fits in code you can run right now:

```python
# save as per_event_rbac_demo.py, run with: python3 per_event_rbac_demo.py

access = {"alice": {"proj-abc"}}  # live, mutable access state — can change at any time

def can_access(user, resource):
    return resource in access.get(user, set())

class NaiveBroker:
    """Checks access ONCE, at subscribe time, and never again."""
    def __init__(self):
        self.subscriptions = {}   # user -> {resource: allowed_at_subscribe_time}

    def subscribe(self, user, resource):
        self.subscriptions.setdefault(user, {})[resource] = can_access(user, resource)

    def publish(self, resource, event):
        return [u for u, r in self.subscriptions.items()
                if r.get(resource)]           # uses the STALE cached decision

class CorrectBroker:
    """Re-checks access at the moment of every publish."""
    def __init__(self):
        self.subscriptions = {}   # user -> set of resources they're listening to

    def subscribe(self, user, resource):
        self.subscriptions.setdefault(user, set()).add(resource)

    def publish(self, resource, event):
        return [u for u, r in self.subscriptions.items()
                if resource in r and can_access(u, resource)]   # LIVE check

naive, correct = NaiveBroker(), CorrectBroker()
naive.subscribe("alice", "proj-abc")
correct.subscribe("alice", "proj-abc")

print("While Alice still has access:")
print("  naive broker delivers to:  ", naive.publish("proj-abc", "cluster_created"))
print("  correct broker delivers to:", correct.publish("proj-abc", "cluster_created"))

access["alice"].discard("proj-abc")   # an admin removes Alice from the project

print("After Alice is removed (her subscription is never torn down):")
print("  naive broker delivers to:  ", naive.publish("proj-abc", "cluster_updated"))
print("  correct broker delivers to:", correct.publish("proj-abc", "cluster_updated"))
```

Run it. Both brokers deliver to Alice while she has access. After she's removed, the naive broker **still delivers to her** — the exact bug from section 1 — while the correct broker delivers to no one, because it asked the live permission system fresh, at the moment of publish.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** After the removal, add one more line: `access["alice"].add("proj-abc")` — an admin re-adds Alice — and publish a third event. Watch the correct broker start delivering to her again **automatically, with no reconnect, no re-subscribe, nothing** — because it never cached a decision in the first place, it just asks the live system every time. That self-healing property is the entire payoff of checking live instead of caching.

**Sabotage 2 (walk it in your head, no code needed).** Now delete the NATS hop from the architecture and go back to each pod's broker only knowing about its own local connections. Walk it: Bob's browser is pinned to Pod B by the load balancer; Alice's browser is pinned to Pod A. Bob creates a project. Pod B saves it to the database successfully — the project genuinely exists, `POST /projects` returns `201` — and Pod B's *local* broker fans the event out to whichever of *its own* clients are authorized. Pod A's broker never receives anything, because nothing told it to. Alice's tab sits there, connected, healthy, heartbeating every 10 seconds, and simply never learns the project exists — until she manually refreshes the page. **Nothing in this failure looks broken from the outside**: no errors, no dropped connections, no 5xx anywhere. That's what makes it dangerous — the silent-failure surface this bug creates is exactly why the pub/sub hop is "mandatory," not "an optimization for later."

## 9. One-sentence recap

Same words as before, on purpose: **every event is re-checked against live permissions at the moment it's about to be delivered, not at the moment the connection opened; it carries no data, only a nudge to refetch, so a missed one is recoverable; and a lightweight pub/sub bus between pods means any pod can serve any subscriber, because every pod's local broker hears the same event.**

## 10. What transfers

Swap NATS for Redis pub/sub, SNS fan-out, or MSK, and swap Go's goroutine-per-connection model for whatever your language's equivalent concurrency primitive is — those are the incidental, swappable pieces (and this repo's own material names exactly this trade-off: NATS/Redis pub/sub are cheap and at-most-once, MSK/Kafka buys you replay if you ever need it). What transfers to **every** long-lived push system, in any language, on any stack: authorization has to be checked **per event**, live, whenever the underlying permission model can change out from under an open connection — never cached at connect time; **fire-and-forget is only safe when the payload is a hint, not the data** — the instant a design needs the event itself to be durable and lossless, that's [message-queues](../message-queues/teach.md)'s problem, not this one; a shared pub/sub layer is what turns "any node can serve any subscriber" from a hope into a guarantee the moment you have more than one server process holding connections; and long-lived connections need to be **actively** torn down on shutdown, because "wait for them to drain" is not a plan when a connection can legitimately live for fifteen minutes.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the per-event RBAC re-check → Alice's exact bug returns, a live authorization leak that no error surfaces. Delete NATS (the pub/sub hop between pods) → any user not connected to the exact pod that handled a given write silently never sees the update, with nothing in any log indicating a problem. Delete active close on `SIGTERM` → a rolling deploy can hang for up to fifteen minutes per pod waiting for long-lived streams to drain on their own, blocking every release.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer, straight from this repo's own failure-mode table: a dropped-event counter and channel-full occurrences first — that's a slow consumer being disconnected, which is expected and self-healing; then reconnect-rate spike plus a connection-count cliff on one pod, which points at a bad rolling deploy causing a reconnect stampede; then an audit trail of deliveries after a specific revocation timestamp, which is exactly how you'd prove or disprove a permission leak like section 1's.)*

If you answered all three cold, go read [`sse-deep-dive-qa.md`](./sse-deep-dive-qa.md) anyway — it has the real Go and React code this script only summarized, plus the connection-limit enforcement (Q8) and the frontend `SSEProvider` wiring (Q10) this script deliberately left out so as not to bury the four ideas that actually matter under implementation detail. Those are the natural next read, along with [`diagrams.md`](./diagrams.md)'s one-page master diagram for final revision.
