import SwiftUI

@main
struct LinkBridgeApp: App {
    @StateObject private var server = WebSocketServer()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server)
                .onAppear { server.start() }
        }
    }
}

struct ContentView: View {
    @ObservedObject var server: WebSocketServer

    var body: some View {
        VStack(spacing: 20) {
            Text("LinkBridge")
                .font(.largeTitle)
                .fontWeight(.bold)

            if server.isRunning {
                Text(server.localAddress)
                    .font(.system(.body, design: .monospaced))
            } else {
                Text("Starting...")
                    .foregroundColor(.secondary)
            }

            Text("Clients: \(server.clientCount)")
                .font(.title2)
        }
    }
}
