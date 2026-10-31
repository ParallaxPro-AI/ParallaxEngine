"""Game-wide tunables (config/sky_freight.json): the career, contracts, landings, and the
reference speeds and feed timing the HUD reads."""

from parallax import ContentRef, config, field

from game.content import IslandDef


@config("sky_freight")
class FreightRules:
    home: ContentRef[IslandDef] = field()
    payoff_target: int = field(20000, min=1, doc="Bank this much and the airfield is yours.")
    start_airframes: int = field(3, min=1)
    max_airframes: int = field(5, min=1)
    ditch_fee: int = field(350, min=0)
    offers: int = field(3, min=1)
    pay_base: int = field(250, min=0)
    pay_per_metre: float = field(0.62, min=0)
    deadline_base: float = field(30, unit="s")
    deadline_slack: float = field(2.4, doc="Multiplier on the leg flown at cruise speed.")
    urgent_slack: float = field(1.55)
    cruise_speed: float = field(60, unit="m/s")
    on_time_bonus: int = field(180, min=0)
    late_factor: float = field(0.55, min=0, max=1)
    pad_radius: float = field(30, unit="m", doc="Load and unload within this of the depot, on foot or in the plane.")
    office_radius: float = field(75, unit="m", doc="The office is the shed beside the pad.")
    board_reach: float = field(24, unit="m", doc="Boarding range, to the fuselage centre; must clear the wing collider.")
    exit_speed: float = field(12, unit="m/s", doc="Stepping out works on the ground below this.")
    low_pass_height: float = field(3, unit="m", doc="A pass this low over the pad counts as on the ground.")
    water_level: float = field(-1, unit="m", doc="Zero on the altimeter.")
    grease_sink: float = field(2.2, unit="m/s")
    hard_sink: float = field(6.5, unit="m/s")
    crash_sink: float = field(12, unit="m/s")
    grease_bonus: int = field(220, min=0)
    damaged_factor: float = field(0.45, min=0, max=1)
    stall_ref_speed: float = field(17, unit="m/s", doc="HUD reference: the minimum flying speed.")
    stall_margin: float = field(1.3, min=1, doc="The HUD warns below stall_ref_speed times this.")
    stall_warning_aoa: float = field(9.5, unit="deg", doc="...or above this angle of attack.")
    rotate_speed: float = field(33, unit="m/s", doc="HUD reference: rotate on the takeoff roll.")
    deadline_warning: float = field(30, unit="s", doc="The contract clock turns red below this.")
    touch_stopped_speed: float = field(2.2, unit="m/s", doc="Touch: the cockpit's Exit / Office buttons show below this.")
    toast_seconds: float = field(3.5, unit="s", doc="How long a line stays in the HUD feed.")
    toast_lines: int = field(3, min=1, doc="Feed lines shown at once; the oldest goes first.")
