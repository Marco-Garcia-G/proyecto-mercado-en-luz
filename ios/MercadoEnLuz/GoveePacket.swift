import Foundation

enum GoveePacket {
    static func command(_ payload: [UInt8]) -> Data {
        precondition(payload.count <= 19)
        var packet = [UInt8](repeating: 0, count: 20)
        for (index, byte) in payload.enumerated() { packet[index] = byte }
        packet[19] = packet.prefix(19).reduce(0, ^)
        return Data(packet)
    }

    static func segments(red: UInt8, green: UInt8, blue: UInt8, mask: Int) -> Data {
        precondition(mask >= 0 && mask <= 0x7fff)
        var packet = [UInt8](command([0x33, 0x05, 0x15, 0x01, red, green, blue]))
        packet[12] = UInt8(mask & 0xff)
        packet[13] = UInt8((mask >> 8) & 0xff)
        packet[19] = packet.prefix(19).reduce(0, ^)
        return Data(packet)
    }
}
