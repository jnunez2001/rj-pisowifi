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

# Qt loads SQL drivers (QPSQL included) as runtime plugins from a "sqldrivers"
# subfolder next to the executable - this is NOT the same as the regular DLL
# dependencies that get auto-deployed after linking, so it needs an explicit copy step.
# Without this, QSqlDatabase::addDatabase("QPSQL") fails at runtime with
# "Driver not loaded" even though the build itself succeeds - found by actually
# running the compiled binary, not something visible from the build log alone.
#
# Uses vcpkg's own VCPKG_INSTALLED_DIR/VCPKG_TARGET_TRIPLET variables directly, rather
# than deriving the path from a target's LOCATION property - that property isn't
# reliable for multi-config generators like Visual Studio (first attempt at this fix
# resolved to the wrong path, missing the debug/ segment, and failed at build time).
set(_vcpkg_bin_dir "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/$<$<CONFIG:Debug>:debug/>")

add_custom_command(TARGET ZenCafeServer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ZenCafeServer>/sqldrivers"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${_vcpkg_bin_dir}Qt6/plugins/sqldrivers/qsqlpsql$<$<CONFIG:Debug>:d>.dll"
        "$<TARGET_FILE_DIR:ZenCafeServer>/sqldrivers/"
    COMMENT "Deploying QPSQL Qt SQL driver plugin (not covered by normal DLL dependency deployment)"
)

# The QPSQL plugin above has its OWN dependencies (libpq, and libpq's own dependencies:
# OpenSSL for encrypted connections, lz4 for compression) - these are transitive
# dependencies of the plugin, not of ZenCafeServer.exe directly, so the normal automatic
# DLL-dependency deployment never discovers or copies them either. Found the same way as
# the plugin itself: the build succeeded, but the compiled program failed at runtime with
# "Driver not loaded" until this was traced down and fixed. Placed in the executable's own
# directory (not the sqldrivers subfolder) since that's where Windows looks first for a
# loaded plugin's own dependencies.
add_custom_command(TARGET ZenCafeServer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${_vcpkg_bin_dir}bin/libpq.dll"
        "${_vcpkg_bin_dir}bin/libssl-3-x64.dll"
        "${_vcpkg_bin_dir}bin/libcrypto-3-x64.dll"
        "${_vcpkg_bin_dir}bin/lz4$<$<CONFIG:Debug>:d>.dll"
        "$<TARGET_FILE_DIR:ZenCafeServer>/"
    COMMENT "Deploying libpq and its own runtime dependencies (needed by the QPSQL plugin, not visible to normal dependency deployment)"
)

message(STATUS "ZenCafe Server build configuration")
message(STATUS "  C++ Standard: 17")
message(STATUS "  Qt Version: 6.7")
message(STATUS "  Database: PostgreSQL (via Qt6::Sql QPSQL driver)")
message(STATUS "  Current scope: migration runner only (--migrate)")
