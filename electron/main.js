import { app, BrowserWindow, Menu, desktopCapturer, dialog, session } from "electron";
import { setTimeout as delay } from "node:timers/promises";

const port = Number.parseInt(process.env.PORT || "8152", 10);
const appUrl = `http://127.0.0.1:${port}/host?autostart=1`;

process.env.SCREEN_SHARE_AUTO_START = "1";
process.env.NO_OPEN = "1";
process.env.BUNDLED_TURN = process.env.BUNDLED_TURN || "1";

app.setAppUserModelId("local.msi.game.room");

let mainWindow;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
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
  });
}

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
