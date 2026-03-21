# Automated Gamepad Compatibility Testing

This repository includes an automated compatibility harness for validating the
`controller_helper.py` input pipeline without a physical gamepad.

The flow is:

1. `lgui-inputtino-harness` creates a virtual source controller using `inputtino`.
2. `controller_helper.py` detects that source device and creates its output virtual controller.
3. `scripts/inputtino_compat_lab.py` drives button, d-pad, guide, stick, and trigger scenarios.
4. The harness reads the output evdev node and asserts the translated events.

## What It Covers

- `XInput` mapping for:
  - face buttons
  - guide/home button
  - d-pad
  - left stick axes
- `DualSense` source coverage through both:
  - `xinput` target mode
  - `dualsense` target mode
- `Switch` source coverage through `xinput` target mode

This is aimed at the controller compatibility layer itself. It is much faster
than retesting with real pads and catches regressions in detection, remapping,
and virtual-device output.

## Prerequisites

- Linux with `/dev/uinput` access
- Python 3 with `python-evdev`
- CMake and a C++20 compiler
- Network access for the first build, unless you point the harness at a local
  `inputtino` checkout

## Build The Inputtino Harness

By default the harness will try, in order:

1. a local `inputtino` checkout passed through `-DINPUTTINO_SOURCE_DIR=...`
2. an installed `inputtino` CMake package
3. a GitHub fetch of `games-on-whales/inputtino`

So the common case is now simply:

```bash
npm run build:inputtino-harness
```

If you want to pin it to a local checkout instead:

```bash
cmake -S tools/inputtino-harness -B build/inputtino-harness -DINPUTTINO_SOURCE_DIR=/path/to/inputtino
cmake --build build/inputtino-harness
```

## Run The Compatibility Matrix

```bash
npm run test:gamepad-compat
```

List the available controller profiles:

```bash
python3 scripts/inputtino_compat_lab.py --list-profiles
```

Run only selected profiles:

```bash
python3 scripts/inputtino_compat_lab.py --profile dualsense --profile switch
```

If the helper fails to create a virtual device, verify that the host exposes
`/dev/uinput` and that the current user can open it. When testing from a
container, you also need to pass `/dev/uinput` and the relevant `/dev/input`
devices through to the container.

## Files

- `tools/inputtino-harness/main.cpp`
  A tiny stdin-driven virtual controller feeder built on top of `inputtino`.
- `scripts/gamepad_compat_matrix.json`
  Profiles and assertions for the automated matrix.
- `scripts/inputtino_compat_lab.py`
  Orchestrates the end-to-end compatibility run and reads output evdev events.
