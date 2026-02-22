import Foundation
import Network

final class WebSocketServer: ObservableObject {
    private var listener: NWListener?
    private var connections: [Int: NWConnection] = [:]
    private var nextID = 0

    @Published var clientCount = 0
    @Published var localAddress: String = "—"
    @Published var isRunning = false

    let port: UInt16 = 20809

    func start() {
        let params = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }

        do {
            listener = try NWListener(using: params, on: nwPort)
        } catch {
            print("Failed to create listener: \(error)")
            return
        }

        listener?.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    self?.isRunning = true
                    self?.updateLocalAddress()
                case .failed, .cancelled:
                    self?.isRunning = false
                default:
                    break
                }
            }
        }

        listener?.newConnectionHandler = { [weak self] conn in
            self?.handleNewConnection(conn)
        }

        listener?.start(queue: .main)
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for conn in connections.values {
            conn.cancel()
        }
        connections.removeAll()
        DispatchQueue.main.async {
            self.clientCount = 0
            self.isRunning = false
        }
    }

    private func handleNewConnection(_ connection: NWConnection) {
        let id = nextID
        nextID += 1
        connections[id] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                DispatchQueue.main.async { self.clientCount = self.connections.count }
                self.sendHello(to: connection)
                self.receiveLoop(connection: connection, id: id)
            case .failed, .cancelled:
                self.connections.removeValue(forKey: id)
                DispatchQueue.main.async { self.clientCount = self.connections.count }
            default:
                break
            }
        }

        connection.start(queue: .main)
    }

    private func sendHello(to connection: NWConnection) {
        let hello: [String: Any] = [
            "type": "hello",
            "tempo": 120.0,
            "isPlaying": false,
            "beat": 0.0,
            "phase": 0.0,
            "quantum": 4,
            "numPeers": 0,
            "numClients": connections.count,
            "nextBar0Delay": 0.0
        ]
        sendJSON(hello, to: connection)
    }

    func sendJSON(_ dict: [String: Any], to connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in }))
    }

    func broadcast(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])
        for conn in connections.values {
            conn.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in }))
        }
    }

    private func receiveLoop(connection: NWConnection, id: Int) {
        connection.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self = self else { return }
            if let error = error {
                print("Receive error (\(id)): \(error)")
                connection.cancel()
                return
            }
            // For Step 2, we just ignore incoming messages.
            // Step 3 will parse and handle commands.
            if content != nil {
                // Continue receiving
                self.receiveLoop(connection: connection, id: id)
            }
        }
    }

    private func updateLocalAddress() {
        var address = "unknown"
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr {
            var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
            while let current = ptr {
                let flags = Int32(current.pointee.ifa_flags)
                if (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
                   current.pointee.ifa_addr.pointee.sa_family == UInt8(AF_INET) {
                    let name = String(cString: current.pointee.ifa_name)
                    if name == "en0" || name.hasPrefix("en") {
                        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        if getnameinfo(current.pointee.ifa_addr, socklen_t(current.pointee.ifa_addr.pointee.sa_len),
                                       &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                            address = String(cString: hostname)
                            if name == "en0" { break }
                        }
                    }
                }
                ptr = current.pointee.ifa_next
            }
            freeifaddrs(ifaddr)
        }
        DispatchQueue.main.async {
            self.localAddress = "ws://\(address):\(self.port)"
        }
    }
}
