import { useCallback, useEffect, useMemo, useState } from "react";

import { useModalActions } from "../contexts/ModalContext";
import { useTranslation } from "../contexts/TranslationContext";
import * as ipc from "../utils/ipc";

import DialogLayout from "./DialogLayout";
import FocusableRow from "./FocusableRow";
import RowBasedMenu from "./RowBasedMenu";
import SelectionMenu from "./SelectionMenu";

import "../styles/ControllerSettings.css";

const INPUT_MODE_OPTIONS = [
  ["Native", "native"],
  ["XInput", "xinput"],
  ["Aegis", "aegis"],
];

const MODE_DESCRIPTIONS = {
  native:
    "Leaves controller detection unchanged and relies on the game's native support.",
  xinput:
    "Presents a virtual Xbox-compatible controller for maximum baseline compatibility.",
  aegis:
    "Prefers native PlayStation recognition for supported games and falls back to Xbox compatibility when needed.",
};

const HELPER_STATUS_LABELS = {
  ready: "Controller helper is ready.",
  missing_permissions:
    "Controller helper needs /dev/uinput access before virtual controller modes can work.",
  missing_uinput_device:
    "Container setup is missing /dev/uinput. Pass the device through to the container before using virtual controller modes.",
  missing_uinput_permission:
    "Container can see /dev/uinput but cannot open it. Add the required device permission or input-group access for the container user.",
  missing_dependency:
    "Controller helper dependencies are missing. Install python-evdev to enable virtual controller modes.",
  error: "Controller helper is unavailable on this system.",
};

const STRATEGY_LABELS = {
  "dualsense-native": "Aegis will prefer native DualSense-style input.",
  "xinput-fallback": "Aegis will fall back to Xbox-compatible input.",
  "native-fallback": "Aegis will fall back to native input.",
};

const getBrowserControllerFamily = (gamepadId) => {
  const value = String(gamepadId || "").toLowerCase();
  if (value.includes("dualsense") || value.includes("ps5")) return "dualsense";
  if (
    value.includes("dualshock") ||
    value.includes("wireless controller") ||
    value.includes("ps4")
  ) {
    return "dualshock";
  }
  if (value.includes("xbox")) return "xbox";
  if (value.includes("8bitdo")) return "8bitdo";
  return "generic";
};

const getBrowserControllers = () =>
  (navigator.getGamepads?.() || [])
    .filter(Boolean)
    .map((gamepad) => ({
      id: `browser-${gamepad.index}`,
      name: gamepad.id || `Gamepad ${gamepad.index + 1}`,
      vendorId: "browser",
      productId: String(gamepad.index),
      connectionType: "browser",
      family: getBrowserControllerFamily(gamepad.id),
      capabilities: ["buttons", "sticks", "browser-detected"],
      isPrimary: gamepad.index === 0,
    }));

const getHelperStatusMessage = (state, t) => {
  if (!state) return "";

  const { helperStatus, helperDetails } = state;

  if (helperStatus === "missing_permissions" && helperDetails?.running_in_container) {
    if (!helperDetails.uinput_present) {
      return t(HELPER_STATUS_LABELS.missing_uinput_device);
    }

    return t(HELPER_STATUS_LABELS.missing_uinput_permission);
  }

  return t(HELPER_STATUS_LABELS[helperStatus] || "");
};

const ControllerSettings = ({ onClose }) => {
  const { t } = useTranslation();
  const { showModal } = useModalActions();
  const [controllerState, setControllerState] = useState(null);
  const [browserControllers, setBrowserControllers] = useState([]);
  const [focusedItem, setFocusedItem] = useState(null);

  const loadControllerState = useCallback(async () => {
    const state = await ipc.getControllerState();
    setControllerState(state);
    setBrowserControllers(getBrowserControllers());
  }, []);

  useEffect(() => {
    loadControllerState().catch((error) => {
      ipc.logError("Failed to load controller state:", error);
    });

    const unsubscribe = ipc.onControllerStateChanged((state) => {
      setControllerState(state);
      setBrowserControllers(getBrowserControllers());
    });

    const refreshBrowserControllers = () => {
      setBrowserControllers(getBrowserControllers());
    };

    globalThis.addEventListener("gamepadconnected", refreshBrowserControllers);
    globalThis.addEventListener(
      "gamepaddisconnected",
      refreshBrowserControllers,
    );

    return () => {
      unsubscribe?.();
      globalThis.removeEventListener(
        "gamepadconnected",
        refreshBrowserControllers,
      );
      globalThis.removeEventListener(
        "gamepaddisconnected",
        refreshBrowserControllers,
      );
    };
  }, [loadControllerState]);

  const controllers = useMemo(() => {
    if (controllerState?.controllers?.length) {
      return controllerState.controllers;
    }

    return browserControllers;
  }, [browserControllers, controllerState?.controllers]);

  const openInputModePicker = useCallback(() => {
    if (!controllerState) return;

    showModal((hideThisModal) => (
      <SelectionMenu
        title={t("Input Mode")}
        description={t(
          "Choose how Lutris Gamepad UI should present your controller to games.",
        )}
        options={INPUT_MODE_OPTIONS.map(([label, value]) => [t(label), value])}
        currentValue={controllerState.inputMode}
        onSelect={(value) => {
          ipc
            .setControllerInputMode(value)
            .then(() => loadControllerState())
            .catch((error) =>
              ipc.logError("Failed to set controller input mode:", error),
            );
          hideThisModal();
        }}
        onClose={hideThisModal}
      />
    ));
  }, [controllerState, loadControllerState, showModal, t]);

  const items = useMemo(() => {
    const menuItems = [
      {
        type: "INPUT_MODE",
        label: t("Input Mode"),
      },
      {
        type: "REFRESH",
        label: t("Refresh Controllers"),
      },
    ];

    if (controllers.length > 0) {
      for (const controller of controllers) {
        menuItems.push({
          type: "CONTROLLER",
          id: controller.id,
          controller,
          label: controller.name,
        });
      }
    }

    return menuItems;
  }, [controllers, t]);

  const handleRefresh = useCallback(() => {
    ipc
      .refreshControllerState()
      .then((state) => setControllerState(state))
      .catch((error) => ipc.logError("Failed to refresh controller state:", error));
  }, []);

  const handleAction = useCallback(
    (actionName, item) => {
      if (actionName === "B") {
        onClose();
        return;
      }

      if (!item || actionName !== "A") {
        return;
      }

      if (item.type === "INPUT_MODE") {
        openInputModePicker();
      } else if (item.type === "REFRESH") {
        handleRefresh();
      }
    },
    [handleRefresh, onClose, openInputModePicker],
  );

  const renderItem = useCallback(
    (item, isFocused, onMouseEnter) => {
      if (item.type === "INPUT_MODE") {
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={openInputModePicker}
          >
            <span className="settings-menu-label">{item.label}</span>
            <span className="controller-settings-value">
              {t(
                INPUT_MODE_OPTIONS.find(([, value]) => value === controllerState?.inputMode)?.[0] ||
                  "Native",
              )}
            </span>
          </FocusableRow>
        );
      }

      if (item.type === "REFRESH") {
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={handleRefresh}
          >
            <span className="settings-menu-label">{item.label}</span>
          </FocusableRow>
        );
      }

      return (
        <FocusableRow
          key={item.id}
          isFocused={isFocused}
          onMouseEnter={onMouseEnter}
        >
          <div className="controller-settings-device">
            <span className="settings-menu-label">{item.controller.name}</span>
            <span className="controller-settings-meta">
              {[
                item.controller.family,
                item.controller.connectionType,
                `${item.controller.vendorId}:${item.controller.productId}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        </FocusableRow>
      );
    },
    [controllerState?.inputMode, handleRefresh, openInputModePicker, t],
  );

  const currentDescription = useMemo(() => {
    if (!controllerState) {
      return t("Loading...");
    }

    if (focusedItem?.type === "INPUT_MODE") {
      return t(MODE_DESCRIPTIONS[controllerState.inputMode] || MODE_DESCRIPTIONS.native);
    }

    if (focusedItem?.type === "CONTROLLER") {
      return focusedItem.controller.capabilities?.length
        ? focusedItem.controller.capabilities.join(", ")
        : focusedItem.controller.name;
    }

    return t(
      STRATEGY_LABELS[controllerState.aegisStrategyPreview] ||
        HELPER_STATUS_LABELS[controllerState.helperStatus] ||
        "",
    );
  }, [controllerState, focusedItem, t]);

  const helperStatusText = useMemo(() => {
    return getHelperStatusMessage(controllerState, t);
  }, [controllerState, t]);

  const legendItems = useMemo(
    () => [
      { button: "A", label: t("Select") },
      { button: "B", label: t("Close"), onClick: onClose },
    ],
    [onClose, t],
  );

  return (
    <DialogLayout
      title={t("Controller Settings")}
      description={currentDescription}
      legendItems={legendItems}
      maxWidth="700px"
    >
      <div className="controller-settings-summary">
        <p>
          {t("Connected Controllers")}: {controllers.length}
        </p>
        {!controllerState?.controllers?.length && browserControllers.length > 0 && (
          <p className="controller-settings-status">
            {t(
              "The UI can see your controller through the browser gamepad API, but the backend helper has not matched it to a Linux event device yet.",
            )}
          </p>
        )}
        {helperStatusText && (
          <p className="controller-settings-status">{helperStatusText}</p>
        )}
        {controllerState?.setupGuidePath &&
          controllerState.helperStatus !== "ready" &&
          !controllerState?.helperDetails?.running_in_container && (
          <p className="controller-settings-status">
            {t("Setup Guide")}: {controllerState.setupGuidePath}
          </p>
          )}
      </div>

      <RowBasedMenu
        items={items}
        renderItem={renderItem}
        onAction={handleAction}
        onFocusChange={setFocusedItem}
        focusId="ControllerSettings"
      />
    </DialogLayout>
  );
};

export default ControllerSettings;
