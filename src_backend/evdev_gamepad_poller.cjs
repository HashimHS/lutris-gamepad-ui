const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { logInfo, logWarn } = require("./utils.cjs");

// struct input_event on x86_64: 24 bytes
// [16 bytes timeval] [2 bytes type] [2 bytes code] [4 bytes value]
const INPUT_EVENT_SIZE = 24;

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;

// evdev button codes → standard Gamepad API button indices
const EVDEV_KEY_TO_BUTTON = {
  0x130: 0,   // BTN_SOUTH / BTN_A
  0x131: 1,   // BTN_EAST  / BTN_B
  0x133: 2,   // BTN_NORTH / BTN_X (kernel aliases X=NORTH per Nintendo layout)
  0x134: 3,   // BTN_WEST  / BTN_Y (kernel aliases Y=WEST per Nintendo layout)
  0x136: 4,   // BTN_TL (LB)
  0x137: 5,   // BTN_TR (RB)
  0x13a: 8,   // BTN_SELECT
  0x13b: 9,   // BTN_START
  0x13d: 10,  // BTN_THUMBL
  0x13e: 11,  // BTN_THUMBR
  0x13c: 16,  // BTN_MODE (Guide)
  // D-pad as buttons (some controllers)
  0x220: 12,  // BTN_DPAD_UP
  0x221: 13,  // BTN_DPAD_DOWN
  0x222: 14,  // BTN_DPAD_LEFT
  0x223: 15,  // BTN_DPAD_RIGHT
};

// evdev axis codes
const ABS_X = 0x00;
const ABS_Y = 0x01;
const ABS_Z = 0x02;    // Left trigger
const ABS_RX = 0x03;
const ABS_RY = 0x04;
const ABS_RZ = 0x05;   // Right trigger
const ABS_HAT0X = 0x10;
const ABS_HAT0Y = 0x11;

// Axis range for Xbox virtual controllers (inputtino uses -32768..32767)
const AXIS_MIN = -32768;
const AXIS_MAX = 32767;
const AXIS_RANGE = AXIS_MAX - AXIS_MIN;

// Trigger range (0..1023 for Xbox)
const TRIGGER_MAX = 1023;

const TOTAL_BUTTONS = 17;
const TOTAL_AXES = 4;

function normalizeStickAxis(value) {
  return Math.max(-1, Math.min(1, (2 * (value - AXIS_MIN)) / AXIS_RANGE - 1));
}

function normalizeTrigger(value) {
  return Math.max(0, Math.min(1, value / TRIGGER_MAX));
}

class EvdevGamepadPoller extends EventEmitter {
  constructor(devicePath, controllerName) {
    super();
    this.devicePath = devicePath;
    this.controllerName = controllerName || "Unknown Controller";
    this._stream = null;
    this._remainder = Buffer.alloc(0);
    this._buttons = new Array(TOTAL_BUTTONS).fill(false);
    this._axes = new Float64Array(TOTAL_AXES); // [leftX, leftY, rightX, rightY]
    this._triggerLeft = 0;
    this._triggerRight = 0;
    this._dirty = false;
    this._closed = false;
  }

  start() {
    if (this._stream) return;
    this._closed = false;

    try {
      this._stream = fs.createReadStream(this.devicePath, {
        highWaterMark: INPUT_EVENT_SIZE * 32,
      });
    } catch (error) {
      logWarn("EvdevPoller: failed to open", this.devicePath, error.message);
      return;
    }

    this._stream.on("data", (chunk) => this._onData(chunk));

    this._stream.on("error", (error) => {
      if (!this._closed) {
        logWarn("EvdevPoller: read error on", this.devicePath, error.message);
      }
      this.stop();
    });

    this._stream.on("close", () => {
      if (!this._closed) {
        logInfo("EvdevPoller: device closed", this.devicePath);
        this.stop();
        this.emit("disconnected");
      }
    });

    logInfo(
      "EvdevPoller: started reading",
      this.devicePath,
      this.controllerName,
    );
  }

  stop() {
    this._closed = true;
    if (this._stream) {
      this._stream.destroy();
      this._stream = null;
    }
    this._remainder = Buffer.alloc(0);
  }

  isActive() {
    return this._stream !== null && !this._closed;
  }

  _onData(chunk) {
    let buffer =
      this._remainder.length > 0
        ? Buffer.concat([this._remainder, chunk])
        : chunk;

    let offset = 0;
    while (offset + INPUT_EVENT_SIZE <= buffer.length) {
      const type = buffer.readUInt16LE(offset + 16);
      const code = buffer.readUInt16LE(offset + 18);
      const value = buffer.readInt32LE(offset + 20);
      this._processEvent(type, code, value);
      offset += INPUT_EVENT_SIZE;
    }

    this._remainder =
      offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0);
  }

  _processEvent(type, code, value) {
    if (type === EV_KEY) {
      const buttonIndex = EVDEV_KEY_TO_BUTTON[code];
      if (buttonIndex !== undefined) {
        const pressed = value > 0;
        if (this._buttons[buttonIndex] !== pressed) {
          this._buttons[buttonIndex] = pressed;
          this._dirty = true;
        }
      }
    } else if (type === EV_ABS) {
      this._processAxis(code, value);
    } else if (type === EV_SYN && code === 0 && this._dirty) {
      this._dirty = false;
      this._emitState();
    }
  }

  _processAxis(code, value) {
    switch (code) {
      case ABS_X:
        this._axes[0] = normalizeStickAxis(value);
        this._dirty = true;
        break;
      case ABS_Y:
        this._axes[1] = normalizeStickAxis(value);
        this._dirty = true;
        break;
      case ABS_RX:
        this._axes[2] = normalizeStickAxis(value);
        this._dirty = true;
        break;
      case ABS_RY:
        this._axes[3] = normalizeStickAxis(value);
        this._dirty = true;
        break;
      case ABS_Z: {
        const norm = normalizeTrigger(value);
        this._triggerLeft = norm;
        this._buttons[6] = norm > 0.1;
        this._dirty = true;
        break;
      }
      case ABS_RZ: {
        const norm = normalizeTrigger(value);
        this._triggerRight = norm;
        this._buttons[7] = norm > 0.1;
        this._dirty = true;
        break;
      }
      case ABS_HAT0X:
        // Hat left/right → d-pad buttons[14]/buttons[15]
        this._buttons[14] = value < 0; // LEFT
        this._buttons[15] = value > 0; // RIGHT
        this._dirty = true;
        break;
      case ABS_HAT0Y:
        // Hat up/down → d-pad buttons[12]/buttons[13]
        this._buttons[12] = value < 0; // UP
        this._buttons[13] = value > 0; // DOWN
        this._dirty = true;
        break;
    }
  }

  _emitState() {
    const buttons = this._buttons.map((pressed, index) => ({
      pressed,
      value: pressed
        ? index === 6
          ? this._triggerLeft
          : index === 7
            ? this._triggerRight
            : 1
        : 0,
    }));

    this.emit("state", {
      id: `evdev:${this.controllerName}`,
      mapping: "standard",
      buttons,
      axes: Array.from(this._axes),
      connected: true,
      timestamp: Date.now(),
    });
  }
}

module.exports = { EvdevGamepadPoller };
