import Foundation

@MainActor final class LocalAPI {
    static let shared = LocalAPI()
    private let defaults = UserDefaults.standard
    private let provider = QuoteProvider()
    let ble = GoveeBLE()
    private let averageSymbol = "PORTFOLIO"
    private var portfolio: [[String: Any]] = []
    private var carousel: [[String: Any]] = []
    private var quotes: [String: [String: Any]] = [:]
    private var pro: [String: Any] = [:]
    private var revision = 1
    private var lastFetch: String?
    private var lastLED: String?
    private var marketError = ""
    private var bluetoothError = ""
    private var lastAlert: String?
    private var alertsEnabled = false
    private var alerts: ThresholdAlerts
    private var carouselEnabled = false
    private var carouselPosition = -1
    private var carouselWindowStart = 0
    private var carouselCurrent: String?
    private var busy = false
    private var refreshing = false
    private var refreshTask: Task<Void, Never>?
    private var lastPalette = ""

    private init() {
        alerts = ThresholdAlerts(saved: Set(defaults.stringArray(forKey: "alert_fired") ?? []))
        portfolio = Self.readArray(defaults, key: "portfolio") ?? Self.initialPortfolio()
        carousel = Self.readArray(defaults, key: "carousel") ?? []
        quotes = Self.readDictionary(defaults, key: "quote_cache") as? [String: [String: Any]] ?? [:]
        for symbol in quotes.keys { quotes[symbol]?["stale"] = true }
        pro = Self.readDictionary(defaults, key: "pro") ?? Self.defaultPro()
        revision = max(1, defaults.integer(forKey: "portfolio_revision"))
        alertsEnabled = defaults.bool(forKey: "alerts_enabled")
        carouselEnabled = defaults.bool(forKey: "carousel_enabled") && !carousel.isEmpty
        ble.onConnectionEvent = { [weak self] in
            guard let self else { return }
            Task {
                do { _ = try await self.ble.queryPower(); self.bluetoothError = "" }
                catch { self.bluetoothError = error.localizedDescription }
                await self.refresh()
            }
        }
        ble.onCarouselFrame = { [weak self] index, position, start in
            guard let self else { return }
            self.carouselPosition = position
            self.carouselWindowStart = start
            self.carouselCurrent = index >= 0 && index < self.carousel.count
                ? self.carousel[index]["symbol"] as? String : nil
        }
    }

    func start() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(nanoseconds: 600_000_000_000)
            }
        }
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await self.ble.queryPower(); await self.updateLEDs() }
            catch { self.bluetoothError = error.localizedDescription }
        }
    }

    func setForeground(_ foreground: Bool) { ble.mayScan = foreground }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let assets = portfolio + carousel
        var failures = 0
        var visited = Set<String>()
        var flashes: [(String, String, Int, Int)] = []
        for asset in assets {
            guard let symbol = asset["symbol"] as? String, symbol != averageSymbol else { continue }
            if !visited.insert(symbol).inserted { continue }
            do {
                let quote = try await provider.quote(asset)
                quotes[symbol] = quote
                observeTarget(symbol: symbol, quote: quote)
                if let change = quote["change_pct"] as? Double,
                   let session = quote["session_date"] as? String {
                    let crossed = alerts.observe(symbol: symbol, session: session, change: change)
                    let hit = ((pro["targets"] as? [String: [String: Any]])?[symbol]?["hit"] as? String)
                    if alertsEnabled && hit == nil && !carouselEnabled && ble.powerKnown && ble.isOn {
                        let mask = (asset["segments"] as? [Int] ?? []).reduce(0) { $0 | (1 << $1) }
                        for level in crossed { flashes.append((symbol, session, level, mask)) }
                    }
                }
            } catch {
                if quotes[symbol] != nil { quotes[symbol]?["stale"] = true }
                else { failures += 1 }
            }
        }
        if portfolio.contains(where: { $0["symbol"] as? String == averageSymbol }) {
            quotes[averageSymbol] = averageQuote()
            if let quote = quotes[averageSymbol], let change = quote["change_pct"] as? Double,
               let session = quote["session_date"] as? String {
                let crossed = alerts.observe(symbol: averageSymbol, session: session, change: change)
                if alertsEnabled && !carouselEnabled && ble.powerKnown && ble.isOn,
                   let asset = portfolio.first(where: { $0["symbol"] as? String == averageSymbol }) {
                    let mask = (asset["segments"] as? [Int] ?? []).reduce(0) { $0 | (1 << $1) }
                    for level in crossed { flashes.append((averageSymbol, session, level, mask)) }
                }
            }
        }
        lastFetch = Self.iso(Date())
        marketError = failures == 0 ? "" : "\(failures) cotizaciones no disponibles ahora"
        saveJSON(quotes, key: "quote_cache")
        await updateLEDs()
        for (symbol, session, level, mask) in flashes where mask != 0 {
            do {
                try await ble.flash(mask: mask, rgb: level > 0 ? 0x00ff00 : 0xff0000,
                    seconds: abs(level))
                if alerts.mark(symbol: symbol, session: session, level: level) {
                    defaults.set(Array(alerts.fired), forKey: "alert_fired")
                    lastAlert = "\(symbol) \(level > 0 ? "+" : "")\(level)%"
                }
            } catch { bluetoothError = error.localizedDescription }
        }
    }

    func handle(method: String, address: String, body: String) async -> [String: Any] {
        guard let url = URLComponents(string: "https://app.local\(address)") else {
            return error(400, "Ruta no válida")
        }
        let path = url.path
        do {
            if method == "GET" && path == "/api/state" { return answer(snapshot()) }
            if method == "GET" && path == "/api/search" {
                let term = url.queryItems?.first(where: { $0.name == "q" })?.value ?? ""
                return answer(["results": try await provider.search(term)])
            }
            if method == "GET" && path == "/api/history" {
                let symbol = url.queryItems?.first(where: { $0.name == "symbol" })?.value ?? ""
                let range = url.queryItems?.first(where: { $0.name == "range" })?.value ?? "1M"
                let points = symbol == averageSymbol ? try await averageHistory(range: range)
                    : try await provider.history(symbol, range: range)
                return answer(["points": points])
            }
            if method == "GET" && path == "/api/events" {
                return answer(["dividends": [], "earnings": [], "dividends_available": false,
                    "earnings_available": false])
            }
            guard method == "POST", let data = body.data(using: .utf8),
                  let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return error(404, "Ruta no encontrada")
            }
            switch path {
            case "/api/device":
                guard let model = input["model"] as? String else { return error(400, "Modelo no válido") }
                try ble.selectModel(model)
                bluetoothError = ""
                lastPalette = ""
                return answer(snapshot())
            case "/api/power":
                guard let desired = input["on"] as? Bool else { return error(400, "Estado no válido") }
                if busy { return error(409, "Bluetooth ocupado") }
                busy = true
                do {
                    try await ble.setPower(desired)
                    busy = false
                    bluetoothError = ""
                    lastPalette = ""
                    await updateLEDs()
                } catch {
                    busy = false
                    bluetoothError = error.localizedDescription
                    return self.error(502, bluetoothError)
                }
                return answer(snapshot())
            case "/api/portfolio": return await savePortfolio(input)
            case "/api/pro": return await savePro(input)
            case "/api/alerts":
                guard let enabled = input["enabled"] as? Bool else { return error(400, "Estado no válido") }
                alertsEnabled = enabled
                alerts.resetBaseline()
                if enabled { pro["enabled"] = true }
                defaults.set(enabled, forKey: "alerts_enabled")
                saveJSON(pro, key: "pro")
                return answer(snapshot())
            case "/api/carousel": return await saveCarousel(input)
            default: return error(404, "Ruta no encontrada")
            }
        } catch { return self.error(502, error.localizedDescription) }
    }

    private func snapshot() -> [String: Any] {
        var visible: [[String: Any]] = []
        for asset in portfolio {
            guard let symbol = asset["symbol"] as? String else { continue }
            var item = quotes[symbol] ?? asset
            item["name"] = asset["name"]
            item["market"] = asset["market"]
            item["segments"] = asset["segments"] ?? []
            item["exchange"] = asset["exchange"] ?? (symbol == averageSymbol ? "MEDIA EQUIPONDERADA" : "NASDAQ")
            item["currency"] = asset["currency"] ?? (symbol == averageSymbol ? "pts" : "USD")
            if quotes[symbol] == nil {
                item["price"] = NSNull(); item["change_pct"] = NSNull()
                item["points"] = []; item["stale"] = true
            }
            item["market_open"] = symbol == averageSymbol
                ? portfolio.contains(where: { ($0["symbol"] as? String) != averageSymbol && Self.marketOpen($0["market"] as? String ?? "US") })
                : Self.marketOpen(asset["market"] as? String ?? "US")
            visible.append(item)
        }
        let carouselQuotes = carousel.map { asset -> [String: Any] in
            let symbol = asset["symbol"] as? String ?? ""
            return ["symbol": symbol, "name": asset["name"] ?? symbol,
                "change_pct": quotes[symbol]?["change_pct"] ?? NSNull()]
        }
        return ["on": ble.isOn, "power_known": ble.powerKnown, "busy": busy,
            "loading": lastFetch == nil, "portfolio_revision": String(revision),
            "quotes": visible, "last_fetch": lastFetch as Any? ?? NSNull(),
            "last_led_update": lastLED as Any? ?? NSNull(), "market_error": marketError,
            "ble_error": bluetoothError.isEmpty ? ble.error : bluetoothError,
            "refresh_seconds": 600, "device_model": ble.selectedModel,
            "device_models": GoveeBLE.supportedModels, "alerts_enabled": alertsEnabled,
            "last_alert": lastAlert as Any? ?? NSNull(), "pro": pro,
            "portfolio_average_supported": true, "carousel_enabled": carouselEnabled,
            "carousel_assets": carousel, "carousel_quotes": carouselQuotes,
            "carousel_current_symbol": carouselCurrent as Any? ?? NSNull(),
            "carousel_position": carouselPosition, "carousel_window_start": carouselWindowStart,
            "carousel_route": carouselRoute()]
    }

    private func savePortfolio(_ input: [String: Any]) async -> [String: Any] {
        guard input["revision"] as? String == String(revision) else {
            return error(409, "La cartera cambió; vuelve a abrir el editor")
        }
        guard let draft = input["portfolio"] as? [[String: Any]], (1...15).contains(draft.count) else {
            return error(400, "La cartera admite entre 1 y 15 valores")
        }
        var used = Set<Int>(), symbols = Set<String>(), next: [[String: Any]] = []
        for item in draft {
            guard let symbol = (item["symbol"] as? String)?.uppercased(), Self.validSymbol(symbol),
                  symbols.insert(symbol).inserted,
                  let positions = item["segments"] as? [Int], !positions.isEmpty else {
                return error(400, "Símbolo o segmentos no válidos")
            }
            for position in positions {
                guard (0...14).contains(position), used.insert(position).inserted else {
                    return error(400, "Segmento repetido o inválido")
                }
            }
            var asset = portfolio.first(where: { $0["symbol"] as? String == symbol })
            if asset == nil && symbol == averageSymbol {
                asset = ["symbol": averageSymbol, "name": "Mi cartera", "market": "AVG",
                    "exchange": "MEDIA EQUIPONDERADA", "currency": "pts"]
            }
            if asset == nil {
                do { asset = try await provider.search(symbol).first(where: { $0["symbol"] as? String == symbol }) }
                catch { return self.error(502, error.localizedDescription) }
            }
            guard var found = asset else { return error(400, "No encontré \(symbol) en las bolsas admitidas") }
            found["segments"] = positions
            next.append(found)
        }
        guard next.contains(where: { $0["symbol"] as? String != averageSymbol }) else {
            return error(400, "La media necesita al menos una empresa real")
        }
        portfolio = next
        reconcileWeights()
        revision += 1
        defaults.set(revision, forKey: "portfolio_revision")
        saveJSON(portfolio, key: "portfolio")
        saveJSON(pro, key: "pro")
        lastPalette = ""
        Task { await refresh() }
        return answer(snapshot())
    }

    private func savePro(_ input: [String: Any]) async -> [String: Any] {
        guard let enabled = input["enabled"] as? Bool,
              let average = input["average"] as? [String: Any],
              let mode = average["mode"] as? String, ["equal", "weighted"].contains(mode),
              let weights = average["weights"] as? [String: Double],
              let targets = input["targets"] as? [String: [String: Any]],
              let ambient = input["ambient"] as? [String: Any],
              ambient["enabled"] is Bool, ambient["night"] is Bool, ambient["schedule"] is Bool,
              let start = ambient["start"] as? String, let end = ambient["end"] as? String,
              Self.validTime(start), Self.validTime(end) else { return error(400, "Ajustes Pro no válidos") }
        let real = Set(portfolio.compactMap { $0["symbol"] as? String }.filter { $0 != averageSymbol })
        if mode == "weighted" {
            guard Set(weights.keys) == real,
                  weights.values.allSatisfy({ $0.isFinite && (0...100).contains($0) }),
                  abs(weights.values.reduce(0, +) - 100) <= 0.01 else {
                return error(400, "Los pesos de la media deben sumar 100 %")
            }
        }
        for (symbol, target) in targets {
            guard real.contains(symbol) else { return error(400, "Objetivo no válido") }
            for key in ["sell", "stop"] {
                if let value = target[key], !(value is NSNull) {
                    guard let number = value as? Double, number.isFinite, number > 0 else {
                        return error(400, "Precio objetivo no válido")
                    }
                }
            }
            if let sell = target["sell"] as? Double, let stop = target["stop"] as? Double, stop >= sell {
                return error(400, "El stop debe ser menor que el objetivo")
            }
        }
        pro = input
        if !enabled {
            alertsEnabled = false
            alerts.resetBaseline()
            carouselEnabled = false
            ble.stopCarousel()
            defaults.set(false, forKey: "alerts_enabled")
            defaults.set(false, forKey: "carousel_enabled")
        }
        saveJSON(pro, key: "pro")
        quotes[averageSymbol] = averageQuote()
        lastPalette = ""
        await updateLEDs()
        return answer(snapshot())
    }

    private func saveCarousel(_ input: [String: Any]) async -> [String: Any] {
        guard let enabled = input["enabled"] as? Bool,
              let symbols = input["symbols"] as? [String], symbols.count <= 100 else {
            return error(400, "Lista del carrusel no válida")
        }
        var next: [[String: Any]] = [], seen = Set<String>()
        for raw in symbols {
            let symbol = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard Self.validSymbol(symbol), symbol != averageSymbol,
                  seen.insert(symbol).inserted else { continue }
            do {
                guard let found = try await provider.search(symbol).first(where: { $0["symbol"] as? String == symbol }) else {
                    return error(400, "No encontré \(symbol) en las bolsas admitidas")
                }
                next.append(found)
            } catch { return self.error(502, error.localizedDescription) }
        }
        if enabled && next.isEmpty { return error(400, "Añade al menos una empresa") }
        carousel = next
        carouselEnabled = enabled
        carouselPosition = -1
        carouselWindowStart = 0
        carouselCurrent = nil
        defaults.set(enabled, forKey: "carousel_enabled")
        saveJSON(carousel, key: "carousel")
        if enabled { Task { await refresh() } }
        else { ble.stopCarousel(); lastPalette = ""; await updateLEDs() }
        return answer(snapshot())
    }

    private func carouselRoute() -> [[String: Any]] {
        guard !carousel.isEmpty else { return [] }
        let count = min(15, carousel.count)
        var route: [[String: Any]] = []
        for index in 0..<count {
            let asset = carousel[(carouselWindowStart + index) % carousel.count]
            let blocks = 15 / count + (index < 15 % count ? 1 : 0)
            route += Array(repeating: asset, count: blocks)
        }
        return (0..<15).map { position in
            let index = (position - max(0, carouselPosition) % 15 + 15) % 15
            let asset = route[index]
            let symbol = asset["symbol"] as? String ?? ""
            return ["symbol": symbol, "name": asset["name"] ?? symbol,
                "change_pct": quotes[symbol]?["change_pct"] ?? NSNull()]
        }
    }

    private func updateLEDs() async {
        guard ble.powerKnown, ble.isOn, !busy else { return }
        if carouselEnabled {
            let colors = carousel.map { asset -> Int in
                let symbol = asset["symbol"] as? String ?? ""
                let change = quotes[symbol]?["change_pct"] as? Double
                return change.map { ambientColor($0 < 0 ? 0xff0000 : 0x00ff00, change: $0) } ?? 0
            }
            ble.setCarousel(colors: colors, enabled: true)
            return
        }
        var masks: [Int: Int] = [:]
        var assigned = 0
        let targets = pro["targets"] as? [String: [String: Any]] ?? [:]
        for asset in portfolio {
            let symbol = asset["symbol"] as? String ?? ""
            let change = quotes[symbol]?["change_pct"] as? Double
            let hit = (pro["enabled"] as? Bool == true) ? targets[symbol]?["hit"] as? String : nil
            let rgb = hit == "sell" ? 0xffbe00 : hit == "stop" ? 0xff00b4
                : change.map { ambientColor($0 < 0 ? 0xff0000 : 0x00ff00, change: $0) } ?? 0
            for segment in asset["segments"] as? [Int] ?? [] where (0...14).contains(segment) {
                masks[rgb, default: 0] |= 1 << segment
                assigned |= 1 << segment
            }
        }
        masks[0, default: 0] |= 0x7fff & ~assigned
        let palette = masks.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        let signature = palette.map { "\($0.0):\($0.1)" }.joined(separator: ",")
        guard signature != lastPalette else { return }
        do {
            try await ble.showPalette(palette)
            lastPalette = signature
            lastLED = Self.iso(Date())
            bluetoothError = ""
        } catch { bluetoothError = error.localizedDescription }
    }

    private func ambientColor(_ rgb: Int, change: Double) -> Int {
        guard pro["enabled"] as? Bool == true,
              let ambient = pro["ambient"] as? [String: Any],
              ambient["enabled"] as? Bool == true else { return rgb }
        let night = ambient["night"] as? Bool == true || scheduledNight(ambient)
        let scale = night ? 0.23 : 0.42 + 0.28 * min(abs(change) / 3, 1)
        let red = Int((Double((rgb >> 16) & 255) * scale).rounded())
        let green = Int((Double((rgb >> 8) & 255) * scale).rounded())
        let blue = Int((Double(rgb & 255) * scale).rounded())
        return (red << 16) | (green << 8) | blue
    }

    private func scheduledNight(_ ambient: [String: Any]) -> Bool {
        guard ambient["schedule"] as? Bool == true,
              let start = ambient["start"] as? String,
              let end = ambient["end"] as? String, start != end else { return false }
        let format = DateFormatter()
        format.dateFormat = "HH:mm"
        let now = format.string(from: Date())
        return start < end ? now >= start && now < end : now >= start || now < end
    }

    private func observeTarget(symbol: String, quote: [String: Any]) {
        guard pro["enabled"] as? Bool == true,
              let price = quote["price"] as? Double,
              var targets = pro["targets"] as? [String: [String: Any]],
              var target = targets[symbol] else { return }
        let sell = target["sell"] as? Double
        let stop = target["stop"] as? Double
        if target["acknowledged"] as? Bool == true && (sell == nil || price < sell!) && (stop == nil || price > stop!) {
            target["acknowledged"] = false
        }
        if target["hit"] == nil || target["hit"] is NSNull {
            if let stop, price <= stop { target["hit"] = "stop" }
            else if let sell, price >= sell { target["hit"] = "sell" }
        }
        targets[symbol] = target
        pro["targets"] = targets
        saveJSON(pro, key: "pro")
    }

    private func weights() -> [String: Double] {
        let symbols = portfolio.compactMap { $0["symbol"] as? String }.filter { $0 != averageSymbol }
        guard !symbols.isEmpty else { return [:] }
        let average = pro["average"] as? [String: Any] ?? [:]
        if pro["enabled"] as? Bool == true, average["mode"] as? String == "weighted",
           let stored = average["weights"] as? [String: Double] {
            let total = symbols.reduce(0) { $0 + (stored[$1] ?? 0) }
            if total > 0 { return Dictionary(uniqueKeysWithValues: symbols.map { ($0, (stored[$0] ?? 0) / total) }) }
        }
        return Dictionary(uniqueKeysWithValues: symbols.map { ($0, 1 / Double(symbols.count)) })
    }

    private func reconcileWeights() {
        var average = pro["average"] as? [String: Any] ?? [:]
        let stored = average["weights"] as? [String: Double] ?? [:]
        let symbols = portfolio.compactMap { $0["symbol"] as? String }.filter { $0 != averageSymbol }
        let total = symbols.reduce(0) { $0 + (stored[$1] ?? 1) }
        average["weights"] = Dictionary(uniqueKeysWithValues: symbols.map { ($0, total > 0 ? (stored[$0] ?? 1) / total * 100 : 0) })
        pro["average"] = average
        let oldTargets = pro["targets"] as? [String: [String: Any]] ?? [:]
        pro["targets"] = oldTargets.filter { symbols.contains($0.key) }
    }

    private func averageQuote() -> [String: Any] {
        let weights = weights()
        let members = portfolio.compactMap { $0["symbol"] as? String }.filter { $0 != averageSymbol }
        var change = 0.0
        var complete = !members.isEmpty
        var stale = false
        var session: String?
        var asof: String?
        for symbol in members {
            guard let quote = quotes[symbol], let value = quote["change_pct"] as? Double else {
                complete = false; stale = true; continue
            }
            change += value * (weights[symbol] ?? 0)
            stale = stale || (quote["stale"] as? Bool == true)
            let day = quote["session_date"] as? String
            if session == nil { session = day } else if session != day { session = "" }
            let stamp = quote["asof"] as? String
            if let stamp, stamp > (asof ?? "") { asof = stamp }
        }
        let weighted = pro["enabled"] as? Bool == true
            && (pro["average"] as? [String: Any])?["mode"] as? String == "weighted"
        var result: [String: Any] = ["symbol": averageSymbol, "name": "Mi cartera", "market": "AVG",
            "exchange": weighted ? "MEDIA PONDERADA" : "MEDIA EQUIPONDERADA", "currency": "pts",
            "previous_close": 100, "change_pct": complete ? change : NSNull() as Any,
            "price": complete ? 100 + change : NSNull() as Any, "stale": stale,
            "session_date": session as Any? ?? NSNull(), "asof": asof as Any? ?? NSNull()]
        result["points"] = complete && !(session ?? "").isEmpty
            ? averageIntraday(members: members, weights: weights) : []
        return result
    }

    private func averageIntraday(members: [String], weights: [String: Double]) -> [[String: Any]] {
        var baseline: [String: Double] = [:]
        var events: [(String, String, Double)] = []
        for symbol in members {
            guard let quote = quotes[symbol], let previous = quote["previous_close"] as? Double,
                  previous > 0 else { return [] }
            baseline[symbol] = previous
            for point in quote["points"] as? [[String: Any]] ?? [] {
                if let time = point["time"] as? String, let price = point["price"] as? Double, price > 0 {
                    events.append((time, symbol, price))
                }
            }
        }
        guard !events.isEmpty else { return [] }
        events.sort { $0.0 < $1.0 }
        var current = baseline
        var points: [[String: Any]] = [["time": events[0].0, "price": 100.0, "volume": 0]]
        for (time, symbol, price) in events {
            current[symbol] = price
            let value = members.reduce(0.0) { $0 + (current[$1]! / baseline[$1]! * 100 * (weights[$1] ?? 0)) }
            points.append(["time": time, "price": value, "volume": 0])
        }
        let stride = max(1, points.count / 180)
        var sampled = Swift.stride(from: 0, to: points.count, by: stride).map { points[$0] }
        if (sampled.last?["time"] as? String) != (points.last?["time"] as? String) { sampled.append(points.last!) }
        return sampled
    }

    private func averageHistory(range: String) async throws -> [[String: Any]] {
        let members = portfolio.compactMap { $0["symbol"] as? String }.filter { $0 != averageSymbol }
        guard !members.isEmpty else { throw QuoteProvider.QuoteError.message("La media necesita empresas") }
        var series: [String: [String: Double]] = [:]
        var allDays = Set<String>()
        for symbol in members {
            let history = try await provider.history(symbol, range: range)
            var values: [String: Double] = [:]
            for point in history {
                if let day = point["time"] as? String, let price = point["price"] as? Double, price > 0 {
                    values[day] = price; allDays.insert(day)
                }
            }
            guard !values.isEmpty else { throw QuoteProvider.QuoteError.message("Falta el histórico de una empresa") }
            series[symbol] = values
        }
        let weights = weights()
        var current: [String: Double] = [:], baseline: [String: Double] = [:]
        var result: [[String: Any]] = []
        for day in allDays.sorted() {
            for symbol in members { if let value = series[symbol]?[day] { current[symbol] = value } }
            guard current.count == members.count else { continue }
            if baseline.isEmpty { baseline = current }
            let value = members.reduce(0.0) { $0 + (current[$1]! / baseline[$1]! * 100 * (weights[$1] ?? 0)) }
            result.append(["time": day, "price": value, "volume": 0])
        }
        guard result.count >= 2 else { throw QuoteProvider.QuoteError.message("No hay suficientes cierres para la media") }
        return result
    }

    private func saveJSON(_ value: Any, key: String) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        defaults.set(data, forKey: key)
    }

    private static func readArray(_ defaults: UserDefaults, key: String) -> [[String: Any]]? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
    }

    private static func readDictionary(_ defaults: UserDefaults, key: String) -> [String: Any]? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func answer(_ body: [String: Any], status: Int = 200) -> [String: Any] {
        ["status": status, "body": body]
    }

    private func error(_ status: Int, _ message: String) -> [String: Any] {
        answer(["error": message], status: status)
    }

    private static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    private static func validSymbol(_ symbol: String) -> Bool {
        symbol.range(of: "^[A-Z0-9.-]{1,16}$", options: .regularExpression) != nil
    }
    private static func validTime(_ time: String) -> Bool {
        time.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil
    }
    private static func marketOpen(_ market: String) -> Bool {
        let zone = TimeZone(identifier: market == "ES" ? "Europe/Madrid" : "America/New_York")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = Date()
        let weekday = calendar.component(.weekday, from: date)
        guard weekday != 1 && weekday != 7 else { return false }
        let hour = calendar.component(.hour, from: date)
        let minute = calendar.component(.minute, from: date)
        let now = hour * 60 + minute
        return market == "ES" ? (now >= 540 && now < 1050) : (now >= 570 && now < 960)
    }

    private static func defaultPro() -> [String: Any] {
        ["enabled": true, "average": ["mode": "equal", "weights": [:] as [String: Double]],
         "targets": [:] as [String: [String: Any]],
         "ambient": ["enabled": false, "night": false, "schedule": false,
             "start": "22:00", "end": "07:00"] as [String: Any]]
    }

    private static func initialPortfolio() -> [[String: Any]] {
        let values: [(String, String, String, String, [Int])] = [
            ("GOOGL", "Alphabet", "US", "NASDAQ", [0, 1]),
            ("ENG.MC", "Enagás", "ES", "BME", [2, 3]),
            ("UBER", "Uber", "US", "NYSE", [4, 5]),
            ("AAPL", "Apple", "US", "NASDAQ", [6, 7]),
            ("TSM", "TSMC", "US", "NYSE", [8, 9]),
            ("IBE.MC", "Iberdrola", "ES", "BME", [10, 11]),
            ("MCD", "McD", "US", "NYSE", [12]),
            ("KO", "Coca-Cola", "US", "NYSE", [13]),
            ("AMZN", "Amazon", "US", "NASDAQ", [14])]
        return values.map { symbol, name, market, exchange, segments in
            ["symbol": symbol, "name": name, "market": market, "exchange": exchange,
             "currency": market == "ES" ? "EUR" : "USD", "segments": segments]
        }
    }
}
