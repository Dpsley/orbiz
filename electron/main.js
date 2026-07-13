import { app, BrowserWindow, Menu, desktopCapturer, dialog, globalShortcut, screen, session } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const electronDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(electronDir);
const resourceRoot = process.resourcesPath || appRoot;
const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR || "";
const envPaths = [
  join(appRoot, ".env"),
  join(process.cwd(), ".env"),
  join(dirname(process.cwd()), ".env"),
  ...(portableExecutableDir ? [
    join(portableExecutableDir, ".env"),
    join(dirname(portableExecutableDir), ".env")
  ] : []),
  join(dirname(process.execPath), ".env"),
  join(dirname(dirname(process.execPath)), ".env")
];

loadDotEnv(envPaths);

const port = Number.parseInt(process.env.PORT || "8152", 10);
const appUrl = `http://127.0.0.1:${port}/host?autostart=1`;
const codexScreenPrompt = (process.env.CODEX_SCREEN_PROMPT || process.env.CODE_SCREEN_PROMPT || "").trim();
const codexWslDistro = (process.env.CODEX_WSL_DISTRO || "").trim();
const codexWslCwd = (process.env.CODEX_WSL_CWD || "~").trim() || "~";
const codexCommand = (process.env.CODEX_WSL_CODEX_BIN || "codex").trim() || "codex";
const codexTimeoutMs = clampNumber(Number.parseInt(process.env.CODEX_SCREEN_TIMEOUT_MS || "300000", 10), 10_000, 600_000, 300_000);
const doubleShiftMs = clampNumber(Number.parseInt(process.env.CODEX_SCREEN_DOUBLE_SHIFT_MS || "450", 10), 200, 1500, 450);
const overlayEnabled = process.env.CODEX_SCREEN_OVERLAY !== "0";

process.env.SCREEN_SHARE_AUTO_START = "1";
process.env.NO_OPEN = "1";
process.env.BUNDLED_TURN = process.env.BUNDLED_TURN || "1";

app.setAppUserModelId("local.msi.game.room");

let mainWindow;
let overlayWindow;
let shiftWatcher;
let isQuitting = false;
let codexRunInProgress = false;
const overlayMoveStep = 48;
const overlayToggleShortcut = "Alt+T";
const overlayMoveShortcuts = [
  ["Control+Alt+Left", -overlayMoveStep, 0],
  ["Control+Alt+Right", overlayMoveStep, 0],
  ["Control+Alt+Up", 0, -overlayMoveStep],
  ["Control+Alt+Down", 0, overlayMoveStep]
];
const maxOverlayImages = 6;
const maxOverlayImageBytes = 6 * 1024 * 1024;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
    showOverlayWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerDisplayMediaPicker();

    await import("../server.js");
    await waitForServer();

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 940,
      minHeight: 640,
      title: "msi game room",
      backgroundColor: "#101418",
      autoHideMenuBar: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
      app.quit();
    });

    mainWindow.on("minimize", () => {
      mainWindow.setSkipTaskbar(true);
    });

    mainWindow.on("restore", () => {
      mainWindow.setSkipTaskbar(false);
    });

    mainWindow.on("show", () => {
      mainWindow.setSkipTaskbar(false);
    });

    await mainWindow.loadURL(appUrl);

    if (overlayEnabled) {
      await createOverlayWindow();
      registerOverlayToggleShortcut();
      registerOverlayMoveShortcuts();
      startDoubleShiftWatcher();
    }
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  unregisterOverlayToggleShortcut();
  unregisterOverlayMoveShortcuts();
  stopDoubleShiftWatcher();
});

app.on("window-all-closed", () => {
  app.quit();
});

function registerDisplayMediaPicker() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      });

      if (!sources.length) {
        callback({});
        return;
      }

      const cancelId = sources.length;
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "Share screen",
        message: "Choose a screen to share",
        buttons: [...sources.map((source, index) => source.name || `Screen ${index + 1}`), "Cancel"],
        cancelId,
        defaultId: 0,
        noLink: true
      });

      if (result.response === cancelId) {
        callback({});
        return;
      }

      callback({ video: sources[result.response] });
    } catch (error) {
      console.error(error);
      callback({});
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setSkipTaskbar(false);

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

async function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(420, Math.floor(workArea.width * 0.5));
  const height = Math.max(320, Math.floor(workArea.height * 0.5));

  overlayWindow = new BrowserWindow({
    width,
    height,
    minWidth: 360,
    minHeight: 260,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    title: "Codex Screen",
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    transparent: true,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  protectOverlayWindow(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setFocusable(false);

  overlayWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      overlayWindow.hide();
    }
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  overlayWindow.on("show", () => {
    protectOverlayWindow(overlayWindow);
  });

  overlayWindow.on("restore", () => {
    protectOverlayWindow(overlayWindow);
  });

  overlayWindow.once("ready-to-show", () => {
    protectOverlayWindow(overlayWindow);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.showInactive();
    protectOverlayWindow(overlayWindow);
    updateOverlay({
      status: "Ready",
      message: codexScreenPrompt ? "Waiting." : getMissingPromptMessage(),
      meta: codexScreenPrompt ? "" : getDotEnvMeta()
    });
  });

  await overlayWindow.loadFile(join(electronDir, "overlay.html"));
  return overlayWindow;
}

function showOverlayWindow() {
  if (!overlayEnabled) {
    return;
  }

  const win = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
  if (!win) {
    void createOverlayWindow();
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  protectOverlayWindow(win);
  win.setAlwaysOnTop(true, "floating");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.showInactive();
  protectOverlayWindow(win);
}

function protectOverlayWindow(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.setContentProtection(true);
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setContentProtection(true);
    }
  }, 250);
}

function toggleOverlayWindow() {
  if (!overlayEnabled) {
    return;
  }

  const win = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;

  if (!win) {
    void createOverlayWindow();
    return;
  }

  if (win.isVisible()) {
    win.hide();
    return;
  }

  showOverlayWindow();
}

function registerOverlayToggleShortcut() {
  if (globalShortcut.isRegistered(overlayToggleShortcut)) {
    return;
  }

  const registered = globalShortcut.register(overlayToggleShortcut, toggleOverlayWindow);

  if (!registered) {
    console.error(`Could not register overlay shortcut ${overlayToggleShortcut}.`);
  }
}

function unregisterOverlayToggleShortcut() {
  if (globalShortcut.isRegistered(overlayToggleShortcut)) {
    globalShortcut.unregister(overlayToggleShortcut);
  }
}

function registerOverlayMoveShortcuts() {
  for (const [accelerator, dx, dy] of overlayMoveShortcuts) {
    if (isShortcutRegistered(accelerator)) {
      continue;
    }

    const registered = registerShortcut(accelerator, () => {
      moveOverlayBy(dx, dy);
    });

    if (!registered) {
      console.error(`Could not register overlay shortcut ${accelerator}.`);
    }
  }
}

function unregisterOverlayMoveShortcuts() {
  for (const [accelerator] of overlayMoveShortcuts) {
    if (isShortcutRegistered(accelerator)) {
      unregisterShortcut(accelerator);
    }
  }
}

function moveOverlayBy(dx, dy) {
  const win = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
  if (!win) {
    return;
  }

  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const { workArea } = display;
  const nextX = Math.min(workArea.x + workArea.width - bounds.width, Math.max(workArea.x, bounds.x + dx));
  const nextY = Math.min(workArea.y + workArea.height - bounds.height, Math.max(workArea.y, bounds.y + dy));

  win.setBounds({
    ...bounds,
    x: nextX,
    y: nextY
  });
}

function scrollOverlay(direction) {
  const win = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
  if (!win || !win.isVisible()) {
    return;
  }

  const safeDirection = direction < 0 ? -1 : 1;
  const script = `
    (() => {
      const direction = ${safeDirection};
      const scrollTarget = (target) => {
        if (!target) return null;
        const amount = Math.max(160, Math.floor((target.clientHeight || window.innerHeight) * 0.85));
        const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
        const before = target.scrollTop || 0;
        const after = Math.max(0, Math.min(maxTop, before + direction * amount));
        target.scrollTop = after;
        return { before, after: target.scrollTop, clientHeight: target.clientHeight, scrollHeight: target.scrollHeight };
      };
      const answer = document.querySelector("#answer");
      const primary = window.__scrollAssistant ? window.__scrollAssistant(direction) : scrollTarget(answer);
      if (primary && primary.after !== primary.before) return primary;
      const fallback = scrollTarget(document.scrollingElement || document.documentElement);
      return fallback || primary;
    })()
  `;

  win.webContents.executeJavaScript(script).catch((error) => {
    console.error(`Could not scroll overlay: ${error.message}`);
  });
}

function registerShortcut(accelerator, callback) {
  try {
    return globalShortcut.register(accelerator, callback);
  } catch (error) {
    console.error(`Could not register overlay shortcut ${accelerator}: ${error.message}`);
    return false;
  }
}

function unregisterShortcut(accelerator) {
  try {
    globalShortcut.unregister(accelerator);
  } catch {
    // Invalid accelerator variants are intentionally ignored.
  }
}

function isShortcutRegistered(accelerator) {
  try {
    return globalShortcut.isRegistered(accelerator);
  } catch {
    return false;
  }
}

function updateOverlay(payload) {
  if (!overlayEnabled) {
    return;
  }

  void prepareOverlayPayload(payload).then((preparedPayload) => {
    applyOverlayPayload(preparedPayload);
  }).catch(() => {
    applyOverlayPayload(payload);
  });
}

function applyOverlayPayload(payload) {
  const apply = (win) => {
    const data = JSON.stringify(payload).replace(/</g, "\\u003c");
    win.webContents.executeJavaScript(`window.__setAssistantState(${data})`).catch(() => {});
  };

  const win = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
  if (!win) {
    void createOverlayWindow().then(apply);
    return;
  }

  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => apply(win));
    return;
  }

  apply(win);
}

async function prepareOverlayPayload(payload) {
  if (!payload || typeof payload.message !== "string" || !hasImageReference(payload.message)) {
    return payload;
  }

  const imageSources = extractImageSources(payload.message).slice(0, maxOverlayImages);
  if (!imageSources.length) {
    return payload;
  }

  const imageAssets = {};

  for (const source of imageSources) {
    const resolved = await resolveOverlayImageSource(source);
    if (resolved) {
      imageAssets[source] = resolved;
      imageAssets[normalizeImageSource(source)] = resolved;
    }
  }

  return Object.keys(imageAssets).length ? { ...payload, imageAssets } : payload;
}

function hasImageReference(message) {
  return /!\[[^\]]*]\([^)]+\)/.test(message)
    || /data:image\//i.test(message)
    || /(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/mnt\/[a-zA-Z]\/|\/(?:home|tmp|var)\/).+?\.(?:png|jpe?g|gif|webp|bmp|svg)/i.test(message);
}

function extractImageSources(message) {
  const sources = new Set();
  const markdownImagePattern = /!\[[^\]]*]\(([^)\n]+)\)/g;
  const bareImagePattern = /(?:https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s)]*)?|data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|file:\/\/\/?[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)|[A-Za-z]:\\[^\r\n]+?\.(?:png|jpe?g|gif|webp|bmp|svg)|\/mnt\/[a-zA-Z]\/[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)|\/(?:home|tmp|var)\/[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;
  let match;

  while ((match = markdownImagePattern.exec(message))) {
    const source = normalizeImageSource(match[1]);
    if (source) {
      sources.add(source);
    }
  }

  while ((match = bareImagePattern.exec(message))) {
    const source = normalizeImageSource(match[0]);
    if (source) {
      sources.add(source);
    }
  }

  return [...sources];
}

function normalizeImageSource(source) {
  let value = String(source || "").trim();

  if (value.startsWith("<") && value.includes(">")) {
    value = value.slice(1, value.indexOf(">"));
  } else {
    const titleMatch = /^(\S+)(?:\s+["'][^"']*["'])?$/.exec(value);
    if (titleMatch) {
      value = titleMatch[1];
    }
  }

  return value
    .replace(/^["']|["']$/g, "")
    .replace(/[),.;:]+$/g, "")
    .trim();
}

async function resolveOverlayImageSource(source) {
  const normalized = normalizeImageSource(source);

  if (!normalized) {
    return "";
  }

  if (/^(?:https?:\/\/|data:image\/)/i.test(normalized)) {
    return normalized;
  }

  const windowsPath = imageSourceToWindowsPath(normalized);
  if (windowsPath) {
    return readWindowsImageAsDataUrl(windowsPath);
  }

  if (normalized.startsWith("/")) {
    return readWslImageAsDataUrl(normalized);
  }

  return "";
}

function imageSourceToWindowsPath(source) {
  if (/^file:\/\//i.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return "";
    }
  }

  if (/^[A-Za-z]:[\\/]/.test(source)) {
    return source;
  }

  const mountMatch = /^\/mnt\/([a-zA-Z])\/(.+)$/.exec(source);
  if (mountMatch) {
    return `${mountMatch[1].toUpperCase()}:\\${decodeURIComponent(mountMatch[2]).replace(/\//g, "\\")}`;
  }

  return "";
}

function readWindowsImageAsDataUrl(windowsPath) {
  try {
    if (!existsSync(windowsPath)) {
      return "";
    }

    const stats = statSync(windowsPath);
    if (!stats.isFile() || stats.size > maxOverlayImageBytes) {
      return "";
    }

    const data = readFileSync(windowsPath).toString("base64");
    return `data:${getImageMimeType(windowsPath)};base64,${data}`;
  } catch {
    return "";
  }
}

async function readWslImageAsDataUrl(wslPath) {
  try {
    const statCommand = `stat -c%s -- ${shellQuote(wslPath)}`;
    const statResult = await execFileAsync("wsl.exe", [
      ...getWslBaseArgs(),
      "--exec",
      "bash",
      "-lc",
      statCommand
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      windowsHide: true
    });
    const size = Number.parseInt(statResult.stdout.trim(), 10);

    if (!Number.isFinite(size) || size <= 0 || size > maxOverlayImageBytes) {
      return "";
    }

    const imageResult = await execFileAsync("wsl.exe", [
      ...getWslBaseArgs(),
      "--exec",
      "bash",
      "-lc",
      `base64 -w0 -- ${shellQuote(wslPath)}`
    ], {
      encoding: "utf8",
      maxBuffer: Math.ceil(size * 1.5) + 1024,
      timeout: 10_000,
      windowsHide: true
    });
    const data = imageResult.stdout.trim();

    return data ? `data:${getImageMimeType(wslPath)};base64,${data}` : "";
  } catch {
    return "";
  }
}

function getImageMimeType(source) {
  const clean = String(source).split(/[?#]/)[0].toLowerCase();

  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (clean.endsWith(".gif")) {
    return "image/gif";
  }

  if (clean.endsWith(".webp")) {
    return "image/webp";
  }

  if (clean.endsWith(".bmp")) {
    return "image/bmp";
  }

  if (clean.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "image/png";
}

function startDoubleShiftWatcher() {
  if (process.platform !== "win32" || shiftWatcher) {
    return;
  }

  const scriptPath = resolveRuntimeFile("electron", "watch-double-shift.ps1");
  let watcherError = "";
  shiftWatcher = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], {
    env: {
      ...process.env,
      CODEX_SCREEN_DOUBLE_SHIFT_MS: String(doubleShiftMs)
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let buffer = "";
  shiftWatcher.stdout.setEncoding("utf8");
  shiftWatcher.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const event = line.trim();

      if (event === "shift-shift") {
        void handleDoubleShift();
      } else if (event === "overlay-scroll-down") {
        scrollOverlay(1);
      } else if (event === "overlay-scroll-up") {
        scrollOverlay(-1);
      }
    }
  });

  shiftWatcher.stderr.setEncoding("utf8");
  shiftWatcher.stderr.on("data", (chunk) => {
    const message = chunk.trim();
    if (message) {
      watcherError = `${watcherError}\n${message}`.trim();
      console.error(`[double-shift] ${message}`);
    }
  });

  shiftWatcher.on("error", (error) => {
    shiftWatcher = null;
    console.error(error);
    updateOverlay({
      status: "Hotkey off",
      message: `Could not start Double Shift watcher.\n${error.message}`,
      meta: scriptPath,
      error: true
    });
  });

  shiftWatcher.on("exit", (code, signal) => {
    shiftWatcher = null;

    if (!isQuitting) {
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`Double Shift watcher stopped with ${suffix}.`);
      updateOverlay({
        status: "Hotkey off",
        message: `Double Shift watcher stopped with ${suffix}.${watcherError ? `\n${watcherError}` : ""}`,
        meta: scriptPath,
        error: true
      });
    }
  });
}

function stopDoubleShiftWatcher() {
  if (shiftWatcher && !shiftWatcher.killed) {
    shiftWatcher.kill();
  }

  shiftWatcher = null;
}

async function handleDoubleShift() {
  showOverlayWindow();

  if (codexRunInProgress) {
    updateOverlay({
      status: "Busy",
      message: "Codex is still processing the previous screenshot."
    });
    return;
  }

  if (!codexScreenPrompt) {
    updateOverlay({
      status: "Prompt missing",
      message: getMissingPromptMessage(),
      meta: getDotEnvMeta(),
      error: true
    });
    return;
  }

  codexRunInProgress = true;

  try {
    updateOverlay({
      status: "Capturing",
      message: "Preparing screenshot..."
    });

    const screenshotPath = await captureActiveDisplay();
    updateOverlay({
      status: "Codex",
      message: "Screenshot sent. Waiting for answer...",
      meta: screenshotPath
    });

    const answer = await runCodexForScreenshot(screenshotPath);
    updateOverlay({
      status: "Answer",
      message: answer || "Codex returned an empty response.",
      meta: new Date().toLocaleTimeString()
    });
  } catch (error) {
    updateOverlay({
      status: "Error",
      message: error?.message || String(error),
      error: true
    });
  } finally {
    codexRunInProgress = false;
  }
}

async function captureActiveDisplay() {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const scaleFactor = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
  };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize
  });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Could not capture the active display.");
  }

  const screenshotDir = join(app.getPath("temp"), "orbiz-codex-screen");
  mkdirSync(screenshotDir, { recursive: true });

  const screenshotPath = join(screenshotDir, `screenshot-${Date.now()}.png`);
  writeFileSync(screenshotPath, source.thumbnail.toPNG());
  return screenshotPath;
}

async function runCodexForScreenshot(screenshotPath) {
  const wslImagePath = await toWslPath(screenshotPath);
  const answerPath = screenshotPath.replace(/\.png$/i, ".answer.txt");
  const wslAnswerPath = await toWslPath(answerPath);
  const codexArgs = [
    codexCommand,
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    wslAnswerPath,
    "--image",
    wslImagePath,
    "--",
    codexScreenPrompt
  ];
  const timeoutSeconds = Math.max(1, Math.ceil(codexTimeoutMs / 1000));
  const shellCommand = `timeout --kill-after=5s ${timeoutSeconds}s ${codexArgs.map(shellQuote).join(" ")} </dev/null`;
  const args = [
    ...getWslBaseArgs(),
    "--cd",
    codexWslCwd,
    "--exec",
    "bash",
    "-lc",
    shellCommand
  ];

  let lastProgressAt = 0;
  const result = await spawnProcess("wsl.exe", args, {
    timeoutMs: codexTimeoutMs + 15_000,
    onStderr: (chunk) => {
      const progress = getLastMeaningfulLine(chunk);

      if (!progress || Date.now() - lastProgressAt < 1200) {
        return;
      }

      lastProgressAt = Date.now();
      updateOverlay({
        status: "Codex",
        message: `Waiting for answer...\n\n${progress}`,
        meta: screenshotPath
      });
    }
  });

  const stdout = stripAnsi(result.stdout).trim();
  const stderr = stripAnsi(result.stderr).trim();

  if (result.timedOut || result.code === 124) {
    const detail = getOutputTail(stderr || stdout);
    throw new Error(`Codex timed out after ${timeoutSeconds} seconds.${detail ? `\n${detail}` : ""}`);
  }

  if (result.code !== 0) {
    const detail = getOutputTail(stderr || stdout);
    throw new Error(detail || `Codex exited with code ${result.code}.`);
  }

  if (existsSync(answerPath)) {
    const answer = normalizeCodexAnswer(readFileSync(answerPath, "utf8"));
    if (answer) {
      return answer;
    }
  }

  return normalizeCodexAnswer(getCodexFinalMessage(stdout) || getOutputTail(stdout || stderr));
}

async function toWslPath(windowsPath) {
  const args = [...getWslBaseArgs(), "--exec", "wslpath", "-a", windowsPath];

  try {
    const { stdout } = await execFileAsync("wsl.exe", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true
    });
    const converted = stdout.trim();
    if (converted) {
      return converted;
    }
  } catch {
    // Fall through to the standard DrvFS conversion.
  }

  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) {
    throw new Error(`Cannot convert Windows path for WSL: ${windowsPath}`);
  }

  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function getWslBaseArgs() {
  return codexWslDistro ? ["--distribution", codexWslDistro] : [];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxOutputLength = 10 * 1024 * 1024;
    const appendOutput = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxOutputLength ? next.slice(-maxOutputLength) : next;
    };
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs) : null;

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
      options.onStderr?.(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }

      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

function getLastMeaningfulLine(value) {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoisyCodexLine(line));

  return lines.at(-1) || "";
}

function getOutputTail(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoisyCodexLine(line));

  return lines.slice(-12).join("\n");
}

function isNoisyCodexLine(line) {
  return line.startsWith("warning: Codex could not find bubblewrap")
    || line === "Reading additional input from stdin..."
    || line === "Reading prompt from stdin...";
}

function getCodexFinalMessage(value) {
  const clean = String(value || "").trim();
  const marker = "\ncodex\n";
  const markerIndex = clean.lastIndexOf(marker);

  if (markerIndex < 0) {
    return "";
  }

  const afterMarker = clean.slice(markerIndex + marker.length);
  const tokenIndex = afterMarker.indexOf("\ntokens used");
  return (tokenIndex >= 0 ? afterMarker.slice(0, tokenIndex) : afterMarker).trim();
}

function normalizeCodexAnswer(value) {
  let text = String(value || "").trim();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = text;
    const trimmed = text.trim();

    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") {
          text = parsed;
        } else if (parsed && typeof parsed === "object") {
          text = parsed.answer || parsed.message || parsed.content || text;
        }
      } catch {
        // Keep the original text if it only looks like JSON.
      }
    } else if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") {
          text = parsed;
        }
      } catch {
        text = trimmed.slice(1, -1);
      }
    }

    if (/\\(?:r\\n|n|r|t|"|\\|u[0-9a-fA-F]{4})/.test(text)) {
      text = decodeKnownEscapes(text);
    }

    if (text === before) {
      break;
    }
  }

  return text.replace(/\r\n/g, "\n").trim();
}

function decodeKnownEscapes(value) {
  return String(value)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function getMissingPromptMessage() {
  return "Set CODEX_SCREEN_PROMPT in .env.";
}

function getDotEnvMeta() {
  const existingPaths = envPaths.filter((envPath) => existsSync(envPath));
  return existingPaths.length ? `Loaded .env: ${existingPaths.join("; ")}` : "No .env found in known locations.";
}

function resolveRuntimeFile(...parts) {
  const unpackedPath = join(resourceRoot, "app.asar.unpacked", ...parts);

  if (existsSync(unpackedPath)) {
    return unpackedPath;
  }

  return join(appRoot, ...parts);
}

async function waitForServer() {
  const statusUrl = `http://127.0.0.1:${port}/api/status`;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(statusUrl, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await delay(100);
  }

  throw new Error(`Screen sharing server did not start on port ${port}.`);
}

function loadDotEnv(paths) {
  const seen = new Set();

  for (const envPath of paths) {
    if (seen.has(envPath) || !existsSync(envPath)) {
      continue;
    }

    seen.add(envPath);
    const content = readFileSync(envPath, "utf8");

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) {
        continue;
      }

      process.env[match[1]] = parseDotEnvValue(match[2]);
    }
  }
}

function parseDotEnvValue(rawValue) {
  let value = rawValue.trim();

  if (value.startsWith("\"") && value.endsWith("\"")) {
    value = value.slice(1, -1);
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
