const params = new URLSearchParams(window.location.search);
const pathRole = window.location.pathname.includes("view") ? "viewer" : "host";
const role = params.get("role") || pathRole;
const room = params.get("room") || "";
const video = document.querySelector("#video");
const streamCanvas = document.querySelector("#stream-canvas");
const streamImage = document.querySelector("#stream-image");
const empty = document.querySelector("#empty");
const title = document.querySelector("#title");
const statusEl = document.querySelector("#status");
const viewerLink = document.querySelector("#viewer-link");
const linkRow = document.querySelector("#link-row");
const hostControls = document.querySelector("#host-controls");
const viewerControls = document.querySelector("#viewer-controls");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const copyButton = document.querySelector("#copy");
const connectButton = document.querySelector("#connect");
const shareDialog = document.querySelector("#share-dialog");
const shareYesButton = document.querySelector("#share-yes");
const shareCancelButton = document.querySelector("#share-cancel");

const targetFps = clamp(Number(params.get("fps") || "30"), 10, 60);
const maxBitrate = clamp(Number(params.get("bitrate") || "6000000"), 800000, 20000000);
const directMode = params.get("direct") === "1";
const relayOnly = params.get("relay") === "1";
const autoStart = params.get("autostart") === "1";

let socket;
let localStream;
let config;
let rtcConfig;
let hostPeer;
let mediaTimeout;
const peers = new Map();
const pendingCandidates = new Map();

init().catch((error) => {
  console.error(error);
  setStatus("Error", "error");
});

async function init() {
  config = await fetch("/api/config", { cache: "no-store" }).then((response) => response.json());
  rtcConfig = {
    iceServers: config.iceServers || [],
    iceTransportPolicy: relayOnly ? "relay" : (directMode ? "all" : (config.iceTransportPolicy || "all")),
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  };

  const activeRoom = room || config.room;
  viewerLink.value = config.viewerUrl;

  streamCanvas.classList.remove("active");
  streamImage.classList.remove("active");

  if (role === "viewer") {
    title.textContent = "Viewer";
    viewerControls.classList.remove("hidden");
    linkRow.classList.add("hidden");
    setStatus("Connecting");
    connectButton.addEventListener("click", () => connect(activeRoom));
    connect(activeRoom);
    return;
  }

  title.textContent = "Host";
  hostControls.classList.remove("hidden");
  linkRow.classList.toggle("hidden", autoStart);
  setStatus("Idle");
  startButton.addEventListener("click", () => startSharing(activeRoom));
  stopButton.addEventListener("click", stopSharing);
  copyButton.addEventListener("click", copyViewerLink);
  shareYesButton.addEventListener("click", () => {
    closeShareDialog();
    startSharing(activeRoom);
  });
  shareCancelButton.addEventListener("click", () => {
    closeShareDialog();
    linkRow.classList.remove("hidden");
  });

  if (autoStart) {
    openShareDialog();
  }
}

async function startSharing(activeRoom) {
  try {
    startButton.disabled = true;
    setStatus("Choosing source");

    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: targetFps, max: targetFps }
      },
      audio: false
    });

    video.srcObject = localStream;
    video.muted = true;
    video.style.display = "block";
    empty.classList.add("hidden");
    stopButton.disabled = false;
    linkRow.classList.remove("hidden");
    await video.play().catch(() => {});

    localStream.getVideoTracks()[0]?.addEventListener("ended", stopSharing);
    connect(activeRoom);

    if (socket?.readyState === WebSocket.OPEN) {
      setStatus("Waiting for viewer", "ready");
    } else {
      setStatus("Connecting");
    }
  } catch (error) {
    console.error(error);
    startButton.disabled = false;
    setStatus("Cancelled", "error");
  }
}

function stopSharing() {
  closeAllPeers();

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }

  localStream = null;
  video.srcObject = null;
  empty.classList.remove("hidden");
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("Stopped");
  linkRow.classList.toggle("hidden", autoStart);

  if (socket) {
    socket.close();
    socket = null;
  }
}

function openShareDialog() {
  if (typeof shareDialog.showModal === "function") {
    shareDialog.showModal();
    return;
  }

  shareDialog.setAttribute("open", "");
}

function closeShareDialog() {
  if (typeof shareDialog.close === "function") {
    shareDialog.close();
    return;
  }

  shareDialog.removeAttribute("open");
}

function connect(activeRoom) {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }

  setStatus("Connecting");
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`);

  const timeout = setTimeout(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Connection timeout", "error");
    }
  }, 7000);

  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    setStatus("Signaling connected");
    socket.send(JSON.stringify({ type: "join", role, room: activeRoom }));
  });

  socket.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    const message = JSON.parse(event.data);
    await handleSignal(message);
  });

  socket.addEventListener("close", () => {
    clearTimeout(timeout);

    if (role === "viewer") {
      connectButton.disabled = false;
      setStatus("Disconnected");
    }
  });

  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    setStatus("Connection error", "error");
  });
}

async function handleSignal(message) {
  if (message.type === "joined") {
    if (role === "host") {
      setStatus("Waiting for viewer", "ready");
      return;
    }

    connectButton.disabled = true;
    setStatus(message.hostReady ? "Joined, waiting for offer" : "Joined, waiting for host");
    return;
  }

  if (message.type === "host-ready" && role === "viewer") {
    setStatus("Waiting for offer");
    return;
  }

  if (message.type === "host-left" && role === "viewer") {
    closeViewerPeer();
    video.srcObject = null;
    empty.classList.remove("hidden");
    setStatus("Host left");
    return;
  }

  if (message.type === "viewer-joined" && role === "host") {
    await createOfferForViewer(message.viewerId);
    return;
  }

  if (message.type === "viewer-left" && role === "host") {
    closePeer(message.viewerId);
    return;
  }

  if (message.type === "offer" && role === "viewer") {
    setStatus("Offer received");
    await acceptOffer(message);
    return;
  }

  if (message.type === "answer" && role === "host") {
    const peer = peers.get(message.from);
    if (peer) {
      await peer.setRemoteDescription(message.sdp);
      await flushPendingCandidates(message.from, peer);
    }
    return;
  }

  if (message.type === "candidate") {
    const peerId = role === "host" ? message.from : "host";
    const peer = role === "host" ? peers.get(peerId) : hostPeer;
    await addIceCandidate(peerId, peer, message.candidate);
    return;
  }

  if (message.type === "error") {
    setStatus(message.message || "Error", "error");
  }
}

async function createOfferForViewer(viewerId) {
  if (!localStream) {
    return;
  }

  closePeer(viewerId);
  const peer = createPeer(viewerId);
  peers.set(viewerId, peer);

  for (const track of localStream.getTracks()) {
    const sender = peer.addTrack(track, localStream);
    await tuneSender(sender);
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  send({ type: "offer", to: viewerId, sdp: peer.localDescription });
  setStatus("Offer sent");
}

async function acceptOffer(message) {
  closeViewerPeer();
  hostPeer = createPeer("host");

  hostPeer.addEventListener("track", (event) => {
    clearMediaTimeout();
    const [stream] = event.streams;
    video.srcObject = stream || new MediaStream([event.track]);
    video.muted = true;
    video.autoplay = true;
    video.controls = false;
    video.playsInline = true;
    video.style.display = "block";
    streamCanvas.classList.remove("active");
    streamImage.classList.remove("active");
    empty.classList.add("hidden");
    setStatus("Track received");
    sendClientLog(`track received kind=${event.track.kind} muted=${event.track.muted} readyState=${event.track.readyState}`);

    event.track.addEventListener("unmute", () => {
      sendClientLog("remote track unmuted");
      playRemoteVideo();
    });

    event.track.addEventListener("ended", () => {
      sendClientLog("remote track ended");
      setStatus("Track ended", "error");
    });

    video.addEventListener("loadedmetadata", playRemoteVideo, { once: true });
    video.addEventListener("canplay", playRemoteVideo, { once: true });
    video.addEventListener("playing", () => {
      sendClientLog(`video playing ${video.videoWidth}x${video.videoHeight}`);
      setStatus("Live", "ready");
    }, { once: true });

    playRemoteVideo();
    window.setTimeout(() => {
      if (video.srcObject && (!video.videoWidth || !video.videoHeight)) {
        sendClientLog("video has no decoded frames after timeout");
        setStatus("No frames", "error");
      }
    }, 5000);
  });

  await hostPeer.setRemoteDescription(message.sdp);
  await flushPendingCandidates("host", hostPeer);
  const answer = await hostPeer.createAnswer();
  await hostPeer.setLocalDescription(answer);
  send({ type: "answer", to: message.from, sdp: hostPeer.localDescription });
  setStatus("Answer sent");
  startMediaTimeout();
}

function createPeer(peerId) {
  const peer = new RTCPeerConnection(rtcConfig);

  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendClientLog(`candidate ${formatCandidate(event.candidate.candidate)}`);
      send({ type: "candidate", to: peerId, candidate: event.candidate });
    }
  });

  peer.addEventListener("icecandidateerror", (event) => {
    sendClientLog(`icecandidateerror url=${event.url || ""} code=${event.errorCode || ""} text=${event.errorText || ""}`);
  });

  peer.addEventListener("icegatheringstatechange", () => {
    sendClientLog(`iceGatheringState=${peer.iceGatheringState}`);
  });

  peer.addEventListener("signalingstatechange", () => {
    sendClientLog(`signalingState=${peer.signalingState}`);
  });

  peer.addEventListener("iceconnectionstatechange", () => {
    const state = peer.iceConnectionState;
    sendClientLog(`iceConnectionState=${state}`);
    if (state === "connected" || state === "completed") {
      clearMediaTimeout();
      setStatus(role === "host" ? "Streaming" : "Live", "ready");
    } else if (state === "failed") {
      setStatus("ICE failed", "error");
    } else if (state === "disconnected") {
      setStatus("Disconnected", "error");
    } else if (state === "checking") {
      setStatus("Connecting media");
    }
  });

  peer.addEventListener("connectionstatechange", () => {
    sendClientLog(`connectionState=${peer.connectionState}`);
    if (peer.connectionState === "connected") {
      setStatus(role === "host" ? "Streaming" : "Live", "ready");
    }

    if (peer.connectionState === "failed") {
      logStats(peer);
      setStatus("WebRTC failed", "error");
    }
  });

  return peer;
}

async function tuneSender(sender) {
  if (!sender.setParameters || sender.track?.kind !== "video") {
    return;
  }

  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0].maxBitrate = maxBitrate;
  parameters.encodings[0].maxFramerate = targetFps;
  parameters.encodings[0].priority = "high";
  parameters.encodings[0].networkPriority = "high";

  try {
    await sender.setParameters(parameters);
  } catch {
    // Some browsers reject optional sender tuning; the stream still works.
  }
}

async function addIceCandidate(peerId, peer, candidate) {
  if (!candidate) {
    return;
  }

  if (!peer || !peer.remoteDescription) {
    const queue = pendingCandidates.get(peerId) || [];
    queue.push(candidate);
    pendingCandidates.set(peerId, queue);
    return;
  }

  try {
    await peer.addIceCandidate(candidate);
  } catch (error) {
    console.error(error);
  }
}

async function flushPendingCandidates(peerId, peer) {
  const queue = pendingCandidates.get(peerId) || [];
  pendingCandidates.delete(peerId);

  for (const candidate of queue) {
    await addIceCandidate(peerId, peer, candidate);
  }
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.close();
    peers.delete(peerId);
  }
  pendingCandidates.delete(peerId);
}

function closeViewerPeer() {
  if (hostPeer) {
    hostPeer.close();
    hostPeer = null;
  }
  clearMediaTimeout();
  pendingCandidates.delete("host");
}

function closeAllPeers() {
  for (const peer of peers.values()) {
    peer.close();
  }
  peers.clear();
  pendingCandidates.clear();
  closeViewerPeer();
}

async function copyViewerLink() {
  try {
    await navigator.clipboard.writeText(viewerLink.value);
  } catch {
    viewerLink.select();
    document.execCommand("copy");
  }

  setStatus("Link copied", "ready");
  setTimeout(() => {
    setStatus(localStream ? "Waiting for viewer" : "Idle", localStream ? "ready" : "");
  }, 1200);
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function playRemoteVideo() {
  video.play()
    .then(() => {
      if (video.videoWidth && video.videoHeight) {
        setStatus("Live", "ready");
      }
    })
    .catch((error) => {
      sendClientLog(`video play failed ${error.name || ""} ${error.message || error}`);
      setStatus("Click Connect", "error");
      connectButton.disabled = false;
    });
}

function sendClientLog(message) {
  send({ type: "client-log", message });
}

async function logStats(peer) {
  try {
    const stats = await peer.getStats();
    for (const report of stats.values()) {
      if (report.type === "candidate-pair" && (report.selected || report.nominated)) {
        sendClientLog(`candidatePair state=${report.state} nominated=${report.nominated} local=${report.localCandidateId} remote=${report.remoteCandidateId}`);
      }
    }
  } catch (error) {
    sendClientLog(`getStats failed ${error.message || error}`);
  }
}

function formatCandidate(candidate) {
  const parts = String(candidate || "").split(/\s+/);
  const protocol = parts[2] || "?";
  const address = parts[4] || "?";
  const port = parts[5] || "?";
  const typeIndex = parts.indexOf("typ");
  const type = typeIndex >= 0 ? parts[typeIndex + 1] : "?";
  return `${type}/${protocol}/${address}:${port}`;
}

function setStatus(text, tone = "") {
  statusEl.textContent = text;
  statusEl.classList.toggle("ready", tone === "ready");
  statusEl.classList.toggle("error", tone === "error");
}

function startMediaTimeout() {
  clearMediaTimeout();
  mediaTimeout = window.setTimeout(() => {
    setStatus("Media timeout", "error");
  }, 15000);
}

function clearMediaTimeout() {
  if (mediaTimeout) {
    window.clearTimeout(mediaTimeout);
    mediaTimeout = null;
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
