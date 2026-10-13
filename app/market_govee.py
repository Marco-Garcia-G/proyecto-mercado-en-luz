"""Muestra la variación diaria de una cartera en una tira Govee segmentada (H617A)."""

import asyncio
import json
import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakDeviceNotFoundError, BleakError


CONFIG_PATH = Path(__file__).with_name("config.json")
CONFIG_EXAMPLE_PATH = Path(__file__).with_name("config.example.json")
DEVICE_PATH = Path(__file__).with_name("device.json")
DEFAULT_MODEL = "H617A"
SCAN_SECONDS = 6.0
MARKET_HOURS = {
    "ES": ("Europe/Madrid", 9, 0, 17, 30),
    "US": ("America/New_York", 9, 30, 16, 0),
}
COLOR_NAMES = (
    "rojo",
    "verde",
    "sin datos",
)


def hex_to_rgb(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
        raise ValueError(f"Color inválido: {value!r}. Usa el formato #RRGGBB")
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def describe_colors(config):
    return ", ".join(
        f"{name}: {config['colors'][name]}"
        for name in COLOR_NAMES if name != "sin datos"
    )


def ensure_config(path=None, example=None):
    """La primera vez crea config.json desde la plantilla; tu cartera no se versiona."""
    path = path or CONFIG_PATH
    example = example or CONFIG_EXAMPLE_PATH
    if not path.exists() and example.exists():
        path.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")


def load_config():
    ensure_config()
    with CONFIG_PATH.open(encoding="utf-8") as file:
        config = json.load(file)
    return validate_config(config)


PORTFOLIO_SYMBOL = "PORTFOLIO"
PORTFOLIO_MARKET = "AVG"


def portfolio_mean(values):
    """Media equiponderada; si falta una empresa, no se presenta una media parcial."""
    if not values or any(value is None or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        return None
    return sum(values) / len(values)


def validate_config(config):
    """Comprueba la configuración antes de usarla o guardarla desde la web."""
    if not isinstance(config, dict):
        raise ValueError("La configuración debe ser un objeto")
    if not 1 <= config["brightness"] <= 100:
        raise ValueError("brightness debe estar entre 1 y 100")
    if not isinstance(config.get("portfolio"), list) or not config["portfolio"]:
        raise ValueError("portfolio no puede estar vacío")
    if not isinstance(config.get("colors"), dict) or set(config["colors"]) != set(COLOR_NAMES):
        raise ValueError("colors debe contener rojo, verde y sin datos")
    for value in config["colors"].values():
        hex_to_rgb(value)
    if config["open_interval_seconds"] < 10 or config["closed_interval_seconds"] < 10:
        raise ValueError("Los intervalos deben ser de al menos 10 segundos")
    if not config["ble_retry_seconds"] or any(
        seconds < 1 for seconds in config["ble_retry_seconds"]
    ):
        raise ValueError("ble_retry_seconds debe contener esperas positivas")

    used_segments = set()
    used_symbols = set()
    real_assets = 0
    for asset in config["portfolio"]:
        if not isinstance(asset, dict):
            raise ValueError("Cada empresa debe ser un objeto")
        symbol = asset.get("symbol")
        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9.-]{1,16}", symbol):
            raise ValueError(f"Símbolo bursátil inválido: {symbol!r}")
        if symbol in used_symbols:
            raise ValueError(f"Empresa repetida: {symbol}")
        used_symbols.add(symbol)
        if not isinstance(asset.get("name"), str) or not asset["name"].strip():
            raise ValueError(f"{symbol} necesita un nombre")
        if symbol == PORTFOLIO_SYMBOL:
            if asset["market"] != PORTFOLIO_MARKET:
                raise ValueError("La media de cartera debe ser un valor especial")
        elif asset["market"] not in MARKET_HOURS:
            raise ValueError(f"Mercado desconocido: {asset['market']}")
        else:
            real_assets += 1
        if not isinstance(asset.get("segments"), list) or not asset["segments"]:
            raise ValueError(f"{asset['symbol']} no tiene segmentos")
        for segment in asset["segments"]:
            if type(segment) is not int or not 0 <= segment <= 14:
                raise ValueError(f"Segmento inválido en {asset['symbol']}: {segment}")
            if segment in used_segments:
                raise ValueError(f"Segmento repetido: {segment}")
            used_segments.add(segment)
    if not real_assets:
        raise ValueError("La media necesita al menos una empresa real")
    return config


def market_is_open(market, now):
    """Usa el horario habitual. Los festivos no se consideran mercado abierto real."""
    if market == PORTFOLIO_MARKET:
        return False
    timezone, start_hour, start_minute, end_hour, end_minute = MARKET_HOURS[market]
    local = now.astimezone(ZoneInfo(timezone))
    minutes = local.hour * 60 + local.minute
    return (
        local.weekday() < 5
        and start_hour * 60 + start_minute <= minutes < end_hour * 60 + end_minute
    )


def poll_interval(config, now):
    if any(market_is_open(asset["market"], now) for asset in config["portfolio"]):
        return config["open_interval_seconds"]
    return config["closed_interval_seconds"]


def next_market_open(config, now):
    openings = []
    for market in {asset["market"] for asset in config["portfolio"] if asset["market"] != PORTFOLIO_MARKET}:
        timezone, hour, minute, _, _ = MARKET_HOURS[market]
        local = now.astimezone(ZoneInfo(timezone))
        for days_ahead in range(8):
            day = local.date() + timedelta(days=days_ahead)
            if day.weekday() >= 5:
                continue
            opening = datetime(
                day.year, day.month, day.day, hour, minute,
                tzinfo=ZoneInfo(timezone),
            )
            if opening > now:
                openings.append(opening)
                break
    return min(openings)


def classify_change(change):
    return "rojo" if change < 0 else "verde"


def fetch_prices(config, previous_results):
    """Consulta precios y conserva valores anteriores si falla un símbolo."""
    results = {}
    for asset in config["portfolio"]:
        symbol = asset["symbol"]
        if symbol == PORTFOLIO_SYMBOL:
            continue
        try:
            history = yf.Ticker(symbol).history(
                period="5d", interval="1d", auto_adjust=False, timeout=10
            )
            closes = history["Close"].dropna()
            if len(closes) < 2:
                raise ValueError("menos de dos sesiones con precio")
            previous_close = float(closes.iloc[-2])
            latest_close = float(closes.iloc[-1])
            if not math.isfinite(previous_close) or previous_close <= 0:
                raise ValueError("cierre anterior inválido")
            if not math.isfinite(latest_close) or latest_close <= 0:
                raise ValueError("último precio inválido")
            results[symbol] = {
                "change": (latest_close / previous_close - 1) * 100,
                "price_date": closes.index[-1].date().isoformat(),
                "fresh": True,
            }
        except Exception as error:
            old = previous_results.get(symbol)
            if old is not None and old["change"] is not None:
                results[symbol] = {**old, "fresh": False}
                print(f"  {symbol}: sin datos nuevos ({error}); conservo el último valor válido")
            else:
                results[symbol] = {"change": None, "price_date": None, "fresh": False}
                print(f"  {symbol}: sin datos ({error}); segmento apagado")
    if any(asset["symbol"] == PORTFOLIO_SYMBOL for asset in config["portfolio"]):
        real = [results[asset["symbol"]] for asset in config["portfolio"] if asset["symbol"] != PORTFOLIO_SYMBOL]
        results[PORTFOLIO_SYMBOL] = {
            "change": portfolio_mean([item["change"] for item in real]),
            "price_date": max((item["price_date"] for item in real if item["price_date"]), default=None),
            "fresh": all(item["fresh"] for item in real),
        }
    return results


def build_color_masks(config, results):
    masks = {color: 0 for color in COLOR_NAMES}
    for asset in config["portfolio"]:
        result = results[asset["symbol"]]
        color = (
            classify_change(result["change"])
            if result["change"] is not None else "sin datos"
        )
        for segment in asset["segments"]:
            masks[color] |= 1 << segment
    # Los segmentos que se liberan desde el editor deben apagarse de verdad;
    # si no se les envía negro, la tira conserva el color anterior.
    assigned = 0
    for mask in masks.values():
        assigned |= mask
    masks["sin datos"] |= ((1 << 15) - 1) & ~assigned
    return tuple(
        (hex_to_rgb(config["colors"][color]), mask)
        for color, mask in masks.items() if mask
    )


def make_packet(payload):
    packet = bytearray(20)
    packet[: len(payload)] = payload
    for byte in packet[:-1]:
        packet[-1] ^= byte
    return bytes(packet)


def build_segment_packet(red, green, blue, mask):
    packet = bytearray(20)
    packet[:4] = bytes((0x33, 0x05, 0x15, 0x01))
    packet[4:7] = bytes((red, green, blue))
    packet[12] = mask & 0xFF
    packet[13] = (mask >> 8) & 0xFF
    for byte in packet[:-1]:
        packet[-1] ^= byte
    return bytes(packet)


class StripError(Exception):
    """Fallo Bluetooth con un código estable para que la interfaz lo explique."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def model_of(config):
    model = str(config.get("model") or DEFAULT_MODEL).upper()
    return model if re.fullmatch(r"H[0-9A-Z]{4,5}", model) else DEFAULT_MODEL


def load_device(config, path=None):
    """Dirección recordada de la tira; cada Mac ve un identificador distinto."""
    path = path or DEVICE_PATH
    model = model_of(config)
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = None
    if isinstance(saved, dict) and saved.get("model") == model and isinstance(saved.get("address"), str) and saved["address"]:
        return {"address": saved["address"], "name": saved.get("name") or model}
    legacy = config.get("device_uuid")
    if isinstance(legacy, str) and legacy.strip():
        return {"address": legacy.strip(), "name": model}
    return None


def save_device(config, device, path=None):
    path = path or DEVICE_PATH
    payload = {"model": model_of(config), "address": device["address"], "name": device.get("name")}
    try:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def forget_device(path=None):
    (path or DEVICE_PATH).unlink(missing_ok=True)


def matches_model(name, model):
    """Las Govee se anuncian como «ihoment_H617A_1A2B» o «Govee_H617A_1A2B»."""
    return bool(name) and model.upper() in name.upper()


async def discover_strips(model, timeout=SCAN_SECONDS):
    """Tiras del modelo cercanas, ordenadas de mejor a peor señal."""
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    strips = []
    for device, advertisement in found.values():
        name = advertisement.local_name or device.name or ""
        if matches_model(name, model):
            strips.append({"address": device.address, "name": name, "rssi": advertisement.rssi})
    strips.sort(key=lambda item: item["rssi"] if item["rssi"] is not None else -999, reverse=True)
    return strips


async def connect_strip(config, on_phase=None, device_path=None):
    """Conecta con la tira recordada o busca la más cercana del modelo configurado.

    Devuelve (cliente conectado, dispositivo). Si la dirección guardada ya no
    existe (otro Mac, tira cambiada), la olvida y vuelve a buscar una vez.
    """
    model = model_of(config)
    notify = on_phase or (lambda phase, device=None: None)
    device = load_device(config, device_path)
    for attempt in range(2):
        if device is None:
            notify("searching")
            strips = await discover_strips(model)
            if not strips:
                raise StripError("not_found", f"No encuentro ninguna tira {model} cerca")
            device = strips[0]
            save_device(config, device, device_path)
        notify("connecting", device)
        client = BleakClient(device["address"], timeout=12.0)
        try:
            await client.connect()
            advertised = getattr(client, "name", None)
            if isinstance(advertised, str) and matches_model(advertised, model) and advertised != device.get("name"):
                device = {**device, "name": advertised}
                save_device(config, device, device_path)
            return client, device
        except BleakDeviceNotFoundError:
            forget_device(device_path)
            device = None
            if attempt:
                raise StripError("not_found", f"No encuentro ninguna tira {model} cerca")
    raise StripError("not_found", f"No encuentro ninguna tira {model} cerca")


def classify_ble_error(error):
    """Traduce errores de bleak/CoreBluetooth a un código que la web sabe explicar."""
    if isinstance(error, StripError):
        return error.code
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if isinstance(error, BleakDeviceNotFoundError):
        return "not_found"
    text = str(error).lower()
    if "turned off" in text or "powered off" in text:
        return "bluetooth_off"
    if "not authorized" in text or "denied" in text or "restricted" in text:
        return "permission"
    if "unsupported" in text:
        return "unsupported"
    if isinstance(error, BleakError) and ("not found" in text or "was not found" in text):
        return "not_found"
    if "disconnected" in text or "not connected" in text:
        return "disconnected"
    return "unknown"


async def update_led_strip(config, color_masks, address=None):
    if address:
        client = BleakClient(address, timeout=12.0)
        await client.connect()
    else:
        client, _ = await connect_strip(config)
    try:
        await client.write_gatt_char(
            config["characteristic_uuid"], make_packet([0x33, 0x01, 0x01]), response=False
        )
        await asyncio.sleep(0.2)
        await client.write_gatt_char(
            config["characteristic_uuid"],
            make_packet([0x33, 0x04, config["brightness"]]), response=False
        )
        await asyncio.sleep(0.3)
        for (red, green, blue), mask in color_masks:
            await client.write_gatt_char(
                config["characteristic_uuid"],
                build_segment_packet(red, green, blue, mask), response=False
            )
            await asyncio.sleep(0.4)
    finally:
        await client.disconnect()


def print_results(config, results, now, next_poll):
    print(f"\nPrecios consultados: {now:%Y-%m-%d %H:%M:%S}")
    for asset in config["portfolio"]:
        result = results[asset["symbol"]]
        if result["change"] is None:
            detail = "sin datos"
        else:
            freshness = "consultado" if result["fresh"] else "último valor conservado"
            detail = (
                f"{result['change']:+.2f}% · {classify_change(result['change'])} "
                f"· sesión {result['price_date']} · {freshness}"
            )
        status = "horario abierto*" if market_is_open(asset["market"], now) else "fuera de horario*"
        print(f"  {asset['name']} ({asset['symbol']}): {detail} · {status}")
    print(f"Próxima consulta: {next_poll:%H:%M:%S}")
    print("* Horario habitual; no contempla festivos ni cierres especiales.")


async def main():
    config = load_config()
    config_mtime_ns = CONFIG_PATH.stat().st_mtime_ns
    print("Monitor Govee iniciado. Control+C para detenerlo.")
    print(f"Colores cargados: {describe_colors(config)}")
    print("Fuera de horario se conserva el último estado y se espacian las consultas.")
    results = {}
    desired_colors = None
    sent_colors = None
    next_poll = datetime.now().astimezone()
    next_ble_attempt = None
    ble_failures = 0
    last_led_update = None
    last_loop = datetime.now().astimezone()
    force_resync = False

    while True:
        now = datetime.now().astimezone()
        try:
            current_mtime_ns = CONFIG_PATH.stat().st_mtime_ns
        except OSError:
            current_mtime_ns = None
        if current_mtime_ns != config_mtime_ns:
            config_mtime_ns = current_mtime_ns
            try:
                updated_config = load_config()
            except Exception as error:
                print(f"No se pudo recargar config.json: {error}")
            else:
                old_config = config
                config = updated_config
                print(f"Configuración recargada: {describe_colors(config)}")
                if not results or config["portfolio"] != old_config["portfolio"]:
                    next_poll = now
                else:
                    desired_colors = build_color_masks(config, results)
                    connection_changed = any(
                        config.get(key) != old_config.get(key)
                        for key in ("brightness", "model", "characteristic_uuid")
                    )
                    if desired_colors != sent_colors or connection_changed:
                        next_ble_attempt = now
                        print("Aplicando los nuevos colores a la tira...")
                    else:
                        print("Los colores cambiados no afectan a los segmentos activos.")
        if (now - last_loop).total_seconds() > 60:
            print(f"\nEl ordenador parece haber despertado a las {now:%H:%M:%S}.")
            force_resync = True
        last_loop = now

        if now >= next_poll:
            try:
                results = await asyncio.to_thread(fetch_prices, config, results)
                desired_colors = build_color_masks(config, results)
            except Exception as error:
                print(f"Error al consultar precios: {error}")
            now = datetime.now().astimezone()
            next_poll = min(
                now + timedelta(seconds=poll_interval(config, now)),
                next_market_open(config, now),
            )
            if results:
                print_results(config, results, now, next_poll)
            if desired_colors is not None and (desired_colors != sent_colors or force_resync):
                next_ble_attempt = now
                force_resync = False
            else:
                next_ble_attempt = None
                ble_failures = 0
                print("Colores sin cambios; no se envían comandos a la tira.")
                if last_led_update is not None:
                    print(f"Última actualización de la tira: {last_led_update:%Y-%m-%d %H:%M:%S}")

        if next_ble_attempt is not None and now >= next_ble_attempt:
            try:
                await update_led_strip(config, desired_colors)
                sent_colors = desired_colors
                last_led_update = datetime.now().astimezone()
                next_ble_attempt = None
                ble_failures = 0
                force_resync = False
                print(f"Tira actualizada: {last_led_update:%Y-%m-%d %H:%M:%S}")
            except Exception as error:
                delays = config["ble_retry_seconds"]
                delay = delays[min(ble_failures, len(delays) - 1)]
                ble_failures += 1
                next_ble_attempt = datetime.now().astimezone() + timedelta(seconds=delay)
                force_resync = True
                print(f"Error Bluetooth: {error}. Nuevo intento a las {next_ble_attempt:%H:%M:%S} ({delay} segundos).")
                if last_led_update is not None:
                    print(f"Última actualización de la tira: {last_led_update:%H:%M:%S}")

        deadlines = [next_poll]
        if next_ble_attempt is not None:
            deadlines.append(next_ble_attempt)
        seconds_left = (min(deadlines) - datetime.now().astimezone()).total_seconds()
        await asyncio.sleep(max(0.1, min(10, seconds_left)))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nMonitor detenido.")
