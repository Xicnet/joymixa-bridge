package com.xicnet.joymixabridge

/**
 * Atomic Link state snapshot — mirrors Electron's `link.getState(quantum)`.
 * All fields come from a single `captureAppSessionState()` call on the C++
 * side, so the (beat, anchorTime) pair never phase-skews when the mesh
 * tempo ripples mid-capture.
 *
 * `timeAtBeat` is in seconds (Link clock domain); pass through unchanged
 * as `anchorTime` in bridge wire messages — the Electron bridge does the
 * same at `src/bridge.ts:865`.
 */
data class LinkState(
    val tempo: Double,
    val beat: Double,
    val phase: Double,
    val isPlaying: Boolean,
    val timeAtBeat: Double
)

class LinkSession {

    interface LinkListener {
        fun onTempoChanged(tempo: Double)
        fun onStartStopChanged(isPlaying: Boolean)
        fun onNumPeersChanged(numPeers: Int)
    }

    companion object {
        init {
            System.loadLibrary("linkjni")
        }
        const val QUANTUM = 4.0
    }

    private var handle: Long = 0L

    fun create(bpm: Double) {
        handle = nativeCreate(bpm)
    }

    fun destroy() {
        if (handle != 0L) {
            nativeDestroy(handle)
            handle = 0L
        }
    }

    fun enable() {
        if (handle != 0L) nativeEnable(handle, true)
    }

    fun disable() {
        if (handle != 0L) nativeEnable(handle, false)
    }

    fun enableStartStopSync(enable: Boolean) {
        if (handle != 0L) nativeEnableStartStopSync(handle, enable)
    }

    fun getTempo(): Double =
        if (handle != 0L) nativeGetTempo(handle) else 120.0

    fun getBeat(): Double =
        if (handle != 0L) nativeGetBeat(handle) else 0.0

    fun getPhase(quantum: Double = QUANTUM): Double =
        if (handle != 0L) nativeGetPhase(handle, quantum) else 0.0

    fun isPlaying(): Boolean =
        if (handle != 0L) nativeIsPlaying(handle) else false

    fun getNumPeers(): Int =
        if (handle != 0L) nativeGetNumPeers(handle) else 0

    fun setTempo(bpm: Double) {
        if (handle != 0L) nativeSetTempo(handle, bpm)
    }

    fun setIsPlaying(playing: Boolean) {
        if (handle != 0L) nativeSetIsPlaying(handle, playing)
    }

    fun requestBeatAtStartPlayingTime(beat: Double, quantum: Double) {
        if (handle != 0L) nativeRequestBeatAtStartPlayingTime(handle, beat, quantum)
    }

    fun forceBeatAtTime(beat: Double, time: Long, quantum: Double) {
        if (handle != 0L) nativeForceBeatAtTime(handle, beat, time, quantum)
    }

    /**
     * Atomic snapshot — mirrors Electron's `link.getState(quantum)`.
     * The five returned fields are read from ONE C++-side
     * captureAppSessionState() call. See LinkWrapper.cpp::nativeGetState.
     */
    fun getState(quantum: Double = QUANTUM): LinkState {
        if (handle == 0L) return LinkState(120.0, 0.0, 0.0, false, 0.0)
        val arr = nativeGetState(handle, quantum)
            ?: return LinkState(120.0, 0.0, 0.0, false, 0.0)
        return LinkState(
            tempo = arr[0],
            beat = arr[1],
            phase = arr[2],
            isPlaying = arr[3] > 0.5,
            timeAtBeat = arr[4]
        )
    }

    /** timeAtBeat helper — seconds, in Link clock domain. */
    fun timeAtBeat(beat: Double, quantum: Double): Double =
        if (handle != 0L) nativeTimeAtBeat(handle, beat, quantum) else 0.0

    /**
     * Mirrors Electron's `link.setIsPlayingAndRequestBeatAtTime` —
     * starts/stops transport at `timeMicros` AND requests `beat` to map
     * to that time. Atomic on the C++ side.
     */
    fun setIsPlayingAndRequestBeatAtTime(isPlaying: Boolean, timeMicros: Long, beat: Double, quantum: Double) {
        if (handle != 0L) nativeSetIsPlayingAndRequestBeatAtTime(handle, isPlaying, timeMicros, beat, quantum)
    }

    fun setListener(listener: LinkListener?) {
        if (handle != 0L) nativeSetCallbacks(handle, listener)
    }

    // --- JNI declarations ---

    private external fun nativeCreate(bpm: Double): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeEnable(handle: Long, enable: Boolean)
    private external fun nativeEnableStartStopSync(handle: Long, enable: Boolean)
    private external fun nativeGetTempo(handle: Long): Double
    private external fun nativeGetBeat(handle: Long): Double
    private external fun nativeGetPhase(handle: Long, quantum: Double): Double
    private external fun nativeIsPlaying(handle: Long): Boolean
    private external fun nativeGetNumPeers(handle: Long): Int
    private external fun nativeSetTempo(handle: Long, bpm: Double)
    private external fun nativeSetIsPlaying(handle: Long, playing: Boolean)
    private external fun nativeRequestBeatAtStartPlayingTime(handle: Long, beat: Double, quantum: Double)
    private external fun nativeForceBeatAtTime(handle: Long, beat: Double, time: Long, quantum: Double)
    private external fun nativeSetCallbacks(handle: Long, listener: LinkListener?)
    private external fun nativeGetState(handle: Long, quantum: Double): DoubleArray?
    private external fun nativeTimeAtBeat(handle: Long, beat: Double, quantum: Double): Double
    private external fun nativeSetIsPlayingAndRequestBeatAtTime(
        handle: Long, isPlaying: Boolean, timeMicros: Long, beat: Double, quantum: Double
    )
}
