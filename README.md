# orbiz

Local screen sharing server on port `8152`. The server uses this port for the web UI and WebRTC signaling. The screen itself is sent as a real WebRTC media stream between browsers.

## Requirements

- Node.js 20 or newer
- A browser with `getDisplayMedia` support, such as current Chrome, Edge, or Firefox

## Run

```powershell
npm install
npm start
```

The app asks for confirmation before it starts the server. After you click `Yes`, it opens:

```text
http://localhost:8152/host
```

The host page asks the browser to select a screen or window. Send the viewer link from the page to your friend.

On Windows, Node.js may trigger a firewall prompt. Allow access for the network where your viewer is connected.

The console can print several viewer links if Windows has virtual adapters. For a friend on the same local network, the useful link is usually the one with your real LAN IP, for example `192.168.x.x`.

For VPN sharing, use the URL with your VPN adapter address. You can force that address:

```powershell
$env:SHARE_HOST="15.8.0.2"
npm start
```

Then the first viewer link will use `15.8.0.2`.

Useful host URL parameters:

```text
?fps=30&bitrate=6000000
?fps=60&bitrate=12000000
?direct=1
```

By default, browsers use the bundled TURN relay on UDP/TCP `8153` with relay UDP ports `42000-42050`. Use `direct=1` only to test direct peer-to-peer ICE over the VPN; direct mode can use browser-managed dynamic media ports.

## Demo app without a console

For a local demonstration, run the Electron wrapper instead of opening a browser manually:

```powershell
npm run app
```

This starts the local server inside the desktop app, opens the host screen, and shows a share confirmation dialog. After you click `Yes` and choose a screen, the viewer link appears in the app.

If you minimize the desktop app, it disappears from the taskbar and does not create a tray icon. The stream keeps running in the background. Run the executable again to restore the existing window, or close the window with `X` to stop the app.

To build a portable Windows executable:

```powershell
npm run dist
```

The executable is written to:

```text
dist\msi-game-room-1.0.0.exe
```

Screen selection cannot be accepted silently or remembered between launches. Browsers and Electron require a user action and a fresh permission prompt for each `getDisplayMedia` capture.

## Codex screen assistant

The Electron app also opens a protected overlay window that is about one quarter of the screen area. On Windows, Electron content protection uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, so capture tools that honor the Windows capture APIs should not include this overlay. This is not DRM and is not a guarantee against every recording method.

The overlay is click-through and non-focusable: mouse clicks go to the browser or app underneath it, and the active browser tab keeps focus. Hide or show the overlay with `Alt+T`. Move it with `Ctrl+Alt+Arrow`. Scroll the assistant answer with `Ctrl+Alt` for down and `Ctrl+Shift` for up; holding the chord repeats the scroll.

Assistant answers are rendered as a small safe Markdown subset: headings, lists, blockquotes, fenced code blocks, inline code, bold text, simplified LaTeX-style math blocks, and Markdown images. Local Windows or WSL image files referenced in the answer are converted to data URLs before display when they are under the overlay image size limit.

Configure the prompt in `.env`:

```text
CODEX_SCREEN_PROMPT=Analyze the screenshot and answer briefly.
CODEX_WSL_DISTRO=
CODEX_WSL_CWD=~
CODEX_SCREEN_DOUBLE_SHIFT_MS=450
CODEX_SCREEN_TIMEOUT_MS=300000
```

Run the desktop app:

```powershell
npm run app
```

Press Shift twice quickly. The app captures the display under the cursor, saves a temporary PNG, converts the path for WSL, and runs:

```text
wsl.exe --cd <CODEX_WSL_CWD> --exec bash -lc "timeout --kill-after=5s <seconds>s codex --ask-for-approval never exec --sandbox read-only --skip-git-repo-check --color never --output-last-message <answer-file> --image <screenshot> -- <CODEX_SCREEN_PROMPT> </dev/null"
```

Codex CLI must already be installed and logged in inside WSL. If your default WSL distribution is not the one with Codex installed, set `CODEX_WSL_DISTRO` to that distribution name.

Electron is pinned to `36.3.1` because newer Electron builds have public Windows capture-protection regressions on some Windows 10/11 builds, including Windows 10 build `19045`.

## Open port 8152

Run PowerShell as Administrator, then:

```powershell
npm run firewall:open
```

This creates an inbound Windows Firewall rule for TCP `8152` on all profiles, including `Public`, which is commonly used by VPN adapters.

To disable the rule later:

```powershell
npm run firewall:close
```

If the page opens but media stays on `Connecting media` or `ICE failed`, WebRTC traffic from the browser is blocked. Run PowerShell as Administrator, then:

```powershell
npm run firewall:browser
npm run firewall:turn
```

This creates inbound browser application rules for installed Chrome, Edge, or Firefox. For a stricter rule, pass your VPN subnet directly to the script, for example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/open-browser-webrtc-firewall.ps1 -RemoteAddress 15.8.0.0/24
```

## Configuration

The default port is `8152`.

```powershell
$env:PORT=8152
$env:SHARE_HOST="15.8.0.2"
$env:ROOM="my-room-token"
npm start
```

For a viewer outside your local network, you still need normal network access to the host machine: VPN, tunnel, or router port forwarding. The server does not hide itself from screen capture tools and does not block normal shutdown.

For VPN access, give the viewer the URL with your VPN IP address. The VPN must allow client-to-client traffic. WebRTC media uses browser-managed ICE candidate ports, so opening only TCP `8152` is enough for the page/signaling but may not be enough for media if the firewall blocks the browser's WebRTC traffic.

By default, the app expects a local TURN relay on UDP/TCP `8153` with relay UDP ports `42000-42050`. The default ICE transport policy is `relay`, so normal sharing avoids direct peer-to-peer WebRTC media candidates and uses the configured TURN relay instead.
