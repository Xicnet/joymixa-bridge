package com.xicnet.joymixabridge

import org.json.JSONObject

data class BridgeState(
    val tempo: Double = 120.0,
    val isPlaying: Boolean = false,
    val beat: Double = 0.0,
    val phase: Double = 0.0,
    val quantum: Double = 4.0,
    val numPeers: Int = 0,
    val numClients: Int = 0,
    val nextBar0Delay: Double = 0.0,
    /** Link timeAtBeat (seconds, Link clock domain) — anchorTime in wire format. */
    val anchorTime: Double = 0.0,
    /** Bridge wallclock at message construction (System.currentTimeMillis()). */
    val ts: Long = 0L
) {
    /** Round tempo to 2 decimal places, same as desktop bridge. */
    val tempoRounded: Double get() = Math.round(tempo * 100.0) / 100.0

    fun toJson(type: String, extra: Map<String, Any?> = emptyMap()): String {
        val obj = JSONObject()
        obj.put("type", type)
        obj.put("tempo", tempoRounded)
        obj.put("isPlaying", isPlaying)
        obj.put("beat", beat)
        obj.put("phase", phase)
        obj.put("quantum", quantum.toInt())
        obj.put("numPeers", numPeers)
        obj.put("numClients", numClients)
        obj.put("nextBar0Delay", nextBar0Delay)
        obj.put("anchorTime", anchorTime)
        obj.put("ts", ts)
        for ((k, v) in extra) {
            if (v != null) obj.put(k, v)
        }
        return obj.toString()
    }
}
