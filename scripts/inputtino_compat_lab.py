#!/usr/bin/env python3

import argparse
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path

import evdev
from evdev import ecodes


DEFAULT_MATRIX_PATH = Path(__file__).with_name("gamepad_compat_matrix.json")
DEFAULT_CONTROLLER_HELPER = Path(__file__).resolve().parents[1] / "controller_helper.py"
DEFAULT_INPUTTINO_HELPER = (
    Path(__file__).resolve().parents[1]
    / "build"
    / "inputtino-harness"
    / "lgui-inputtino-harness"
)
READY_TOKENS = ("READY", '"status": "ready"')


def load_matrix(path):
    with open(path, encoding="utf8") as handle:
        return json.load(handle)


def find_profile(matrix, profile_id):
    for profile in matrix["profiles"]:
        if profile["id"] == profile_id:
            return profile
    raise KeyError(f"Unknown matrix profile: {profile_id}")


def normalize_abs_codes(raw_abs_codes):
    normalized = set()
    for code in raw_abs_codes:
        if isinstance(code, tuple):
            normalized.add(code[0])
        else:
            normalized.add(code)
    return normalized


def looks_like_gamepad(device):
    capabilities = device.capabilities()
    key_codes = set(capabilities.get(ecodes.EV_KEY, []))
    abs_codes = normalize_abs_codes(capabilities.get(ecodes.EV_ABS, []))

    has_gamepad_buttons = any(
        code in key_codes
        for code in (
            ecodes.BTN_SOUTH,
            ecodes.BTN_EAST,
            ecodes.BTN_NORTH,
            ecodes.BTN_WEST,
            ecodes.BTN_TL,
            ecodes.BTN_TR,
            ecodes.BTN_SELECT,
            ecodes.BTN_START,
            ecodes.BTN_MODE,
            ecodes.BTN_THUMBL,
            ecodes.BTN_THUMBR,
        )
    )
    has_gamepad_axes = any(
        code in abs_codes
        for code in (
            ecodes.ABS_X,
            ecodes.ABS_Y,
            ecodes.ABS_RX,
            ecodes.ABS_RY,
            ecodes.ABS_HAT0X,
            ecodes.ABS_HAT0Y,
        )
    )

    return has_gamepad_buttons and has_gamepad_axes


def find_new_device(before_paths, expected_name_fragment, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for device_path in evdev.list_devices():
            if device_path in before_paths:
                continue
            device = evdev.InputDevice(device_path)
            if expected_name_fragment.lower() in device.name.lower():
                if looks_like_gamepad(device):
                    return device
            device.close()
        time.sleep(0.05)

    raise TimeoutError(f"Timed out waiting for device containing '{expected_name_fragment}'")


def wait_for_ready(process, timeout=5.0):
    if process.stdout is None:
        raise RuntimeError("Process was started without a stdout pipe")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready = selector.select(timeout=0.1)
        if not ready:
            if process.poll() is not None:
                raise RuntimeError(f"Helper exited before becoming ready: {read_process_error(process)}")
            continue
        line = process.stdout.readline()
        if not line:
            continue
        if any(token in line for token in READY_TOKENS):
            return
    raise TimeoutError("Timed out waiting for helper readiness")


def read_process_error(process):
    if process.stderr is None:
        return "no stderr captured"
    try:
        output = process.stderr.read().strip()
    except Exception:
        output = ""
    return output or "no stderr output"


def run_controller_list(controller_helper_path):
    output = subprocess.check_output(
        [sys.executable, str(controller_helper_path), "list"],
        text=True,
    )
    return json.loads(output)


def wait_for_listed_controller(controller_helper_path, source_device, timeout=5.0):
    deadline = time.monotonic() + timeout
    source_name = source_device.name
    while time.monotonic() < deadline:
        listed = run_controller_list(controller_helper_path)
        for controller in listed["controllers"]:
            if controller["eventPath"] == source_device.path:
                return controller
        for controller in listed["controllers"]:
            if controller["name"] == source_name:
                return controller
        time.sleep(0.1)

    raise TimeoutError(
        f"Timed out waiting for controller_helper.py to list source controller "
        f"{source_name} at {source_device.path}"
    )


def start_inputtino_source(inputtino_helper_path, profile_name):
    process = subprocess.Popen(
        [str(inputtino_helper_path), profile_name],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    wait_for_ready(process)
    return process


def start_controller_pipeline(controller_helper_path, target_mode, controller_id):
    process = subprocess.Popen(
        [
            sys.executable,
            str(controller_helper_path),
            "serve",
            "--mode",
            target_mode,
            "--controller-id",
            controller_id,
            "--exclusive-grab",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    wait_for_ready(process)
    return process


def send_command(process, command):
    process.stdin.write(f"{command}\n")
    process.stdin.flush()


def get_code_name(event_type, event_code):
    code_name = ecodes.bytype.get(event_type, {}).get(event_code)
    if isinstance(code_name, (list, tuple)):
        return code_name[0]
    if isinstance(code_name, str):
        return code_name
    return str(event_code)


def matches_code_name(event_type, event_code, expected_code):
    code_name = ecodes.bytype.get(event_type, {}).get(event_code)
    if isinstance(code_name, (list, tuple)):
        return expected_code in code_name
    return get_code_name(event_type, event_code) == expected_code


def wait_for_event(device, expected_type, expected_code, predicate, timeout=2.0):
    selector = selectors.DefaultSelector()
    selector.register(device.fd, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        ready = selector.select(timeout=0.1)
        if not ready:
            continue
        for event in device.read():
            if event.type != expected_type or not matches_code_name(
                event.type, event.code, expected_code
            ):
                continue
            if predicate(event.value):
                return event

    raise TimeoutError(
        f"Timed out waiting for {ecodes.EV[expected_type]} {expected_code} matching predicate"
    )


def wait_for_events(device, expectations, timeout=2.0):
    selector = selectors.DefaultSelector()
    selector.register(device.fd, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    pending = list(expectations)

    while time.monotonic() < deadline:
        ready = selector.select(timeout=0.1)
        if not ready:
            continue
        for event in device.read():
            next_pending = []
            for expectation in pending:
                if event.type != expectation["event_type"] or not matches_code_name(
                    event.type, event.code, expectation["event_code"]
                ):
                    next_pending.append(expectation)
                    continue
                if not expectation["predicate"](event.value):
                    next_pending.append(expectation)
            pending = next_pending
            if not pending:
                return

    unresolved = ", ".join(
        f"{ecodes.EV[item['event_type']]} {item['event_code']}" for item in pending
    )
    raise TimeoutError(f"Timed out waiting for events: {unresolved}")


def assert_button_check(device, source_process, check):
    send_command(source_process, check["command"])
    wait_for_event(
        device,
        getattr(ecodes, check["event_type"]),
        check["event_code"],
        lambda value: value == check["pressed_value"],
    )
    send_command(source_process, check["release"])
    wait_for_event(
        device,
        getattr(ecodes, check["event_type"]),
        check["event_code"],
        lambda value: value == check["released_value"],
    )


def assert_dpad_check(device, source_process, check):
    send_command(source_process, check["command"])
    wait_for_events(
        device,
        [
            {
                "event_type": getattr(ecodes, check["hat_event_type"]),
                "event_code": check["hat_event_code"],
                "predicate": lambda value: value == check["hat_pressed_value"],
            },
            {
                "event_type": getattr(ecodes, check["button_event_type"]),
                "event_code": check["button_event_code"],
                "predicate": lambda value: value == check["button_pressed_value"],
            },
        ],
    )

    send_command(source_process, check["release"])
    wait_for_events(
        device,
        [
            {
                "event_type": getattr(ecodes, check["hat_event_type"]),
                "event_code": check["hat_event_code"],
                "predicate": lambda value: value == check["hat_released_value"],
            },
            {
                "event_type": getattr(ecodes, check["button_event_type"]),
                "event_code": check["button_event_code"],
                "predicate": lambda value: value == check["button_released_value"],
            },
        ],
    )


def assert_axis_check(device, source_process, check):
    send_command(source_process, check["command"])
    threshold = 8000
    if check["direction"] == "positive":
        wait_for_event(
            device,
            getattr(ecodes, check["event_type"]),
            check["event_code"],
            lambda value: value > threshold,
        )
    else:
        wait_for_event(
            device,
            getattr(ecodes, check["event_type"]),
            check["event_code"],
            lambda value: value < -threshold,
        )

    send_command(source_process, check["release"])
    wait_for_event(
        device,
        getattr(ecodes, check["event_type"]),
        check["event_code"],
        lambda value: abs(value) < 2048,
    )


def assert_trigger_check(device, source_process, check):
    send_command(source_process, check["command"])
    wait_for_event(
        device,
        getattr(ecodes, check["event_type"]),
        check["event_code"],
        lambda value: value >= check["pressed_min_value"],
    )
    send_command(source_process, check["release"])
    wait_for_event(
        device,
        getattr(ecodes, check["event_type"]),
        check["event_code"],
        lambda value: value <= check["released_max_value"],
    )


def terminate_process(process, quit_command=None):
    if process is None:
        return

    try:
        if quit_command and process.poll() is None:
            send_command(process, quit_command)
    except Exception:
        pass

    try:
        process.terminate()
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def run_profile(matrix, profile, controller_helper_path, inputtino_helper_path):
    source_process = None
    pipeline_process = None
    output_device = None
    failures = []

    try:
        before_devices = set(evdev.list_devices())
        source_process = start_inputtino_source(
            inputtino_helper_path,
            profile["inputtino_profile"],
        )
        source_device = find_new_device(before_devices, "LGUI Test")

        matched = wait_for_listed_controller(controller_helper_path, source_device)

        before_pipeline_devices = set(evdev.list_devices())
        pipeline_process = start_controller_pipeline(
            controller_helper_path,
            profile["target_mode"],
            matched["id"],
        )

        expected_name = (
            "Aegis Virtual Xbox Controller"
            if profile["target_mode"] == "xinput"
            else "DualSense Wireless Controller"
        )
        output_device = find_new_device(before_pipeline_devices, expected_name)

        for check in matrix["checks"]:
            try:
                if check["kind"] == "button":
                    assert_button_check(output_device, source_process, check)
                elif check["kind"] == "dpad":
                    assert_dpad_check(output_device, source_process, check)
                elif check["kind"] == "axis":
                    assert_axis_check(output_device, source_process, check)
                elif check["kind"] == "trigger":
                    assert_trigger_check(output_device, source_process, check)
                else:
                    raise RuntimeError(f"Unsupported check kind: {check['kind']}")
                print(f"[PASS] {profile['id']}::{check['id']}")
            except Exception as error:
                failures.append(
                    {
                        "profile": profile["id"],
                        "check": check["id"],
                        "error": str(error),
                    }
                )
                print(f"[FAIL] {profile['id']}::{check['id']} {error}")

        if not failures:
            print(f"[PASS] {profile['id']}")
        return failures
    finally:
        terminate_process(source_process, "QUIT")
        terminate_process(pipeline_process)
        if output_device:
            output_device.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--matrix",
        default=str(DEFAULT_MATRIX_PATH),
        help="Path to the compatibility matrix JSON",
    )
    parser.add_argument(
        "--profile",
        action="append",
        dest="profiles",
        help="Run only selected matrix profile ids",
    )
    parser.add_argument(
        "--controller-helper",
        default=str(DEFAULT_CONTROLLER_HELPER),
        help="Path to controller_helper.py",
    )
    parser.add_argument(
        "--inputtino-helper",
        default=str(DEFAULT_INPUTTINO_HELPER),
        help="Path to the built inputtino harness binary",
    )
    parser.add_argument(
        "--list-profiles",
        action="store_true",
        help="Print available profile ids and exit",
    )
    arguments = parser.parse_args()

    matrix = load_matrix(arguments.matrix)
    if arguments.list_profiles:
        for profile in matrix["profiles"]:
            print(profile["id"])
        return

    profiles = (
        [find_profile(matrix, profile_id) for profile_id in arguments.profiles]
        if arguments.profiles
        else matrix["profiles"]
    )

    controller_helper_path = Path(arguments.controller_helper)
    inputtino_helper_path = Path(arguments.inputtino_helper)

    if not controller_helper_path.exists():
        raise FileNotFoundError(f"Controller helper not found: {controller_helper_path}")
    if not inputtino_helper_path.exists():
        raise FileNotFoundError(
            f"Inputtino harness not found: {inputtino_helper_path}. "
            "Build it first with `npm run build:inputtino-harness`."
        )

    failures = []
    for profile in profiles:
        failures.extend(run_profile(matrix, profile, controller_helper_path, inputtino_helper_path))

    if failures:
        print("\nCompatibility matrix failures:")
        for failure in failures:
            print(f"- {failure['profile']}::{failure['check']} -> {failure['error']}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
