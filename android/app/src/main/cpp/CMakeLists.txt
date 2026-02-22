cmake_minimum_required(VERSION 3.22.1)
project(joymixabridge CXX)

set(CMAKE_CXX_STANDARD 17)
set(LINK_DIR ${CMAKE_SOURCE_DIR}/link)

# Ableton Link as a header-only interface library
add_library(AbletonLink INTERFACE)
target_include_directories(AbletonLink INTERFACE
    ${LINK_DIR}/include
    ${LINK_DIR}/modules/asio-standalone/asio/include
)
target_compile_definitions(AbletonLink INTERFACE
    LINK_PLATFORM_LINUX=1
    ASIO_STANDALONE=1
)

# JNI shared library
add_library(linkjni SHARED jni/LinkWrapper.cpp)
target_link_libraries(linkjni AbletonLink android log)
