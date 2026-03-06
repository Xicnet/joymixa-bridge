/**
 * CoreAudio output latency query — Node.js NAPI addon.
 *
 * Queries the default output device for:
 *   - kAudioDevicePropertyLatency        (device pipeline frames)
 *   - kAudioStreamPropertyLatency        (stream pipeline frames)
 *   - kAudioDevicePropertySafetyOffset   (safety frames)
 *   - kAudioDevicePropertyBufferFrameSize (buffer frames)
 *   - kAudioDevicePropertyNominalSampleRate
 *
 * Returns an object { latencyMs, sampleRate, deviceLatency, streamLatency,
 *   safetyOffset, bufferFrames } or null if measurement fails.
 *
 * Only compiled on macOS. On other platforms, getOutputLatency() returns null.
 */

#include <napi.h>

#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>

static bool getUInt32Property(AudioObjectID id,
                              AudioObjectPropertySelector selector,
                              AudioObjectPropertyScope scope,
                              UInt32 *out) {
    AudioObjectPropertyAddress addr = {
        selector,
        scope,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = sizeof(UInt32);
    return AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, out) == noErr;
}

static bool getFloat64Property(AudioObjectID id,
                               AudioObjectPropertySelector selector,
                               AudioObjectPropertyScope scope,
                               Float64 *out) {
    AudioObjectPropertyAddress addr = {
        selector,
        scope,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = sizeof(Float64);
    return AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, out) == noErr;
}

#endif // __APPLE__

Napi::Value GetOutputLatency(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

#ifndef __APPLE__
    return env.Null();
#else
    // Get default output device
    AudioDeviceID deviceID = 0;
    {
        AudioObjectPropertyAddress addr = {
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        UInt32 size = sizeof(AudioDeviceID);
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr,
                                       &size, &deviceID) != noErr) {
            return env.Null();
        }
    }

    // Device latency (frames)
    UInt32 deviceLatency = 0;
    if (!getUInt32Property(deviceID, kAudioDevicePropertyLatency,
                           kAudioDevicePropertyScopeOutput, &deviceLatency)) {
        return env.Null();
    }

    // Safety offset (frames)
    UInt32 safetyOffset = 0;
    if (!getUInt32Property(deviceID, kAudioDevicePropertySafetyOffset,
                           kAudioDevicePropertyScopeOutput, &safetyOffset)) {
        return env.Null();
    }

    // Buffer frame size
    UInt32 bufferFrames = 0;
    if (!getUInt32Property(deviceID, kAudioDevicePropertyBufferFrameSize,
                           kAudioObjectPropertyScopeGlobal, &bufferFrames)) {
        return env.Null();
    }

    // Sample rate
    Float64 sampleRate = 0;
    if (!getFloat64Property(deviceID, kAudioDevicePropertyNominalSampleRate,
                            kAudioObjectPropertyScopeGlobal, &sampleRate) ||
        sampleRate <= 0) {
        return env.Null();
    }

    // Stream latency — get first output stream
    UInt32 streamLatency = 0;
    {
        AudioObjectPropertyAddress addr = {
            kAudioDevicePropertyStreams,
            kAudioDevicePropertyScopeOutput,
            kAudioObjectPropertyElementMain
        };
        UInt32 streamsSize = 0;
        if (AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nullptr,
                                           &streamsSize) == noErr &&
            streamsSize >= sizeof(AudioStreamID)) {
            int count = streamsSize / sizeof(AudioStreamID);
            AudioStreamID *streams = new AudioStreamID[count];
            if (AudioObjectGetPropertyData(deviceID, &addr, 0, nullptr,
                                           &streamsSize, streams) == noErr) {
                AudioObjectPropertyAddress sAddr = {
                    kAudioStreamPropertyLatency,
                    kAudioObjectPropertyScopeGlobal,
                    kAudioObjectPropertyElementMain
                };
                UInt32 sSize = sizeof(UInt32);
                AudioObjectGetPropertyData(streams[0], &sAddr, 0, nullptr,
                                           &sSize, &streamLatency);
            }
            delete[] streams;
        }
    }

    double totalFrames = (double)(deviceLatency + streamLatency +
                                  safetyOffset + bufferFrames);
    double latencyMs = (totalFrames / sampleRate) * 1000.0;

    Napi::Object result = Napi::Object::New(env);
    result.Set("latencyMs", Napi::Number::New(env, latencyMs));
    result.Set("sampleRate", Napi::Number::New(env, sampleRate));
    result.Set("deviceLatency", Napi::Number::New(env, (double)deviceLatency));
    result.Set("streamLatency", Napi::Number::New(env, (double)streamLatency));
    result.Set("safetyOffset", Napi::Number::New(env, (double)safetyOffset));
    result.Set("bufferFrames", Napi::Number::New(env, (double)bufferFrames));
    return result;

#endif // __APPLE__
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getOutputLatency",
                Napi::Function::New(env, GetOutputLatency));
    return exports;
}

NODE_API_MODULE(coreaudio_latency, Init)
