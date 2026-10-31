from parallax import component, field


@component("safe_zone")
class SafeZone:
    """Hostiles never spawn within `radius` (torches, a beacon that held)."""
    radius: float = field(0, unit="m")
