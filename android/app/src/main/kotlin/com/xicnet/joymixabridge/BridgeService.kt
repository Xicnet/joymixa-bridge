package com.xicnet.joymixabridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.net.InetSocketAddress

class BridgeService : Service() {

    companion object {
        private const val TAG = "BridgeService"
        const val CHANNEL_ID = "joymixabridge_channel"
        const val NOTIFICATION_ID = 1
        const val ACTION_STATE_UPDATE = "com.xicnet.joymixabridge.STATE_UPDATE"
        const val EXTRA_STATE_JSON = "state_json"

        fun buildIntent(context: Context): Intent = Intent(context, BridgeService::class.java)
    }

    inner class LocalBinder : Binder() {
        fun getService(): BridgeService = this@BridgeService
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Link
    private val linkSession = LinkSession()

    // WebSocket
    private var wsServer: BridgeWebSocketServer? = null
    private val clients = mutableSetOf<WebSocket>()
    private val clientsLock = Any()
    private val clientLoopBeats = mutableMapOf<WebSocket, Double>()


    // Locks
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    // Native audio output latency measurement (ms)
    @Volatile private var measuredOutputLatency: Double? = null
    private var latencyMethod: String? = null
    // Full tier-by-tier diagnostic log for frontend visibility
    private var latencyDiagnostics: String? = null

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireLocks()
        // Latency measurement runs in background — doesn't block WS server or game boot.
        // measuredOutputLatency is null until measurement completes; clients fall back to
        // browser APIs until then.
        serviceScope.launch(Dispatchers.IO) { measureAudioOutputLatency() }
        startLink()
        startWebSocketServer()
        startStateBroadcastLoop()
        Log.i(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(getCurrentState()))
        return START_STICKY
    }

    override fun onDestroy() {
        serviceScope.cancel()
        wsServer?.stop(500)
        linkSession.setListener(null)
        linkSession.disable()
        linkSession.destroy()
        releaseLocks()
        Log.i(TAG, "Service destroyed")
        super.onDestroy()
    }

    /**
     * Capture an atomic Link state snapshot and wrap it in a BridgeState.
     * Mirrors Electron's `getLinkState()` (src/bridge.ts:847) — the (beat,
     * phase, tempo, isPlaying, anchorTime) tuple comes from a SINGLE
     * captureAppSessionState() call so no field can phase-skew with
     * another. `ts` is the bridge wallclock, set per call.
     */
    fun getCurrentState(): BridgeState {
        val s = linkSession.getState(LinkSession.QUANTUM)
        val quantum = LinkSession.QUANTUM
        val remainingBeats = quantum - s.phase
        val msPerBeat = 60000.0 / s.tempo
        return BridgeState(
            tempo = s.tempo,
            isPlaying = s.isPlaying,
            beat = s.beat,
            phase = s.phase,
            quantum = quantum,
            numPeers = linkSession.getNumPeers(),
            numClients = synchronized(clientsLock) { clients.size },
            nextBar0Delay = remainingBeats * msPerBeat,
            anchorTime = s.timeAtBeat,
            ts = System.currentTimeMillis()
        )
    }

    // ─── Audio latency measurement ───

    /**
     * Measure the native audio output latency using a 3-tier strategy:
     *
     * Tier 1: AudioTrack.getLatency() via reflection — HIDDEN API (@hide, "unsupported"
     *         tier). Direct HAL query: instant, no warmup, no timing artifacts. Same
     *         pattern used by Google's Media3/ExoPlayer and VLC. Returns total pipeline
     *         latency (HAL + buffer + mixer). Works on Android 9-15. The @UnsupportedAppUsage
     *         annotation has no maxTargetSdk — least-restrictive hidden tier. Google can't
     *         block it without breaking their own Media3 player. try/catch ensures graceful
     *         degradation if ever restricted.
     *
     * Tier 2: Silent AudioTrack probe + getTimestamp() — PUBLIC API, +/- 1ms accuracy.
     *         Creates a temporary AudioTrack, writes ~500ms of silence to warm it up,
     *         then reads AudioTimestamp to compute pipeline latency from frame delta.
     *         Indirect measurement with more moving parts, but fully public.
     *
     * Tier 3: Buffer estimation from AudioManager properties — PUBLIC API, rough estimate
     *         (~10-30ms error). Uses HAL buffer size * 2 (double-buffering) as pipeline
     *         approximation.
     *
     * Runs on Dispatchers.IO — does not block service startup or game boot.
     */
    private fun measureAudioOutputLatency() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val sampleRateStr = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
        val framesPerBufStr = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)
        val sampleRate = sampleRateStr?.toIntOrNull() ?: 48000
        val framesPerBuf = framesPerBufStr?.toIntOrNull() ?: 256

        val diag = StringBuilder()
        diag.append("sr=$sampleRate fpb=$framesPerBuf | ")

        // Tier 1: AudioTrack.getLatency() via reflection (direct HAL query, same as Media3)
        // Returns pipeline-only latency (raw getLatency minus track buffer, like ExoPlayer)
        val reflectionResult = measureViaGetLatencyReflection(sampleRate)
        if (reflectionResult != null) {
            diag.append("T1(pipeline)=${"%.0f".format(reflectionResult)}ms USED")
            measuredOutputLatency = reflectionResult
            latencyMethod = "AudioTrack.getLatency"
            Log.i(TAG, "Audio latency: ${"%.0f".format(reflectionResult)}ms (AudioTrack.getLatency pipeline, sr=$sampleRate)")
        } else {
            diag.append("T1(getLatency)=FAIL")
        }

        // Always try tier 2 for diagnostics (even if tier 1 succeeded)
        val timestampResult = measureViaTimestampProbe(sampleRate)
        if (timestampResult != null) {
            diag.append(" | T2(timestamp)=${"%.1f".format(timestampResult)}ms")
            if (reflectionResult == null) {
                diag.append(" USED")
                measuredOutputLatency = timestampResult
                latencyMethod = "AudioTimestamp"
                Log.i(TAG, "Audio latency: ${"%.1f".format(timestampResult)}ms (AudioTimestamp probe, sr=$sampleRate)")
            }
        } else {
            diag.append(" | T2(timestamp)=FAIL")
        }

        // Tier 3: Buffer estimation (always computed for reference)
        val pipelineFrames = framesPerBuf * 2
        val bufferMs = pipelineFrames.toDouble() / sampleRate * 1000.0
        diag.append(" | T3(buffer)=${"%.1f".format(bufferMs)}ms")
        if (reflectionResult == null && timestampResult == null) {
            diag.append(" USED")
            measuredOutputLatency = bufferMs
            latencyMethod = "buffer-estimate"
            Log.i(TAG, "Audio latency: ${"%.1f".format(bufferMs)}ms (buffer estimate ${framesPerBuf}*2/$sampleRate, fallback)")
        }

        // Cross-validation: when T1 and T2 disagree by >2x, T1 is measuring a
        // different audio path than Chrome uses (e.g. Samsung Exynos legacy mixer).
        // Fall back to T3-based estimate which is path-independent.
        if (reflectionResult != null && timestampResult != null) {
            val ratio = if (reflectionResult > timestampResult)
                reflectionResult / timestampResult else timestampResult / reflectionResult
            if (ratio > 2.0) {
                val crossVal = bufferMs * 3.0  // conservative: 3× HAL double-buffer estimate
                diag.append(" | XVAL: T1/T2 ratio=${"%.1f".format(ratio)}x, override=${
                    "%.1f".format(crossVal)}ms (T3×3)")
                measuredOutputLatency = crossVal
                latencyMethod = "cross-validated"
                Log.w(TAG, "Cross-validation: T1=${"%.0f".format(reflectionResult)}ms T2=${
                    "%.0f".format(timestampResult)}ms disagree (ratio=${"%.1f".format(ratio)}x), " +
                    "using T3×3=${"%.1f".format(crossVal)}ms")
            } else {
                diag.append(" | XVAL: T1/T2 agree (ratio=${"%.1f".format(ratio)}x), keeping T1")
            }
        }

        latencyDiagnostics = diag.toString()
        Log.i(TAG, "Latency diagnostics: $latencyDiagnostics")
    }

    /**
     * Tier 2: Create a silent AudioTrack, write silence to warm it up, then use
     * the public AudioTrack.getTimestamp() API to compute output latency.
     *
     * Note: this measures the latency of a *separate* AudioTrack, not Chrome's
     * actual AAudio path. On Samsung Exynos devices the value can be wildly
     * inflated due to extra AudioFlinger buffering. Used for diagnostics only;
     * cross-validation logic decides whether to trust it.
     *
     * Returns latency in ms, or null if timestamps are not available.
     */
    private fun measureViaTimestampProbe(sampleRate: Int): Double? {
        var track: AudioTrack? = null
        try {
            val minBuf = AudioTrack.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) return null

            @Suppress("DEPRECATION")
            track = AudioTrack(
                AudioManager.STREAM_MUSIC,
                sampleRate,
                AudioFormat.CHANNEL_OUT_STEREO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf,
                AudioTrack.MODE_STREAM
            )

            // Write silence to warm up the audio pipeline.
            // minBuf is in bytes; for 16-bit stereo, one frame = 4 bytes = 2 shorts.
            val samplesPerBuffer = minBuf / 2  // total shorts in buffer
            val silence = ShortArray(samplesPerBuffer)
            track.play()

            var totalFramesWritten = 0L
            val warmupFrames = sampleRate / 2  // ~500ms worth of frames
            while (totalFramesWritten < warmupFrames) {
                val framesToWrite = minOf(
                    (samplesPerBuffer / 2).toLong(),  // shorts / 2 channels = frames
                    warmupFrames - totalFramesWritten
                )
                val shortsToWrite = (framesToWrite * 2).toInt()  // stereo: 2 shorts per frame
                val written = track.write(silence, 0, shortsToWrite)
                if (written <= 0) break
                totalFramesWritten += written / 2  // shorts written / 2 channels = frames
            }

            // Poll for a valid timestamp (may take a few attempts)
            val timestamp = AudioTimestamp()
            var latencyMs: Double? = null
            for (attempt in 0 until 10) {
                Thread.sleep(50)
                if (track.getTimestamp(timestamp)) {
                    val elapsedNanos = System.nanoTime() - timestamp.nanoTime
                    val extrapolatedPresented = timestamp.framePosition +
                        (elapsedNanos * sampleRate / 1_000_000_000.0)
                    val pendingFrames = totalFramesWritten - extrapolatedPresented
                    if (pendingFrames >= 0) {
                        latencyMs = (pendingFrames / sampleRate.toDouble()) * 1000.0
                        // Sanity check: reject implausible values
                        if (latencyMs in 1.0..500.0) break
                        latencyMs = null
                    }
                }
            }

            track.stop()
            return latencyMs
        } catch (e: Exception) {
            Log.d(TAG, "Timestamp probe failed: ${e.message}")
            return null
        } finally {
            track?.release()
        }
    }

    /**
     * Tier 1: AudioTrack.getLatency() via reflection.
     * Hidden API (unsupported tier) — same pattern used by Google's Media3/ExoPlayer.
     * Direct HAL query: instant, no warmup, no timing artifacts.
     *
     * AOSP returns: mAfLatency + (1000 * mFrameCount) / mSampleRate
     * where mFrameCount is THIS track's buffer — not Chrome's buffer.
     * We subtract the track buffer contribution to isolate mAfLatency
     * (the shared AudioFlinger→HAL→speaker pipeline), same as ExoPlayer:
     *   latencyUs = getLatency() * 1000 - bufferSizeUs
     *
     * Returns pipeline latency in ms (excluding track buffer), or null if unavailable.
     */
    private fun measureViaGetLatencyReflection(sampleRate: Int): Double? {
        try {
            val minBuf = AudioTrack.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) return null

            @Suppress("DEPRECATION")
            val track = AudioTrack(
                AudioManager.STREAM_MUSIC,
                sampleRate,
                AudioFormat.CHANNEL_OUT_STEREO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf,
                AudioTrack.MODE_STREAM
            )
            try {
                val method = AudioTrack::class.java.getMethod("getLatency")
                val rawLatencyMs = method.invoke(track) as Int
                if (rawLatencyMs in 1..500) {
                    // Subtract this track's buffer duration to isolate mAfLatency.
                    // minBuf is in bytes; for 16-bit stereo, frame = 4 bytes.
                    val frameSizeBytes = 4 // 2 bytes/sample * 2 channels
                    val trackBufferFrames = minBuf / frameSizeBytes
                    val trackBufferMs = trackBufferFrames.toDouble() / sampleRate * 1000.0
                    val pipelineMs = rawLatencyMs.toDouble() - trackBufferMs
                    Log.d(TAG, "getLatency raw=${rawLatencyMs}ms - trackBuf=${"%.1f".format(trackBufferMs)}ms (${trackBufferFrames}fr) = pipeline=${"%.1f".format(pipelineMs)}ms")
                    return if (pipelineMs >= 1.0) pipelineMs else rawLatencyMs.toDouble()
                }
            } catch (e: Exception) {
                Log.d(TAG, "AudioTrack.getLatency() not available: ${e.message}")
            } finally {
                track.release()
            }
        } catch (e: Exception) {
            Log.d(TAG, "AudioTrack creation failed: ${e.message}")
        }
        return null
    }

    // ─── Link ───

    private fun startLink() {
        linkSession.create(120.0)
        linkSession.enable()
        linkSession.enableStartStopSync(true)

        linkSession.setListener(object : LinkSession.LinkListener {
            override fun onTempoChanged(tempo: Double) {
                // Atomic snapshot — beat, phase, anchorTime all derive from
                // the same captureAppSessionState() call (T21 fix). Mirrors
                // Electron's setTempoCallback at src/bridge.ts:642.
                val s = linkSession.getState(LinkSession.QUANTUM)
                val rounded = Math.round(s.tempo * 100.0) / 100.0
                val ts = System.currentTimeMillis()
                val msg = JSONObject().apply {
                    put("type", "tempo")
                    put("tempo", rounded)
                    put("beat", s.beat)
                    put("phase", s.phase)
                    put("quantum", LinkSession.QUANTUM.toInt())
                    put("anchorTime", s.timeAtBeat)
                    put("ts", ts)
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }

            override fun onStartStopChanged(isPlaying: Boolean) {
                val msg = JSONObject().apply {
                    put("type", "playing")
                    put("isPlaying", isPlaying)
                    put("ts", System.currentTimeMillis())
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }

            override fun onNumPeersChanged(numPeers: Int) {
                val msg = JSONObject().apply {
                    put("type", "peers")
                    put("numPeers", numPeers)
                    put("ts", System.currentTimeMillis())
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }
        })
    }

    // ─── WebSocket Server ───

    private fun startWebSocketServer() {
        // Bundle variant: the WebView connects over ws://127.0.0.1, so bind loopback
        // only (matches Electron — HTTPS pages can't reach a LAN-IP ws://). Bridge-only
        // variant serves a browser on another device, so it must bind all interfaces.
        val bindHost = if (BuildConfig.INCLUDE_GAME) "127.0.0.1" else "0.0.0.0"
        wsServer = BridgeWebSocketServer(InetSocketAddress(bindHost, WS_PORT))
        wsServer!!.isReuseAddr = true
        wsServer!!.start()
        Log.i(TAG, "WS server started on $bindHost:$WS_PORT")
    }

    private inner class BridgeWebSocketServer(address: InetSocketAddress)
        : WebSocketServer(address) {

        override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
            synchronized(clientsLock) {
                clients.add(conn)
            }
            Log.i(TAG, "Client connected. clients: ${synchronized(clientsLock) { clients.size }}")

            // Send hello with atomic state (anchorTime + ts inside BridgeState.toJson)
            val state = getCurrentState()
            val jmxBeat = getJmxBeat()
            val extra = mutableMapOf<String, Any?>()
            if (jmxBeat != null) extra["jmxBeat"] = jmxBeat
            measuredOutputLatency?.let { extra["measuredOutputLatency"] = it }
            extra["latencyMethod"] = latencyMethod ?: "none"
            latencyDiagnostics?.let { extra["latencyDiagnostics"] = it }
            conn.send(state.toJson("hello", extra))

            notifyStateUpdate()
        }

        override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
            synchronized(clientsLock) {
                clients.remove(conn)
                clientLoopBeats.remove(conn)
            }
            Log.i(TAG, "Client disconnected. clients: ${synchronized(clientsLock) { clients.size }}")
            notifyStateUpdate()
        }

        override fun onMessage(conn: WebSocket, message: String?) {
            if (message == null) return
            val msg = try {
                JSONObject(message)
            } catch (_: Exception) {
                Log.e(TAG, "JSON parse error")
                return
            }
            handleClientMessage(msg, conn)
        }

        override fun onError(conn: WebSocket?, ex: Exception?) {
            Log.e(TAG, "WS error: ${ex?.message}")
        }

        override fun onStart() {
            Log.i(TAG, "WS server onStart")
        }
    }

    // ─── Client message handling (port of bridge.ts handleClientMessage) ───

    private fun handleClientMessage(msg: JSONObject, sender: WebSocket) {
        val type = msg.optString("type", "")

        // relay: forward payload to all OTHER clients
        if (type == "relay") {
            val payload = msg.optJSONObject("payload") ?: return
            val relayMsg = JSONObject().apply {
                put("type", "relay")
                put("payload", payload)
            }
            broadcastExcept(sender, relayMsg.toString())
            return
        }

        // loop-beat: store per-client
        if (type == "loop-beat") {
            val beat = msg.optDouble("beat", Double.NaN)
            if (!beat.isNaN()) {
                synchronized(clientsLock) {
                    clientLoopBeats[sender] = beat
                }
            }
            return
        }

        // Commands that require Link
        if (type == "set-tempo") {
            val tempo = msg.optDouble("tempo", Double.NaN)
            if (tempo.isNaN() || !tempo.isFinite() || tempo <= 0) return
            // Optional atTime: shared hostTimeAtOutput (Link-clock seconds) so all
            // peers apply together. Absent => apply-now. Mirrors src/bridge.ts set-tempo.
            val atTime = msg.optDouble("atTime", Double.NaN)
            if (!atTime.isNaN() && atTime.isFinite() && atTime > 0) {
                Log.i(TAG, "Client set-tempo: $tempo atTime=$atTime")
                linkSession.setTempo(tempo, atTime)
            } else {
                Log.i(TAG, "Client set-tempo: $tempo (no atTime, apply now)")
                linkSession.setTempo(tempo)
            }
            // Atomic readback — same pattern as Electron's set-tempo handler
            // (src/bridge.ts:933): one captureAppSessionState() call, all
            // fields from the same snapshot.
            val s = linkSession.getState(LinkSession.QUANTUM)
            val tempoMsg = JSONObject().apply {
                put("type", "tempo")
                put("tempo", s.tempo)
                put("beat", s.beat)
                put("phase", s.phase)
                put("quantum", LinkSession.QUANTUM.toInt())
                put("anchorTime", s.timeAtBeat)
                put("ts", System.currentTimeMillis())
            }
            broadcastExcept(sender, tempoMsg.toString())
        }

        if (type == "play") {
            Log.i(TAG, "Client play")
            linkSession.setIsPlaying(true)
        }

        if (type == "stop") {
            Log.i(TAG, "Client stop")
            linkSession.setIsPlaying(false)
        }

        if (type == "request-quantized-start") {
            val quantum = if (msg.has("quantum") && !msg.optDouble("quantum", Double.NaN).isNaN())
                msg.getDouble("quantum") else LinkSession.QUANTUM
            // Match Electron pattern (src/bridge.ts:951-954):
            //   const time = link.getTimeForBeat(link.getBeat(), quantum);
            //   link.setIsPlayingAndRequestBeatAtTime(true, time, 0, quantum);
            // requestBeatAtStartPlayingTime had subtly different semantics —
            // setIsPlayingAndRequestBeatAtTime atomically maps beat=0 to
            // the time at the current beat, giving deterministic bar-0
            // alignment when crossing the start.
            val s = linkSession.getState(quantum)
            val timeSec = linkSession.timeAtBeat(s.beat, quantum)
            val timeMicros = (timeSec * 1_000_000.0).toLong()
            Log.i(TAG, "Client request-quantized-start. quantum=$quantum beat=${s.beat} timeMicros=$timeMicros")
            linkSession.setIsPlayingAndRequestBeatAtTime(true, timeMicros, 0.0, quantum)
        }

        if (type == "force-beat-at-time") {
            val beat = msg.optDouble("beat", Double.NaN)
            val time = msg.optLong("time", -1L)
            val quantum = msg.optDouble("quantum", Double.NaN)
            if (!beat.isNaN() && time >= 0 && !quantum.isNaN()) {
                Log.i(TAG, "Client force-beat-at-time: $beat $time $quantum")
                linkSession.forceBeatAtTime(beat, time, quantum)
            }
        }
    }

    // ─── jmxBeat (port of bridge.ts getJmxBeat) ───

    private fun getJmxBeat(): Double? {
        synchronized(clientsLock) {
            for ((ws, beat) in clientLoopBeats) {
                if (ws.isOpen) return beat
            }
        }
        return null
    }

    // ─── 100Hz state broadcast loop (parity with Electron stateHz=100) ───

    private fun startStateBroadcastLoop() {
        serviceScope.launch {
            while (isActive) {
                delay(10)  // 100Hz — matches Electron at src/bridge.ts:781
                // BridgeState.toJson includes anchorTime + ts (set in
                // getCurrentState via System.currentTimeMillis). Don't
                // duplicate ts in extra — would override toJson's value.
                val state = getCurrentState()
                val jmxBeat = getJmxBeat()
                val extra = mutableMapOf<String, Any?>()
                if (jmxBeat != null) extra["jmxBeat"] = jmxBeat
                measuredOutputLatency?.let { extra["measuredOutputLatency"] = it }
                extra["latencyMethod"] = latencyMethod ?: "none"
                broadcast(state.toJson("state", extra))
            }
        }
    }

    // ─── Broadcast helpers ───

    private fun broadcast(message: String) {
        synchronized(clientsLock) {
            for (ws in clients) {
                if (ws.isOpen) {
                    try { ws.send(message) } catch (_: Exception) {}
                }
            }
        }
    }

    private fun broadcastExcept(sender: WebSocket, message: String) {
        synchronized(clientsLock) {
            for (ws in clients) {
                if (ws !== sender && ws.isOpen) {
                    try { ws.send(message) } catch (_: Exception) {}
                }
            }
        }
    }

    // ─── Notification ───

    private fun notifyStateUpdate() {
        val state = getCurrentState()

        // Update notification
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(state))

        // Broadcast to MainActivity
        val intent = Intent(ACTION_STATE_UPDATE).apply {
            setPackage(packageName)
            putExtra(EXTRA_STATE_JSON, state.toJson("state"))
        }
        sendBroadcast(intent)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Joymixa Bridge",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Ableton Link bridge status"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(state: BridgeState): Notification {
        val transport = if (state.isPlaying) "Playing" else "Stopped"
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Joymixa Bridge")
            .setContentText("${state.tempoRounded} BPM \u2022 $transport \u2022 ${state.numPeers} peers")
            .setSubText("${state.numClients} clients \u2022 ${getWsUrl()}")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    // ─── Locks ───

    private fun acquireLocks() {
        // Multicast lock — required for Ableton Link UDP multicast on Android
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifiManager.createMulticastLock("joymixabridge.multicast").apply {
            setReferenceCounted(false)
            acquire()
        }
        Log.i(TAG, "Multicast lock acquired")

        // Wake lock — keep CPU alive for 100Hz state broadcast loop
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "joymixabridge::bridge"
        ).apply {
            acquire()
        }
        Log.i(TAG, "Wake lock acquired")
    }

    private fun releaseLocks() {
        multicastLock?.let {
            if (it.isHeld) it.release()
            multicastLock = null
        }
        wakeLock?.let {
            if (it.isHeld) it.release()
            wakeLock = null
        }
        Log.i(TAG, "Locks released")
    }
}
