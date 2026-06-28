# MultiTerminalAI

MultiTerminalAI is a local desktop app for organizing AI CLI work across projects and terminal sessions. It is designed for tools such as Codex CLI, Claude Code, OpenCode, CommandCode, and normal shells.

The app has no accounts and no hosted backend. Projects, sessions, authorized mobile devices, and local state live on the computer running MultiTerminalAI.

## Features

- Desktop app for Windows and Linux through Electron.
- Project list backed by local folders.
- One-click chat/session creation.
- Integrated PTY terminal with `xterm.js` and `node-pty`.
- Multiple clients can attach to the same terminal session.
- Mobile remote PWA served by the desktop app.
- Android WebView wrapper source for building an APK.
- Tailscale-friendly remote access.
- One-time pairing flow with desktop approval.
- Revocable mobile device tokens.
- E2E tests for terminal transport, mobile pairing, reconnect, and desktop flow.

## Desktop

Install dependencies:

```powershell
npm.cmd install
```

Run in development:

```powershell
npm.cmd run desktop
```

Build Windows packages:

```powershell
npm.cmd run pack:win
```

Build Linux packages from Linux:

```bash
npm run pack:linux
```

Build outputs are written to `dist/`.

## Usage

1. Click `Abrir carpeta` and choose a project folder.
2. Click `Nuevo chat` to create a terminal session.
3. Select a chat to attach to the integrated terminal.
4. Use `...` menus to rename or delete projects and chats.

Terminal sessions run on the computer, not on the UI client. If a mobile device disconnects, closes the app, loses Tailscale, or powers off, the CLI process continues on the desktop as long as MultiTerminalAI stays open. Reconnecting to the same chat restores the saved scrollback and continues control of the same PTY.

## Mobile Remote

The desktop app serves a mobile PWA at:

```text
http://TAILSCALE_IP_OR_NAME:PORT/mobile/
```

Recommended flow:

1. Install and connect Tailscale on the desktop and phone.
2. Open MultiTerminalAI on the desktop.
3. Open `Remoto`.
4. Click `Crear enlace de emparejamiento`.
5. Scan the QR or open the shown link from the phone.
6. The phone requests access.
7. Accept the request from the desktop.

After approval, the phone stores a device token locally. You can revoke lost or old phones from `Remoto`.

Each computer has its own identity and authorized-device list, so two PCs on the same Tailnet can be paired independently.

## Android APK

The Android wrapper is in `android-mobile/`. It is a small WebView app that asks for the desktop remote URL and loads the mobile PWA.

Build the APK:

```powershell
npm.cmd run build:apk
```

The generated APK is local output and is intentionally ignored by Git.

## Web Local Mode

For debugging the web UI without Electron:

```powershell
npm.cmd run start:web
```

Then open:

```text
http://localhost:4173
```

Folder picking and native desktop dialogs are only available in the Electron app.

## Tests

Run all E2E smoke tests:

```powershell
npm.cmd run e2e
```

The suite covers:

- fragmented WebSocket frames, including the previous `Unexpected end of JSON input` crash
- mobile pairing and approval
- mobile token authentication
- mobile project listing
- mobile terminal attach/reconnect/scrollback
- desktop folder/chat/terminal flow

## Security Notes

- Do not expose the remote server directly to the public internet.
- Use Tailscale or another private network.
- The local `/terminal` WebSocket is restricted to loopback.
- Mobile access uses `/mobile-terminal` with a per-device bearer token.
- Tokens are stored hashed on the desktop.
- Revoking a device removes its token immediately.

## Repository Hygiene

Generated builds, local app state, pairing data, APKs, keystores, and Codex attachments are ignored by Git. Keep the repository source-only because it is public.
