import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "../contexts/TranslationContext";
import { useScopedInput } from "../hooks/useScopedInput";
import { getMappedInput } from "../utils/gamepad_mapping";
import DialogLayout from "./DialogLayout";

import "../styles/ControllerTester.css";

// W3C Standard Gamepad API button indices
const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  HOME: 16,
};

// Resolve which button label style to show based on the active input mode
function resolveButtonStyle(inputMode, aegisStrategy, controllerFamily) {
  if (inputMode === "xinput") return "xbox";
  if (inputMode === "aegis") {
    return aegisStrategy === "dualsense-native" ? "playstation" : "xbox";
  }
  // native: mirror what the connected hardware actually is
  if (
    controllerFamily === "dualsense" ||
    controllerFamily === "dualshock" ||
    controllerFamily === "playstation"
  ) {
    return "playstation";
  }
  return "xbox";
}

const FACE_LABELS = {
  xbox: {
    a: { label: "A", color: "#4caf50" },
    b: { label: "B", color: "#f44336" },
    x: { label: "X", color: "#2196f3" },
    y: { label: "Y", color: "#ffc107" },
  },
  playstation: {
    a: { label: "✕", color: "#7eb3e0" },
    b: { label: "○", color: "#f48fb1" },
    x: { label: "□", color: "#ce93d8" },
    y: { label: "△", color: "#4db6ac" },
  },
};

function getButtonValue(state, index) {
  return state?.buttons?.[index]?.value ?? 0;
}

function isPressed(state, index) {
  return state?.buttons?.[index]?.pressed ?? false;
}

function getAxis(state, index) {
  return state?.axes?.[index] ?? 0;
}

function readGamepadState(gamepad) {
  if (!gamepad) return null;

  // Match InputContext exactly:
  // - use the browser's standard mapping when available
  // - only use the custom SDL mapping database for unmapped devices
  if (gamepad.mapping === "standard") {
    return {
      buttons: Array.from(gamepad.buttons).map((b) => ({
        pressed: b.pressed,
        touched: b.touched,
        value: b.value,
      })),
      axes: Array.from(gamepad.axes),
    };
  }

  if (gamepad.mapping === "") {
    return getMappedInput(gamepad) ?? null;
  }

  return null;
}

const VIRTUAL_XINPUT_ID_PATTERN = "aegis virtual xbox controller";
const VIRTUAL_DUALSENSE_ID_PATTERN =
  "sony interactive entertainment dualsense wireless controller";

function findTargetGamepad(gamepads, controllerState) {
  const connected = Array.from(gamepads).filter(Boolean);
  if (connected.length === 0) return null;

  const inputMode = controllerState?.inputMode ?? "native";
  const strategy = controllerState?.aegisStrategyPreview;

  const isVirtualXInput = (gp) =>
    gp.id.toLowerCase().includes(VIRTUAL_XINPUT_ID_PATTERN);

  const isVirtualDualSense = (gp) =>
    gp.id.toLowerCase().includes(VIRTUAL_DUALSENSE_ID_PATTERN);

  if (inputMode === "xinput") {
    return connected.find(isVirtualXInput) ?? connected[0];
  }

  if (inputMode === "aegis") {
    if (strategy === "xinput-fallback") {
      return connected.find(isVirtualXInput) ?? connected[0];
    }

    if (strategy === "dualsense-native") {
      return (
        connected.find(isVirtualDualSense) ??
        connected.find(isVirtualXInput) ??
        connected[0]
      );
    }
  }

  // native mode: prefer non-virtual devices when available
  return (
    connected.find((gp) => {
      const id = gp.id.toLowerCase();
      return (
        !id.includes(VIRTUAL_XINPUT_ID_PATTERN) &&
        !id.includes(VIRTUAL_DUALSENSE_ID_PATTERN)
      );
    }) ?? connected[0]
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const AnalogStick = ({ x, y, pressed, label }) => {
  const knobX = 50 + x * 36;
  const knobY = 50 + y * 36;
  return (
    <div className="ct-stick-wrapper">
      <div className={`ct-stick-area${pressed ? " pressed" : ""}`}>
        <div className="ct-stick-crosshair-h" />
        <div className="ct-stick-crosshair-v" />
        <div
          className={`ct-stick-knob${pressed ? " pressed" : ""}`}
          style={{ left: `${knobX}%`, top: `${knobY}%` }}
        />
      </div>
      <span className="ct-label">{label}</span>
    </div>
  );
};

const TriggerBar = ({ value, label, side }) => (
  <div className={`ct-trigger-wrapper ct-trigger-${side}`}>
    <span className="ct-label">{label}</span>
    <div className="ct-trigger-track">
      <div className="ct-trigger-fill" style={{ width: `${value * 100}%` }} />
    </div>
    <span className="ct-trigger-pct">{Math.round(value * 100)}%</span>
  </div>
);

const ShoulderButton = ({ pressed, label }) => (
  <div className={`ct-shoulder${pressed ? " pressed" : ""}`}>{label}</div>
);

const FaceButton = ({ pressed, label, color }) => (
  <div
    className={`ct-face-btn${pressed ? " pressed" : ""}`}
    style={
      pressed
        ? { background: color, borderColor: color }
        : { borderColor: `${color}88` }
    }
  >
    <span style={{ color: pressed ? "#fff" : color }}>{label}</span>
  </div>
);

const DPad = ({ up, down, left, right }) => (
  <div className="ct-dpad">
    <div className={`ct-dpad-cell${up ? " pressed" : ""}`} />
    <div className="ct-dpad-row">
      <div className={`ct-dpad-cell${left ? " pressed" : ""}`} />
      <div className="ct-dpad-center" />
      <div className={`ct-dpad-cell${right ? " pressed" : ""}`} />
    </div>
    <div className={`ct-dpad-cell${down ? " pressed" : ""}`} />
  </div>
);

const CenterButton = ({ pressed, label }) => (
  <div className={`ct-center-btn${pressed ? " pressed" : ""}`}>{label}</div>
);

// ─── Main component ───────────────────────────────────────────────────────────

const ControllerTester = ({ onClose, controllerState, controller = null }) => {
  const { t } = useTranslation();
  const [gamepadState, setGamepadState] = useState(null);
  const [gamepadName, setGamepadName] = useState(null);
  const rafRef = useRef(null);
  const activeController = controller || controllerState?.controllers?.[0] || null;

  const buttonStyle = useMemo(() => {
    const family = activeController?.family ?? "generic";
    return resolveButtonStyle(
      activeController?.inputMode ?? controllerState?.inputMode ?? "native",
      activeController?.aegisStrategyPreview ?? controllerState?.aegisStrategyPreview,
      family,
    );
  }, [activeController, controllerState]);

  const faceLabels = FACE_LABELS[buttonStyle] ?? FACE_LABELS.xbox;

  // Poll the raw Gamepad API via rAF — separate from the InputContext event
  // system so we can visualise every button without consuming navigation events.
  useEffect(() => {
    const poll = () => {
      const gamepads = navigator.getGamepads?.() ?? [];
      const gp = findTargetGamepad(gamepads, activeController || controllerState);

      if (gp) {
        setGamepadName(gp.id);
        setGamepadState(readGamepadState(gp));
      } else {
        setGamepadName(null);
        setGamepadState(null);
      }
      rafRef.current = requestAnimationFrame(poll);
    };
    rafRef.current = requestAnimationFrame(poll);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [activeController, controllerState]);

  // Close on B press via the focus-scoped input system
  useScopedInput(
    useCallback(
      (input) => {
        if (input.name === "B") onClose();
      },
      [onClose],
    ),
    "ControllerTester",
    true,
  );

  const ltValue = getButtonValue(gamepadState, BTN.LT);
  const rtValue = getButtonValue(gamepadState, BTN.RT);

  const isPlaystation = buttonStyle === "playstation";
  const triggerLabels = { lt: isPlaystation ? "L2" : "LT", rt: isPlaystation ? "R2" : "RT" };
  const shoulderLabels = { lb: isPlaystation ? "L1" : "LB", rb: isPlaystation ? "R1" : "RB" };
  const selectLabel = isPlaystation ? "Create" : "View";
  const startLabel = isPlaystation ? "Options" : "Menu";

  const modeLabel = useMemo(() => {
    const mode = activeController?.inputMode ?? controllerState?.inputMode ?? "native";
    const strategy =
      activeController?.aegisStrategyPreview ?? controllerState?.aegisStrategyPreview;
    if (mode === "aegis" && strategy)
      return `Aegis · ${strategy.replace(/-/g, " ")}`;
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }, [activeController, controllerState]);

  const legendItems = useMemo(
    () => [{ button: "B", label: t("Close"), onClick: onClose }],
    [onClose, t],
  );

  const statusText = gamepadName
    ? `${t("Testing")}: ${gamepadName}`
    : t("No controller detected — press a button to connect.");

  return (
    <DialogLayout
      title={t("Test Controller")}
      description={statusText}
      legendItems={legendItems}
      maxWidth="860px"
    >
      <div className="ct-root">
        <div className="ct-mode-badge">{modeLabel}</div>

        {/* Triggers */}
        <div className="ct-triggers-row">
          <TriggerBar value={ltValue} label={triggerLabels.lt} side="left" />
          <div className="ct-flex-spacer" />
          <TriggerBar value={rtValue} label={triggerLabels.rt} side="right" />
        </div>

        {/* Shoulder buttons */}
        <div className="ct-shoulders-row">
          <ShoulderButton
            pressed={isPressed(gamepadState, BTN.LB)}
            label={shoulderLabels.lb}
          />
          <div className="ct-flex-spacer" />
          <ShoulderButton
            pressed={isPressed(gamepadState, BTN.RB)}
            label={shoulderLabels.rb}
          />
        </div>

        {/* Main body: D-pad · center buttons · face buttons */}
        <div className="ct-body">
          <div className="ct-body-col">
            <DPad
              up={isPressed(gamepadState, BTN.DPAD_UP)}
              down={isPressed(gamepadState, BTN.DPAD_DOWN)}
              left={isPressed(gamepadState, BTN.DPAD_LEFT)}
              right={isPressed(gamepadState, BTN.DPAD_RIGHT)}
            />
          </div>

          <div className="ct-body-center">
            <CenterButton
              pressed={isPressed(gamepadState, BTN.SELECT)}
              label={selectLabel}
            />
            <CenterButton
              pressed={isPressed(gamepadState, BTN.HOME)}
              label="⏺"
            />
            <CenterButton
              pressed={isPressed(gamepadState, BTN.START)}
              label={startLabel}
            />
          </div>

          <div className="ct-body-col">
            <div className="ct-face-grid">
              <div className="ct-face-row">
                <FaceButton
                  pressed={isPressed(gamepadState, BTN.Y)}
                  label={faceLabels.y.label}
                  color={faceLabels.y.color}
                />
              </div>
              <div className="ct-face-row">
                <FaceButton
                  pressed={isPressed(gamepadState, BTN.X)}
                  label={faceLabels.x.label}
                  color={faceLabels.x.color}
                />
                <FaceButton
                  pressed={isPressed(gamepadState, BTN.B)}
                  label={faceLabels.b.label}
                  color={faceLabels.b.color}
                />
              </div>
              <div className="ct-face-row">
                <FaceButton
                  pressed={isPressed(gamepadState, BTN.A)}
                  label={faceLabels.a.label}
                  color={faceLabels.a.color}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Analog sticks */}
        <div className="ct-sticks-row">
          <AnalogStick
            x={getAxis(gamepadState, 0)}
            y={getAxis(gamepadState, 1)}
            pressed={isPressed(gamepadState, BTN.L3)}
            label="L3"
          />
          <div className="ct-flex-spacer" />
          <AnalogStick
            x={getAxis(gamepadState, 2)}
            y={getAxis(gamepadState, 3)}
            pressed={isPressed(gamepadState, BTN.R3)}
            label="R3"
          />
        </div>
      </div>
    </DialogLayout>
  );
};

export default ControllerTester;
