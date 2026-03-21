cmake_minimum_required(VERSION 3.22)
project(lgui_inputtino_harness LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

set(INPUTTINO_SOURCE_DIR "" CACHE PATH "Optional local inputtino source checkout")

if(INPUTTINO_SOURCE_DIR)
  add_subdirectory(${INPUTTINO_SOURCE_DIR} ${CMAKE_CURRENT_BINARY_DIR}/inputtino EXCLUDE_FROM_ALL)
else()
  find_package(inputtino CONFIG QUIET)
  if(NOT inputtino_FOUND)
    message(STATUS "inputtino package not found, fetching from GitHub")
    FetchContent_Declare(
      inputtino
      GIT_REPOSITORY https://github.com/games-on-whales/inputtino.git
      GIT_TAG fd136cf
    )
    FetchContent_MakeAvailable(inputtino)
  endif()
endif()

add_executable(lgui-inputtino-harness main.cpp)
target_link_libraries(lgui-inputtino-harness PRIVATE inputtino::libinputtino)
