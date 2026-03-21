import { useCallback, useEffect, useMemo, useState } from "react";

import { useModalActions } from "../contexts/ModalContext";
import { useTranslation } from "../contexts/TranslationContext";
import * as ipc from "../utils/ipc";

import ControllerTester from "./ControllerTester";
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

const AEGIS_STRATEGY_OPTIONS = [
  ["Auto", "auto"],
  ["DualSense Native", "dualsense-native"],
  ["XInput Fallback", "xinput-fallback"],
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
      inputMode: "native",
      aegisStrategyPreview: "native-fallback",
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
  const [selectedControllerId, setSelectedControllerId] = useState(null);

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

  const selectedController = useMemo(
    () => controllers.find((controller) => controller.id === selectedControllerId) || null,
    [controllers, selectedControllerId],
  );

  useEffect(() => {
    if (selectedControllerId && !selectedController) {
      setSelectedControllerId(null);
    }
  }, [selectedController, selectedControllerId]);

  const openInputModePicker = useCallback(
    (controller) => {
      if (!controller) return;

      showModal((hideThisModal) => (
        <SelectionMenu
          title={t("Input Mode")}
          description={t(
            "Choose how Lutris Gamepad UI should present your controller to games.",
          )}
          options={INPUT_MODE_OPTIONS.map(([label, value]) => [t(label), value])}
          currentValue={controller.inputMode}
          onSelect={(value) => {
            ipc
              .setControllerInputMode(controller.id, value)
              .then(() => loadControllerState())
              .catch((error) =>
                ipc.logError("Failed to set controller input mode:", error),
              );
            hideThisModal();
          }}
          onClose={hideThisModal}
        />
      ));
    },
    [loadControllerState, showModal, t],
  );

  const openControllerTester = useCallback(
    (controller) => {
      if (!controller) return;

      showModal((hideThisModal) => (
        <ControllerTester
          onClose={hideThisModal}
          controllerState={controllerState}
          controller={controller}
        />
      ));
    },
    [controllerState, showModal],
  );

  const openAegisStrategyPicker = useCallback(
    (controller) => {
      if (!controller) return;

      showModal((hideThisModal) => (
        <SelectionMenu
          title={t("Aegis Strategy")}
          description={t(
            "Override how Aegis decides which virtual controller to present to games.",
          )}
          options={AEGIS_STRATEGY_OPTIONS.map(([label, value]) => [t(label), value])}
          currentValue={controller.isAegisStrategyOverridden ? controller.aegisStrategyPreview : "auto"}
          onSelect={(value) => {
            ipc
              .setControllerAegisStrategy(controller.id, value === "auto" ? null : value)
              .then(() => loadControllerState())
              .catch((error) =>
                ipc.logError("Failed to set aegis strategy:", error),
              );
            hideThisModal();
          }}
          onClose={hideThisModal}
        />
      ));
    },
    [loadControllerState, showModal, t],
  );

  const items = useMemo(() => {
    if (!selectedController) {
      const menuItems = controllers.map((controller) => ({
        type: "CONTROLLER",
        id: controller.id,
        controller,
        label: controller.name,
      }));

      menuItems.push({
        type: "REFRESH",
        label: t("Refresh Controllers"),
      });

      return menuItems;
    }

    return [
      {
        type: "INPUT_MODE",
        label: t("Input Mode"),
        controller: selectedController,
      },
      selectedController.inputMode === "aegis" && {
        type: "AEGIS_STRATEGY",
        label: t("Aegis Strategy"),
        controller: selectedController,
      },
      {
        type: "TEST",
        label: t("Test Controller"),
        controller: selectedController,
      },
      selectedController.isInputModeOverridden && {
        type: "RESET_INPUT_MODE",
        label: t("Reset Input Mode to Default"),
        controller: selectedController,
      },
      {
        type: "REFRESH",
        label: t("Refresh Controllers"),
      },
    ].filter(Boolean);
  }, [controllers, selectedController, t]);

  const handleRefresh = useCallback(() => {
    ipc
      .refreshControllerState()
      .then((state) => setControllerState(state))
      .catch((error) => ipc.logError("Failed to refresh controller state:", error));
  }, []);

  const handleAction = useCallback(
    (actionName, item) => {
      if (actionName === "B") {
        if (selectedController) {
          setSelectedControllerId(null);
          return;
        }

        onClose();
        return;
      }

      if (!item || actionName !== "A") {
        return;
      }

      if (item.type === "CONTROLLER") {
        setSelectedControllerId(item.controller.id);
      } else if (item.type === "INPUT_MODE") {
        openInputModePicker(item.controller);
      } else if (item.type === "AEGIS_STRATEGY") {
        openAegisStrategyPicker(item.controller);
      } else if (item.type === "TEST") {
        openControllerTester(item.controller);
      } else if (item.type === "RESET_INPUT_MODE") {
        ipc
          .clearControllerInputMode(item.controller.id)
          .then(() => loadControllerState())
          .catch((error) => ipc.logError("Failed to reset input mode:", error));
      } else if (item.type === "REFRESH") {
        handleRefresh();
      }
    },
    [handleRefresh, onClose, openAegisStrategyPicker, openControllerTester, openInputModePicker, selectedController],
  );

  const renderItem = useCallback(
    (item, isFocused, onMouseEnter) => {
      if (item.type === "INPUT_MODE") {
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={() => openInputModePicker(item.controller)}
          >
            <span className="settings-menu-label">{item.label}</span>
            <span className="controller-settings-value">
              {t(
                INPUT_MODE_OPTIONS.find(([, value]) => value === item.controller?.inputMode)?.[0] ||
                  "Native",
              )}
            </span>
          </FocusableRow>
        );
      }

      if (item.type === "TEST") {
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={() => openControllerTester(item.controller)}
          >
            <span className="settings-menu-label">{item.label}</span>
          </FocusableRow>
        );
      }

      if (item.type === "AEGIS_STRATEGY") {
        const strategyLabel =
          item.controller.isAegisStrategyOverridden
            ? AEGIS_STRATEGY_OPTIONS.find(
                ([, v]) => v === item.controller.aegisStrategyPreview,
              )?.[0] || item.controller.aegisStrategyPreview
            : "Auto";
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={() => openAegisStrategyPicker(item.controller)}
          >
            <span className="settings-menu-label">{item.label}</span>
            <span className="controller-settings-value">{t(strategyLabel)}</span>
          </FocusableRow>
        );
      }

      if (item.type === "RESET_INPUT_MODE") {
        return (
          <FocusableRow
            key={item.type}
            isFocused={isFocused}
            onMouseEnter={onMouseEnter}
            onClick={() =>
              ipc
                .clearControllerInputMode(item.controller.id)
                .then(() => loadControllerState())
                .catch((error) => ipc.logError("Failed to reset input mode:", error))
            }
          >
            <span className="settings-menu-label">{item.label}</span>
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
          onClick={() => setSelectedControllerId(item.controller.id)}
        >
          <div className="controller-settings-device">
            <div className="controller-settings-device-header">
              <span className="settings-menu-label">{item.controller.name}</span>
              <span className="controller-settings-mode-badge">
                {item.controller.inputMode}
              </span>
            </div>
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
    [handleRefresh, loadControllerState, openAegisStrategyPicker, openControllerTester, openInputModePicker, t],
  );

  const currentDescription = useMemo(() => {
    if (!controllerState) {
      return t("Loading...");
    }

    if (!selectedController) {
      if (focusedItem?.type === "CONTROLLER") {
        return focusedItem.controller.capabilities?.length
          ? focusedItem.controller.capabilities.join(", ")
          : focusedItem.controller.name;
      }

      return t("Choose a controller to configure.");
    }

    if (focusedItem?.type === "INPUT_MODE") {
      return t(MODE_DESCRIPTIONS[selectedController.inputMode] || MODE_DESCRIPTIONS.native);
    }

    if (focusedItem?.type === "AEGIS_STRATEGY") {
      return t(
        "Override the automatic Aegis strategy for this controller. Auto lets Aegis decide based on controller family.",
      );
    }

    if (focusedItem?.type === "RESET_INPUT_MODE") {
      return t("Remove the per-controller override and return to the global default input mode.");
    }

    if (focusedItem?.type === "TEST") {
      return t("Visualize buttons and analog sticks with the current input mode.");
    }

    return t(
      STRATEGY_LABELS[selectedController.aegisStrategyPreview] ||
        HELPER_STATUS_LABELS[controllerState.helperStatus] ||
        "",
    );
  }, [controllerState, focusedItem, selectedController, t]);

  const helperStatusText = useMemo(() => {
    return getHelperStatusMessage(controllerState, t);
  }, [controllerState, t]);

  const legendItems = useMemo(
    () => [
      { button: "A", label: t("Select") },
      {
        button: "B",
        label: selectedController ? t("Back") : t("Close"),
        onClick: selectedController ? () => setSelectedControllerId(null) : onClose,
      },
    ],
    [onClose, selectedController, t],
  );

  return (
    <DialogLayout
      title={selectedController ? t(selectedController.name) : t("Controller Settings")}
      description={currentDescription}
      legendItems={legendItems}
      maxWidth="700px"
    >
      <div className="controller-settings-summary">
        {!selectedController && (
          <p>
            {t("Connected Controllers")}: {controllers.length}
          </p>
        )}
        {selectedController && (
          <p className="controller-settings-status">
            {[selectedController.family, selectedController.connectionType, `${selectedController.vendorId}:${selectedController.productId}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {!controllerState?.controllers?.length && browserControllers.length > 0 && (
          <p className="controller-settings-status">
            {t(
              "The UI can see your controller through the browser gamepad API, but the backend helper has not matched it to a Linux event device yet.",
            )}
          </p>
        )}
        {controllerState?.helperActive && (
          <p className="controller-settings-status controller-settings-status--active">
            {t("Virtual controller session active.")}
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
        focusId={selectedController ? `ControllerSettings:${selectedController.id}` : "ControllerSettings"}
      />
    </DialogLayout>
  );
};

export default ControllerSettings;
