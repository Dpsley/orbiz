import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import Turn from "node-turn";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number.parseInt(process.env.PORT || "8152", 10);
const shareHost = process.env.SHARE_HOST || "";
const turnPort = Number.parseInt(process.env.TURN_PORT || "8153", 10);
const turnMinPort = Number.parseInt(process.env.TURN_MIN_PORT || "42000", 10);
const turnMaxPort = Number.parseInt(process.env.TURN_MAX_PORT || "42050", 10);
const turnUsername = process.env.TURN_USERNAME || "orbiz";
const turnPassword = process.env.TURN_PASSWORD || "orbiz-turn";
const bundledTurn = process.env.BUNDLED_TURN === "1";
const room = process.env.ROOM || randomBytes(5).toString("hex");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

const rooms = new Map();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be a number from 1 to 65535.");
  process.exit(1);
}

for (const [name, value] of Object.entries({ TURN_PORT: turnPort, TURN_MIN_PORT: turnMinPort, TURN_MAX_PORT: turnMaxPort })) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`${name} must be a number from 1 to 65535.`);
    process.exit(1);
  }
}

if (turnMinPort > turnMaxPort) {
  console.error("TURN_MIN_PORT must be less than or equal to TURN_MAX_PORT.");
  process.exit(1);
}

if (!confirmStart()) {
  console.log("Screen sharing server was not started.");
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/config") {
      const viewerUrls = getShareAddresses().map((item) => buildViewerUrl(item.address));
      respondJson(res, {
        room,
        port,
        hostUrl: `http://localhost:${port}/host?room=${encodeURIComponent(room)}`,
        viewerUrl: viewerUrls[0] || `http://localhost:${port}/view?room=${encodeURIComponent(room)}`,
        viewerUrls,
        iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY || "relay",
        iceServers: getIceServers()
      });
      return;
    }

    if (url.pathname === "/api/status") {
      respondJson(res, getStatus());
      return;
    }

    const filePath = resolvePublicPath(url.pathname);
    if (!filePath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
});

const wss = new WebSocketServer({ server, path: "/signal" });
const turnServer = bundledTurn ? startTurnServer() : null;

wss.on("connection", (socket) => {
  socket.id = randomBytes(8).toString("hex");
  socket.room = null;
  socket.role = null;
  socket.remoteAddress = socket._socket?.remoteAddress || "unknown";
  log(`ws connected id=${socket.id} remote=${socket.remoteAddress}`);

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      relayFrame(socket, raw);
      return;
    }

    const message = parseMessage(raw);
    if (!message) {
      send(socket, { type: "error", message: "Invalid message" });
      return;
    }

    if (message.type === "join") {
      joinRoom(socket, message);
      return;
    }

    if (!socket.room || !socket.role) {
      send(socket, { type: "error", message: "Join a room first" });
      return;
    }

    if (message.type === "client-log") {
      log(`client role=${socket.role} id=${socket.id} ${message.message || ""}`);
      return;
    }

    relaySignal(socket, message);
  });

  socket.on("close", () => {
    log(`ws closed id=${socket.id} role=${socket.role || "none"} remote=${socket.remoteAddress}`);
    leaveRoom(socket);
  });
});

server.listen(port, "0.0.0.0", () => {
  const hostUrl = `http://localhost:${port}/host?room=${encodeURIComponent(room)}`;
  const viewerUrls = getShareAddresses().map((item) => buildViewerUrl(item.address));
  const viewerUrl = viewerUrls[0] || `http://localhost:${port}/view?room=${encodeURIComponent(room)}`;

  console.log("");
  console.log(`Screen sharing server is running on port ${port}.`);
  console.log(`Host:   ${hostUrl}`);
  console.log(`Viewer: ${viewerUrl}`);
  for (const extraUrl of viewerUrls.slice(1)) {
    console.log(`        ${extraUrl}`);
  }
  console.log(`TURN:   ${getTurnHost()}:${turnPort} relay ${turnMinPort}-${turnMaxPort}/udp${bundledTurn ? " bundled" : " external"}`);
  console.log("");
  console.log("Press Ctrl+C in this window to stop the server.");

  openBrowser(hostUrl);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the other process or set another PORT.`);
    process.exit(1);
  }

  throw error;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function confirmStart() {
  if (process.env.SCREEN_SHARE_AUTO_START === "1") {
    return true;
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName PresentationFramework;",
      "$result = [System.Windows.MessageBox]::Show(",
      "'Start screen sharing server on port " + port + "?',",
      "'Screen Share',",
      "'YesNo',",
      "'Question'",
      ");",
      "if ($result -eq 'Yes') { exit 0 } else { exit 1 }"
    ].join(" ");

    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: "ignore",
      windowsHide: true
    });

    return result.status === 0;
  }

  return true;
}

function resolvePublicPath(pathname) {
  const route = pathname === "/" || pathname === "/host" || pathname === "/view" ? "/index.html" : pathname;
  const cleanRoute = decodeURIComponent(route.split("?")[0]);
  const candidate = normalize(join(publicDir, cleanRoute));

  if (!candidate.startsWith(publicDir) || !existsSync(candidate)) {
    return null;
  }

  return candidate;
}

function respondJson(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function parseMessage(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return typeof message === "object" && message !== null ? message : null;
  } catch {
    return null;
  }
}

function joinRoom(socket, message) {
  const requestedRoom = String(message.room || "");
  const role = message.role === "host" ? "host" : message.role === "viewer" ? "viewer" : null;

  if (requestedRoom !== room || !role) {
    send(socket, { type: "error", message: "Wrong room or role" });
    socket.close();
    return;
  }

  leaveRoom(socket);

  socket.room = requestedRoom;
  socket.role = role;

  const state = getRoomState(requestedRoom);
  log(`join role=${role} id=${socket.id} remote=${socket.remoteAddress} room=${requestedRoom}`);

  if (role === "host") {
    if (state.host && state.host.readyState === WebSocket.OPEN) {
      send(socket, { type: "error", message: "Host is already connected" });
      socket.close();
      return;
    }

    state.host = socket;
    send(socket, { type: "joined", id: socket.id, role });
    log(`host ready id=${socket.id}`);

    for (const viewer of state.viewers.values()) {
      send(socket, { type: "viewer-joined", viewerId: viewer.id });
      send(viewer, { type: "host-ready" });
    }

    return;
  }

  state.viewers.set(socket.id, socket);
  send(socket, { type: "joined", id: socket.id, role, hostReady: Boolean(state.host) });
  log(`viewer ready id=${socket.id} hostReady=${Boolean(state.host)} viewers=${state.viewers.size}`);

  if (state.host) {
    send(state.host, { type: "viewer-joined", viewerId: socket.id });
    send(socket, { type: "host-ready" });
    if (state.streamMeta) {
      send(socket, state.streamMeta);
    }
    if (state.initChunk) {
      socket.send(state.initChunk, { binary: true });
    }
  }
}

function leaveRoom(socket) {
  if (!socket.room) {
    return;
  }

  const state = rooms.get(socket.room);
  if (!state) {
    return;
  }

  if (socket.role === "host" && state.host === socket) {
    state.host = null;
    state.streamMeta = null;
    state.initChunk = null;
    state.expectInitChunk = false;
    for (const viewer of state.viewers.values()) {
      send(viewer, { type: "host-left" });
    }
  }

  if (socket.role === "viewer") {
    state.viewers.delete(socket.id);
    if (state.host) {
      send(state.host, { type: "viewer-left", viewerId: socket.id });
    }
  }

  if (!state.host && state.viewers.size === 0) {
    rooms.delete(socket.room);
  }

  socket.room = null;
  socket.role = null;
}

function relaySignal(socket, message) {
  const state = rooms.get(socket.room);
  if (!state) {
    return;
  }

  if (socket.role === "host" && message.type === "stream-meta") {
    state.streamMeta = {
      type: "stream-meta",
      mode: message.mode,
      mimeType: message.mimeType || "",
      width: message.width || null,
      height: message.height || null
    };
    state.initChunk = null;
    state.expectInitChunk = message.mode === "mse";

    for (const viewer of state.viewers.values()) {
      send(viewer, state.streamMeta);
    }
    return;
  }

  if (socket.role === "host" && message.type === "stream-end") {
    state.streamMeta = null;
    state.initChunk = null;
    state.expectInitChunk = false;

    for (const viewer of state.viewers.values()) {
      send(viewer, { type: "stream-end" });
    }
    return;
  }

  if (socket.role === "host") {
    const viewer = state.viewers.get(String(message.to || ""));
    if (!viewer) {
      log(`relay miss type=${message.type} from=host to=${message.to || "none"}`);
      return;
    }

    if (message.type === "offer" || message.type === "candidate") {
      log(`relay type=${message.type} from=host to=${viewer.id}${summarizeCandidate(message.candidate)}`);
    }

    send(viewer, {
      type: message.type,
      from: socket.id,
      sdp: message.sdp,
      candidate: message.candidate
    });
    return;
  }

  if (!state.host) {
    send(socket, { type: "error", message: "Host is not connected" });
    return;
  }

  send(state.host, {
    type: message.type,
    from: socket.id,
    sdp: message.sdp,
    candidate: message.candidate
  });

  if (message.type === "answer" || message.type === "candidate") {
    log(`relay type=${message.type} from=viewer ${socket.id} to=host${summarizeCandidate(message.candidate)}`);
  }
}

function relayFrame(socket, frame) {
  if (!socket.room || socket.role !== "host") {
    return;
  }

  const state = rooms.get(socket.room);
  if (!state) {
    return;
  }

  if (state.streamMeta?.mode === "mse" && state.expectInitChunk && !state.initChunk) {
    state.initChunk = Buffer.isBuffer(frame) ? Buffer.from(frame) : Buffer.from(frame);
    state.expectInitChunk = false;
  }

  for (const viewer of state.viewers.values()) {
    if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 4 * 1024 * 1024) {
      viewer.send(frame, { binary: true });
    }
  }
}

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      viewers: new Map(),
      streamMeta: null,
      initChunk: null,
      expectInitChunk: false
    });
  }

  return rooms.get(roomId);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function getStatus() {
  const state = rooms.get(room);

  return {
    room,
    port,
    hostConnected: Boolean(state?.host && state.host.readyState === WebSocket.OPEN),
    viewers: [...(state?.viewers.values() || [])].map((viewer) => ({
      id: viewer.id,
      remoteAddress: viewer.remoteAddress,
      readyState: viewer.readyState
    })),
    clients: wss.clients.size,
    turn: {
      host: getTurnHost(),
      port: turnPort,
      minPort: turnMinPort,
      maxPort: turnMaxPort
    }
  };
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function summarizeCandidate(candidate) {
  if (!candidate?.candidate) {
    return "";
  }

  const parts = candidate.candidate.split(/\s+/);
  const protocol = parts[2] || "?";
  const address = parts[4] || "?";
  const port = parts[5] || "?";
  const typeIndex = parts.indexOf("typ");
  const type = typeIndex >= 0 ? parts[typeIndex + 1] : "?";

  return ` candidate=${type}/${protocol}/${address}:${port}`;
}

function getIceServers() {
  const host = getTurnHost();

  return [
    {
      urls: [
        `turn:${host}:${turnPort}?transport=udp`,
        `turn:${host}:${turnPort}?transport=tcp`
      ],
      username: turnUsername,
      credential: turnPassword
    }
  ];
}

function getTurnHost() {
  return shareHost || getShareAddresses()[0]?.address || "127.0.0.1";
}

function startTurnServer() {
  const host = getTurnHost();
  const options = {
    listeningPort: turnPort,
    listeningIps: [host],
    relayIps: [host],
    minPort: turnMinPort,
    maxPort: turnMaxPort,
    authMech: "long-term",
    credentials: {
      [turnUsername]: turnPassword
    },
    realm: "orbiz.local",
    debugLevel: "ERROR",
    debug: (level, message) => {
      if (level === "ERROR" || level === "FATAL" || level === "WARN") {
        log(`turn ${level}: ${message}`);
      }
    }
  };

  const instance = new Turn(options);
  instance.start();
  log(`turn started host=${host} port=${turnPort} relay=${turnMinPort}-${turnMaxPort}`);
  return instance;
}

function buildViewerUrl(host) {
  return `http://${host}:${port}/view?room=${encodeURIComponent(room)}`;
}

function getShareAddresses() {
  if (shareHost) {
    return [{ address: shareHost, interfaceName: "SHARE_HOST", priority: 0 }];
  }

  const interfaces = networkInterfaces();
  const addresses = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push({
          address: item.address,
          interfaceName,
          priority: getInterfacePriority(interfaceName, item.address)
        });
      }
    }
  }

  return [...new Map(addresses
    .sort((a, b) => a.priority - b.priority || a.interfaceName.localeCompare(b.interfaceName))
    .map((item) => [item.address, item])).values()];
}

function getInterfacePriority(interfaceName, address) {
  const name = interfaceName.toLowerCase();

  if (name.includes("openvpn") || name.includes("vpn") || name.includes("tap") || name.includes("tun")) {
    return 10;
  }

  if (name.includes("wireguard") || name.includes("tailscale") || name.includes("zerotier") || name.includes("hamachi")) {
    return 10;
  }

  if (address.startsWith("10.") || address.startsWith("100.")) {
    return 20;
  }

  if (address.startsWith("172.") || address.startsWith("192.168.")) {
    return 30;
  }

  return 40;
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1") {
    return;
  }

  if (process.platform === "win32") {
    execFile("powershell.exe", ["-NoProfile", "-Command", "Start-Process", url], {
      windowsHide: true
    });
    return;
  }

  if (process.platform === "darwin") {
    execFile("open", [url]);
    return;
  }

  execFile("xdg-open", [url]);
}

function shutdown() {
  if (turnServer) {
    turnServer.stop();
  }

  for (const client of wss.clients) {
    client.close();
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 1500).unref();
}
