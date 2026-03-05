# P2P Send Pipe (WebRTC MVP)

Personal, cross-device transfer tool (files + text + clipboard) using WebRTC DataChannels with a minimal WebSocket signaling server.

This repo follows the phased plan in `PROJECT_CONTEXT.md`.
Context is also exported to `PROJECT_CONTEXT.pdf` (run `npm run context:pdf` on macOS).

App-first plan rewrite: `docs/WEBRTC_SEND_PIPE_ARCH_PLAN_v2.pdf` (regen with `npm run plan:pdf`).

## Quick start (Desktop app)

Prereqs: Node.js 20+ and Rust toolchain.

1) Install deps

```bash
npm install
```

2) Start signaling server

```bash
npm run dev -w @landrop/server
```

Optional (account mode):
- Local email/password (easy testing): set `AUTH_REQUIRED=1` and `LOCAL_AUTH=1` on the signaling server.
- Google device-flow: set `AUTH_REQUIRED=1` and `GOOGLE_CLIENT_ID=...` on the signaling server.

LAN discovery (so clients auto-find the server on the same Wi‑Fi):
- Enabled by default. Server listens on UDP `8788` and responds to discovery probes.
- Override with `LAN_DISCOVERY=0` or `DISCOVERY_PORT=...`.
- In Tauri dev builds, if no server is found, the app will try to start the server automatically by spawning `npm run dev -w @landrop/server`.
- If `AUTH_REQUIRED=1`, the desktop app will *discover the server first* (so it knows where to log in) and then delay the WebSocket presence connection until after you sign in.

Portable LAN account (recommended for “any server on the LAN”):
- The email/password buttons in the app generate a portable token (`local:<sha256(email:password)>`) and do not require server signup.
- Any LAN signaling server with `AUTH_REQUIRED=1 LOCAL_AUTH=1` will scope devices by that token, so devices will see each other even if they hit different servers.

Findable mode:
- Each device can toggle `Findable` on/off in the app.
- When `Findable` is ON, same-account devices can discover and connect directly (no pairing code or safety-phrase verification needed).
- When `Findable` is OFF, the device is hidden from presence discovery and rejects direct WebRTC targeting.

3) Run the desktop app (Tauri)

```bash
npm run tauri:dev -w @landrop/app
```

## Build + release flow

- Build macOS locally:

```bash
npm run tauri:build -w @landrop/app
```

- Push to GitHub: CI builds Windows + Linux packages and uploads workflow artifacts automatically.
- Push a tag like `v0.1.0`: CI also creates a GitHub Release and auto-attaches built assets.

4) Pair two devices
- Install/run the app on both machines.
- On Device A: create a pairing code.
- On Device B: join with the code, verify the safety phrase, and trust the peer.

5) Transfer flow (strict send/accept)
- Sender offers a file first (`FILE_OFFER`), then waits for receiver acceptance.
- Receiver must explicitly `Accept` or `Decline`.
- File chunks are sent only after `Accept`.
- Either side can cancel an active transfer; sender times out if no acceptance is received.

## Web dev simulation (optional)

You can still run the web UI for quick iteration and simulate two devices in one browser by using different profiles:
- `http://localhost:5173/?profile=a`
- `http://localhost:5173/?profile=b`

## Notes

- WebRTC uses STUN only (no TURN) for now.
- File receiving saves to the OS Downloads folder when running in Tauri; browser download is a fallback.
- Transfer states are explicit (`pending_accept`, `sending`, `receiving`, `done`, `cancelled`, `failed`) and shown in the UI.
