/**
 * WASAPI default-render-endpoint latency query — Node.js NAPI addon.
 *
 * Queries shared-mode device-period and mix-format on the default render endpoint:
 *   - IAudioClient::GetMixFormat            (sample rate)
 *   - IAudioClient::GetDevicePeriod         (default scheduling period, hns)
 *   - IMMDevice::OpenPropertyStore →
 *     PKEY_AudioEndpoint_FormFactor         (best-effort, for Bluetooth heuristic)
 *
 * No stream is opened. IAudioClient::Initialize is intentionally NOT called: it
 * would open a new shared-mode stream separate from Chrome's, and any post-Initialize
 * query (GetStreamLatency, GetBufferSize) would describe the ghost stream rather
 * than the OS audio path apps actually use. GetMixFormat and GetDevicePeriod both
 * work pre-Initialize.
 *
 * Returns an object { latencyMs, sampleRate, devicePeriod, streamLatency,
 *   bufferMultiplier, formFactor? } or null if measurement fails.
 *
 * Only compiled-as-a-real-addon on Windows. On other platforms, getOutputLatency()
 * returns null. Mirrors the pattern of native/coreaudio-latency/coreaudio_latency.cc.
 */

#include <napi.h>

#ifdef _WIN32
// INITGUID must be defined exactly once before including headers that declare
// PROPERTYKEY constants. Without it, PKEY_AudioEndpoint_FormFactor is declared
// (extern) but the GUID definition is never emitted, producing LNK2001 at link
// time. The conventional alternative is to link mmdevapi.lib / wmcodecdspuuid.lib;
// INITGUID keeps the dependency surface contained to the header set already in use.
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>

// Hns (100-nanosecond units) → milliseconds.
static const double HNS_PER_MS = 10000.0;

// Mirrors the Linux PipeWire fallback ×2 rationale (bridge.ts measureViaPipeWire):
// the OS audio path double-buffers (one period being filled, one being consumed),
// so real pipeline latency ≥ 2× the scheduling period.
static const double BUFFER_MULTIPLIER = 2.0;

#endif // _WIN32

Napi::Value GetOutputLatency(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

#ifndef _WIN32
    return env.Null();
#else
    // Hoist all locals before the first `goto cleanup` so MSVC doesn't reject jumps
    // over initialization.
    HRESULT hr = S_OK;
    bool comInitialized = false;
    bool needsUninit = false;

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    WAVEFORMATEX* mixFormat = nullptr;
    IPropertyStore* props = nullptr;

    REFERENCE_TIME defaultPeriod = 0;
    REFERENCE_TIME minPeriod = 0;

    Napi::Value rv = env.Null();

    // CoInitializeEx — MTA for non-UI worker threads (NAPI main thread has no
    // apartment by default). Tolerate RPC_E_CHANGED_MODE (another apartment is
    // already on this thread): proceed without re-init AND without uninit.
    // Tolerate S_FALSE (already initialized to the same apartment): we still owe
    // a CoUninitialize to balance the refcount.
    hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (hr == RPC_E_CHANGED_MODE) {
        comInitialized = true;
        needsUninit = false;
    } else if (SUCCEEDED(hr)) {
        comInitialized = true;
        needsUninit = true; // S_OK and S_FALSE both require Uninit
    } else {
        return env.Null();
    }

    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator),
                          reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr) || !enumerator) goto cleanup;

    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr) || !device) goto cleanup;

    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(&client));
    if (FAILED(hr) || !client) goto cleanup;

    hr = client->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat || mixFormat->nSamplesPerSec == 0) goto cleanup;

    hr = client->GetDevicePeriod(&defaultPeriod, &minPeriod);
    if (FAILED(hr) || defaultPeriod <= 0) goto cleanup;

    {
        const double sampleRate = static_cast<double>(mixFormat->nSamplesPerSec);
        const double periodMs = static_cast<double>(defaultPeriod) / HNS_PER_MS;
        const double latencyMs = periodMs * BUFFER_MULTIPLIER;

        Napi::Object result = Napi::Object::New(env);
        result.Set("latencyMs", Napi::Number::New(env, latencyMs));
        result.Set("sampleRate", Napi::Number::New(env, sampleRate));
        result.Set("devicePeriod", Napi::Number::New(env, periodMs));
        // streamLatency is always 0 in v1 — querying it requires Initialize, which
        // would open a ghost stream. Documented in the spec as supplementary.
        result.Set("streamLatency", Napi::Number::New(env, 0.0));
        result.Set("bufferMultiplier", Napi::Number::New(env, BUFFER_MULTIPLIER));

        // Bluetooth-form-factor probe — best-effort. Failure here doesn't void the
        // result; we just omit the formFactor key and let the wrapper assume non-BT.
        if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props)) && props) {
            PROPVARIANT pv;
            PropVariantInit(&pv);
            if (SUCCEEDED(props->GetValue(PKEY_AudioEndpoint_FormFactor, &pv)) &&
                pv.vt == VT_UI4) {
                result.Set("formFactor",
                           Napi::Number::New(env, static_cast<double>(pv.uintVal)));
            }
            PropVariantClear(&pv);
        }

        rv = result;
    }

cleanup:
    if (props) { props->Release(); props = nullptr; }
    if (mixFormat) { CoTaskMemFree(mixFormat); mixFormat = nullptr; }
    if (client) { client->Release(); client = nullptr; }
    if (device) { device->Release(); device = nullptr; }
    if (enumerator) { enumerator->Release(); enumerator = nullptr; }
    if (comInitialized && needsUninit) {
        CoUninitialize();
    }
    return rv;

#endif // _WIN32
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getOutputLatency",
                Napi::Function::New(env, GetOutputLatency));
    return exports;
}

NODE_API_MODULE(wasapi_latency, Init)
