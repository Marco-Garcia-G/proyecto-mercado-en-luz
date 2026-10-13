import Foundation

/// Proveedor provisional de desarrollo; no es una licencia de datos para publicar.
struct QuoteProvider {
    enum QuoteError: LocalizedError {
        case message(String)
        var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
    }

    private func get(_ url: URL) async throws -> [String: Any] {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("MercadoEnLuz-Prototype/0.1", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw QuoteError.message("El proveedor de cotizaciones no está disponible")
        }
        guard data.count <= 3_000_000,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw QuoteError.message("Respuesta bursátil no válida")
        }
        return object
    }

    private func chart(_ symbol: String, range: String, interval: String) async throws -> [String: Any] {
        var lastError: Error = QuoteError.message("Sin datos para \(symbol)")
        for host in ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] {
            var components = URLComponents()
            components.scheme = "https"
            components.host = host
            components.path = "/v8/finance/chart/\(symbol)"
            components.queryItems = [URLQueryItem(name: "range", value: range),
                URLQueryItem(name: "interval", value: interval),
                URLQueryItem(name: "includePrePost", value: "false")]
            guard let url = components.url else { continue }
            do {
                let root = try await get(url)
                guard let chart = root["chart"] as? [String: Any],
                      let result = chart["result"] as? [[String: Any]], let first = result.first else {
                    throw QuoteError.message("Sin datos para \(symbol)")
                }
                return first
            } catch { lastError = error }
        }
        throw lastError
    }

    private func series(_ result: [String: Any]) throws -> ([(Date, Double, Int)], [String: Any]) {
        guard let stamps = result["timestamp"] as? [NSNumber],
              let indicators = result["indicators"] as? [String: Any],
              let quote = (indicators["quote"] as? [[String: Any]])?.first,
              let closes = quote["close"] as? [Any],
              let meta = result["meta"] as? [String: Any] else {
            throw QuoteError.message("Sin precios para este símbolo")
        }
        let volumes = quote["volume"] as? [Any] ?? []
        var points: [(Date, Double, Int)] = []
        for index in 0..<min(stamps.count, closes.count) {
            guard let value = closes[index] as? NSNumber, value.doubleValue.isFinite else { continue }
            let volume = index < volumes.count ? (volumes[index] as? NSNumber)?.intValue ?? 0 : 0
            points.append((Date(timeIntervalSince1970: stamps[index].doubleValue), value.doubleValue, volume))
        }
        guard !points.isEmpty else { throw QuoteError.message("Sin precios para este símbolo") }
        return (points, meta)
    }

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    private func day(_ date: Date, zone: TimeZone) -> String {
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = zone
        format.dateFormat = "yyyy-MM-dd"
        return format.string(from: date)
    }

    func quote(_ asset: [String: Any]) async throws -> [String: Any] {
        guard let symbol = asset["symbol"] as? String else { throw QuoteError.message("Símbolo no válido") }
        let result: [String: Any]
        do { result = try await chart(symbol, range: "5d", interval: "1m") }
        catch { result = try await chart(symbol, range: "1mo", interval: "1d") }
        let (series, meta) = try series(result)
        let zone = TimeZone(identifier: meta["exchangeTimezoneName"] as? String ?? "UTC") ?? TimeZone(secondsFromGMT: 0)!
        let session = day(series.last!.0, zone: zone)
        let previous = series.lastIndex(where: { day($0.0, zone: zone) < session }).map { series[$0].1 }
            ?? (meta["chartPreviousClose"] as? NSNumber)?.doubleValue
        let price = series.last!.1
        var output = asset
        output["exchange"] = asset["exchange"] ?? meta["exchangeName"] ?? "BOLSA"
        output["currency"] = asset["currency"] ?? meta["currency"] ?? "USD"
        output["price"] = price
        output["previous_close"] = previous as Any? ?? NSNull()
        output["change_pct"] = previous.flatMap { $0 > 0 ? (price / $0 - 1) * 100 : nil } as Any? ?? NSNull()
        output["session_date"] = session
        output["asof"] = iso(series.last!.0)
        output["points"] = series.filter { day($0.0, zone: zone) == session }
            .map { ["time": iso($0.0), "price": $0.1, "volume": $0.2] as [String: Any] }
        output["stale"] = false
        return output
    }

    func history(_ symbol: String, range: String) async throws -> [[String: Any]] {
        let days = ["1M": 31, "6M": 183, "1Y": 366, "5Y": 1827]
        guard let span = days[range] else { throw QuoteError.message("Periodo no válido") }
        let result = try await chart(symbol, range: "5y", interval: "1d")
        let (series, meta) = try series(result)
        let zone = TimeZone(identifier: meta["exchangeTimezoneName"] as? String ?? "UTC") ?? TimeZone(secondsFromGMT: 0)!
        let since = Date().addingTimeInterval(-Double(span) * 86400)
        var output: [[String: Any]] = []
        var rolling: [Double] = []
        for (date, price, volume) in series {
            rolling.append(price)
            if rolling.count > 200 { rolling.removeFirst() }
            guard date >= since else { continue }
            output.append(["time": day(date, zone: zone), "price": price, "volume": volume,
                "ma200": rolling.count == 200 ? rolling.reduce(0, +) / 200 : NSNull() as Any])
        }
        return output
    }

    func search(_ text: String) async throws -> [[String: Any]] {
        var components = URLComponents(string: "https://query1.finance.yahoo.com/v1/finance/search")!
        components.queryItems = [URLQueryItem(name: "q", value: text),
            URLQueryItem(name: "quotesCount", value: "12"), URLQueryItem(name: "newsCount", value: "0")]
        let root = try await get(components.url!)
        let quotes = root["quotes"] as? [[String: Any]] ?? []
        var results: [[String: Any]] = []
        for item in quotes where results.count < 8 {
            guard item["quoteType"] as? String == "EQUITY",
                  let rawSymbol = item["symbol"] as? String else { continue }
            let symbol = rawSymbol.uppercased()
            let exchange = item["exchange"] as? String ?? ""
            let spanish = symbol.hasSuffix(".MC") && ["MCE", "MCM"].contains(exchange)
            let american = ["NMS", "NCM", "NGM", "NYQ", "ASE"].contains(exchange)
            guard spanish || american else { continue }
            results.append(["symbol": symbol, "name": item["longname"] ?? item["shortname"] ?? symbol,
                "market": spanish ? "ES" : "US", "exchange": spanish ? "BME" : exchange == "NYQ" ? "NYSE" : "NASDAQ",
                "currency": spanish ? "EUR" : "USD"])
        }
        return results
    }
}
