cmake_minimum_required(VERSION 3.20)
project(ZenCafeServer)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# Find dependencies
find_package(Qt6 REQUIRED COMPONENTS
    Core
    Network
    Sql
    Concurrent
)

find_package(PostgreSQL REQUIRED)

# Source files placeholder structure
# set(SOURCES
#     src/main.cpp
#     src/api/api_server.cpp
#     src/database/database_manager.cpp
#     src/auth/auth_service.cpp
#     src/sessions/session_manager.cpp
#     src/games/game_service.cpp
#     src/analytics/analytics_service.cpp
#     src/admin/admin_service.cpp
#     src/billing/billing_service.cpp
# )

# Executable
# add_executable(ZenCafeServer ${SOURCES})

# Link Qt6 and PostgreSQL
# target_link_libraries(ZenCafeServer
#     Qt6::Core
#     Qt6::Network
#     Qt6::Sql
#     Qt6::Concurrent
#     pq          # PostgreSQL client library
# )

message(STATUS "ZenCafe Server build configuration")
message(STATUS "  C++ Standard: 17")
message(STATUS "  Qt Version: 6.7")
message(STATUS "  Database: PostgreSQL")
message(STATUS "  API: REST + WebSocket")
