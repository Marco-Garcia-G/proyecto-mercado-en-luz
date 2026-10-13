import Foundation

@main struct CoreTests {
    static func main() {
        let on = [UInt8](GoveePacket.command([0x33, 0x01, 0x01]))
        precondition(on.count == 20 && on[19] == 0x33)
        let segments = [UInt8](GoveePacket.segments(red: 255, green: 0, blue: 0, mask: 0x4001))
        precondition(segments[12] == 1 && segments[13] == 0x40)
        precondition(segments.reduce(0, ^) == 0)

        var alerts = ThresholdAlerts(saved: [])
        precondition(alerts.observe(symbol: "AAPL", session: "2026-09-25", change: 2.4).isEmpty)
        precondition(alerts.observe(symbol: "AAPL", session: "2026-09-25", change: 3.1) == [3])
        precondition(alerts.mark(symbol: "AAPL", session: "2026-09-25", level: 3))
        precondition(alerts.observe(symbol: "AAPL", session: "2026-09-25", change: 2.9).isEmpty)
        precondition(alerts.observe(symbol: "AAPL", session: "2026-09-25", change: 3.2).isEmpty)
        print("Paquetes H617A y cruces de umbral correctos")
    }
}
