import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import market_govee
from bleak.exc import BleakDeviceNotFoundError, BleakError


def advertised(address, name, rssi):
    return (SimpleNamespace(address=address, name=None), SimpleNamespace(local_name=name, rssi=rssi))


class FakeClient:
    """Cliente bleak mínimo: falla al conectar con las direcciones indicadas."""

    missing = set()

    def __init__(self, address, timeout):
        self.address = address
        self.name = None

    async def connect(self):
        if self.address in self.missing:
            raise BleakDeviceNotFoundError(self.address)


class DiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.device_path = Path(self.directory.name) / "device.json"
        self.config = {"model": "H617A"}
        FakeClient.missing = set()

    def tearDown(self):
        self.directory.cleanup()

    def test_matches_govee_advertised_names(self):
        self.assertTrue(market_govee.matches_model("ihoment_H617A_1A2B", "H617A"))
        self.assertTrue(market_govee.matches_model("Govee_H617A_5D33", "h617a"))
        self.assertFalse(market_govee.matches_model("Govee_H6199_5D33", "H617A"))
        self.assertFalse(market_govee.matches_model(None, "H617A"))

    def test_discovery_orders_same_model_strips_by_signal(self):
        found = dict([
            ("a", advertised("A", "ihoment_H617A_AAAA", -80)),
            ("b", advertised("B", "Govee_H617A_BBBB", -45)),
            ("c", advertised("C", "Govee_H6199_CCCC", -30)),
            ("d", advertised("D", None, -20)),
        ])
        with patch.object(market_govee.BleakScanner, "discover", AsyncMock(return_value=found)):
            strips = asyncio.run(market_govee.discover_strips("H617A", timeout=0))
        self.assertEqual([strip["address"] for strip in strips], ["B", "A"])

    def test_first_connection_searches_and_remembers_nearest_strip(self):
        strips = [{"address": "NEAR", "name": "Govee_H617A_1111", "rssi": -40}]
        phases = []
        with patch.object(market_govee, "discover_strips", AsyncMock(return_value=strips)), \
             patch.object(market_govee, "BleakClient", FakeClient):
            client, device = asyncio.run(market_govee.connect_strip(
                self.config, lambda phase, device=None: phases.append(phase), self.device_path,
            ))
        self.assertEqual(client.address, "NEAR")
        self.assertEqual(phases, ["searching", "connecting"])
        self.assertEqual(json.loads(self.device_path.read_text())["address"], "NEAR")

    def test_stale_saved_strip_is_forgotten_and_found_again(self):
        self.device_path.write_text(json.dumps({"model": "H617A", "address": "OLD", "name": "H617A"}))
        FakeClient.missing = {"OLD"}
        strips = [{"address": "NEW", "name": "Govee_H617A_2222", "rssi": -50}]
        with patch.object(market_govee, "discover_strips", AsyncMock(return_value=strips)), \
             patch.object(market_govee, "BleakClient", FakeClient):
            client, device = asyncio.run(market_govee.connect_strip(self.config, None, self.device_path))
        self.assertEqual(device["address"], "NEW")
        self.assertEqual(json.loads(self.device_path.read_text())["address"], "NEW")

    def test_no_strip_nearby_reports_not_found(self):
        with patch.object(market_govee, "discover_strips", AsyncMock(return_value=[])):
            with self.assertRaises(market_govee.StripError) as raised:
                asyncio.run(market_govee.connect_strip(self.config, None, self.device_path))
        self.assertEqual(raised.exception.code, "not_found")

    def test_saved_device_of_another_model_is_ignored(self):
        self.device_path.write_text(json.dumps({"model": "H6199", "address": "X"}))
        self.assertIsNone(market_govee.load_device(self.config, self.device_path))
        legacy = {"model": "H617A", "device_uuid": "LEGACY"}
        self.assertEqual(market_govee.load_device(legacy, self.device_path)["address"], "LEGACY")

    def test_bluetooth_errors_get_actionable_codes(self):
        classify = market_govee.classify_ble_error
        self.assertEqual(classify(BleakError("Bluetooth device is turned off")), "bluetooth_off")
        self.assertEqual(classify(BleakError(
            "Bluetooth access is denied by the user for the current application. Check macOS privacy settings.")), "permission")
        self.assertEqual(classify(BleakDeviceNotFoundError("X")), "not_found")
        self.assertEqual(classify(asyncio.TimeoutError()), "timeout")
        self.assertEqual(classify(market_govee.StripError("no_reply", "…")), "no_reply")
        self.assertEqual(classify(RuntimeError("algo raro")), "unknown")


class ConfigTemplateTest(unittest.TestCase):
    def test_missing_config_is_created_from_the_template(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            example = Path(directory) / "config.example.json"
            example.write_text('{"model": "H617A"}', encoding="utf-8")
            market_govee.ensure_config(path, example)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["model"], "H617A")
            path.write_text('{"model": "H6199"}', encoding="utf-8")
            market_govee.ensure_config(path, example)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["model"], "H6199")


if __name__ == "__main__":
    unittest.main()
