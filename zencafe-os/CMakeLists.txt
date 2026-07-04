cmake_minimum_required(VERSION 3.20)
project(ZenCafeOS)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# Find Qt6
find_package(Qt6 REQUIRED COMPONENTS
    Core
    Gui
    Widgets
    Network
    Sql
)

# Source files placeholder structure
# set(SOURCES
#     src/shell/main.cpp
#     src/shell/shell.cpp
#     src/launcher/launcher.cpp
#     src/lockdown/lockdown.cpp
#     src/monitor/watchdog.cpp
#     src/config/config_manager.cpp
# )

# Executable
# add_executable(ZenCafeOS ${SOURCES})

# Link Qt6
# target_link_libraries(ZenCafeOS
#     Qt6::Core
#     Qt6::Gui
#     Qt6::Widgets
#     Qt6::Network
#     Qt6::Sql
# )

# Platform-specific libraries
# if(WIN32)
#     target_link_libraries(ZenCafeOS
#         advapi32       # Registry functions
#         user32         # Window/keyboard hooks
#         winuser        # User API
#     )
# endif()

message(STATUS "ZenCafe OS build configuration")
message(STATUS "  C++ Standard: 17")
message(STATUS "  Qt Version: 6.7")
message(STATUS "  Target: Windows 10/11")
