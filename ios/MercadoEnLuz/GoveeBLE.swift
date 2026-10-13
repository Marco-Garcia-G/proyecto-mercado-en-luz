import CoreBluetooth
import Foundation

@MainActor final class GoveeBLE: NSObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    static let supportedModels = ["H617A", "H617C", "H6053", "H6072", "H6102", "H6199"]
    private let writeID = CBUUID(string: "00010203-0405-0607-0809-0a0b0c0d2b11")
    private let notifyID = CBUUID(string: "00010203-0405-0607-0809-0a0b0c0d2b10")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writer: CBCharacteristic?
    private var notifier: CBCharacteristic?
    private var ready = false
    private var powerReply: Bool?
    private var carouselTask: Task<Void, Never>?
    private var carouselColors: [Int] = []
    private var carouselRunning = false
    private var scanCandidates: [UUID: (peripheral: CBPeripheral, rssi: Int)] = [:]
    private var scanWindow: Task<Void, Never>?
    var mayScan = true
    var onConnectionEvent: (() -> Void)?
    var onCarouselFrame: ((Int, Int, Int) -> Void)?
    private(set) var powerKnown = false
    private(set) var isOn = false
    private(set) var error = ""
    private(set) var selectedModel = UserDefaults.standard.string(forKey: "govee_model") ?? "H617A"

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "MercadoEnLuz.GoveeBLE"])
    }

    func selectModel(_ model: String) throws {
        guard Self.supportedModels.contains(model) else { throw BLEError.message("Modelo no admitido") }
        guard model != selectedModel else { return }
        stopCarousel()
        central.stopScan()
        scanWindow?.cancel()
        scanWindow = nil
        scanCandidates.removeAll()
        if let peripheral { central.cancelPeripheralConnection(peripheral) }
        peripheral = nil
        writer = nil
        notifier = nil
        ready = false
        powerKnown = false
        selectedModel = model
        UserDefaults.standard.set(model, forKey: "govee_model")
        error = ""
        if central.state == .poweredOn { connectSavedPeripheral() }
        onConnectionEvent?()
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { connectSavedPeripheral() }
        else {
            ready = false
            powerKnown = false
            error = unavailableMessage(central.state)
        }
        onConnectionEvent?()
    }

    private func unavailableMessage(_ state: CBManagerState) -> String {
        switch state {
        case .unauthorized: return "Concede permiso de Bluetooth para conectar la tira"
        case .unsupported: return "Este dispositivo no admite Bluetooth Low Energy"
        default: return "Activa Bluetooth en el iPhone"
        }
    }

    private func savedIdentifierKeys() -> [String] {
        selectedModel == "H617A" ? ["govee_identifier_H617A", "h617a_identifier"] : ["govee_identifier_\(selectedModel)"]
    }

    /// Olvida una tira recordada que ya no aparece (otra tira, restablecida o de otro dispositivo)
    /// para que el siguiente intento vuelva a buscar en lugar de esperar indefinidamente.
    private func forgetUnreachablePeripheral() {
        guard let stale = peripheral, stale.state != .connected else { return }
        central.cancelPeripheralConnection(stale)
        peripheral = nil
        for key in savedIdentifierKeys() { UserDefaults.standard.removeObject(forKey: key) }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        if let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first {
            guard (restored.name ?? "").uppercased().contains(selectedModel) else {
                central.cancelPeripheralConnection(restored)
                return
            }
            peripheral = restored
            restored.delegate = self
            if restored.state == .connected { restored.discoverServices(nil) }
            else { central.connect(restored) }
        }
    }

    private func connectSavedPeripheral() {
        guard peripheral == nil,
              let saved = UserDefaults.standard.string(forKey: "govee_identifier_\(selectedModel)")
                ?? (selectedModel == "H617A" ? UserDefaults.standard.string(forKey: "h617a_identifier") : nil),
              let id = UUID(uuidString: saved),
              let found = central.retrievePeripherals(withIdentifiers: [id]).first else { return }
        peripheral = found
        found.delegate = self
        central.connect(found)
    }

    func centralManager(_ central: CBCentralManager, didDiscover found: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? found.name ?? ""
        guard peripheral == nil, name.uppercased().contains(selectedModel) else { return }
        // 127 significa «RSSI no disponible»; cuenta como la señal más débil.
        let rssi = RSSI.intValue == 127 ? -127 : RSSI.intValue
        if rssi > (scanCandidates[found.identifier]?.rssi ?? Int.min) {
            scanCandidates[found.identifier] = (found, rssi)
        }
        // Con varias tiras del mismo modelo cerca, espera un instante y elige la más próxima.
        guard scanWindow == nil else { return }
        scanWindow = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self?.connectStrongestCandidate()
        }
    }

    private func connectStrongestCandidate() {
        central.stopScan()
        scanWindow = nil
        let best = scanCandidates.values.max { $0.rssi < $1.rssi }?.peripheral
        scanCandidates.removeAll()
        guard peripheral == nil, let best else { return }
        peripheral = best
        best.delegate = self
        UserDefaults.standard.set(best.identifier.uuidString, forKey: "govee_identifier_\(selectedModel)")
        central.connect(best)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == self.peripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        error = ""
        peripheral.delegate = self
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        ready = false
        self.error = error?.localizedDescription ?? "No se pudo conectar con la \(selectedModel)"
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == self.peripheral?.identifier else { return }
        ready = false
        writer = nil
        notifier = nil
        powerKnown = false
        self.error = error?.localizedDescription ?? "Bluetooth desconectado"
        if central.state == .poweredOn { central.connect(peripheral) }
        onConnectionEvent?()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil else { self.error = error!.localizedDescription; return }
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics([writeID, notifyID], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { self.error = error!.localizedDescription; return }
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == writeID { writer = characteristic }
            if characteristic.uuid == notifyID {
                notifier = characteristic
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
        if writer != nil && notifier?.isNotifying == true {
            ready = true
            self.error = ""
            onConnectionEvent?()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if characteristic.uuid == notifyID && error == nil && characteristic.isNotifying && writer != nil {
            ready = true
            self.error = ""
            onConnectionEvent?()
        } else if let error { self.error = error.localizedDescription }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == notifyID, let bytes = characteristic.value,
              bytes.count >= 3 else { return }
        let data = [UInt8](bytes)
        if data[0] == 0xaa && data[1] == 0x01 {
            powerReply = data[2] == 1
            powerKnown = true
            isOn = data[2] == 1
        }
    }

    private func pause(_ milliseconds: UInt64) async {
        try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }

    private func ensureReady() async throws {
        if ready { return }
        for _ in 0..<50 where central.state == .unknown || central.state == .resetting {
            await pause(100)
        }
        guard central.state == .poweredOn else { throw BLEError.message(unavailableMessage(central.state)) }
        if peripheral == nil {
            guard mayScan else {
                throw BLEError.message("Abre la app para encontrar la \(selectedModel) por primera vez")
            }
            if !central.isScanning { central.scanForPeripherals(withServices: nil) }
        } else if peripheral?.state != .connected {
            central.connect(peripheral!)
        }
        for _ in 0..<120 {
            if ready { return }
            await pause(100)
        }
        central.stopScan()
        scanWindow?.cancel()
        scanWindow = nil
        scanCandidates.removeAll()
        forgetUnreachablePeripheral()
        throw BLEError.message("No encuentro la \(selectedModel). Acerca el iPhone a la tira")
    }

    private func write(_ data: Data) throws {
        guard ready, let peripheral, let writer else { throw BLEError.message("Bluetooth desconectado") }
        peripheral.writeValue(data, for: writer, type: .withoutResponse)
    }

    func queryPower() async throws -> Bool {
        try await ensureReady()
        powerReply = nil
        try write(GoveePacket.command([0xaa, 0x01, 0x00]))
        for _ in 0..<25 {
            if let powerReply { return powerReply }
            await pause(100)
        }
        throw BLEError.message("La tira no respondió a la consulta")
    }

    func setPower(_ desired: Bool) async throws {
        stopCarousel()
        try await ensureReady()
        for _ in 0..<3 {
            for _ in 0..<3 {
                try write(GoveePacket.command([0x33, 0x01, desired ? 1 : 0]))
                await pause(70)
            }
            await pause(380)
            if (try? await queryPower()) == desired { return }
        }
        throw BLEError.message("La tira no confirmó el cambio de estado")
    }

    func showPalette(_ palette: [(Int, Int)]) async throws {
        guard try await queryPower() else { return }
        try write(GoveePacket.command([0x33, 0x04, 100]))
        await pause(300)
        for (rgb, mask) in palette where mask != 0 {
            try write(GoveePacket.segments(red: UInt8((rgb >> 16) & 255),
                green: UInt8((rgb >> 8) & 255), blue: UInt8(rgb & 255), mask: mask))
            await pause(400)
        }
    }

    func flash(mask: Int, rgb: Int, seconds: Int) async throws {
        guard !carouselRunning, mask != 0, try await queryPower() else { return }
        let lit = GoveePacket.segments(red: UInt8((rgb >> 16) & 255),
            green: UInt8((rgb >> 8) & 255), blue: UInt8(rgb & 255), mask: mask)
        for _ in 0..<seconds {
            try write(GoveePacket.segments(red: 0, green: 0, blue: 0, mask: mask))
            await pause(500)
            try write(lit)
            await pause(500)
        }
    }

    func setCarousel(colors: [Int], enabled: Bool) {
        carouselColors = colors
        if !enabled || colors.isEmpty { stopCarousel(); return }
        guard carouselTask == nil else { return }
        carouselRunning = true
        carouselTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard try await self.queryPower() else { self.stopCarousel(); return }
                try self.write(GoveePacket.command([0x33, 0x04, 100]))
                await self.pause(250)
                var windowStart = 0
                var shift = 0
                while self.carouselRunning && !Task.isCancelled {
                    let colors = self.carouselColors
                    if colors.isEmpty { break }
                    let active = min(15, colors.count)
                    var route: [Int] = []
                    for index in 0..<active {
                        let count = 15 / active + (index < 15 % active ? 1 : 0)
                        route += Array(repeating: (windowStart + index) % colors.count, count: count)
                    }
                    for _ in 0..<15 where self.carouselRunning && !Task.isCancelled {
                        var masks: [Int: Int] = [:]
                        for position in 0..<15 {
                            let asset = route[(position - shift + 15) % 15]
                            masks[colors[asset], default: 0] |= 1 << position
                        }
                        self.onCarouselFrame?(route[(15 - shift) % 15], shift, windowStart)
                        for (rgb, mask) in masks.sorted(by: { $0.key < $1.key }) {
                            try self.write(GoveePacket.segments(red: UInt8((rgb >> 16) & 255),
                                green: UInt8((rgb >> 8) & 255), blue: UInt8(rgb & 255), mask: mask))
                        }
                        await self.pause(1200)
                        shift = (shift + 1) % 15
                    }
                    if colors.count > 15 { windowStart = (windowStart + 1) % colors.count }
                }
            } catch { self.error = error.localizedDescription }
            self.carouselRunning = false
            self.carouselTask = nil
            self.onCarouselFrame?(-1, -1, 0)
        }
    }

    func stopCarousel() {
        carouselRunning = false
        carouselTask?.cancel()
        carouselTask = nil
        onCarouselFrame?(-1, -1, 0)
    }

    enum BLEError: LocalizedError {
        case message(String)
        var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
    }
}
