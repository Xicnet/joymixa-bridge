package com.xicnet.joymixabridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireLocks()
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

    fun getCurrentState(): BridgeState {
        val tempo = linkSession.getTempo()
        val beat = linkSession.getBeat()
        val phase = linkSession.getPhase(LinkSession.QUANTUM)
        val quantum = LinkSession.QUANTUM
        val remainingBeats = quantum - phase
        val msPerBeat = 60000.0 / tempo
        return BridgeState(
            tempo = tempo,
            isPlaying = linkSession.isPlaying(),
            beat = beat,
            phase = phase,
            quantum = quantum,
            numPeers = linkSession.getNumPeers(),
            numClients = synchronized(clientsLock) { clients.size },
            nextBar0Delay = remainingBeats * msPerBeat
        )
    }

    // ─── Link ───

    private fun startLink() {
        linkSession.create(120.0)
        linkSession.enable()
        linkSession.enableStartStopSync(true)

        linkSession.setListener(object : LinkSession.LinkListener {
            override fun onTempoChanged(tempo: Double) {
                val rounded = Math.round(tempo * 100.0) / 100.0
                val beat = linkSession.getBeat()
                val phase = linkSession.getPhase(LinkSession.QUANTUM)
                val msg = JSONObject().apply {
                    put("type", "tempo")
                    put("tempo", rounded)
                    put("beat", beat)
                    put("phase", phase)
                    put("quantum", LinkSession.QUANTUM.toInt())
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }

            override fun onStartStopChanged(isPlaying: Boolean) {
                val msg = JSONObject().apply {
                    put("type", "playing")
                    put("isPlaying", isPlaying)
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }

            override fun onNumPeersChanged(numPeers: Int) {
                val msg = JSONObject().apply {
                    put("type", "peers")
                    put("numPeers", numPeers)
                }
                broadcast(msg.toString())
                notifyStateUpdate()
            }
        })
    }

    // ─── WebSocket Server ───

    private fun startWebSocketServer() {
        wsServer = BridgeWebSocketServer(InetSocketAddress("0.0.0.0", WS_PORT))
        wsServer!!.isReuseAddr = true
        wsServer!!.start()
        Log.i(TAG, "WS server started on port $WS_PORT")
    }

    private inner class BridgeWebSocketServer(address: InetSocketAddress)
        : WebSocketServer(address) {

        override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
            synchronized(clientsLock) {
                clients.add(conn)
            }
            Log.i(TAG, "Client connected. clients: ${synchronized(clientsLock) { clients.size }}")

            // Send hello
            val state = getCurrentState()
            val jmxBeat = getJmxBeat()
            val extra = mutableMapOf<String, Any?>()
            if (jmxBeat != null) extra["jmxBeat"] = jmxBeat
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
            Log.i(TAG, "Client set-tempo: $tempo")
            linkSession.setTempo(tempo)
            // Read back actual tempo from Link and broadcast
            val actualTempo = linkSession.getTempo()
            val beat = linkSession.getBeat()
            val phase = linkSession.getPhase(LinkSession.QUANTUM)
            val tempoMsg = JSONObject().apply {
                put("type", "tempo")
                put("tempo", actualTempo)
                put("beat", beat)
                put("phase", phase)
                put("quantum", LinkSession.QUANTUM.toInt())
            }
            broadcast(tempoMsg.toString())
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
            Log.i(TAG, "Client request-quantized-start. quantum: $quantum")
            linkSession.requestBeatAtStartPlayingTime(0.0, quantum)
            linkSession.setIsPlaying(true)
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

    // ─── 20Hz state broadcast loop ───

    private fun startStateBroadcastLoop() {
        serviceScope.launch {
            while (isActive) {
                delay(50)  // 20Hz
                val state = getCurrentState()
                val jmxBeat = getJmxBeat()
                val extra = mutableMapOf<String, Any?>(
                    "ts" to System.currentTimeMillis()
                )
                if (jmxBeat != null) extra["jmxBeat"] = jmxBeat
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

        // Wake lock — keep CPU alive for 20Hz loop
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
