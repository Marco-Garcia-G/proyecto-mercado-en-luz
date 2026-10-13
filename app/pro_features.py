"""Small, device-independent rules for the optional Pro lighting modes."""

import math
import re
from datetime import datetime


TARGET_COLORS = {"sell": (255, 190, 0), "stop": (255, 0, 180)}


def default_settings():
    # Todas las funciones están incluidas; «enabled» se mantiene por compatibilidad.
    return {
        "enabled": True,
        "average": {"mode": "equal", "weights": {}},
        "targets": {},
        "ambient": {
            "enabled": False, "night": False, "schedule": False,
            "start": "22:00", "end": "07:00",
        },
    }


def validate_settings(value, symbols):
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
        raise ValueError("Ajustes Pro no válidos")
    average = value.get("average")
    ambient = value.get("ambient")
    targets = value.get("targets")
    if not isinstance(average, dict) or average.get("mode") not in {"equal", "weighted"}:
        raise ValueError("Media no válida")
    weights = average.get("weights")
    if not isinstance(weights, dict) or set(weights) - set(symbols):
        raise ValueError("Pesos de cartera no válidos")
    checked_weights = {}
    for symbol, weight in weights.items():
        if type(weight) not in (int, float) or not math.isfinite(weight) or weight < 0 or weight > 100:
            raise ValueError(f"Peso no válido para {symbol}")
        checked_weights[symbol] = float(weight)
    if average["mode"] == "weighted":
        if any(symbol not in checked_weights for symbol in symbols) or not math.isclose(
            sum(checked_weights.values()), 100.0, rel_tol=0, abs_tol=1e-8
        ):
            raise ValueError("Los pesos de la media deben sumar 100 %")
    if not isinstance(targets, dict) or set(targets) - set(symbols):
        raise ValueError("Objetivos no válidos")
    checked_targets = {}
    for symbol, target in targets.items():
        if not isinstance(target, dict) or target.get("hit") not in (None, "sell", "stop") or type(target.get("acknowledged", False)) is not bool:
            raise ValueError(f"Objetivo no válido para {symbol}")
        entry = {}
        for name in ("sell", "stop"):
            price = target.get(name)
            if price is not None:
                if type(price) not in (int, float) or not math.isfinite(price) or price <= 0:
                    raise ValueError(f"Precio de {name} no válido para {symbol}")
                entry[name] = float(price)
            else:
                entry[name] = None
        if entry["sell"] is not None and entry["stop"] is not None and entry["stop"] >= entry["sell"]:
            raise ValueError(f"El stop de {symbol} debe ser menor que el objetivo")
        if target.get("hit") and entry[target["hit"]] is None:
            raise ValueError(f"Falta el precio alcanzado de {symbol}")
        entry["hit"] = target.get("hit")
        entry["acknowledged"] = target.get("acknowledged", False)
        if entry["sell"] is not None or entry["stop"] is not None:
            checked_targets[symbol] = entry
    if not isinstance(ambient, dict):
        raise ValueError("Ambiente no válido")
    checked_ambient = {}
    for key in ("enabled", "night", "schedule"):
        if type(ambient.get(key)) is not bool:
            raise ValueError("Ambiente no válido")
        checked_ambient[key] = ambient[key]
    for key in ("start", "end"):
        clock = ambient.get(key)
        if not isinstance(clock, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clock):
            raise ValueError("Hora de Ambiente no válida")
        checked_ambient[key] = clock
    return {
        "enabled": True,
        "average": {"mode": average["mode"], "weights": checked_weights},
        "targets": checked_targets,
        "ambient": checked_ambient,
    }


def weights_for(assets, settings):
    real = [asset for asset in assets if asset["symbol"] != "PORTFOLIO"]
    if not real:
        return []
    average = settings["average"]
    if not settings["enabled"] or average["mode"] != "weighted":
        return [1 / len(real)] * len(real)
    raw = [average["weights"].get(asset["symbol"], 0) for asset in real]
    total = sum(raw)
    return [weight / total for weight in raw] if total > 0 else [1 / len(real)] * len(real)


def weighted_mean(values, weights):
    if not values or len(values) != len(weights) or any(
        value is None or not isinstance(value, (int, float)) or not math.isfinite(value)
        for value in values
    ):
        return None
    return sum(value * weight for value, weight in zip(values, weights))


def night_active(ambient, now=None):
    if not ambient["enabled"]:
        return False
    if ambient["night"]:
        return True
    if not ambient["schedule"]:
        return False
    current = (now or datetime.now().astimezone()).strftime("%H:%M")
    start, end = ambient["start"], ambient["end"]
    if start == end:
        return False
    return start <= current < end if start < end else current >= start or current < end


def ambient_rgb(rgb, change, settings, now=None):
    if not settings["enabled"] or not settings["ambient"]["enabled"]:
        return rgb
    if night_active(settings["ambient"], now):
        scale = 0.23
    else:
        movement = min(abs(change) / 3, 1) if isinstance(change, (int, float)) and math.isfinite(change) else 0
        scale = 0.42 + 0.28 * movement
    return tuple(round(channel * scale) for channel in rgb)


def target_hit(target, quote):
    if not target or target.get("hit") or target.get("acknowledged") or not quote or quote.get("stale"):
        return None
    price = quote.get("price")
    if not isinstance(price, (int, float)) or not math.isfinite(price):
        return None
    if target.get("stop") is not None and price <= target["stop"]:
        return "stop"
    if target.get("sell") is not None and price >= target["sell"]:
        return "sell"
    return None


def reconcile_portfolio(settings, symbols):
    """Keep existing allocations when the user edits the regular strip layout."""
    updated = {**settings, "average": dict(settings["average"])}
    updated["targets"] = {symbol: value for symbol, value in settings["targets"].items() if symbol in symbols}
    previous = settings["average"]["weights"]
    raw = {symbol: previous.get(symbol, 1.0) for symbol in symbols}
    total = sum(raw.values())
    if total <= 0:
        raw = {symbol: 1.0 for symbol in symbols}
        total = len(symbols)
    updated["average"]["weights"] = {symbol: weight / total * 100 for symbol, weight in raw.items()}
    return updated
