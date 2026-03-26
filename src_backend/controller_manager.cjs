const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const { getAppConfig, setAppConfig } = require("./config_manager.cjs");
const { EvdevGamepadPoller } = require("./evdev_gamepad_poller.cjs");
const { getMainWindow } = require("./state.cjs");
const {
  execFilePromise,
  getControllerHelperPath,
  getControllerUdevRulesPath,
  logInfo,
  logWarn,
  showToastOnUi,
} = require("./utils.cjs");

const INPUT_MODES = new Set(["native", "xinput", "aegis"]);
const HELPER_STATUS = {
  READY: "ready",
  MISSING_PERMISSIONS: "missing_permissions",
  MISSING_DEPENDENCY: "missing_dependency",
  ERROR: "error",
};

const AEGIS_STRATEGIES = {
  DUALSENSE_NATIVE: "dualsense-native",
  XINPUT_FALLBACK: "xinput-fallback",
  NATIVE_FALLBACK: "native-fallback",
};

const CONTROLLER_STATE_CHANNEL = "controller-state-changed";
const REFRESH_INTERVAL_MS = 5000;

const KNOWN_DUALSENSE_GAME_PROFILES = {
  "kena-bridge-of-spirits": {
    preferredStrategy: AEGIS_STRATEGIES.DUALSENSE_NATIVE,
  },
};

let helperCommandCache = null;
let cachedControllerState = {
  controllers: [],
  helperStatus: HELPER_STATUS.ERROR,
  helperDetails: null,
  inputMode: "native",
  aegisStrategyPreview: AEGIS_STRATEGIES.NATIVE_FALLBACK,
  setupGuidePath: null,
};

let activeControllerSession = null;
let refreshTimer = null;
let activeEvdevPoller = null;

const EVDEV_GAMEPAD_STATE_CHANNEL = "evdev-gamepad-state";

function isValidInputMode(mode) {
  return INPUT_MODES.has(mode);
}

function normalizeInputMode(mode) {
  return isValidInputMode(mode) ? mode : "native";
}

async function resolvePythonCommand() {
  if (helperCommandCache) {
    return helperCommandCache;
  }

  const helperPath = getControllerHelperPath();
  const candidates = ["python3", "python"];

  for (const command of candidates) {
    try {
      await execFilePromise(command, [helperPath, "probe"], {
        timeout: 5000,
      });
      helperCommandCache = command;
      return command;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error("Python 3 with controller helper support was not found.");
}

async function runControllerHelper(arguments_) {
  const helperPath = getControllerHelperPath();
  const pythonCommand = await resolvePythonCommand();
  const { stdout } = await execFilePromise(pythonCommand, [helperPath, ...arguments_], {
    timeout: 10_000,
  });

  const parsedOutput = JSON.parse(stdout || "{}");
  return parsedOutput;
}

function deriveHelperStatus(probeResult) {
  if (!probeResult?.python_ok) {
    return HELPER_STATUS.MISSING_DEPENDENCY;
  }

  if (!probeResult?.evdev_available) {
    return HELPER_STATUS.MISSING_DEPENDENCY;
  }

  if (!probeResult?.uinput_access) {
    return HELPER_STATUS.MISSING_PERMISSIONS;
  }

  return HELPER_STATUS.READY;
}

function slugifyGameName(name) {
  return String(name || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function getKnownGameProfile(game) {
  if (!game) return null;

  let appProfiles = {};

  if (process.env.NODE_ENV !== "test") {
    try {
      appProfiles = getAppConfig().controllerGameProfiles || {};
    } catch (error) {
      logWarn("Unable to read controller game profiles from app config:", error);
    }
  }

  const keyCandidates = [
    String(game.id ?? ""),
    game.slug,
    slugifyGameName(game.name),
  ].filter(Boolean);

  for (const key of keyCandidates) {
    if (appProfiles[key]) {
      return appProfiles[key];
    }
    if (KNOWN_DUALSENSE_GAME_PROFILES[key]) {
      return KNOWN_DUALSENSE_GAME_PROFILES[key];
    }
  }

  return null;
}

function isDualSenseFamily(family) {
  return family === "dualsense" || family === "dualshock" || family === "playstation";
}

function getControllerConfigKey(controller) {
  if (!controller) return null;

  const vendorId = String(controller.vendorId || "unknown").toLowerCase();
  const productId = String(controller.productId || "unknown").toLowerCase();
  const name = slugifyGameName(controller.name || controller.id || "controller");

  return `${vendorId}:${productId}:${name}`;
}

function getControllerInputModeFromConfig(appConfig, controller) {
  const defaultInputMode = normalizeInputMode(appConfig?.controllerInputMode);
  const controllerInputModes = appConfig?.controllerInputModes || {};
  const controllerKey = getControllerConfigKey(controller);

  if (!controllerKey) {
    return defaultInputMode;
  }

  return normalizeInputMode(controllerInputModes[controllerKey] || defaultInputMode);
}

function getControllerInputMode(controller) {
  return getControllerInputModeFromConfig(getAppConfig(), controller);
}

function getControllerAegisStrategyFromConfig(appConfig, controller) {
  const controllerAegisStrategies = appConfig?.controllerAegisStrategies || {};
  const controllerKey = getControllerConfigKey(controller);
  if (!controllerKey) return null;
  return controllerAegisStrategies[controllerKey] || null;
}

function getControllerAegisStrategy(controller) {
  return getControllerAegisStrategyFromConfig(getAppConfig(), controller);
}

function resolveAegisStrategy(game, controllers = cachedControllerState.controllers) {
  const primaryController = controllers.find((controller) => controller.isPrimary) || controllers[0];

  if (!primaryController) {
    return AEGIS_STRATEGIES.NATIVE_FALLBACK;
  }

  const knownProfile = getKnownGameProfile(game);
  if (
    knownProfile?.preferredStrategy === AEGIS_STRATEGIES.DUALSENSE_NATIVE &&
    isDualSenseFamily(primaryController.family)
  ) {
    return AEGIS_STRATEGIES.DUALSENSE_NATIVE;
  }

  if (isDualSenseFamily(primaryController.family)) {
    return AEGIS_STRATEGIES.DUALSENSE_NATIVE;
  }

  if (
    primaryController.family === "xbox" ||
    primaryController.family === "8bitdo" ||
    primaryController.family === "nintendo" ||
    primaryController.family === "steam" ||
    primaryController.family === "generic"
  ) {
    return AEGIS_STRATEGIES.XINPUT_FALLBACK;
  }

  return AEGIS_STRATEGIES.NATIVE_FALLBACK;
}

function buildLaunchEnvironment({ inputMode, strategy, game, helperActive }) {
  const environment = {
    AEGIS_INPUT_MODE: inputMode,
    AEGIS_STRATEGY: strategy,
  };

  if (helperActive) {
    environment.AEGIS_HELPER_ACTIVE = "1";
  }

  if (strategy === AEGIS_STRATEGIES.XINPUT_FALLBACK) {
    environment.SDL_GAMECONTROLLER_USE_BUTTON_LABELS = "0";
    environment.SDL_JOYSTICK_HIDAPI = "1";
    // Prevent SDL from presenting both the physical device and the virtual
    // Xbox controller to the game, which causes duplicate controller entries.
    environment.SDL_JOYSTICK_RAWINPUT = "0";
    environment.WINE_HIDE_GAMEPAD_RAWINPUT = "1";
  }

  if (strategy === AEGIS_STRATEGIES.DUALSENSE_NATIVE) {
    environment.SDL_JOYSTICK_HIDAPI = "1";
    environment.SDL_JOYSTICK_HIDAPI_PS5 = "1";
    environment.SDL_JOYSTICK_HIDAPI_PS4 = "1";
    environment.SDL_GAMECONTROLLER_USE_BUTTON_LABELS = "1";
    environment.PROTON_ENABLE_HIDRAW = "1";
    environment.AEGIS_PREFER_DUALSENSE = "1";
  }

  if (game?.runner) {
    environment.AEGIS_GAME_RUNNER = String(game.runner);
  }

  if (game?.slug) {
    environment.AEGIS_GAME_SLUG = String(game.slug);
  }

  return environment;
}

function makeSetupGuidePath() {
  const rulesPath = getControllerUdevRulesPath();
  return existsSync(rulesPath) ? rulesPath : null;
}

function buildControllerPreview(controller, controllers) {
  const appConfig = getAppConfig();
  const inputMode = getControllerInputModeFromConfig(appConfig, controller);
  const overrideStrategy = getControllerAegisStrategyFromConfig(appConfig, controller);
  let aegisStrategyPreview = AEGIS_STRATEGIES.NATIVE_FALLBACK;

  if (inputMode === "aegis") {
    aegisStrategyPreview =
      overrideStrategy ||
      resolveAegisStrategy(null, [controller, ...controllers.filter((item) => item.id !== controller.id)]);
  } else if (inputMode === "xinput") {
    aegisStrategyPreview = AEGIS_STRATEGIES.XINPUT_FALLBACK;
  }

  const configKey = getControllerConfigKey(controller);
  const { controllerInputModes = {} } = appConfig;
  const isInputModeOverridden = configKey
    ? Object.prototype.hasOwnProperty.call(controllerInputModes, configKey)
    : false;
  const isAegisStrategyOverridden = Boolean(overrideStrategy);

  return {
    ...controller,
    inputMode,
    aegisStrategyPreview,
    isInputModeOverridden,
    isAegisStrategyOverridden,
    configKey,
  };
}

function buildControllerStatePayload({ controllers, helperStatus, helperDetails }) {
  const enrichedControllers = controllers.map((controller) =>
    buildControllerPreview(controller, controllers),
  );
  const primaryController =
    enrichedControllers.find((controller) => controller.isPrimary) ||
    enrichedControllers[0] ||
    null;
  const inputMode = primaryController?.inputMode || normalizeInputMode(getAppConfig().controllerInputMode);
  const aegisStrategyPreview =
    primaryController?.aegisStrategyPreview || AEGIS_STRATEGIES.NATIVE_FALLBACK;

  return {
    controllers: enrichedControllers,
    helperStatus,
    helperDetails,
    inputMode,
    aegisStrategyPreview,
    setupGuidePath: makeSetupGuidePath(),
  };
}

function broadcastControllerStateChanged() {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;
  mainWindow.webContents.send(CONTROLLER_STATE_CHANNEL, cachedControllerState);
}

function stopEvdevPoller() {
  if (activeEvdevPoller) {
    activeEvdevPoller.stop();
    activeEvdevPoller = null;
    logInfo("EvdevPoller: stopped");
  }
}

function startEvdevPollerForController(controller) {
  if (!controller?.eventPath) return;
  if (activeControllerSession) return;

  // Already polling the same device
  if (activeEvdevPoller?.isActive() && activeEvdevPoller.devicePath === controller.eventPath) {
    return;
  }

  stopEvdevPoller();

  const poller = new EvdevGamepadPoller(controller.eventPath, controller.name);

  poller.on("state", (state) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(EVDEV_GAMEPAD_STATE_CHANNEL, state);
    }
  });

  poller.on("disconnected", () => {
    if (activeEvdevPoller === poller) {
      activeEvdevPoller = null;
    }
  });

  poller.start();
  activeEvdevPoller = poller;
}

function syncEvdevPoller() {
  if (activeControllerSession) {
    stopEvdevPoller();
    return;
  }

  const controllers = cachedControllerState.controllers || [];
  const primary = controllers.find((c) => c.isPrimary) || controllers[0];
  if (primary) {
    startEvdevPollerForController(primary);
  } else {
    stopEvdevPoller();
  }
}

async function refreshControllerState() {
  try {
    const [probeResult, listResult] = await Promise.all([
      runControllerHelper(["probe"]),
      runControllerHelper(["list"]),
    ]);

    cachedControllerState = buildControllerStatePayload({
      controllers: listResult.controllers || [],
      helperStatus: deriveHelperStatus(probeResult),
      helperDetails: probeResult,
    });
  } catch (error) {
    logWarn("Unable to refresh controller state:", error);
    cachedControllerState = buildControllerStatePayload({
      controllers: [],
      helperStatus: HELPER_STATUS.ERROR,
      helperDetails: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  broadcastControllerStateChanged();
  syncEvdevPoller();
  return cachedControllerState;
}

function ensureControllerRefreshLoop() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(() => {
    refreshControllerState().catch((error) => {
      logWarn("Controller refresh loop failed:", error);
    });
  }, REFRESH_INTERVAL_MS);

  if (typeof refreshTimer.unref === "function") {
    refreshTimer.unref();
  }
}

async function getControllerState() {
  ensureControllerRefreshLoop();

  if (!cachedControllerState.helperDetails) {
    return await refreshControllerState();
  }

  return {
    ...cachedControllerState,
    inputMode: normalizeInputMode(getAppConfig().controllerInputMode),
    helperActive: Boolean(activeControllerSession),
  };
}

function clearControllerInputMode(controllerId) {
  const controller = cachedControllerState.controllers.find((item) => item.id === controllerId);
  if (!controller) {
    throw new Error(`Unknown controller id: ${controllerId}`);
  }

  const controllerKey = getControllerConfigKey(controller);
  const controllerInputModes = { ...(getAppConfig().controllerInputModes || {}) };
  delete controllerInputModes[controllerKey];
  setAppConfig("controllerInputModes", controllerInputModes);

  cachedControllerState = buildControllerStatePayload({
    controllers: cachedControllerState.controllers,
    helperStatus: cachedControllerState.helperStatus,
    helperDetails: cachedControllerState.helperDetails,
  });
  broadcastControllerStateChanged();
}

function setControllerAegisStrategy(controllerId, strategy) {
  const controller = cachedControllerState.controllers.find((item) => item.id === controllerId);
  if (!controller) {
    throw new Error(`Unknown controller id: ${controllerId}`);
  }

  const controllerKey = getControllerConfigKey(controller);
  const controllerAegisStrategies = { ...(getAppConfig().controllerAegisStrategies || {}) };

  if (strategy === null || strategy === "auto") {
    delete controllerAegisStrategies[controllerKey];
  } else {
    controllerAegisStrategies[controllerKey] = strategy;
  }

  setAppConfig("controllerAegisStrategies", controllerAegisStrategies);

  cachedControllerState = buildControllerStatePayload({
    controllers: cachedControllerState.controllers,
    helperStatus: cachedControllerState.helperStatus,
    helperDetails: cachedControllerState.helperDetails,
  });
  broadcastControllerStateChanged();
}

function setControllerInputMode(mode, controllerId = null) {
  const normalizedMode = normalizeInputMode(mode);
  let newConfig;

  if (controllerId === null) {
    newConfig = setAppConfig("controllerInputMode", normalizedMode);
  } else {
    const controller = cachedControllerState.controllers.find((item) => item.id === controllerId);
    if (!controller) {
      throw new Error(`Unknown controller id: ${controllerId}`);
    }

    const controllerKey = getControllerConfigKey(controller);
    const controllerInputModes = {
      ...(getAppConfig().controllerInputModes || {}),
      [controllerKey]: normalizedMode,
    };
    newConfig = setAppConfig("controllerInputModes", controllerInputModes);
  }

  cachedControllerState = buildControllerStatePayload({
    controllers: cachedControllerState.controllers,
    helperStatus: cachedControllerState.helperStatus,
    helperDetails: cachedControllerState.helperDetails,
  });
  broadcastControllerStateChanged();
  return newConfig;
}

function stopControllerSession() {
  if (!activeControllerSession) {
    return;
  }

  const { process: process_ } = activeControllerSession;
  activeControllerSession = null;

  if (process_ && !process_.killed) {
    try {
      process_.kill("SIGTERM");
    } catch (error) {
      logWarn("Unable to stop controller helper session:", error);
    }
  }

  syncEvdevPoller();
}

async function startXInputHelperSession(controller, strategy) {
  const helperState = await getControllerState();
  if (helperState.helperStatus !== HELPER_STATUS.READY) {
    return null;
  }

  stopEvdevPoller();

  const pythonCommand = await resolvePythonCommand();
  const helperPath = getControllerHelperPath();

  const helperMode =
    strategy === AEGIS_STRATEGIES.DUALSENSE_NATIVE ? "dualsense" : "xinput";

  const helperArguments = [
    helperPath,
    "serve",
    "--mode",
    helperMode,
  ];

  if (controller?.id) {
    helperArguments.push("--controller-id", controller.id);
  }

  if (strategy === AEGIS_STRATEGIES.XINPUT_FALLBACK) {
    helperArguments.push("--exclusive-grab");
  }

  const child = spawn(pythonCommand, helperArguments, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    logInfo("controller-helper", chunk.toString().trim());
  });

  child.stderr.on("data", (chunk) => {
    logWarn("controller-helper", chunk.toString().trim());
  });

  child.on("exit", (code, signal) => {
    logInfo("controller-helper-exit", code, signal);
    if (activeControllerSession?.process === child) {
      activeControllerSession = null;
    }
  });

  activeControllerSession = {
    process: child,
    strategy,
    mode: helperMode,
  };

  return child;
}

async function startControllerSessionForGame(game) {
  const state = await getControllerState();
  const primaryController =
    state.controllers.find((controller) => controller.isPrimary) ||
    state.controllers[0] ||
    null;
  const inputMode = getControllerInputMode(primaryController);

  if (inputMode === "native") {
    return {
      mode: inputMode,
      strategy: AEGIS_STRATEGIES.NATIVE_FALLBACK,
      environment: buildLaunchEnvironment({
        inputMode,
        strategy: AEGIS_STRATEGIES.NATIVE_FALLBACK,
        game,
        helperActive: false,
      }),
    };
  }

  let strategy =
    inputMode === "xinput"
      ? AEGIS_STRATEGIES.XINPUT_FALLBACK
      : resolveAegisStrategy(game, primaryController ? [primaryController] : state.controllers);

  let helperActive = false;

  if (
    strategy === AEGIS_STRATEGIES.XINPUT_FALLBACK ||
    strategy === AEGIS_STRATEGIES.DUALSENSE_NATIVE
  ) {
    const helperProcess = await startXInputHelperSession(primaryController, strategy);
    helperActive = Boolean(helperProcess);

    if (!helperActive) {
      strategy = AEGIS_STRATEGIES.NATIVE_FALLBACK;
      showToastOnUi({
        title: inputMode === "aegis" ? "Aegis fallback" : "XInput fallback",
        description:
          "Controller helper prerequisites are unavailable. Falling back to native input.",
        type: "warn",
      });
    }
  }

  return {
    mode: inputMode,
    strategy,
    environment: buildLaunchEnvironment({
      inputMode,
      strategy,
      game,
      helperActive,
    }),
  };
}

module.exports = {
  INPUT_MODES,
  HELPER_STATUS,
  AEGIS_STRATEGIES,
  getControllerState,
  refreshControllerState,
  setControllerInputMode,
  clearControllerInputMode,
  setControllerAegisStrategy,
  startControllerSessionForGame,
  stopControllerSession,
  resolveAegisStrategy,
  buildLaunchEnvironment,
  normalizeInputMode,
  getControllerConfigKey,
  getControllerInputMode,
  getControllerInputModeFromConfig,
  getControllerAegisStrategyFromConfig,
};

if (process.env.NODE_ENV !== "test") {
  ensureControllerRefreshLoop();
  refreshControllerState().catch((error) => {
    logWarn("Initial controller refresh failed:", error);
  });
}
