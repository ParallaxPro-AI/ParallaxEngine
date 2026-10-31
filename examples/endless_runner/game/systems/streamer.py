"""Streams the street: road, buildings, obstacles, coins and power-ups."""

import random

from parallax import System, system, vec3
from project import Prefabs, Scenes

from game.components import Obstacle, PowerUp, Runner, Streamed
from game.config import Rules
from game.content import Avoid, DistrictDef, ObstacleDef, PowerUpDef
from game.resources import Run, Street


@system("street_streamer", scenes=[Scenes.street])
class StreetStreamer(System):
    """Builds the street `spawn_ahead` metres in front of the runner and clears
    it `despawn_behind` metres after.

    Obstacles follow each district's authored encounter rhythm (with `rest`
    beats that are just a coin run), falling back to a weighted pick that leans
    toward the hard rows the deeper you get. A side-step obstacle always leaves
    one lane open; a jump or slide wall may span the street. Coins reward reading
    the wall: a run down the open lane, an arc over a jump, a low line under a
    full-width bar. Gaps tighten with depth but never below `decision_seconds`
    of travel at the current speed."""

    def start(self, ctx):
        rules = ctx.config(Rules)
        street = ctx.get(Street)
        street.road_z = street.building_z = -rules.segment_length
        street.obstacle_z = rules.gap_max
        self.fill(ctx, 0.0)

    def update(self, ctx, dt):
        runner, _ = ctx.world.query(Runner).single()
        z = runner.transform.position.z
        self.fill(ctx, z)
        behind = z - ctx.config(Rules).despawn_behind
        for entity in ctx.world.query(tagged=Streamed).to_list():
            if entity.transform.position.z < behind:
                entity.destroy()

    def fill(self, ctx, z: float):
        rules = ctx.config(Rules)
        street = ctx.get(Street)
        horizon = z + rules.spawn_ahead
        while street.road_z < horizon:
            self.put(ctx, self.district_at(ctx, street.road_z).road, 0, street.road_z)
            street.road_z += rules.segment_length
        while street.building_z < horizon:
            self.buildings(ctx, street.building_z)
            street.building_z += rules.building_spacing
        while street.obstacle_z < horizon:
            self.encounter(ctx, street.obstacle_z)
            street.obstacle_z += self.gap(ctx)
        goal = ctx.content(DistrictDef)[-1].data.end_distance
        if not ctx.get(Run).endless and not street.finish_placed and street.road_z > goal:
            street.finish_placed = True
            self.put(ctx, Prefabs.finish_line, 0, goal)

    def district_at(self, ctx, z: float) -> DistrictDef:
        order = ctx.content(DistrictDef)
        distance = z % order[-1].data.end_distance if ctx.get(Run).endless else z
        return next((d.data for d in order if distance < d.data.end_distance), order[-1].data)

    def buildings(self, ctx, z: float):
        """Buildings face the street from both kerbs (the harbour's right side is open
        water); every other slot a district's landmark stands in front of them."""
        rules = ctx.config(Rules)
        district = self.district_at(ctx, z)
        slot = int(z / rules.building_spacing)
        for side in (-1, 1):
            if not (district.waterfront and side > 0):
                self.put(ctx, random.choice(district.buildings), side * rules.building_offset, z, yaw=90 * side)
            if district.landmark is not None and slot % 2 == 0 and (side > 0 or not district.waterfront):
                yaw = 0 if district.waterfront else 90 * side
                self.put(ctx, district.landmark, side * district.landmark_x, z + 7, yaw=yaw)

    def encounter(self, ctx, z: float):
        street = ctx.get(Street)
        rhythm = self.district_at(ctx, z).encounters
        step = rhythm[street.pattern_step % len(rhythm)]
        street.pattern_step += 1
        lane_xs = ctx.config(Rules).lane_xs
        if step == "rest":
            self.coin_line(ctx, random.choice(lane_xs), z - 4, z + 8)
            return
        on_rhythm = ctx.get(Run).distance >= step.data.from_distance and random.random() > 0.2
        self.wall(ctx, step if on_rhythm else self.pick(ctx), z)
        if random.random() < self.powerup_chance(ctx, z):
            kinds = ctx.content(PowerUpDef)
            kind = random.choices(kinds, weights=[k.data.weight for k in kinds])[0]
            self.put(ctx, kind.data.prefab, random.choice(lane_xs), z + 12, PowerUp(kind=kind), y=1.8)

    def wall(self, ctx, kind, z: float):
        obstacle: ObstacleDef = kind.data
        lane_xs = ctx.config(Rules).lane_xs
        lanes = len(lane_xs)
        cap = lanes - 1 if obstacle.avoid is Avoid.SWITCH_LANE else lanes
        first = random.randrange(lanes)
        blocked = [(first + i) % lanes for i in range(min(obstacle.lanes_blocked, cap))]
        for lane in blocked:
            self.put(ctx, obstacle.prefab, lane_xs[lane], z, Obstacle(kind=kind))
        open_lanes = [lane for lane in range(lanes) if lane not in blocked]
        if open_lanes:
            self.coin_line(ctx, lane_xs[open_lanes[0]], z - 5, z + 5)
        if obstacle.avoid is Avoid.JUMP:
            self.coin_arc(ctx, lane_xs[first], z)
        elif obstacle.avoid is Avoid.SLIDE and not open_lanes:
            self.coin_line(ctx, lane_xs[first], z - 3, z + 3, y=ctx.config(Rules).low_coin_height)

    def pick(self, ctx):
        distance = ctx.get(Run).distance
        bias = self.hard_bias(ctx)
        kinds = ctx.content(ObstacleDef).where(lambda obstacle: distance >= obstacle.from_distance)
        weights = [k.data.weight * (1 + bias if k.data.hard else 1) for k in kinds]
        return random.choices(kinds, weights=weights)[0]

    def ramp(self, ctx) -> float:
        return max(0.0, ctx.get(Run).distance - ctx.config(Rules).ramp_start) / 100

    def hard_bias(self, ctx) -> float:
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        bias = rules.hard_bias_per_100m * self.ramp(ctx) + run.district.data.hard_bias
        return bias + (rules.endless_bias_per_1000m * run.distance / 1000 if run.endless else 0)

    def gap(self, ctx) -> float:
        rules = ctx.config(Rules)
        _, runner = ctx.world.query(Runner).single()
        shrink = 1 - min(rules.gap_shrink_max, rules.gap_shrink_per_100m * self.ramp(ctx))
        rolled = random.uniform(rules.gap_min, rules.gap_max) * shrink * ctx.get(Run).district.data.gap_scale
        return max(rules.gap_floor, rolled, runner.speed * rules.decision_seconds + rules.gap_margin)

    def powerup_chance(self, ctx, z: float) -> float:
        rules = ctx.config(Rules)
        chance = (rules.powerup_chance + ctx.get(Run).powerup_bonus) * self.district_at(ctx, z).powerup_scale
        return max(rules.powerup_chance_floor, chance - self.hard_bias(ctx) * rules.powerup_bias_damping)

    def coin_line(self, ctx, x: float, z_from: float, z_to: float, y: float | None = None):
        rules = ctx.config(Rules)
        z = z_from
        while z <= z_to:
            self.put(ctx, Prefabs.coin, x, z, y=rules.coin_height if y is None else y)
            z += rules.coin_spacing

    def coin_arc(self, ctx, x: float, z: float):
        rules = ctx.config(Rules)
        for i in range(-2, 3):
            self.put(ctx, Prefabs.coin, x, z + i * 1.5, y=rules.coin_height + rules.arc_height * (1 - i * i / 4))

    def put(self, ctx, prefab, x: float, z: float, *components, y: float = 0.0, yaw: float = 0.0):
        # The template's street ran down -z; this one runs up +z, its mirror across z, so a
        # template yaw is negated (storefronts on the -x kerb turn +90 to face the street).
        return ctx.world.spawn(prefab, at=vec3(x, y, z), rotation=vec3(0, yaw, 0), components=components, tags=[Streamed])
