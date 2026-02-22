package com.xicnet.joymixabridge

import java.net.NetworkInterface

const val WS_PORT = 20809

fun getLocalIpAddress(): String {
    try {
        for (intf in NetworkInterface.getNetworkInterfaces()) {
            for (addr in intf.inetAddresses) {
                if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                    return addr.hostAddress ?: "127.0.0.1"
                }
            }
        }
    } catch (_: Exception) {}
    return "127.0.0.1"
}

fun getWsUrl(): String = "ws://${getLocalIpAddress()}:$WS_PORT"
