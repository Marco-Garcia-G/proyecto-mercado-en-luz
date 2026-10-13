"""Pruebas sin Bluetooth ni cambios en la configuración del usuario."""

import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pandas as pd
import web_server
from pro_features import ambient_rgb, default_settings, night_active, target_hit, validate_settings


class OneCycleEvent:
    def __init__(self):
        self.checks = 0

    def is_set(self):
        self.checks += 1
        return self.checks > 1

    def wait(self, _seconds):
        return False

    def clear(self):
        pass


class CarouselRouteTests(unittest.TestCase):
    def test_fifteen_zones_are_split_evenly_and_keep_order(self):
        assets = [{"symbol": chr(65 + index)} for index in range(4)]
        route = web_server.build_carousel_route(assets)
        self.assertEqual(len(route), 15)
        self.assertEqual([route.count(asset) for asset in assets], [4, 4, 4, 3])

    def test_queue_brings_later_companies_into_the_route(self):
        assets = [{"symbol": f"S{index}"} for index in range(16)]
        first = web_server.build_carousel_route(assets, window_start=0)
        next_lap = web_server.build_carousel_route(assets, window_start=1)
        self.assertEqual(len({asset["symbol"] for asset in first}), 15)
        self.assertEqual(len({asset["symbol"] for asset in next_lap}), 15)
        self.assertNotIn(assets[15], first)
        self.assertIn(assets[15], next_lap)

    def test_route_moves_one_zone_without_changing_allocations(self):
        assets = [{"symbol": chr(65 + index)} for index in range(4)]
        first = web_server.build_carousel_route(assets, shift=0)
        shifted = web_server.build_carousel_route(assets, shift=1)
        self.assertEqual(shifted, [first[-1], *first[:-1]])


class DashboardTests(unittest.TestCase):
    def test_carousel_reordering_reuses_known_companies(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = web_server.StripDashboard.__new__(web_server.StripDashboard)
            service.lock = threading.RLock()
            service.search_lock = threading.Lock()
            service.search_cache = {}
            service.config = {"portfolio": [{"symbol": "GOOG", "name": "Alphabet", "market": "US", "exchange": "NASDAQ", "segments": [0]}]}
            service.carousel_assets = [{"symbol": "SPCX", "name": "SpaceX", "market": "US", "exchange": "NASDAQ"}]
            service.refresh_event = Mock()
            service.search = Mock(side_effect=AssertionError("No debería volver a buscar un símbolo conocido"))
            service.snapshot = Mock(return_value={"saved": True})
            path = Path(temporary) / "carousel.json"

            with patch.object(web_server, "CAROUSEL_PATH", path):
                self.assertEqual(service.set_carousel(True, ["GOOG", "SPCX"]), {"saved": True})

            self.assertEqual([asset["symbol"] for asset in service.carousel_assets], ["GOOG", "SPCX"])
            self.assertTrue(service.carousel_enabled)
            service.search.assert_not_called()

    def test_carousel_quote_does_not_require_fixed_segments(self):
        asset = {"symbol": "NVDA", "name": "NVIDIA", "market": "US", "exchange": "NASDAQ"}
        candles = pd.DataFrame(
            {"Close": [100.0, 102.0], "Volume": [50, 60]},
            index=pd.DatetimeIndex(["2026-09-23T15:00:00Z", "2026-09-24T15:00:00Z"]),
        )
        ticker = Mock()
        ticker.history.return_value = candles
        with patch.object(web_server.yf, "Ticker", return_value=ticker):
            quote = web_server.fetch_quote(asset)

        self.assertEqual(quote["segments"], [])
        self.assertEqual(quote["change_pct"], 2.0)

    def test_quote_lookup_falls_back_to_daily_data(self):
        asset = {"symbol": "NVDA", "name": "NVIDIA", "market": "US"}
        daily = pd.DataFrame(
            {"Close": [100.0, 103.0], "Volume": [50, 60]},
            index=pd.DatetimeIndex(["2026-09-23T00:00:00Z", "2026-09-24T00:00:00Z"]),
        )
        ticker = Mock()
        ticker.history.side_effect = [OSError("intraday data unavailable"), daily]
        with patch.object(web_server.yf, "Ticker", return_value=ticker):
            quote = web_server.fetch_quote(asset)

        self.assertEqual(quote["resolution"], "daily")
        self.assertEqual(quote["segments"], [])
        self.assertEqual(quote["change_pct"], 3.0)

    def test_quote_cache_survives_restart_and_is_marked_stale(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "quotes.json"
            quote = {
                "symbol": "NVDA", "price": 120.5, "previous_close": 118.0,
                "change_pct": 2.1186, "session_date": "2026-09-23",
                "asof": "2026-09-23T20:00:00+00:00", "stale": False,
            }
            web_server.save_quote_cache({"NVDA": quote}, path)

            restored = web_server.load_quote_cache(path)

            self.assertEqual(restored["NVDA"]["change_pct"], 2.1186)
            self.assertTrue(restored["NVDA"]["stale"])

    def test_quote_cache_ignores_invalid_and_incomplete_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "quotes.json"
            path.write_text(json.dumps({
                "NO_PRICE": {"change_pct": 1},
                "NAN": {"price": 10, "change_pct": float("nan")},
            }), encoding="utf-8")

            self.assertEqual(web_server.load_quote_cache(path), {})

    def test_portfolio_average_counts_each_company_once(self):
        assets = [
            {"symbol": "A", "segments": [0, 1]},
            {"symbol": "B", "segments": [2]},
            {"symbol": "PORTFOLIO", "segments": [3]},
        ]
        quotes = {
            "A": {"change_pct": 10, "previous_close": 10, "session_date": "2026-09-22", "asof": "2026-09-22T10:00:00+00:00", "points": [{"time": "2026-09-22T10:00:00+00:00", "price": 11}]},
            "B": {"change_pct": -10, "previous_close": 20, "session_date": "2026-09-22", "asof": "2026-09-22T10:00:00+00:00", "points": [{"time": "2026-09-22T10:00:00+00:00", "price": 18}]},
        }
        average = web_server.average_intraday_quote(assets, quotes)
        self.assertEqual(average["change_pct"], 0)
        self.assertEqual(average["price"], 100)
        self.assertEqual(average["points"][-1]["price"], 100)

    def test_portfolio_average_does_not_hide_missing_company(self):
        assets = [{"symbol": "A"}, {"symbol": "B"}]
        average = web_server.average_intraday_quote(assets, {"A": {"change_pct": 4}})
        self.assertIsNone(average["change_pct"])
        self.assertIsNone(average["price"])

    def test_weighted_average_uses_companies_not_segments(self):
        settings = default_settings()
        settings["enabled"] = True
        settings["average"] = {"mode": "weighted", "weights": {"A": 80, "B": 20}}
        assets = [{"symbol": "A", "segments": [0, 1, 2]}, {"symbol": "B", "segments": [3]}]
        quotes = {"A": {"change_pct": 10}, "B": {"change_pct": -10}}
        self.assertEqual(web_server.average_intraday_quote(assets, quotes, settings)["change_pct"], 6)
        validate_settings(settings, ["A", "B"])

    def test_weighted_intraday_chart_ends_at_weighted_percentage(self):
        settings = default_settings()
        settings["enabled"] = True
        settings["average"] = {"mode": "weighted", "weights": {"A": 80, "B": 20}}
        assets = [{"symbol": "A"}, {"symbol": "B"}, {"symbol": "PORTFOLIO"}]
        quotes = {
            "A": {"change_pct": 10, "previous_close": 10, "session_date": "2026-09-22", "points": [{"time": "2026-09-22T10:00:00+00:00", "price": 11}]},
            "B": {"change_pct": -10, "previous_close": 20, "session_date": "2026-09-22", "points": [{"time": "2026-09-22T10:00:00+00:00", "price": 18}]},
        }
        average = web_server.average_intraday_quote(assets, quotes, settings)
        self.assertEqual(average["change_pct"], 6)
        self.assertEqual(average["points"][-1]["price"], 106)

    def test_weighted_average_requires_exactly_one_hundred_percent(self):
        settings = default_settings()
        settings["enabled"] = True
        settings["average"] = {"mode": "weighted", "weights": {"A": 50, "B": 49.99}}
        with self.assertRaisesRegex(ValueError, "100 %"):
            validate_settings(settings, ["A", "B"])
        settings["average"]["weights"]["B"] = 50.01
        with self.assertRaisesRegex(ValueError, "100 %"):
            validate_settings(settings, ["A", "B"])
        settings["average"]["weights"]["B"] = 50
        self.assertEqual(validate_settings(settings, ["A", "B"])["average"]["weights"], {"A": 50, "B": 50})

    def test_weighted_history_uses_the_same_allocation(self):
        first = [{"time": "2026-09-21", "price": 10}, {"time": "2026-09-22", "price": 11}]
        second = [{"time": "2026-09-21", "price": 20}, {"time": "2026-09-22", "price": 18}]
        result = web_server.average_history([first, second], [.8, .2])
        self.assertEqual([point["price"] for point in result], [100, 106])

    def test_target_latches_and_ambient_does_not_change_global_brightness(self):
        target = {"sell": 110.0, "stop": 90.0, "hit": None, "acknowledged": False}
        self.assertEqual(target_hit(target, {"price": 111, "stale": False}), "sell")
        self.assertIsNone(target_hit(target, {"price": 111, "stale": True}))
        target["hit"] = "sell"
        self.assertIsNone(target_hit(target, {"price": 112, "stale": False}))
        settings = default_settings()
        settings["enabled"] = settings["ambient"]["enabled"] = True
        settings["ambient"]["night"] = True
        self.assertTrue(night_active(settings["ambient"]))
        self.assertEqual(ambient_rgb((255, 0, 0), 2, settings), (59, 0, 0))

    def test_portfolio_history_carries_close_across_different_holidays(self):
        first = [{"time": "2026-09-21", "price": 10}, {"time": "2026-09-22", "price": 11}, {"time": "2026-09-23", "price": 11}]
        second = [{"time": "2026-09-21", "price": 20}, {"time": "2026-09-23", "price": 18}]
        result = web_server.average_history([first, second])
        self.assertEqual([point["price"] for point in result], [100, 105, 100])

    def test_alerts_cross_once_per_limit_and_session(self):
        alerts = web_server.ThresholdAlerts()
        self.assertEqual(alerts.observe("AAPL", "2026-09-23", 0.2), [])
        self.assertEqual(alerts.observe("AAPL", "2026-09-23", 2.1), [
            ("AAPL|2026-09-23|1", 1), ("AAPL|2026-09-23|2", 2),
        ])
        alerts.fired.update(("AAPL|2026-09-23|1", "AAPL|2026-09-23|2"))
        self.assertEqual(alerts.observe("AAPL", "2026-09-23", 0.1), [])
        self.assertEqual(alerts.observe("AAPL", "2026-09-23", 2.1), [])
        self.assertEqual(alerts.observe("AAPL", "2026-09-23", -1.1), [
            ("AAPL|2026-09-23|-1", -1),
        ])
        self.assertEqual(alerts.observe("AAPL", "2026-09-24", 2.1), [])
        self.assertEqual(alerts.observe("AAPL", "2026-09-24", 3.1), [
            ("AAPL|2026-09-24|3", 3),
        ])

    def test_alert_setting_is_saved_separately_from_portfolio(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "alerts.json"
            service = web_server.StripDashboard.__new__(web_server.StripDashboard)
            service.lock = threading.RLock()
            service.alert_file_lock = threading.Lock()
            service.alerts_enabled = False
            service.alerts = web_server.ThresholdAlerts()
            service.pro = web_server.default_settings()
            service._save_pro = Mock()
            service.snapshot = Mock(return_value={"alerts_enabled": True})
            with patch.object(web_server, "ALERTS_PATH", path):
                self.assertEqual(service.set_alerts(True), {"alerts_enabled": True})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["enabled"], True)

    def test_bluetooth_failure_does_not_claim_power_changed(self):
        service = web_server.StripDashboard.__new__(web_server.StripDashboard)
        service.lock = threading.RLock()
        service.ble_lock = threading.Lock()
        service.requested_on = False
        service.on = True
        service.power_known = True
        service.busy = True
        service.ble_error = None
        service._power_session = AsyncMock(side_effect=RuntimeError("sin confirmación"))

        service._write_power(False)

        self.assertTrue(service.on)
        self.assertFalse(service.power_known)
        self.assertFalse(service.busy)
        self.assertIn("sin confirmación", service.ble_error)

    def test_quote_failure_keeps_previous_value_as_stale(self):
        service = web_server.StripDashboard.__new__(web_server.StripDashboard)
        service.lock = threading.RLock()
        service.config_file_lock = threading.RLock()
        service.stop_event = OneCycleEvent()
        service.refresh_event = OneCycleEvent()
        service.portfolio_version = 0
        service.config = {"portfolio": [{"symbol": "TEST"}]}
        service.quotes = {"TEST": {
            "symbol": "TEST", "price": 12, "previous_close": 10,
            "change_pct": 20, "stale": False,
        }}
        service.last_fetch = None
        service.market_error = None
        service.pro = web_server.default_settings()
        service._sync_strip = Mock()

        with patch.object(web_server, "load_config", return_value=service.config), \
             patch.object(web_server, "fetch_quote", side_effect=OSError("sin conexión")), \
             patch.object(web_server, "save_quote_cache"):
            service._market_loop()

        self.assertEqual(service.quotes["TEST"]["price"], 12)
        self.assertTrue(service.quotes["TEST"]["stale"])
        self.assertIsNone(service.market_error)

    def test_conflicting_portfolio_cannot_overwrite_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            original = {"portfolio": [{"symbol": "TEST", "name": "Test", "market": "US", "segments": [0]}]}
            path.write_text(json.dumps(original), encoding="utf-8")
            service = web_server.StripDashboard.__new__(web_server.StripDashboard)
            service.config_file_lock = threading.RLock()

            with patch.object(web_server, "CONFIG_PATH", path):
                with self.assertRaises(web_server.PortfolioConflict):
                    service.save_portfolio([{"symbol": "TEST", "segments": [1]}], "0" * 64)

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), original)

    def test_portfolio_save_updates_only_validated_draft(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            original = {"portfolio": [{"symbol": "TEST", "name": "Test", "market": "US", "segments": [0]}]}
            path.write_text(json.dumps(original), encoding="utf-8")
            revision = hashlib.sha256(path.read_bytes()).hexdigest()
            service = web_server.StripDashboard.__new__(web_server.StripDashboard)
            service.lock = threading.RLock()
            service.config_file_lock = threading.RLock()
            service.config = original
            service.portfolio_version = 0
            service.quotes = {}
            service.pro = web_server.default_settings()
            service._save_pro = Mock()
            service.last_sent = "old"
            service.market_error = "old"
            service.refresh_event = Mock()
            service.snapshot = Mock(return_value={"saved": True})

            with patch.object(web_server, "CONFIG_PATH", path), \
                 patch.object(web_server, "validate_config") as validate:
                result = service.save_portfolio([{"symbol": "TEST", "segments": [1]}], revision)

            self.assertEqual(result, {"saved": True})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["portfolio"][0]["segments"], [1])
            self.assertEqual(service.portfolio_version, 1)
            self.assertIsNone(service.last_sent)
            validate.assert_called_once()
            service.refresh_event.set.assert_called_once()

    def test_portfolio_average_can_take_a_duplicate_segment(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            config = {
                "brightness": 100,
                "colors": {"rojo": "#FF0000", "verde": "#00FF00", "sin datos": "#000000"},
                "open_interval_seconds": 60,
                "closed_interval_seconds": 600,
                "ble_retry_seconds": [5],
                "portfolio": [{"symbol": "TEST", "name": "Test", "market": "US", "segments": [0, 1]}],
            }
            path.write_text(json.dumps(config), encoding="utf-8")
            revision = hashlib.sha256(path.read_bytes()).hexdigest()
            service = web_server.StripDashboard.__new__(web_server.StripDashboard)
            service.lock = threading.RLock()
            service.config_file_lock = threading.RLock()
            service.config = config
            service.portfolio_version = 0
            service.quotes = {}
            service.pro = web_server.default_settings()
            service._save_pro = Mock()
            service.last_sent = None
            service.market_error = None
            service.refresh_event = Mock()
            service.snapshot = Mock(return_value={"saved": True})
            with patch.object(web_server, "CONFIG_PATH", path):
                result = service.save_portfolio([
                    {"symbol": "TEST", "segments": [1]},
                    {"symbol": "PORTFOLIO", "segments": [0]},
                ], revision)
            self.assertEqual(result, {"saved": True})
            saved = json.loads(path.read_text(encoding="utf-8"))["portfolio"]
            self.assertEqual(saved[1]["market"], "AVG")
            self.assertEqual(saved[1]["segments"], [0])

    def test_event_source_failure_is_not_reported_as_no_dividends(self):
        ticker = Mock()
        ticker.history.side_effect = OSError("sin red")
        ticker.get_earnings_dates.side_effect = OSError("sin red")
        ticker.calendar = {}
        with patch.object(web_server.yf, "Ticker", return_value=ticker):
            result = web_server.fetch_events("TEST")
        self.assertFalse(result["dividends_available"])
        self.assertFalse(result["earnings_available"])


if __name__ == "__main__":
    unittest.main()
