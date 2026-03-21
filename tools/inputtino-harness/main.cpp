#include <inputtino/input.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>

namespace {

using JoypadVariant =
    std::variant<inputtino::XboxOneJoypad, inputtino::PS5Joypad, inputtino::SwitchJoypad>;

struct HarnessState {
  JoypadVariant pad;
  std::string profile;
  std::uint32_t buttons = 0;
  float ls_x = 0.0F;
  float ls_y = 0.0F;
  float rs_x = 0.0F;
  float rs_y = 0.0F;
  std::uint8_t lt = 0;
  std::uint8_t rt = 0;
};

std::string normalize_token(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}

short normalize_stick_axis(float value) {
  const auto clamped = std::clamp(value, -1.0F, 1.0F);
  if (clamped >= 0.0F) {
    return static_cast<short>(std::lround(clamped * 32767.0F));
  }
  return static_cast<short>(std::lround(clamped * 32768.0F));
}

std::optional<JoypadVariant> create_pad(const std::string &profile) {
  const auto normalized = normalize_token(profile);

  if (normalized == "XBOX" || normalized == "XBOX_ONE") {
    auto result = inputtino::XboxOneJoypad::create(
        {.name = "LGUI Test XboxOne", .vendor_id = 0x045E, .product_id = 0x02EA, .version = 0x0408});
    if (!result) {
      std::cerr << result.getErrorMessage() << '\n';
      return std::nullopt;
    }
    return JoypadVariant(std::move(*result));
  }

  if (normalized == "PS5" || normalized == "DUALSENSE") {
    auto result = inputtino::PS5Joypad::create(
        {.name = "LGUI Test DualSense", .vendor_id = 0x054C, .product_id = 0x0CE6, .version = 0x8111});
    if (!result) {
      std::cerr << result.getErrorMessage() << '\n';
      return std::nullopt;
    }
    return JoypadVariant(std::move(*result));
  }

  if (normalized == "SWITCH" || normalized == "NINTENDO") {
    auto result = inputtino::SwitchJoypad::create(
        {.name = "LGUI Test Switch", .vendor_id = 0x057E, .product_id = 0x2009, .version = 0x8111});
    if (!result) {
      std::cerr << result.getErrorMessage() << '\n';
      return std::nullopt;
    }
    return JoypadVariant(std::move(*result));
  }

  std::cerr << "Unsupported profile: " << profile << '\n';
  return std::nullopt;
}

std::optional<std::uint32_t> resolve_button_mask(const std::string &button_name) {
  static const std::unordered_map<std::string, std::uint32_t> button_map = {
      {"A", inputtino::Joypad::A},
      {"B", inputtino::Joypad::B},
      {"X", inputtino::Joypad::X},
      {"Y", inputtino::Joypad::Y},
      {"LB", inputtino::Joypad::LEFT_BUTTON},
      {"RB", inputtino::Joypad::RIGHT_BUTTON},
      {"L1", inputtino::Joypad::LEFT_BUTTON},
      {"R1", inputtino::Joypad::RIGHT_BUTTON},
      {"BACK", inputtino::Joypad::BACK},
      {"SELECT", inputtino::Joypad::BACK},
      {"START", inputtino::Joypad::START},
      {"GUIDE", inputtino::Joypad::HOME},
      {"HOME", inputtino::Joypad::HOME},
      {"LS", inputtino::Joypad::LEFT_STICK},
      {"RS", inputtino::Joypad::RIGHT_STICK},
      {"DPAD_UP", inputtino::Joypad::DPAD_UP},
      {"DPAD_DOWN", inputtino::Joypad::DPAD_DOWN},
      {"DPAD_LEFT", inputtino::Joypad::DPAD_LEFT},
      {"DPAD_RIGHT", inputtino::Joypad::DPAD_RIGHT},
  };

  const auto normalized = normalize_token(button_name);
  const auto iterator = button_map.find(normalized);
  if (iterator == button_map.end()) {
    return std::nullopt;
  }

  return iterator->second;
}

std::optional<std::uint32_t> resolve_profile_button_mask(const std::string &profile, const std::string &button_name) {
  auto normalized = normalize_token(button_name);
  const auto normalized_profile = normalize_token(profile);

  // Keep matrix commands stable across emulated hardware by mapping to the
  // same physical face-button positions for each profile.
  if (normalized_profile == "PS5" || normalized_profile == "DUALSENSE") {
    if (normalized == "X") {
      normalized = "Y";
    } else if (normalized == "Y") {
      normalized = "X";
    }
  } else if (normalized_profile == "SWITCH" || normalized_profile == "NINTENDO") {
    if (normalized == "A") {
      normalized = "B";
    } else if (normalized == "B") {
      normalized = "A";
    }
  }

  return resolve_button_mask(normalized);
}

void apply_state(HarnessState &state) {
  std::visit(
      [&](auto &pad) {
        pad.set_pressed_buttons(state.buttons);
        pad.set_stick(inputtino::Joypad::LS, normalize_stick_axis(state.ls_x), normalize_stick_axis(state.ls_y));
        pad.set_stick(inputtino::Joypad::RS, normalize_stick_axis(state.rs_x), normalize_stick_axis(state.rs_y));
        pad.set_triggers(state.lt, state.rt);
      },
      state.pad);
}

bool handle_command(HarnessState &state, const std::string &line) {
  std::istringstream stream(line);
  std::string command;
  stream >> command;
  command = normalize_token(command);

  if (command.empty()) {
    return true;
  }

  if (command == "QUIT") {
    return false;
  }

  if (command == "PRESS" || command == "RELEASE") {
    std::string button_name;
    stream >> button_name;
    const auto button_mask = resolve_profile_button_mask(state.profile, button_name);
    if (!button_mask) {
      std::cerr << "Unknown button: " << button_name << '\n';
      return true;
    }

    if (command == "PRESS") {
      state.buttons |= *button_mask;
    } else {
      state.buttons &= ~(*button_mask);
    }

    apply_state(state);
    return true;
  }

  if (command == "STICK") {
    std::string side;
    float x = 0.0F;
    float y = 0.0F;
    stream >> side >> x >> y;
    side = normalize_token(side);

    if (side == "LS") {
      state.ls_x = x;
      state.ls_y = y;
    } else if (side == "RS") {
      state.rs_x = x;
      state.rs_y = y;
    } else {
      std::cerr << "Unknown stick: " << side << '\n';
      return true;
    }

    apply_state(state);
    return true;
  }

  if (command == "TRIGGERS") {
    int left = 0;
    int right = 0;
    stream >> left >> right;
    state.lt = static_cast<std::uint8_t>(std::clamp(left, 0, 255));
    state.rt = static_cast<std::uint8_t>(std::clamp(right, 0, 255));
    apply_state(state);
    return true;
  }

  if (command == "RESET") {
    state.buttons = 0;
    state.ls_x = 0.0F;
    state.ls_y = 0.0F;
    state.rs_x = 0.0F;
    state.rs_y = 0.0F;
    state.lt = 0;
    state.rt = 0;
    apply_state(state);
    return true;
  }

  std::cerr << "Unknown command: " << command << '\n';
  return true;
}

} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "Usage: lgui-inputtino-harness <xbox|ps5|switch>\n";
    return EXIT_FAILURE;
  }

  auto pad = create_pad(argv[1]);
  if (!pad) {
    return EXIT_FAILURE;
  }

  HarnessState state{.pad = std::move(*pad), .profile = argv[1]};
  apply_state(state);

  std::cout << "READY" << std::endl;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (!handle_command(state, line)) {
      break;
    }
  }

  return EXIT_SUCCESS;
}
