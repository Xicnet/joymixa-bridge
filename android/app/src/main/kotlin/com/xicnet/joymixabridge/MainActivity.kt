package com.xicnet.joymixabridge

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.xicnet.joymixabridge.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var bridgeService: BridgeService? = null
    private var bound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as BridgeService.LocalBinder
            bridgeService = binder.getService()
            bound = true
            updateUI(bridgeService!!.getCurrentState())
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            bridgeService = null
            bound = false
        }
    }

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val json = intent?.getStringExtra(BridgeService.EXTRA_STATE_JSON) ?: return
            try {
                val obj = org.json.JSONObject(json)
                val state = BridgeState(
                    tempo = obj.optDouble("tempo", 120.0),
                    isPlaying = obj.optBoolean("isPlaying", false),
                    beat = obj.optDouble("beat", 0.0),
                    phase = obj.optDouble("phase", 0.0),
                    quantum = obj.optDouble("quantum", 4.0),
                    numPeers = obj.optInt("numPeers", 0),
                    numClients = obj.optInt("numClients", 0),
                    nextBar0Delay = obj.optDouble("nextBar0Delay", 0.0)
                )
                updateUI(state)
            } catch (_: Exception) {}
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Request notification permission on API 33+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }

        // Start and bind to service
        val serviceIntent = BridgeService.buildIntent(this)
        ContextCompat.startForegroundService(this, serviceIntent)
        bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    override fun onResume() {
        super.onResume()
        ContextCompat.registerReceiver(
            this,
            stateReceiver,
            IntentFilter(BridgeService.ACTION_STATE_UPDATE),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        if (bound) {
            updateUI(bridgeService!!.getCurrentState())
        }
    }

    override fun onPause() {
        super.onPause()
        unregisterReceiver(stateReceiver)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (bound) {
            unbindService(serviceConnection)
            bound = false
        }
    }

    private fun updateUI(state: BridgeState) {
        binding.peerCount.text = state.numPeers.toString()
        binding.tempo.text = String.format("%.1f", state.tempoRounded)
        binding.transport.text = if (state.isPlaying) "Playing" else "Stopped"
        binding.transport.setTextColor(
            ContextCompat.getColor(this,
                if (state.isPlaying) R.color.playing else R.color.stopped)
        )
        binding.clientCount.text = state.numClients.toString()
        binding.wsUrl.text = getWsUrl()
    }
}
