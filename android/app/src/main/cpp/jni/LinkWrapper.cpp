#include "LinkWrapper.h"
#include <android/log.h>
#include <chrono>

#define TAG "LinkJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// ─── Helper: attach current thread, call Kotlin listener method ───

static void callListenerMethod(LinkHandle* h, const char* methodName, const char* sig, ...) {
    if (!h || !h->jvm || !h->listenerRef) return;

    JNIEnv* env = nullptr;
    bool didAttach = false;
    int stat = h->jvm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
    if (stat == JNI_EDETACHED) {
        if (h->jvm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
            LOGE("Failed to attach thread");
            return;
        }
        didAttach = true;
    }

    jclass cls = env->GetObjectClass(h->listenerRef);
    jmethodID mid = env->GetMethodID(cls, methodName, sig);
    if (mid) {
        va_list args;
        va_start(args, sig);
        // Dispatch based on known signatures
        if (strcmp(sig, "(D)V") == 0) {
            double val = va_arg(args, double);
            env->CallVoidMethod(h->listenerRef, mid, val);
        } else if (strcmp(sig, "(Z)V") == 0) {
            int val = va_arg(args, int);  // bool promoted to int in varargs
            env->CallVoidMethod(h->listenerRef, mid, (jboolean)val);
        } else if (strcmp(sig, "(I)V") == 0) {
            int val = va_arg(args, int);
            env->CallVoidMethod(h->listenerRef, mid, (jint)val);
        }
        va_end(args);
    }

    env->DeleteLocalRef(cls);
    if (didAttach) {
        h->jvm->DetachCurrentThread();
    }
}

// ─── JNI exports ───
// Naming: Java_com_xicnet_joymixabridge_LinkSession_native*
// The handle pointer is stored as a jlong on the Kotlin side.

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeCreate(JNIEnv* env, jobject, jdouble bpm) {
    auto* h = new LinkHandle(bpm);
    env->GetJavaVM(&h->jvm);
    LOGI("Link created at %.1f BPM", bpm);
    return reinterpret_cast<jlong>(h);
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeDestroy(JNIEnv* env, jobject, jlong handle) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    h->link.enable(false);
    if (h->listenerRef) {
        env->DeleteGlobalRef(h->listenerRef);
        h->listenerRef = nullptr;
    }
    delete h;
    LOGI("Link destroyed");
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeEnable(JNIEnv*, jobject, jlong handle, jboolean enable) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    h->link.enable(enable);
    LOGI("Link %s", enable ? "enabled" : "disabled");
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeEnableStartStopSync(JNIEnv*, jobject, jlong handle, jboolean enable) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    h->link.enableStartStopSync(enable);
    LOGI("start/stop sync %s", enable ? "enabled" : "disabled");
}

JNIEXPORT jdouble JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeGetTempo(JNIEnv*, jobject, jlong handle) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return 120.0;
    auto state = h->link.captureAppSessionState();
    return state.tempo();
}

JNIEXPORT jdouble JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeGetBeat(JNIEnv*, jobject, jlong handle) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return 0.0;
    auto state = h->link.captureAppSessionState();
    return state.beatAtTime(h->link.clock().micros(), 4.0);
}

JNIEXPORT jdouble JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeGetPhase(JNIEnv*, jobject, jlong handle, jdouble quantum) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return 0.0;
    auto state = h->link.captureAppSessionState();
    return state.phaseAtTime(h->link.clock().micros(), quantum);
}

JNIEXPORT jboolean JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeIsPlaying(JNIEnv*, jobject, jlong handle) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return false;
    auto state = h->link.captureAppSessionState();
    return state.isPlaying();
}

JNIEXPORT jint JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeGetNumPeers(JNIEnv*, jobject, jlong handle) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return 0;
    return static_cast<jint>(h->link.numPeers());
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeSetTempo(JNIEnv*, jobject, jlong handle, jdouble bpm) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    auto state = h->link.captureAppSessionState();
    state.setTempo(bpm, h->link.clock().micros());
    h->link.commitAppSessionState(state);
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeSetIsPlaying(JNIEnv*, jobject, jlong handle, jboolean playing) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    auto state = h->link.captureAppSessionState();
    state.setIsPlaying(playing, h->link.clock().micros());
    h->link.commitAppSessionState(state);
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeRequestBeatAtStartPlayingTime(
        JNIEnv*, jobject, jlong handle, jdouble beat, jdouble quantum) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    auto state = h->link.captureAppSessionState();
    state.requestBeatAtStartPlayingTime(beat, quantum);
    h->link.commitAppSessionState(state);
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeForceBeatAtTime(
        JNIEnv*, jobject, jlong handle, jdouble beat, jlong time, jdouble quantum) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;
    auto state = h->link.captureAppSessionState();
    auto micros = std::chrono::microseconds(time * 1000);  // ms → μs
    state.forceBeatAtTime(beat, micros, quantum);
    h->link.commitAppSessionState(state);
}

JNIEXPORT void JNICALL
Java_com_xicnet_joymixabridge_LinkSession_nativeSetCallbacks(JNIEnv* env, jobject, jlong handle, jobject listener) {
    auto* h = reinterpret_cast<LinkHandle*>(handle);
    if (!h) return;

    // Clean up old listener
    if (h->listenerRef) {
        env->DeleteGlobalRef(h->listenerRef);
        h->listenerRef = nullptr;
    }

    if (!listener) return;
    h->listenerRef = env->NewGlobalRef(listener);

    // Tempo callback
    h->link.setTempoCallback([h](double tempo) {
        LOGI("tempo changed: %.2f", tempo);
        callListenerMethod(h, "onTempoChanged", "(D)V", tempo);
    });

    // Start/stop callback
    h->link.setStartStopCallback([h](bool isPlaying) {
        LOGI("start/stop changed: %s", isPlaying ? "playing" : "stopped");
        callListenerMethod(h, "onStartStopChanged", "(Z)V", (int)isPlaying);
    });

    // Peer count callback
    h->link.setNumPeersCallback([h](std::size_t numPeers) {
        LOGI("peers changed: %zu", numPeers);
        callListenerMethod(h, "onNumPeersChanged", "(I)V", (int)numPeers);
    });
}

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    LOGI("linkjni loaded");
    return JNI_VERSION_1_6;
}

} // extern "C"
