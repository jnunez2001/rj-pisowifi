cmake_minimum_required(VERSION 3.20)
project(ZenCafeServer)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# Find dependencies
# Only Core + Sql for now - this build covers the migration runner only (see
# PROGRESS.md "What's Next"). Network/Concurrent will be added back once
# api_server.cpp and the other service modules are actually built, not before -
# no point finding packages this specific build doesn't yet use.
find_package(Qt6 REQUIRED COMPONENTS
    Core
    Sql
)

# Source files - migration runner is the first real service code in this project
# (everything else in src/ is still header-only stubs).
set(SOURCES
    src/main.cpp
    src/database/migration_runner.cpp
)

add_executable(ZenCafeServer ${SOURCES})

# Database access goes through Qt6::Sql's QPSQL driver, which links libpq internally -
# no separate PostgreSQL client library (e.g. libpqxx) needed on top of that.
target_link_libraries(ZenCafeServer
    Qt6::Core
    Qt6::Sql
)

message(STATUS "ZenCafe Server build configuration")
message(STATUS "  C++ Standard: 17")
message(STATUS "  Qt Version: 6.7")
message(STATUS "  Database: PostgreSQL (via Qt6::Sql QPSQL driver)")
message(STATUS "  Current scope: migration runner only (--migrate)")
