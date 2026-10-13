"""Página local para controlar una tira Govee segmentada (H617A) y ver la cartera."""

import argparse
import asyncio
import hashlib
import ipaddress
import json
import math
import mimetypes
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import yfinance as yf
from bleak import BleakClient

from market_govee import (
    CONFIG_PATH,
    StripError,
    classify_ble_error,
    connect_strip,
    forget_device,
    load_device,
    model_of,
    PORTFOLIO_MARKET,
    PORTFOLIO_SYMBOL,
    build_segment_packet,
    build_color_masks,
    hex_to_rgb,
    load_config,
    make_packet,
    market_is_open,
    portfolio_mean,
    update_led_strip,
    validate_config,
)
from pro_features import (
    TARGET_COLORS, ambient_rgb, default_settings, target_hit,
    reconcile_portfolio, validate_settings, weighted_mean, weights_for,
)


WEB_ROOT = Path(__file__).with_name("web").resolve()
ALERTS_PATH = Path(__file__).with_name("alerts.json")
CAROUSEL_PATH = Path(__file__).with_name("carousel.json")
QUOTE_CACHE_PATH = Path(__file__).with_name("quotes_cache.json")
PRO_PATH = Path(__file__).with_name("pro.json")


def load_quote_cache(path=QUOTE_CACHE_PATH):
    """Load last known-good quotes; cached values are always marked stale."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(payload, dict):
        return {}
    cached = {}
    for symbol, quote in payload.items():
        if not isinstance(symbol, str) or not isinstance(quote, dict):
            continue
        change = quote.get("change_pct")
        price = quote.get("price")
        if (not isinstance(change, (int, float)) or not math.isfinite(change)
                or not isinstance(price, (int, float)) or not math.isfinite(price)
                or price <= 0):
            continue
        cached[symbol] = {**quote, "symbol": symbol, "stale": True}
    return cached


def save_quote_cache(quotes, path=QUOTE_CACHE_PATH):
    """Persist a bounded cache atomically so a failed refresh never erases data."""
    safe = {}
    for symbol, quote in quotes.items():
        if not isinstance(quote, dict):
            continue
        change = quote.get("change_pct")
        price = quote.get("price")
        if (not isinstance(change, (int, float)) or not math.isfinite(change)
                or not isinstance(price, (int, float)) or not math.isfinite(price)
                or price <= 0):
            continue
        safe[symbol] = {**quote, "stale": bool(quote.get("stale", False))}
    # Retain the most recently updated 300 symbols to keep the local file small.
    safe = dict(sorted(safe.items(), key=lambda item: item[1].get("asof", ""), reverse=True)[:300])
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=".quotes-", suffix=".json", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(safe, temporary, ensure_ascii=False, allow_nan=False)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    except OSError:
        # A cache failure must not interrupt live quotes or BLE updates.
        pass
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def build_carousel_route(assets, window_start=0, shift=0):
    """Map an ordered ticker queue evenly onto the 15 H617A logical zones."""
    if not assets:
        return [None] * 15
    start = window_start % len(assets)
    active_count = min(15, len(assets))
    active = [assets[(start + index) % len(assets)] for index in range(active_count)]
    base, remainder = divmod(15, active_count)
    route = []
    for index, asset in enumerate(active):
        route.extend([asset] * (base + (1 if index < remainder else 0)))
    offset = shift % 15
    return [route[(position - offset) % 15] for position in range(15)]
NOTIFY_UUID = "00010203-0405-0607-0809-0a0b0c0d2b10"
HISTORY_RANGES = {"1M": 31, "6M": 183, "1Y": 366, "5Y": 1827}
EXCHANGES = {
    "GOOGL": "NASDAQ", "AAPL": "NASDAQ", "AMZN": "NASDAQ",
    "UBER": "NYSE", "TSM": "NYSE", "MCD": "NYSE", "KO": "NYSE",
    "ENG.MC": "BME", "IBE.MC": "BME",
}
US_EXCHANGES = {
    "NMS": "NASDAQ", "NCM": "NASDAQ", "NGM": "NASDAQ",
    "NYQ": "NYSE", "ASE": "NYSE American",
}
SPANISH_EXCHANGES = {"MCE", "MCM"}
def lan_address():
    """Encuentra la dirección IPv4 y la subred de la interfaz local del Mac."""
    for interface in ("en0", "en1", "en2", "en3", "en4"):
        try:
            details = subprocess.check_output(
                ["ifconfig", interface], stderr=subprocess.DEVNULL, timeout=2,
            ).decode()
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        match = re.search(r"\binet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-fA-F]+|\d+\.\d+\.\d+\.\d+)", details)
        if not match:
            continue
        address = ipaddress.ip_address(match.group(1))
        if address.is_loopback or address.is_link_local or address.is_multicast:
            continue
        mask = match.group(2)
        mask_int = int(mask, 16) if mask.startswith("0x") else int(ipaddress.IPv4Address(mask))
        subnet = ipaddress.ip_network(f"{address}/{ipaddress.IPv4Address(mask_int)}", strict=False)
        return str(address), subnet
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("1.1.1.1", 80))
            address = ipaddress.ip_address(probe.getsockname()[0])
            if not address.is_loopback and not address.is_link_local:
                return str(address), ipaddress.ip_network(f"{address}/24", strict=False)
    except OSError:
        pass
    return None


class PortfolioConflict(Exception):
    """La cartera cambió en disco después de abrir el editor."""


class ThresholdAlerts:
    """Cruces de ±1…5 % por empresa y sesión, sin avisos al arrancar."""

    def __init__(self, fired=()):
        self.previous = {}
        self.fired = set(fired)
        self.pending = set()

    def reset_baseline(self):
        self.previous.clear()

    def observe(self, symbol, session, change):
        if not session or not isinstance(change, (int, float)) or not math.isfinite(change):
            return []
        old = self.previous.get(symbol)
        self.previous[symbol] = (session, change)
        if old is None or old[0] != session:
            prefix = f"{symbol}|"
            self.fired = {key for key in self.fired if not key.startswith(prefix) or key.startswith(f"{prefix}{session}|")}
            return []
        levels = []
        for level in range(1, 6):
            signed = level if old[1] < level <= change else -level if old[1] > -level >= change else None
            if signed is None:
                continue
            key = f"{symbol}|{session}|{signed}"
            if key not in self.fired and key not in self.pending:
                levels.append((key, signed))
        return levels


def portfolio_revision():
    return hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()


def search_equities(term):
    """Busca acciones de EE. UU. y Madrid, los mercados soportados ahora."""
    matches = yf.Search(
        term, max_results=10, news_count=0, lists_count=0,
        include_cb=False, include_nav_links=False, include_research=False,
        timeout=8,
    ).quotes
    results = []
    seen = set()
    for item in matches:
        if item.get("quoteType") != "EQUITY":
            continue
        symbol = str(item.get("symbol", "")).upper()
        code = item.get("exchange", "")
        if symbol in seen or not symbol or len(symbol) > 16:
            continue
        if code in SPANISH_EXCHANGES and symbol.endswith(".MC"):
            market, exchange = "ES", "BME"
        elif code in US_EXCHANGES and not symbol.endswith(".MC"):
            market, exchange = "US", US_EXCHANGES[code]
        else:
            continue
        name = str(item.get("longname") or item.get("shortname") or symbol).strip()[:80]
        results.append({
            "symbol": symbol, "name": name, "market": market,
            "exchange": exchange, "currency": "EUR" if market == "ES" else "USD",
        })
        seen.add(symbol)
        if len(results) == 8:
            break
    return results


def fetch_quote(asset):
    """Último precio disponible y recorrido de la última sesión bursátil."""
    symbol = asset["symbol"]
    try:
        history = yf.Ticker(symbol).history(
            period="5d", interval="1m", auto_adjust=False, prepost=False, timeout=12
        )
    except Exception:
        return fetch_daily_quote(asset)
    if history is None or history.empty or "Close" not in history:
        return fetch_daily_quote(asset)

    closes = history["Close"].dropna()
    if closes.empty:
        return fetch_daily_quote(asset)
    last_time = closes.index[-1]
    session_date = last_time.date()
    previous = closes[[stamp.date() < session_date for stamp in closes.index]]
    if previous.empty:
        return fetch_daily_quote(asset)
    previous_close = float(previous.iloc[-1])
    price = float(closes.iloc[-1])
    if not math.isfinite(price) or not math.isfinite(previous_close) or previous_close <= 0:
        return fetch_daily_quote(asset)

    intraday = closes[[stamp.date() == session_date for stamp in closes.index]]
    stride = max(1, len(intraday) // 110)
    positions = list(range(0, len(intraday), stride))
    if positions and positions[-1] != len(intraday) - 1:
        positions.append(len(intraday) - 1)
    volume = history["Volume"] if "Volume" in history else None
    points = []
    for position in positions:
        stamp = intraday.index[position]
        traded = 0
        if volume is not None:
            amount = volume.get(stamp, 0)
            if amount is not None and math.isfinite(float(amount)):
                traded = int(amount)
        points.append({
            "time": stamp.isoformat(),
            "price": round(float(intraday.iloc[position]), 4),
            "volume": traded,
        })

    return {
        "symbol": symbol,
        "name": asset["name"],
        "exchange": asset.get("exchange", EXCHANGES.get(symbol, "BME" if asset["market"] == "ES" else "BOLSA")),
        "currency": "EUR" if asset["market"] == "ES" else "USD",
        "market": asset["market"],
        "segments": asset.get("segments", []),
        "price": round(price, 4),
        "previous_close": round(previous_close, 4),
        "change_pct": round((price / previous_close - 1) * 100, 4),
        "session_date": session_date.isoformat(),
        "asof": last_time.isoformat(),
        "points": points,
        "stale": False,
    }


def fetch_daily_quote(asset):
    """Respaldo gratuito con cierres diarios cuando Yahoo no da velas de 1 minuto."""
    symbol = asset["symbol"]
    history = yf.Ticker(symbol).history(
        period="10d", interval="1d", auto_adjust=False, prepost=False, timeout=12
    )
    if history is None or history.empty or "Close" not in history:
        raise ValueError("sin cotizaciones intradía ni diarias")
    closes = history["Close"].dropna()
    if len(closes) < 2:
        raise ValueError("sin cierre diario anterior")
    last_time = closes.index[-1]
    price = float(closes.iloc[-1])
    previous_close = float(closes.iloc[-2])
    if (not math.isfinite(price) or not math.isfinite(previous_close)
            or price <= 0 or previous_close <= 0):
        raise ValueError("precio diario inválido")
    session_date = last_time.date()
    volume = history["Volume"] if "Volume" in history else None
    traded = 0
    if volume is not None:
        amount = volume.get(last_time, 0)
        if amount is not None and math.isfinite(float(amount)):
            traded = int(amount)
    return {
        "symbol": symbol,
        "name": asset["name"],
        "exchange": asset.get("exchange", EXCHANGES.get(symbol, "BME" if asset["market"] == "ES" else "BOLSA")),
        "currency": "EUR" if asset["market"] == "ES" else "USD",
        "market": asset["market"],
        "segments": asset.get("segments", []),
        "price": round(price, 4),
        "previous_close": round(previous_close, 4),
        "change_pct": round((price / previous_close - 1) * 100, 4),
        "session_date": session_date.isoformat(),
        "asof": last_time.isoformat(),
        "points": [{"time": last_time.isoformat(), "price": round(price, 4), "volume": traded}],
        "resolution": "daily",
        "stale": False,
    }


def fetch_history(symbol, years):
    """Cierres diarios suficientes para calcular una media de 200 sesiones."""
    history = yf.Ticker(symbol).history(
        period="5y" if years == 5 else "2y", interval="1d",
        auto_adjust=False, timeout=15,
    )
    if history is None or history.empty or "Close" not in history:
        raise ValueError("no hay histórico disponible")
    closes = history["Close"].dropna()
    if closes.empty:
        raise ValueError("no hay cierres válidos")
    average = closes.rolling(window=200, min_periods=200).mean()
    volumes = history["Volume"] if "Volume" in history else None
    points = []
    for stamp, value in closes.items():
        mean = average.loc[stamp]
        volume = volumes.get(stamp, 0) if volumes is not None else 0
        points.append({
            "time": stamp.date().isoformat(),
            "price": round(float(value), 4),
            "ma200": round(float(mean), 4) if math.isfinite(float(mean)) else None,
            "volume": int(volume) if volume is not None and math.isfinite(float(volume)) else 0,
        })
    return points


def average_intraday_quote(assets, found, settings=None):
    """Índice base 100 de la última sesión compartida, sin sumar monedas."""
    real = [asset for asset in assets if asset["symbol"] != PORTFOLIO_SYMBOL]
    quotes = [found.get(asset["symbol"]) for asset in real]
    weights = weights_for(assets, settings or default_settings())
    changes = weighted_mean([quote.get("change_pct") if quote else None for quote in quotes], weights)
    sessions = {quote.get("session_date") for quote in quotes if quote}
    session = sessions.pop() if len(sessions) == 1 else None
    points = []
    if changes is not None and session and all(quote.get("previous_close", 0) > 0 for quote in quotes):
        events = []
        for index, quote in enumerate(quotes):
            for point in quote.get("points", []):
                if point.get("time") and isinstance(point.get("price"), (int, float)):
                    events.append((datetime.fromisoformat(point["time"]).astimezone(timezone.utc), index, point["price"]))
        events.sort(key=lambda item: item[0])
        if events:
            current = [quote["previous_close"] for quote in quotes]
            start = events[0][0] - timedelta(minutes=1)
            points.append({"time": start.isoformat(), "price": 100.0, "volume": 0})
            for stamp, index, price in events:
                current[index] = price
                value = weighted_mean([current[i] / quotes[i]["previous_close"] * 100 for i in range(len(quotes))], weights)
                points.append({"time": stamp.isoformat(), "price": round(value, 4), "volume": 0})
            stride = max(1, len(points) // 180)
            sampled = points[::stride]
            if sampled[-1] is not points[-1]:
                sampled.append(points[-1])
            points = sampled
    asof = max((quote.get("asof") for quote in quotes if quote and quote.get("asof")), default=None)
    return {
        "symbol": PORTFOLIO_SYMBOL, "name": "Mi cartera", "market": PORTFOLIO_MARKET,
        "exchange": "MEDIA PONDERADA" if (settings or {}).get("average", {}).get("mode") == "weighted" else "MEDIA EQUIPONDERADA", "currency": "pts", "segments": [],
        "previous_close": 100, "price": round(100 + changes, 4) if changes is not None else None,
        "change_pct": round(changes, 4) if changes is not None else None,
        "session_date": session, "asof": asof, "points": points,
        "stale": any(not quote or quote.get("stale") for quote in quotes),
    }


def average_history(series, weights=None):
    """Rebasa cada acción a 100 y arrastra el último cierre en festivos distintos."""
    if not series or any(not points for points in series):
        return []
    by_day = [{point["time"]: point["price"] for point in points if isinstance(point.get("price"), (int, float)) and point["price"] > 0} for points in series]
    days = sorted(set().union(*(prices.keys() for prices in by_day)))
    current = [None] * len(series)
    baseline = None
    output = []
    for day in days:
        for index, prices in enumerate(by_day):
            current[index] = prices.get(day, current[index])
        if any(price is None for price in current):
            continue
        if baseline is None:
            baseline = current.copy()
        value = weighted_mean([current[index] / baseline[index] * 100 for index in range(len(current))], weights or [1 / len(current)] * len(current))
        output.append({"time": day, "price": round(value, 4), "volume": 0})
    return output


def fetch_events(symbol):
    """Dividendos pasados y fechas de resultados disponibles, sin inventar anuncios."""
    ticker = yf.Ticker(symbol)
    dividends = []
    earnings = []
    next_date = None
    dividends_available = False
    earnings_available = False
    try:
        history = ticker.history(period="5y", interval="1d", auto_adjust=False, actions=True, timeout=15)
        dividends_available = history is not None and not history.empty
        previous_close = None
        for stamp, row in history.iterrows():
            close = float(row.get("Close", 0))
            amount = float(row.get("Dividends", 0))
            if math.isfinite(amount) and amount > 0 and previous_close and previous_close > 0:
                dividends.append({
                    "date": stamp.date().isoformat(),
                    "percent": round(amount / previous_close * 100, 3),
                    "amount": round(amount, 4),
                })
            if math.isfinite(close) and close > 0:
                previous_close = close
    except Exception:
        pass
    try:
        dates = ticker.get_earnings_dates(limit=32)
        if dates is not None:
            earnings_available = True
            earnings = sorted({stamp.date().isoformat() for stamp in dates.index if stamp.date() <= date.today()})
    except Exception:
        pass
    try:
        calendar = ticker.calendar or {}
        for key in ("Ex-Dividend Date", "Dividend Date"):
            value = calendar.get(key)
            if isinstance(value, (list, tuple)):
                value = value[0] if value else None
            day = value.date() if isinstance(value, datetime) else value
            if isinstance(day, date) and day > date.today():
                next_date = day.isoformat()
                break
    except Exception:
        pass
    return {
        "dividends": dividends, "earnings": earnings, "next_date": next_date,
        "dividends_available": dividends_available, "earnings_available": earnings_available,
    }


class StripDashboard:
    def __init__(self):
        self.config = load_config()
        self.quote_cache_path = QUOTE_CACHE_PATH
        self.lock = threading.RLock()
        self.config_file_lock = threading.RLock()
        self.alert_file_lock = threading.Lock()
        self.pro_file_lock = threading.Lock()
        self.portfolio_version = 0
        self.ble_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.refresh_event = threading.Event()
        self.on = False
        self.requested_on = False
        self.power_known = False
        self.busy = False
        self.loading = True
        self.quotes = load_quote_cache(self.quote_cache_path)
        self.last_fetch = None
        self.last_led_update = None
        self.last_sent = None
        self.market_error = None
        self.ble_error = None
        self.ble_code = None
        self.ble_phase = "searching"
        self.device = load_device(self.config)
        self.last_ble_ok = None
        self.retry_at = None
        self.ble_failures = 0
        self.connect_event = threading.Event()
        self.probe_requested = False
        self.history_cache = {}
        self.history_lock = threading.Lock()
        self.events_cache = {}
        self.events_lock = threading.Lock()
        self.search_cache = {}
        self.search_lock = threading.Lock()
        try:
            alert_state = json.loads(ALERTS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            alert_state = {}
        self.alerts_enabled = alert_state.get("enabled") is True
        self.alerts = ThresholdAlerts(alert_state.get("fired", []))
        pro_migrating = not PRO_PATH.is_file()
        try:
            saved_pro = json.loads(PRO_PATH.read_text(encoding="utf-8"))
            symbols = [asset["symbol"] for asset in self.config["portfolio"] if asset["symbol"] != PORTFOLIO_SYMBOL]
            self.pro = validate_settings(saved_pro, symbols)
        except (OSError, ValueError, KeyError):
            self.pro = default_settings()
        if pro_migrating and self.alerts_enabled:
            self.pro["enabled"] = True
        try:
            carousel_state = json.loads(CAROUSEL_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            carousel_state = {}
        self.carousel_assets = carousel_state.get("assets", []) if isinstance(carousel_state.get("assets", []), list) else []
        self.carousel_enabled = carousel_state.get("enabled") is True and bool(self.carousel_assets)
        if pro_migrating and (self.carousel_enabled or any(asset["symbol"] == PORTFOLIO_SYMBOL for asset in self.config["portfolio"])):
            self.pro["enabled"] = True
        self.carousel_current_symbol = None
        self.carousel_position = -1
        self.carousel_window_start = 0
        self.alert_worker = ThreadPoolExecutor(max_workers=1)
        self.carousel_worker = threading.Thread(target=self._carousel_loop, daemon=True)
        self.carousel_worker.start()
        self.power_probe = threading.Thread(target=self._connection_loop, daemon=True)
        self.power_probe.start()
        self.worker = threading.Thread(target=self._market_loop, daemon=True)
        self.worker.start()

    def snapshot(self):
        with self.lock:
            now = datetime.now(timezone.utc)
            return {
                "on": self.on,
                "power_known": self.power_known,
                "busy": self.busy,
                "loading": self.loading,
                "portfolio_revision": portfolio_revision(),
                "quotes": [
                    {**self.quotes.get(asset["symbol"], {
                        "symbol": asset["symbol"], "name": asset["name"],
                        "exchange": asset.get("exchange", "MEDIA EQUIPONDERADA" if asset["symbol"] == PORTFOLIO_SYMBOL else EXCHANGES.get(asset["symbol"], "BME" if asset["market"] == "ES" else "BOLSA")),
                        "currency": "pts" if asset["symbol"] == PORTFOLIO_SYMBOL else "EUR" if asset["market"] == "ES" else "USD",
                        "market": asset["market"], "segments": asset["segments"],
                        "price": None, "change_pct": None, "points": [], "stale": True,
                    }), "name": asset["name"], "market": asset["market"],
                    "exchange": (self.quotes.get(asset["symbol"]) or {}).get("exchange") if asset["symbol"] == PORTFOLIO_SYMBOL and (self.quotes.get(asset["symbol"]) or {}).get("exchange") else asset.get("exchange", "MEDIA EQUIPONDERADA" if asset["symbol"] == PORTFOLIO_SYMBOL else EXCHANGES.get(asset["symbol"], "BME" if asset["market"] == "ES" else "BOLSA")),
                    "segments": asset["segments"],
                    "market_open": any(market_is_open(item["market"], now) for item in self.config["portfolio"] if item["symbol"] != PORTFOLIO_SYMBOL) if asset["symbol"] == PORTFOLIO_SYMBOL else market_is_open(asset["market"], now)}
                    for asset in self.config["portfolio"]
                ],
                "last_fetch": self.last_fetch,
                "last_led_update": self.last_led_update,
                "market_error": self.market_error,
                "ble_error": self.ble_error,
                "ble_code": self.ble_code,
                "ble_phase": self.ble_phase,
                "device_model": model_of(self.config),
                "device_name": (self.device or {}).get("name"),
                "last_ble_ok": self.last_ble_ok,
                "retry_in": max(0, round(self.retry_at - time.monotonic())) if self.retry_at else None,
                "refresh_seconds": 60,
                "alerts_enabled": self.alerts_enabled,
                "pro": json.loads(json.dumps(self.pro)),
                "portfolio_average_supported": True,
                "carousel_enabled": self.carousel_enabled,
                "carousel_assets": [{key: asset[key] for key in ("symbol", "name", "market", "exchange")} for asset in self.carousel_assets],
                "carousel_quotes": [
                    {"symbol": asset["symbol"], "name": asset["name"], "change_pct": (self.quotes.get(asset["symbol"]) or {}).get("change_pct")}
                    for asset in self.carousel_assets
                ],
                "carousel_current_symbol": self.carousel_current_symbol,
                "carousel_position": self.carousel_position,
                "carousel_window_start": self.carousel_window_start,
                "carousel_route": [
                    None if asset is None else {
                        "symbol": asset["symbol"], "name": asset["name"],
                        "change_pct": (self.quotes.get(asset["symbol"]) or {}).get("change_pct"),
                    }
                    for asset in build_carousel_route(
                        self.carousel_assets, self.carousel_window_start,
                        max(0, self.carousel_position),
                    )
                ],
            }

    def set_carousel(self, enabled, symbols):
        if type(enabled) is not bool or not isinstance(symbols, list) or len(symbols) > 100:
            raise ValueError("Carrusel no válido")
        assets = []
        seen = set()
        with self.lock:
            known = {
                item["symbol"]: item
                for item in [*self.config["portfolio"], *self.carousel_assets]
                if item["symbol"] != PORTFOLIO_SYMBOL
            }
        with self.search_lock:
            for _, results in self.search_cache.values():
                known.update((item["symbol"], item) for item in results)
        for raw in symbols:
            if not isinstance(raw, str):
                raise ValueError("Símbolo de empresa no válido")
            symbol = raw.strip().upper()
            if not symbol or symbol in seen:
                continue
            if symbol == PORTFOLIO_SYMBOL:
                raise ValueError("Mi cartera no se añade al carrusel")
            match = known.get(symbol)
            if match is None:
                match = next((item for item in self.search(symbol) if item["symbol"] == symbol), None)
            if match is None:
                raise ValueError(f"No encontré {symbol} en las bolsas admitidas")
            assets.append({key: match[key] for key in ("symbol", "name", "market", "exchange")})
            seen.add(symbol)
        if enabled and not assets:
            raise ValueError("Añade al menos una empresa")
        with self.lock:
            self.carousel_assets = assets
            self.carousel_enabled = enabled
            self.carousel_current_symbol = None
            self.carousel_position = -1
            self.carousel_window_start = 0
            self.last_sent = None
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=CAROUSEL_PATH.parent,
                                             prefix=".carousel-", suffix=".json", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                json.dump({"enabled": enabled, "assets": assets}, temporary, ensure_ascii=False, indent=2)
                temporary.write("\n"); temporary.flush(); os.fsync(temporary.fileno())
            os.replace(temporary_path, CAROUSEL_PATH)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        self.refresh_event.set()
        if not enabled:
            self._sync_strip()
        return self.snapshot()

    def _save_alerts(self):
        with self.alert_file_lock:
            with self.lock:
                payload = {"enabled": self.alerts_enabled, "fired": sorted(self.alerts.fired)}
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=ALERTS_PATH.parent,
                    prefix=".alerts-", suffix=".json", delete=False,
                ) as temporary:
                    temporary_path = Path(temporary.name)
                    json.dump(payload, temporary, ensure_ascii=False)
                    temporary.write("\n")
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, ALERTS_PATH)
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)

    def set_alerts(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("enabled debe ser verdadero o falso")
        with self.lock:
            self.alerts_enabled = enabled
            if enabled:
                self.pro["enabled"] = True
            self.alerts.reset_baseline()
        self._save_alerts()
        if enabled:
            self._save_pro()
        return self.snapshot()

    def _save_pro(self):
        with self.pro_file_lock:
            with self.lock:
                payload = json.loads(json.dumps(self.pro))
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=PRO_PATH.parent,
                                                 prefix=".pro-", suffix=".json", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    json.dump(payload, temporary, ensure_ascii=False, indent=2)
                    temporary.write("\n")
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, PRO_PATH)
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)

    def set_pro(self, requested):
        with self.config_file_lock:
            symbols = [asset["symbol"] for asset in self.config["portfolio"] if asset["symbol"] != PORTFOLIO_SYMBOL]
            checked = validate_settings(requested, symbols)
            with self.lock:
                self.pro = checked
                self.last_sent = None
            self._save_pro()
            if any(asset["symbol"] == PORTFOLIO_SYMBOL for asset in self.config["portfolio"]):
                with self.lock:
                    self.quotes[PORTFOLIO_SYMBOL] = average_intraday_quote(self.config["portfolio"], self.quotes, self.pro)
        self._update_target_hits(self.quotes)
        if not checked["enabled"]:
            with self.lock:
                self.alerts_enabled = False
                carousel_symbols = [asset["symbol"] for asset in self.carousel_assets] if self.carousel_enabled else None
            self._save_alerts()
            if carousel_symbols:
                self.set_carousel(False, carousel_symbols)
        self.refresh_event.set()
        self._sync_strip()
        return self.snapshot()

    def _update_target_hits(self, found):
        changed = False
        with self.lock:
            if not self.pro["enabled"]:
                return
            for symbol, target in self.pro["targets"].items():
                quote = found.get(symbol)
                price = quote.get("price") if quote and not quote.get("stale") else None
                if target.get("acknowledged") and isinstance(price, (int, float)) and math.isfinite(price):
                    in_range = (target["stop"] is None or price > target["stop"]) and (target["sell"] is None or price < target["sell"])
                    if in_range:
                        target["acknowledged"] = False
                        changed = True
                hit = target_hit(target, quote)
                if hit:
                    target["hit"] = hit
                    changed = True
            if changed:
                self.last_sent = None
        if changed:
            self._save_pro()

    def _pro_color_masks(self):
        masks = {}
        assigned = 0
        for asset in self.config["portfolio"]:
            symbol = asset["symbol"]
            quote = self.quotes.get(symbol) or {}
            change = quote.get("change_pct")
            target = self.pro["targets"].get(symbol) if self.pro["enabled"] else None
            if target and target.get("hit"):
                rgb = TARGET_COLORS[target["hit"]]
            elif isinstance(change, (int, float)) and math.isfinite(change):
                rgb = hex_to_rgb(self.config["colors"]["rojo" if change < 0 else "verde"])
                rgb = ambient_rgb(rgb, change, self.pro)
            else:
                rgb = (0, 0, 0)
            mask = sum(1 << segment for segment in asset["segments"])
            masks[rgb] = masks.get(rgb, 0) | mask
            assigned |= mask
        missing = 0x7FFF & ~assigned
        if missing:
            masks[(0, 0, 0)] = masks.get((0, 0, 0), 0) | missing
        return tuple((rgb, mask) for rgb, mask in masks.items() if mask)

    def set_power(self, on):
        with self.lock:
            if self.busy:
                return False
            self.requested_on = on
            self.busy = True
            self.ble_error = None
            self.ble_code = None
        threading.Thread(target=self._write_power, args=(on,), daemon=True).start()
        return True

    def reconnect(self, forget=False):
        """Reintento manual: vuelve a consultar la tira y, si se pide, busca otra."""
        with self.lock:
            if self.busy:
                return False
            if forget:
                forget_device()
                self.device = None
            self.probe_requested = True
            self.retry_at = None
            self.ble_error = None
            self.ble_code = None
            self.ble_phase = "searching" if self.device is None else "connecting"
        self.connect_event.set()
        return True

    def _set_phase(self, phase, device=None):
        with self.lock:
            self.ble_phase = phase
            if device is not None:
                self.device = {"address": device["address"], "name": device.get("name")}

    def _address(self):
        with self.lock:
            device = self.device
        if not device:
            raise StripError("not_found", "Todavía no he encontrado la tira")
        return device["address"]

    def _ble_ok(self):
        with self.lock:
            self.ble_phase = "ready"
            self.ble_error = None
            self.ble_code = None
            self.last_ble_ok = datetime.now(timezone.utc).isoformat()
            self.retry_at = None
            self.ble_failures = 0

    def _ble_failed(self, error, prefix=None):
        with self.lock:
            self.ble_phase = "error"
            self.ble_code = classify_ble_error(error)
            message = str(error) or type(error).__name__
            self.ble_error = f"{prefix}: {message}" if prefix else message

    async def _query_power(self, client, config, queue):
        while not queue.empty():
            queue.get_nowait()
        await client.write_gatt_char(
            config["characteristic_uuid"], make_packet([0xAA, 0x01, 0x00]),
            response=False,
        )
        return await asyncio.wait_for(queue.get(), timeout=2.0)

    async def _power_session(self, expected=None):
        config = self.config
        queue = asyncio.Queue()

        def notification(_, data):
            packet = bytes(data)
            if len(packet) >= 3 and packet[0:2] == b"\xAA\x01":
                queue.put_nowait(packet[2] == 1)

        client, _ = await connect_strip(config, self._set_phase)
        try:
            self._set_phase("confirming")
            await client.start_notify(NOTIFY_UUID, notification)
            try:
                if expected is None:
                    try:
                        return await self._query_power(client, config, queue)
                    except asyncio.TimeoutError as error:
                        raise StripError("no_reply", "La tira no respondió a la consulta de estado") from error
                packet = make_packet([0x33, 0x01, 0x01 if expected else 0x00])
                observed = None
                for attempt in range(3):
                    for _ in range(3):
                        await client.write_gatt_char(
                            config["characteristic_uuid"], packet, response=False,
                        )
                        await asyncio.sleep(0.07)
                    await asyncio.sleep(0.38)
                    try:
                        observed = await self._query_power(client, config, queue)
                    except asyncio.TimeoutError:
                        observed = None
                    if observed == expected:
                        return observed
                if observed is None:
                    raise StripError("no_reply", "No llegó la confirmación Bluetooth; comprueba la tira")
                raise StripError("rejected",
                    "La tira responde que sigue encendida" if not expected
                    else "La tira responde que sigue apagada"
                )
            finally:
                try:
                    await client.stop_notify(NOTIFY_UUID)
                except Exception:
                    pass
        finally:
            await client.disconnect()

    def _connection_loop(self):
        """Lee el estado al arrancar y reintenta con esperas crecientes si falla."""
        while not self.stop_event.is_set():
            with self.lock:
                due = not self.busy and (
                    self.probe_requested
                    or (not self.power_known and (self.retry_at is None or time.monotonic() >= self.retry_at))
                )
                if due:
                    self.probe_requested = False
            if due:
                self._probe_power()
            self.connect_event.wait(1.0)
            self.connect_event.clear()

    def _probe_power(self):
        try:
            with self.ble_lock:
                observed = asyncio.run(asyncio.wait_for(self._power_session(), timeout=35))
            with self.lock:
                if not self.busy:
                    self.on = observed
                    self.requested_on = observed
                    self.power_known = True
                    self.last_sent = None
                    if observed:
                        self.refresh_event.set()
            self._ble_ok()
        except Exception as error:
            self._ble_failed(error)
            with self.lock:
                delays = self.config.get("ble_retry_seconds") or [5, 15, 30, 60]
                self.retry_at = time.monotonic() + delays[min(self.ble_failures, len(delays) - 1)]
                self.ble_failures += 1

    def _write_power(self, on):
        try:
            with self.ble_lock:
                with self.lock:
                    if self.requested_on != on:
                        return
                observed = asyncio.run(asyncio.wait_for(self._power_session(on), timeout=40))
                with self.lock:
                    if self.requested_on == on:
                        self.on = observed
                        self.power_known = True
                        self.last_sent = None
                        if on:
                            self.refresh_event.set()
                self._ble_ok()
        except Exception as error:
            with self.lock:
                if self.requested_on == on:
                    self._ble_failed(error)
                    self.power_known = False
                    # Deja ver el aviso unos segundos antes del reintento automático.
                    self.retry_at = time.monotonic() + 8
        finally:
            with self.lock:
                if self.requested_on == on:
                    self.busy = False

    def _sync_strip(self):
        with self.lock:
            if self.carousel_enabled or not self.on or not self.requested_on or not self.quotes:
                return
            colors = self._pro_color_masks()
            if colors == self.last_sent:
                return
            config = self.config
            version = self.portfolio_version
        try:
            with self.ble_lock:
                with self.lock:
                    if not self.on or not self.requested_on or version != self.portfolio_version:
                        return
                asyncio.run(update_led_strip(config, colors, self._address()))
            with self.lock:
                self.last_sent = colors
                self.last_led_update = datetime.now(timezone.utc).isoformat()
            self._ble_ok()
        except Exception as error:
            self._ble_failed(error)

    def _schedule_alerts(self, found):
        events = []
        with self.lock:
            for asset in self.config["portfolio"]:
                quote = found.get(asset["symbol"])
                if not quote or quote.get("stale"):
                    continue
                crossed = self.alerts.observe(
                    asset["symbol"], quote.get("session_date"), quote.get("change_pct"),
                )
                if self.pro["enabled"] and self.pro["targets"].get(asset["symbol"], {}).get("hit"):
                    continue
                if (self.carousel_enabled or not self.alerts_enabled or not self.power_known
                        or not self.on or not self.requested_on):
                    continue
                mask = sum(1 << segment for segment in asset["segments"])
                for key, level in crossed:
                    self.alerts.pending.add(key)
                    events.append((key, level, mask))
            version = self.portfolio_version
        if events:
            self.alert_worker.submit(self._flash_alerts, events, version)

    def _flash_alerts(self, events, version):
        async def run():
            config = self.config
            async with BleakClient(self._address(), timeout=12.0) as client:
                for key, level, mask in events:
                    with self.lock:
                        active = (self.alerts_enabled and self.on and self.requested_on
                                  and version == self.portfolio_version and not self.stop_event.is_set())
                    if not active:
                        break
                    rgb = ambient_rgb(hex_to_rgb(config["colors"]["verde" if level > 0 else "rojo"]), level, self.pro)
                    restore = build_segment_packet(*rgb, mask)
                    try:
                        for _ in range(abs(level)):
                            await client.write_gatt_char(
                                config["characteristic_uuid"], build_segment_packet(0, 0, 0, mask), response=False,
                            )
                            await asyncio.sleep(0.5)
                            await client.write_gatt_char(config["characteristic_uuid"], restore, response=False)
                            await asyncio.sleep(0.5)
                    finally:
                        await client.write_gatt_char(config["characteristic_uuid"], restore, response=False)
                    with self.lock:
                        self.alerts.fired.add(key)
                        self.alerts.pending.discard(key)

        try:
            with self.ble_lock:
                asyncio.run(run())
        except Exception as error:
            self._ble_failed(error, "Destellos")
            with self.lock:
                self.last_sent = None
        finally:
            with self.lock:
                for key, _, _ in events:
                    self.alerts.pending.discard(key)
            self._save_alerts()

    def _carousel_loop(self):
        was_active = False
        while not self.stop_event.is_set():
            with self.lock:
                active = self.carousel_enabled and self.power_known and self.on and self.requested_on and not self.busy
            if not active:
                if was_active:
                    with self.lock:
                        self.carousel_current_symbol = None
                        self.carousel_position = -1
                        self.carousel_window_start = 0
                        self.last_sent = None
                    self._sync_strip()
                    was_active = False
                self.stop_event.wait(0.25)
                continue
            was_active = True
            try:
                with self.ble_lock:
                    asyncio.run(self._carousel_session())
            except Exception as error:
                self._ble_failed(error, "Carrusel")
                with self.lock:
                    self.last_sent = None
                self.stop_event.wait(1.5)

    async def _carousel_session(self):
        config = self.config
        async with BleakClient(self._address(), timeout=12.0) as client:
            await client.write_gatt_char(
                config["characteristic_uuid"], build_segment_packet(0, 0, 0, 0x7FFF), response=False,
            )
            window_start = 0
            shift = 0
            while not self.stop_event.is_set():
                with self.lock:
                    if not (self.carousel_enabled and self.power_known and self.on and self.requested_on):
                        break
                    assets = list(self.carousel_assets)
                if not assets:
                    break
                route = build_carousel_route(assets, window_start, shift)
                masks = {"rojo": 0, "verde": 0, "sin datos": 0}
                with self.lock:
                    for position, asset in enumerate(route):
                        if asset is None:
                            masks["sin datos"] |= 1 << position
                            continue
                        quote = self.quotes.get(asset["symbol"], {})
                        value = quote.get("change_pct")
                        color = "rojo" if isinstance(value, (int, float)) and value < 0 else "verde" if isinstance(value, (int, float)) else "sin datos"
                        masks[color] |= 1 << position
                    self.carousel_position = shift
                    self.carousel_window_start = window_start
                    self.carousel_current_symbol = route[0]["symbol"] if route[0] is not None else None
                for color in ("rojo", "verde", "sin datos"):
                    mask = masks[color]
                    if mask:
                        rgb = ambient_rgb(hex_to_rgb(config["colors"][color]), 0, self.pro)
                        await client.write_gatt_char(
                            config["characteristic_uuid"], build_segment_packet(*rgb, mask), response=False,
                        )
                        await asyncio.sleep(0.025)
                await asyncio.sleep(1.2)
                shift += 1
                if shift == 15:
                    shift = 0
                    if len(assets) > 15:
                        window_start = (window_start + 1) % len(assets)

    def history(self, symbol, range_name):
        if range_name not in HISTORY_RANGES:
            raise ValueError("Periodo desconocido")
        with self.lock:
            if symbol not in {asset["symbol"] for asset in self.config["portfolio"]}:
                raise ValueError("Empresa desconocida")
            real = [asset for asset in self.config["portfolio"] if asset["symbol"] != PORTFOLIO_SYMBOL]
        if symbol == PORTFOLIO_SYMBOL:
            with ThreadPoolExecutor(max_workers=3) as pool:
                series = list(pool.map(lambda asset: self.history(asset["symbol"], range_name)["points"], real))
            points = average_history(series, weights_for(self.config["portfolio"], self.pro))
            if len(points) < 2:
                raise ValueError("No hay suficientes cierres para la media de cartera")
            return {"symbol": symbol, "range": range_name, "points": points}
        years = 5 if range_name == "5Y" else 2
        key = (symbol, years)
        with self.history_lock:
            entry = self.history_cache.get(key)
        if entry is None or time.monotonic() - entry[0] > 600:
            fresh = (time.monotonic(), fetch_history(symbol, years))
            with self.history_lock:
                entry = self.history_cache.setdefault(key, fresh) if entry is None else fresh
                self.history_cache[key] = entry
        points = entry[1]
        cutoff = datetime.fromisoformat(points[-1]["time"]).date() - timedelta(
            days=HISTORY_RANGES[range_name]
        )
        visible = [point for point in points if datetime.fromisoformat(point["time"]).date() >= cutoff]
        return {"symbol": symbol, "range": range_name, "points": visible}

    def events(self, symbol):
        if symbol == PORTFOLIO_SYMBOL:
            return {"symbol": symbol, "dividends": [], "earnings": [], "dividends_available": False, "earnings_available": False, "next_dividend": None}
        with self.lock:
            if symbol not in {asset["symbol"] for asset in self.config["portfolio"]}:
                raise ValueError("Empresa desconocida")
            quote = self.quotes.get(symbol) or {}
            price = quote.get("price")
        with self.events_lock:
            entry = self.events_cache.get(symbol)
            if entry is None or time.monotonic() - entry[0] > 1800:
                entry = (time.monotonic(), fetch_events(symbol))
                self.events_cache[symbol] = entry
        data = entry[1]
        last_amount = data["dividends"][-1]["amount"] if data["dividends"] else None
        estimate = round(last_amount / price * 100, 3) if data["next_date"] and last_amount and isinstance(price, (int, float)) and price > 0 else None
        return {
            "symbol": symbol, "dividends": data["dividends"], "earnings": data["earnings"],
            "dividends_available": data["dividends_available"], "earnings_available": data["earnings_available"],
            "next_dividend": {"date": data["next_date"], "estimated_percent": estimate} if data["next_date"] else None,
        }

    def search(self, term):
        if not isinstance(term, str) or not 2 <= len(term.strip()) <= 50:
            raise ValueError("Escribe al menos dos letras para buscar")
        key = term.strip().casefold()
        with self.search_lock:
            entry = self.search_cache.get(key)
            if entry and time.monotonic() - entry[0] < 300:
                return entry[1]
        results = search_equities(term.strip())
        with self.search_lock:
            if len(self.search_cache) >= 50:
                self.search_cache.clear()
            self.search_cache[key] = (time.monotonic(), results)
        return results

    def save_portfolio(self, requested, expected_revision):
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise ValueError("Falta la versión de la cartera; vuelve a abrir el editor")
        if not isinstance(requested, list) or not 1 <= len(requested) <= 15:
            raise ValueError("Elige entre 1 y 15 empresas para esta tira")
        with self.config_file_lock:
            current_bytes = CONFIG_PATH.read_bytes()
            if hashlib.sha256(current_bytes).hexdigest() != expected_revision:
                raise PortfolioConflict("La cartera cambió desde que abriste el editor. Cierra y vuelve a abrir para no perder cambios")
            current = json.loads(current_bytes)
            previous = {asset["symbol"]: asset for asset in current["portfolio"]}
            portfolio = []
            for item in requested:
                if not isinstance(item, dict):
                    raise ValueError("Empresa inválida")
                symbol = item.get("symbol")
                segments = item.get("segments")
                if not isinstance(symbol, str) or not isinstance(segments, list):
                    raise ValueError("Cada empresa necesita un símbolo y segmentos")
                if symbol in previous:
                    asset = {**previous[symbol], "segments": segments}
                elif symbol == PORTFOLIO_SYMBOL:
                    asset = {"symbol": PORTFOLIO_SYMBOL, "name": "Mi cartera", "market": PORTFOLIO_MARKET, "exchange": "MEDIA EQUIPONDERADA", "segments": segments}
                else:
                    try:
                        match = next((entry for entry in self.search(symbol) if entry["symbol"] == symbol), None)
                    except Exception as error:
                        raise ValueError(f"No pude verificar {symbol} ahora. Inténtalo de nuevo") from error
                    if match is None:
                        raise ValueError(f"No pude verificar {symbol} como acción de Madrid o EE. UU.")
                    asset = {
                        "symbol": match["symbol"], "name": match["name"],
                        "market": match["market"], "exchange": match["exchange"],
                        "segments": segments,
                    }
                portfolio.append(asset)
            candidate = {**current, "portfolio": portfolio}
            validate_config(candidate)
            if CONFIG_PATH.read_bytes() != current_bytes:
                raise PortfolioConflict("La configuración cambió mientras guardabas. Vuelve a abrir el editor")
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=CONFIG_PATH.parent,
                    prefix=".config-", suffix=".json", delete=False,
                ) as temporary:
                    temporary_path = Path(temporary.name)
                    json.dump(candidate, temporary, ensure_ascii=False, indent=2)
                    temporary.write("\n")
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, CONFIG_PATH)
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
            with self.lock:
                self.config = candidate
                self.pro = reconcile_portfolio(self.pro, [asset["symbol"] for asset in portfolio if asset["symbol"] != PORTFOLIO_SYMBOL])
                self.portfolio_version += 1
                self.last_sent = None
                self.market_error = None
            self._save_pro()
            self.refresh_event.set()
        return self.snapshot()

    def _market_loop(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            with self.lock:
                self.loading = True
            try:
                with self.config_file_lock:
                    config = load_config()
                    with self.lock:
                        self.config = config
                        version = self.portfolio_version
                        carousel_assets = list(getattr(self, "carousel_assets", []))
                found = {}
                unavailable = []
                market_assets = list(config["portfolio"])
                present = {asset["symbol"] for asset in market_assets}
                market_assets.extend(asset for asset in carousel_assets if asset["symbol"] not in present)
                with ThreadPoolExecutor(max_workers=3) as pool:
                    tasks = {
                        pool.submit(fetch_quote, asset): asset["symbol"]
                        for asset in market_assets if asset["symbol"] != PORTFOLIO_SYMBOL
                    }
                    for task in as_completed(tasks):
                        symbol = tasks[task]
                        try:
                            found[symbol] = task.result()
                        except Exception as error:
                            with self.lock:
                                old = self.quotes.get(symbol)
                            if old is not None:
                                found[symbol] = {**old, "stale": True}
                            else:
                                unavailable.append(symbol)
                if any(asset["symbol"] == PORTFOLIO_SYMBOL for asset in config["portfolio"]):
                    found[PORTFOLIO_SYMBOL] = average_intraday_quote(config["portfolio"], found, self.pro)
                with self.lock:
                    if version != self.portfolio_version:
                        self.refresh_event.set()
                        continue
                    # Keep cached symbols even when temporarily absent from the active
                    # portfolio, and replace only symbols successfully refreshed.
                    self.quotes = {**self.quotes, **found}
                    self.last_fetch = datetime.now(timezone.utc).isoformat()
                    self.market_error = (
                        "Sin datos nuevos: " + ", ".join(unavailable) if unavailable else None
                    )
                    cache_snapshot = dict(self.quotes)
                save_quote_cache(cache_snapshot, getattr(self, "quote_cache_path", QUOTE_CACHE_PATH))
                self._update_target_hits(found)
                self._sync_strip()
                if hasattr(self, "alerts"):
                    self._schedule_alerts(found)
            except Exception as error:
                with self.lock:
                    self.market_error = str(error)
            finally:
                with self.lock:
                    self.loading = False
            remaining = max(5, 60 - (time.monotonic() - started))
            self.refresh_event.wait(remaining)
            self.refresh_event.clear()

    def close(self):
        self.stop_event.set()
        self.refresh_event.set()
        self.connect_event.set()
        self.alert_worker.shutdown(wait=False, cancel_futures=True)
        with self.lock:
            was_on = self.on
            self.requested_on = False
        if was_on:
            self._write_power(False)


class Handler(BaseHTTPRequestHandler):
    service = None
    allowed_hosts = {"localhost", "127.0.0.1"}
    lan_mode = False
    lan_subnet = None

    def _json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _local_host(self):
        try:
            host = urlparse("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        if host not in self.allowed_hosts:
            return False
        peer = ipaddress.ip_address(self.client_address[0])
        return peer.is_loopback or (self.lan_mode and self.lan_subnet is not None and peer in self.lan_subnet)

    def _prefers_english(self):
        language = self.headers.get("Accept-Language", "").split(",", 1)[0].split(";", 1)[0].strip().lower()
        return language == "en" or language.startswith("en-")

    def do_GET(self):
        if not self._local_host():
            self._json({"error": "Disponible en este Mac o en su red Wi-Fi si se activa --lan"}, 403)
            return
        path = unquote(urlparse(self.path).path)
        if path == "/api/state":
            self._json(self.service.snapshot())
            return
        if path == "/api/history":
            query = parse_qs(urlparse(self.path).query)
            symbol = query.get("symbol", [""])[0]
            range_name = query.get("range", [""])[0]
            try:
                self._json(self.service.history(symbol, range_name))
            except ValueError as error:
                self._json({"error": str(error)}, 400)
            except Exception as error:
                self._json({"error": f"No pude cargar el histórico: {error}"}, 502)
            return
        if path == "/api/events":
            symbol = parse_qs(urlparse(self.path).query).get("symbol", [""])[0]
            try:
                self._json(self.service.events(symbol))
            except ValueError as error:
                self._json({"error": str(error)}, 400)
            except Exception:
                self._json({"error": "No pude consultar los eventos de esta empresa"}, 502)
            return
        if path == "/api/search":
            term = parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                self._json({"results": self.service.search(term)})
            except ValueError as error:
                self._json({"error": str(error)}, 400)
            except Exception:
                self._json({"error": "La búsqueda no está disponible ahora. Inténtalo de nuevo"}, 502)
            return
        if path == "/health":
            self._json({"ok": True})
            return
        if path == "/" and self._prefers_english():
            self.send_response(302)
            self.send_header("Location", "/en/")
            self.send_header("Vary", "Accept-Language")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        relative_path = path.lstrip("/") or "index.html"
        if path.endswith("/") and path != "/":
            relative_path += "index.html"
        target = (WEB_ROOT / relative_path).resolve()
        if not target.is_relative_to(WEB_ROOT) or not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._local_host():
            self._json({"error": "Disponible en este Mac o en su red Wi-Fi si se activa --lan"}, 403)
            return
        path = urlparse(self.path).path
        if path not in {"/api/power", "/api/connect", "/api/portfolio", "/api/alerts", "/api/carousel", "/api/pro"}:
            self._json({"error": "Ruta desconocida"}, 404)
            return
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc not in {self.headers.get("Host")}:
            self._json({"error": "Origen no permitido"}, 403)
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self._json({"error": "Se espera JSON"}, 415)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (16384 if path in {"/api/portfolio", "/api/carousel", "/api/pro"} else 1024):
                raise ValueError("Petición demasiado grande o vacía")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Se espera un objeto JSON")
            if path == "/api/portfolio":
                try:
                    self._json(self.service.save_portfolio(body.get("portfolio"), body.get("revision")))
                except PortfolioConflict as error:
                    self._json({"error": str(error)}, 409)
                except ValueError as error:
                    self._json({"error": str(error)}, 400)
                except OSError:
                    self._json({"error": "No pude guardar la cartera en el Mac"}, 500)
                except Exception:
                    self._json({"error": "No pude guardar la cartera. Inténtalo de nuevo"}, 500)
                return
            if path == "/api/alerts":
                self._json(self.service.set_alerts(body.get("enabled")))
                return
            if path == "/api/connect":
                if not self.service.reconnect(body.get("forget") is True):
                    self._json({"error": "La tira está ocupada; espera un momento"}, 409)
                    return
                self._json(self.service.snapshot())
                return
            if path == "/api/pro":
                try:
                    self._json(self.service.set_pro(body))
                except ValueError as error:
                    self._json({"error": str(error)}, 400)
                except OSError:
                    self._json({"error": "No pude guardar los ajustes Pro"}, 500)
                return
            if path == "/api/carousel":
                try:
                    self._json(self.service.set_carousel(body.get("enabled"), body.get("symbols")))
                except ValueError as error:
                    self._json({"error": str(error)}, 400)
                except OSError:
                    self._json({"error": "No pude guardar la lista del carrusel"}, 500)
                return
            if type(body.get("on")) is not bool:
                raise ValueError("on debe ser verdadero o falso")
        except (ValueError, AttributeError, json.JSONDecodeError) as error:
            self._json({"error": str(error)}, 400)
            return
        if not self.service.set_power(body["on"]):
            self._json({"error": "La tira sigue ocupada; inténtalo de nuevo"}, 409)
            return
        self._json(self.service.snapshot())

    def log_message(self, format_string, *args):
        if not self.path.startswith("/api/state"):
            super().log_message(format_string, *args)


def main():
    parser = argparse.ArgumentParser(description="Web local de la tira Govee")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--lan", action="store_true", help="Permite abrir la página desde un móvil en la misma Wi-Fi")
    args = parser.parse_args()
    lan = lan_address() if args.lan else None
    if args.lan and not lan:
        parser.exit(1, "No encontré una dirección de red local. Conecta el Mac a la Wi-Fi e inténtalo de nuevo.\n")
    lan_ip, lan_subnet = lan if lan else (None, None)
    try:
        server = ThreadingHTTPServer(("0.0.0.0" if args.lan else "127.0.0.1", args.port), Handler)
    except OSError as error:
        parser.exit(1, f"No pude abrir el puerto {args.port}: {error}. Cierra la versión anterior con Control+C.\n")
    try:
        service = StripDashboard()
    except Exception:
        server.server_close()
        raise
    Handler.service = service
    Handler.lan_mode = args.lan
    Handler.lan_subnet = lan_subnet
    Handler.allowed_hosts = {"localhost", "127.0.0.1"} | ({lan_ip} if lan_ip else set())
    url = f"http://127.0.0.1:{args.port}"
    print(f"Página lista: {url}")
    if lan_ip:
        print(f"En tu móvil, conectado a la misma Wi-Fi: http://{lan_ip}:{args.port}")
        print("Usa --lan solo en una red de confianza. Si macOS pregunta, permite conexiones entrantes.")
    print("Control+C para cerrar la página y apagar la tira.")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.close()


if __name__ == "__main__":
    main()
