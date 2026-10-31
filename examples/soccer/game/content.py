"""The cup's rules (config) and its two registries: the opponents and the training cards."""

from parallax import Color, ContentRef, Localized, config, content, field


@content("opponent")
class Opponent:
    """One knockout round's opponent. Every difficulty knob for that round lives here."""

    name: Localized
    stage: Localized
    scout_report: Localized
    shirt: Color
    kit: str = field("red", choices=["red", "green", "violet", "blue", "gold"], doc="The HUD palette matching their shirt.")
    half_seconds: float = field(90, unit="s")
    accuracy: float = field(0.7, min=0, max=1, doc="How close their strikers get to the corner they aim at.")
    speed_mul: float = field(1, doc="Multiplies their outfielders' running speed.")
    kick_mul: float = field(1, doc="Multiplies their shot power.")
    keeper_speed_mul: float = field(1)
    press_radius: float = field(20, unit="m", doc="Their second man presses the ball inside this distance.")
    shot_range_bonus: float = field(4, unit="m", doc="Extra distance both sides shoot from in this tie.")


@content("training")
class TrainingCard:
    """A team-talk card. Picking it stacks every number on the squad for the rest of the run."""

    name: Localized
    description: Localized
    max_stacks: int = field(1, min=1)
    control_speed: float = field(0, unit="m/s", doc="Running speed of the player you control.")
    control_sprint: float = field(0, unit="m/s")
    kick_power: float = field(0, unit="m/s")
    pass_power: float = field(0, unit="m/s")
    pass_range: float = field(0, unit="m")
    stamina_max: float = field(0)
    stamina_regen: float = field(0, unit="1/s")
    mate_speed: float = field(0, unit="m/s", doc="Running speed of your AI teammates.")
    keeper_speed: float = field(0, unit="m/s")
    keeper_reach: float = field(0, unit="m")
    kickoff_possession: bool = field(False, doc="Every restart starts at your feet.")
    fresh_start: bool = field(False, doc="Every kickoff refills the squad's stamina.")


@config("cup")
class CupRules:
    """The competition: its rounds, the match format and the tactics both AIs play."""

    name: Localized
    club: Localized
    rounds: list[ContentRef[Opponent]]
    halves: int = field(2, min=1)
    kickoff_seconds: float = field(3, unit="s")
    celebration_seconds: float = field(3, unit="s")
    half_time_seconds: float = field(4, unit="s")
    golden_goal_seconds: float = field(60, unit="s")
    golden_intro_seconds: float = field(3, unit="s")
    offers: int = field(3, doc="Training cards dealt after each won round.")

    # The human's strikes
    sprint_shot_boost: float = field(1.25, doc="Shot power multiplier while sprinting.")
    shot_assist: float = field(0.35, min=0, max=1, doc="How far shots in the attacking half bend toward goal.")
    pass_lead: float = field(1.4, unit="m", doc="Passes are played this far ahead of the receiver.")
    min_pass_distance: float = field(2, unit="m")
    backward_pass_penalty: float = field(14, unit="m", doc="A teammate behind you counts as this much further away.")
    switch_after_pass: float = field(0.35, unit="s", doc="Control follows a pass to its receiver after this.")

    # Team AI
    arrival_radius: float = field(0.25, unit="m", doc="A running player this close to their spot stops.")
    mate_accuracy: float = field(0.42, min=0, max=1, doc="How clinically your AI teammates finish.")
    shot_distance: float = field(6, unit="m", doc="Strikers shoot from kick range plus this plus the round's bonus.")
    shooting_lane: float = field(20, unit="m", doc="...and only when this close to the middle of the pitch.")
    corner_aim: float = field(0.8, doc="Strikers aim this fraction of the way to a post.")
    shot_spray: float = field(7, unit="m", doc="Aim error of a striker with zero accuracy.")
    chase_pace: float = field(1, doc="Pace of the nearest man going to the ball.")
    press_pace: float = field(0.9)
    carry_pace: float = field(0.9, doc="Pace of an AI player dribbling at goal.")
    carry_drift: float = field(0.35, doc="How much a dribbler keeps to the ball's side of the pitch.")
    hold_pace: float = field(0.6, doc="Pace of players holding their formation slot.")
    formation_push: float = field(0.45, doc="How far the shape slides up and down with the ball.")
    formation_lane: float = field(0.3, doc="How far each man drifts across toward the ball.")
