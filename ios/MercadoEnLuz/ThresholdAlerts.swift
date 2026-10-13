import Foundation

/// Cruces ±1…5 %: el primer precio de cada sesión solo fija una referencia.
struct ThresholdAlerts {
    private var previous: [String: Double] = [:]
    private var sessions: [String: String] = [:]
    private(set) var fired: Set<String>

    init(saved: Set<String>) { fired = saved }

    mutating func resetBaseline() {
        previous.removeAll()
        sessions.removeAll()
    }

    mutating func observe(symbol: String, session: String, change: Double) -> [Int] {
        guard !session.isEmpty, change.isFinite else { return [] }
        let oldSession = sessions.updateValue(session, forKey: symbol)
        let old = previous.updateValue(change, forKey: symbol)
        if oldSession != session {
            fired = fired.filter { !$0.hasPrefix("\(symbol)|") || $0.hasPrefix("\(symbol)|\(session)|") }
            return []
        }
        guard let old else { return [] }
        var crossed: [Int] = []
        for level in 1...5 {
            let signed = change >= Double(level) && old < Double(level) ? level
                : change <= -Double(level) && old > -Double(level) ? -level : 0
            if signed != 0 && !fired.contains(key(symbol, session, signed)) { crossed.append(signed) }
        }
        return crossed
    }

    mutating func mark(symbol: String, session: String, level: Int) -> Bool {
        fired.insert(key(symbol, session, level)).inserted
    }

    private func key(_ symbol: String, _ session: String, _ level: Int) -> String {
        "\(symbol)|\(session)|\(level)"
    }
}
