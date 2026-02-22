#pragma once
#include <jni.h>
#include <ableton/Link.hpp>

struct LinkHandle {
    ableton::Link link;
    JavaVM* jvm;
    jobject listenerRef;  // Global ref to Kotlin LinkListener

    LinkHandle(double bpm) : link(bpm), jvm(nullptr), listenerRef(nullptr) {}
};
