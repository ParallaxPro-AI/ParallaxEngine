"""Continue a garden mid-wave. Opening the pause menu writes a checkpoint to the
profile: the board (every plant, its cell and health), every husk on the lawn (lane,
x, health, whether it already hopped), pollen, the house, the score and where the wave
schedule stands. The title's Continue reloads that garden from it; finishing a garden
clears it. The save plugin keeps only placed entities, so this records the spawned
ones itself."""

from parallax import Context, ContentRef, field, record, resource, vec3
from parallax.combat import Health
from parallax.grid import GridCell
from parallax.values import Cell
from project import Scenes

from game.components import Husk, Planted
from game.content import HuskDef, LevelDef, PlantDef
from game.lawn import PLANT_Y, SPAWN_TURN, lane_z, lawn
from game.resources import Campaign, GardenState, Pollen, WaveState


@record
class PlantRecord:
    kind: ContentRef[PlantDef]
    cell: Cell
    health: float


@record
class HuskRecord:
    kind: ContentRef[HuskDef]
    lane: int
    x: float
    health: float
    vaulted: bool = field(False)


@resource("checkpoint", keep="profile")
class Checkpoint:
    """The last paused garden, or `level` None when there's nothing to continue."""

    level: ContentRef[LevelDef] | None = field(None)
    pollen: int = field(0)
    house_health: int = field(0)
    score: int = field(0)
    kills: int = field(0)
    wave: int = field(0)
    spawned: int = field(0)
    lane_turn: int = field(0)
    wave_elapsed: float = field(0, unit="s", doc="Seconds since the wait for the next wave began.")
    spawn_in: float = field(0, unit="s", doc="Seconds until the wave's next husk.")
    plants: list[PlantRecord] = field([])
    husks: list[HuskRecord] = field([])
    resuming: bool = field(False, doc="Set by Continue until the garden has been rebuilt.")


def save_checkpoint(ctx: Context) -> None:
    cp, waves, garden = ctx.get(Checkpoint), ctx.get(WaveState), ctx.get(GardenState)
    now = ctx.time.now
    cp.level = ctx.get(Campaign).level
    cp.pollen = ctx.get(Pollen).amount
    cp.house_health, cp.score, cp.kills = garden.house_health, garden.score, garden.kills
    cp.wave, cp.spawned, cp.lane_turn = waves.wave, waves.spawned, waves.lane_turn
    cp.wave_elapsed = now - waves.countdown_from
    cp.spawn_in = max(0.0, waves.next_spawn_at - now)
    cp.plants = [
        PlantRecord(kind=planted.kind, cell=spot.cell, health=plant.get(Health).current)
        for plant, planted, spot in ctx.world.query(Planted, GridCell)
    ]
    cp.husks = [
        HuskRecord(
            kind=husk.kind,
            lane=husk.lane,
            x=entity.transform.position.x,
            health=entity.get(Health).current,
            vaulted=husk.vaulted,
        )
        for entity, husk in ctx.world.query(Husk)
    ]


def clear_checkpoint(ctx: Context) -> None:
    ctx.get(Checkpoint).level = None


def can_continue(ctx: Context) -> bool:
    return ctx.get(Checkpoint).level is not None


def continue_garden(ctx: Context) -> None:
    """The title's Continue: reload the checkpointed garden."""
    cp = ctx.get(Checkpoint)
    if cp.level is None:
        return
    ctx.get(Campaign).level = cp.level
    cp.resuming = True
    ctx.scenes.load(Scenes.garden, new_run=True, init=[
        Pollen(amount=cp.pollen),
        GardenState(house_health=cp.house_health, score=cp.score, kills=cp.kills),
    ])


def rebuild_garden(ctx: Context) -> None:
    """After a Continue load: the wave schedule, the plants and the husks."""
    cp = ctx.get(Checkpoint)
    cp.resuming = False
    now = ctx.time.now
    waves = ctx.get(WaveState)
    waves.wave, waves.spawned, waves.lane_turn = cp.wave, cp.spawned, cp.lane_turn
    waves.countdown_from = now - cp.wave_elapsed
    waves.next_spawn_at = now + cp.spawn_in
    for plant in cp.plants:
        sprout = ctx.world.spawn(
            plant.kind.data.prefab,
            at=lawn(ctx).center(plant.cell).with_y(PLANT_Y),
            rotation=SPAWN_TURN,
            components=[
                Planted(kind=plant.kind),
                GridCell(cell=plant.cell, snap=True),
            ],
        )
        sprout.get(Health).current = plant.health  # its max is the prefab's
    for husk in cp.husks:
        tier = husk.kind.data
        ctx.world.spawn(
            tier.prefab,
            at=vec3(husk.x, 0, lane_z(ctx, husk.lane)),
            rotation=SPAWN_TURN,
            components=[
                Husk(kind=husk.kind, lane=husk.lane, speed=tier.speed, vaulted=husk.vaulted),
                Health(current=husk.health, max=tier.health),
            ],
        )
