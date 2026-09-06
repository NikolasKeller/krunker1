# Realtime transport investigation — 2026-09-06

Base and measured live revision: `ea08e6c66f55bb44fb3b667f29cb748e9f399073`.

**Decision: retain the production WebSocket transport pending a deployed, poor-link A/B measurement.** The live socket measurements provide substantial evidence of TCP loss/reordering during state stalls. They do not establish the improvement achievable with WebRTC, and the requested Railway load acceptance run could not be performed. This investigation is inconclusive about the benefit of migration.

Only diagnostic tools, development dependencies, tests and documentation changed. Nothing under `src/` changed. No deployment, framework adoption, browser launch or CDP connection occurred.

## Live measurements

Three 120-second captures connected to the actual public `/ws` endpoint using `arena-v4`. Each created its own room with seven bots, reconstructed the production delta stream, recorded only successfully applied snapshots as updates, and sent ping probes at 250 ms intervals. Existing rooms were left alone. The vantage point was this workstation, not the affected player's machine or inside Railway. It experienced considerable jitter itself; no network impairment was injected.

All captures retained the same deployed revision, with zero baseline errors or invalid states.

| Capture | Applied states | Applied gap p99 / maximum | Source timestamp gap p99 / maximum | Application RTT p50 / p95 / p99 / maximum |
| --- | ---: | ---: | ---: | ---: |
| During dependency installation | 2399 | 137.15 / 918.94 ms | 51 / 55 ms | 658 / 1772 / 2926 / 4178 ms |
| Repeat without dependency downloads | 2400 | 97.21 / 334.14 ms | 51 / 55 ms | 677 / 1988 / 2560 / 3060 ms |
| Final, with per-socket TCP counters | 2407 | **378.70 / 2043.01 ms** | **51 / 53 ms** | 686 / 2046 / 3754 / 4925 ms |

The first capture overlapped npm downloads and is retained as a confounded observation. The repeat's final seconds overlapped local probe initialization. The final capture ran after the local comparison, fallback checks, test suite and build completed. The different results demonstrate changing link conditions, not the effect of a software change. These are **not before/after migration results**.

Sources: [first capture](live-websocket-during-install.json), [repeat](live-websocket-repeat.json), [final capture](live-websocket.json). Each summary links to its raw arrival records. Receive times are monotonic milliseconds relative to the capture; source timestamps are server epoch milliseconds. No clock synchronization is needed to compare consecutive gaps. The final capture's event-loop delay was p99 **11.78 ms**, maximum **39.55 ms**. It recorded **816** consecutive update gaps below 5 ms, consistent with bursts after stalls. A synthetic 60 Hz observation grid reports p99 **416.67 ms**, maximum **2033.33 ms** between occupied frames; this is not a browser render measurement.

The final capture also read `TCP_CONNECTION_INFO` from a duplicate of the **same client TCP socket**, approximately every 50 ms, without reading or writing application bytes. Over the sampled interval:

- **30 outbound retransmitted packets / 2808 retransmitted bytes**.
- **218,796 inbound out-of-order bytes**.
- **257** applied-state gaps exceeded 100 ms.
- **215 of those 257 gaps (83.7%)** contained an increase in received out-of-order bytes with both bounding counter samples strictly inside the gap. Expanding the association window by 50 ms on either side finds 251 gaps. Only one gap contained an outbound retransmission increase with both samples strictly inside it.

This is evidence that later TCP data was arriving out of order while application state was stalled. It strengthens the head-of-line-blocking hypothesis. **83.7% is an association across observed gaps, not a measured percentage of jitter time caused by retransmission.** Out-of-order counters also count reordering; outbound retransmissions describe the upload direction; loss of an entire flight can stall a download without any out-of-order counter increase. The counters do not reveal the exact recovery time or the plain-latency component of every gap. [Raw TCP samples](live-websocket.tcp.ndjson).

Railway terminates TLS at its edge and forwards requests to the deployment. These counters cover the workstation-to-edge TCP connection. Container TCP counters would cover a different leg and cannot establish loss on the player's connection. [Railway edge architecture](https://docs.railway.com/networking/edge-networking).

The live health samples remained at 60 Hz, with zero skipped snapshots and zero maximum buffered bytes. The final health sample's server tick p99 was 0.972 ms. Other players were present in separate rooms, so these captures are not isolated load-matrix runs.

## Actual paired WebSocket/WebRTC experiment

The standalone [paired probe](../../tests/transport/paired.ts) establishes a real Node WebRTC connection using Werift, with `ordered: false` and `maxRetransmits: 0` at both ends. WebSocket carries signaling and a parallel reference stream. The probe reconstructs production snapshots upstream and duplicates identical, independent full-state packets onto both transports. Each receiver actually replaces its replica only for a newer sequence; missing, duplicate and reordered packets cannot roll the state back.

This sidecar is independent of the game server. Full snapshots are larger than the production deltas, and its additional upstream WebSocket hop must be considered when interpreting a remote comparison. By default it creates a local game server and private diagnostic room; it can also run as an authenticated sidecar against a configured game URL.

The measured selected ICE pair was **UDP, host-to-host**. Both channels carried 600 matching snapshots over 30 seconds on loopback:

| Transport | Applied gap p99 | Maximum gap | Payload mismatches |
| --- | ---: | ---: | ---: |
| WebSocket | 53.10 ms | 54.35 ms | 0 |
| Unordered WebRTC | 53.24 ms | 56.04 ms | 0 |

[Paired results](paired-local.json). There is no material improvement on this stable local path. This run does not simulate the player's link and does not establish deployment connectivity.

Werift 0.24.4's default DCEP encoding overwrites the unordered bit when setting `maxRetransmits`. The first experiment rejected the resulting ordered remote channel. The final harness uses explicit negotiated channel ID 0, with identical settings checked through signaling on both ends, avoiding that encoding path. This workaround is confined to the diagnostic harness; Werift is a development dependency. See the installed `werift/lib/webrtc/src/transport/sctp.js`, `dataChannelOpen`, for the inspected implementation, and the [upstream project](https://github.com/shinyoshiaki/werift-webrtc).

Two further real-socket diagnostic checks passed:

- Suppressing ICE candidates at both ends prevented establishment; the WS reference still applied **200 states** over ten seconds, with p99/max gaps **52.83 / 53.40 ms**. [Unavailable-channel result](paired-no-udp.json).
- Closing the established peer after five seconds stopped UDP reception while WS applied **200 states** across the full ten seconds, p99/max **52.43 / 52.75 ms**. The first 100 paired states matched. [Closed-channel result](paired-closed-udp.json).

These verify continued WS operation in the **diagnostic harness**. The existing gameplay WS path remains unchanged; a migrated gameplay fallback has not been implemented or accepted.

## Why RTT quantiles are insufficient

The [sensitivity model](model.json) constructs two different causes producing exactly the same TCP observations. This is a deterministic model, not a kernel TCP/netem experiment or an observed UDP result. It does not model SCTP congestion control, fragmentation, ICE, TURN or changing routes.

| Synthetic profile and cause | TCP RTT p50 / p95 / p99 / max | TCP applied gap p99 / max | Unreliable applied gap p99 / max |
| --- | ---: | ---: | ---: |
| Matched quantiles, isolated loss recovery | 350 / 1121 / 1908 / 2158 ms | 50 / 1858 ms | 50 / 100 ms |
| Identical TCP observations, shared queue | 350 / 1121 / 1908 / 2158 ms | 50 / 1858 ms | 50 / 1858 ms |
| Four-second blackout stress, loss recovery otherwise | 350 / 1600 / 2925 / 4175 ms | 50 / 3875 ms | 50 / 4050 ms |
| Same blackout stress, shared queue | 350 / 1600 / 2925 / 4175 ms | 50 / 3875 ms | 50 / 4050 ms |

The first profile matches the supplied median/p95/p99 but lacks its four-second maximum. The second stress profile supplies a four-second outage and deliberately heavier tails. Neither claims to reconstruct the player's unknown timestamped trace. In the loss model UDP drops the packet initiating recovery and continues with fresh packets; in the shared-queue model it waits behind the same queue. A total outage prevents fresh UDP state in either model.

Rare stalls may leave the packet-count p99 at 50 ms because a subsequent burst supplies many zero-duration gaps. The harness therefore also records maximum silence including capture boundaries and occupied-frame gaps. A disconnected channel reports null gap quantiles plus its entire silence duration, not a misleading zero-gap success.

## Deployment feasibility and outstanding acceptance

Railway's published edge specifications list HTTP/1.1, HTTP/2 and WebSockets. They do not establish HTTP/3/WebTransport support through to this application; the existing server is an HTTP/1.1 Node server. No end-to-end WebTransport route was verified. [Railway specifications](https://docs.railway.com/networking/public-networking/specs-and-limits).

WebRTC has a separate ICE path. Direct UDP connectivity from this deployment has not been measured; outbound UDP/STUN and possibly an external UDP TURN relay need verification. Public HTTP/TCP ingress support alone does not answer whether hole punching will work. The diagnostic harness rejects TCP/TLS TURN configuration so that a purported off-TCP comparison cannot silently use a TCP relay. It records selected candidate transport/types without storing candidate addresses or TURN credentials.

`railway status --json` and `railway ssh` failed with:

```text
Warning: failed to refresh OAuth token: Operation not permitted (os error 1)
Unauthorized. Please run `railway login` again.
```

The sandbox cannot update the existing credentials outside its writable roots. Trying the already stored access token without a config write also returned Unauthorized. The user's help refreshing authentication was requested; none was available during this run. No credentials were printed, copied into the repository or included in artifacts.

Outstanding criteria:

1. Run the paired sidecar through Railway and a UDP ICE path from the same poor-link vantage, with controlled impairment affecting both directions/transports. Retain actual arrival traces, source cadence, ICE route, offered payload rates, event-loop delay and client-side TCP counters. Separate packet loss from shared queueing and total outages. The synthetic table cannot substitute for this measurement.
2. Quantify the p99/max applied-state improvement on that path before choosing an architecture.
3. If justified, redesign snapshot baselines and input recovery before migrating traffic. Current delta snapshots depend on their predecessor; current inputs are individually simulated movement steps, not merely replaceable absolute positions. Lost input batches currently lose movement unless retained/redundantly transmitted or the processing model changes. Session/life/packet sequences, stale reliable combat patches versus newer state, and metadata currently embedded in snapshots also need explicit handling. Joining, lobby state, chat/results and signaling must remain reliable.
4. Run the unchanged inside-Railway 2/5/10-client matrices at 0 and 80 ms added one-way delay against the actual candidate, with zero desyncs and snapshot p99 near 55 ms. **This was blocked, not passed.** Existing [Railway load tooling](../../tests/railway-load.py) is available; its isolation guard requires other players to be absent.
5. Exercise the eventual gameplay fallback, including failed establishment and loss of an established channel.

## Reproduction and verification

```sh
npm ci
# Exact production WS path; optional C helper supplies same-socket counters.
cc -O2 -Wall -Wextra -Werror tests/transport/tcp-info.c -o /tmp/arena-tcp-info
PROBE_TCP_INFO_HELPER=/tmp/arena-tcp-info npm run probe:transport:live
npm run probe:transport:model

# Real headless channels, local game server, 30-second comparison.
npm run probe:transport:pair
PROBE_BLOCK_UDP=1 PROBE_SECONDS=10 PROBE_REPORT=/tmp/probe-no-udp.json npm run probe:transport:pair
PROBE_CLOSE_UDP=1 PROBE_SECONDS=10 PROBE_REPORT=/tmp/probe-closed-udp.json npm run probe:transport:pair

npm test
npm run build
```

The TCP helper supports macOS per-socket retransmission/out-of-order counters and portable Linux `TCP_INFO` retransmission/RTT fields. Unsupported/missing counters are null and explicitly marked unavailable. It requires no packet-capture privileges; closing its stdin stops it. `PROBE_SECONDS`, `PROBE_REPORT` and `GAME_URL` configure the live recorder.

For a separately provisioned diagnostic route, launch `npm run probe:transport:pair -- --serve` with `GAME_URL` pointing to the game server, `PORT` selecting the diagnostic listener, and `PROBE_TOKEN` set in the environment. Connect with `PROBE_URL=wss://<diagnostic-domain>/probe` and the same token. Both endpoints accept `PROBE_ICE_SERVERS` as a JSON array for verified STUN/UDP TURN infrastructure. No remote route is provisioned by these commands. Do not expose the game development server or run dependency installation over the live `/app` directory to create this route.

Validation: **224/224 tests pass**; typecheck and production build pass. Local tooling used Node 25.9.0; Railway's Node 22 still requires verification. The C helper compiles with warnings treated as errors and successfully sampled the live socket. Sequence regression tests cover missing, reordered, duplicated and invalid independent states, including player removal. The original application test suite is unchanged.

## Patch

The workspace's `.git` is read-only. The complete source/test/report patch is `/tmp/krunker-transport-investigation-ea08e6c.patch`, against exact base `ea08e6c66f55bb44fb3b667f29cb748e9f399073`. Apply to a clean checkout of that revision; the working files here already contain the changes. No commit, push or production deployment was made.
