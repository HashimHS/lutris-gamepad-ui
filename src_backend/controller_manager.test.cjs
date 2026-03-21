const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";

const {
  AEGIS_STRATEGIES,
  buildLaunchEnvironment,
  getControllerConfigKey,
  getControllerInputModeFromConfig,
  normalizeInputMode,
  resolveAegisStrategy,
} = require("./controller_manager.cjs");

test("normalizeInputMode falls back to native for unknown values", () => {
  assert.equal(normalizeInputMode("native"), "native");
  assert.equal(normalizeInputMode("xinput"), "xinput");
  assert.equal(normalizeInputMode("aegis"), "aegis");
  assert.equal(normalizeInputMode("unknown"), "native");
});

test("resolveAegisStrategy prefers dualsense-native for known supported titles", () => {
  const strategy = resolveAegisStrategy(
    {
      slug: "kena-bridge-of-spirits",
      name: "Kena: Bridge of Spirits",
    },
    [{ family: "dualsense", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.DUALSENSE_NATIVE);
});

test("resolveAegisStrategy prefers dualsense-native for DualSense controllers", () => {
  const strategy = resolveAegisStrategy(
    {
      slug: "some-other-game",
      name: "Some Other Game",
    },
    [{ family: "dualsense", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.DUALSENSE_NATIVE);
});

test("resolveAegisStrategy falls back to xinput for generic pads", () => {
  const strategy = resolveAegisStrategy(
    {
      slug: "generic-game",
      name: "Generic Game",
    },
    [{ family: "8bitdo", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.XINPUT_FALLBACK);
});

test("buildLaunchEnvironment includes DualSense-native overrides", () => {
  const environment = buildLaunchEnvironment({
    inputMode: "aegis",
    strategy: AEGIS_STRATEGIES.DUALSENSE_NATIVE,
    game: { runner: "wine", slug: "kena-bridge-of-spirits" },
    helperActive: false,
  });

  assert.equal(environment.AEGIS_INPUT_MODE, "aegis");
  assert.equal(environment.AEGIS_STRATEGY, AEGIS_STRATEGIES.DUALSENSE_NATIVE);
  assert.equal(environment.PROTON_ENABLE_HIDRAW, "1");
  assert.equal(environment.AEGIS_PREFER_DUALSENSE, "1");
});

test("buildLaunchEnvironment includes xinput overrides when helper is active", () => {
  const environment = buildLaunchEnvironment({
    inputMode: "xinput",
    strategy: AEGIS_STRATEGIES.XINPUT_FALLBACK,
    game: { runner: "wine", slug: "test-game" },
    helperActive: true,
  });

  assert.equal(environment.AEGIS_HELPER_ACTIVE, "1");
  assert.equal(environment.SDL_GAMECONTROLLER_USE_BUTTON_LABELS, "0");
  assert.equal(environment.SDL_JOYSTICK_RAWINPUT, "0");
  assert.equal(environment.WINE_HIDE_GAMEPAD_RAWINPUT, "1");
});

test("resolveAegisStrategy uses xinput for Nintendo Switch Pro Controller", () => {
  const strategy = resolveAegisStrategy(
    { slug: "some-game", name: "Some Game" },
    [{ family: "nintendo", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.XINPUT_FALLBACK);
});

test("resolveAegisStrategy uses xinput for Steam Controller", () => {
  const strategy = resolveAegisStrategy(
    { slug: "some-game", name: "Some Game" },
    [{ family: "steam", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.XINPUT_FALLBACK);
});

test("resolveAegisStrategy uses dualsense-native for DualShock 4", () => {
  const strategy = resolveAegisStrategy(
    { slug: "some-game", name: "Some Game" },
    [{ family: "dualshock", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.DUALSENSE_NATIVE);
});

test("resolveAegisStrategy uses dualsense-native for generic PlayStation controller", () => {
  const strategy = resolveAegisStrategy(
    { slug: "some-game", name: "Some Game" },
    [{ family: "playstation", isPrimary: true }],
  );

  assert.equal(strategy, AEGIS_STRATEGIES.DUALSENSE_NATIVE);
});

test("getControllerConfigKey is stable for the same controller identity", () => {
  const key = getControllerConfigKey({
    id: "event7",
    name: "Sony DualSense Wireless Controller",
    vendorId: "054c",
    productId: "0ce6",
  });

  assert.equal(key, "054c:0ce6:sony-dualsense-wireless-controller");
});

test("getControllerInputMode falls back to the global default", () => {
  const mode = getControllerInputModeFromConfig(
    {
      controllerInputMode: "native",
      controllerInputModes: {},
    },
    {
      id: "event7",
      name: "Sony DualSense Wireless Controller",
      vendorId: "054c",
      productId: "0ce6",
    },
  );

  assert.equal(mode, "native");
});

test("getControllerInputMode uses per-controller override when present", () => {
  const controller = {
    id: "event7",
    name: "Sony DualSense Wireless Controller",
    vendorId: "054c",
    productId: "0ce6",
  };
  const key = getControllerConfigKey(controller);

  const mode = getControllerInputModeFromConfig(
    {
      controllerInputMode: "native",
      controllerInputModes: { [key]: "aegis" },
    },
    controller,
  );

  assert.equal(mode, "aegis");
});
