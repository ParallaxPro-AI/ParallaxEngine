"""Numbers every contract shares (config/job_rules.json)."""

from parallax import config, field


@config("job_rules")
class JobRules:
    bay_radius: float = field(7, unit="m")
    stopped_speed: float = field(0.6, unit="m/s")
    quiet_load: float = field(8, unit="s")
    permit_load: float = field(4, unit="s")
    risky_load: float = field(2, unit="s")
