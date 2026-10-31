from parallax import vec2, vec3
from parallax.physics import Rigidbody
from parallax.combat import Health
from parallax.vehicles import Vehicle
from parallax.test import GameHarness, playtest
from project import Content, Scenes

from game.actions import TankControls
from game.battlefield import shell_burst
from game.components import EnemyTank, Explosive, Gunnery, PlayerTank
from game.resources import BattleState, Campaign, Career, Loadout, Phase
from game.ui import PauseMenu, ResultScreen, TitleScreen, Workshop


@playtest("the first wave rolls in after the countdown, around the player")
async def first_wave(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    assert game.get(BattleState).phase is Phase.COUNTDOWN
    await game.advance(seconds=3.5)
    assert game.get(BattleState).phase is Phase.FIGHTING
    assert game.world.query(EnemyTank).count() == 4


@playtest("the pause key only exists on the battlefields")
async def pause_scope(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(TankControls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "start")
    await game.press(TankControls.pause)
    assert game.is_open(PauseMenu)


@playtest("enemy hulls shed their tier's flat armor down to a 20% floor; Tungsten Core pierces it")
async def armor(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    await game.advance_until(lambda: game.get(BattleState).phase is Phase.FIGHTING)
    player = game.world.query(tagged=PlayerTank).single()
    _, tank, health = game.world.query(EnemyTank, Health).first()
    health.max = health.current = 1000
    tank.kind = Content.enemy_tank.heavy
    health.damage(35, source=player)
    assert health.current == 1000 - 20, "35 - heavy armor 15"
    tank.kind = Content.enemy_tank.boss
    health.damage(20, source=player)
    assert health.current == 980 - 4, "boss armor 25 leaves the 20% floor"
    game.get(Loadout).pierce = 1.0
    health.damage(35, source=player)
    assert health.current == 976 - 35


@playtest("a shell bursting by a fuel drum cooks it off: enemies in the blast are hurt, and so are you")
async def fuel_drum(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    await game.advance_until(lambda: game.get(BattleState).phase is Phase.FIGHTING)
    drum = game.world.query(tagged=Explosive).first()
    tank = game.world.query(EnemyTank).entities()[0]
    player = game.world.query(tagged=PlayerTank).single()
    tank.get(Health).max = tank.get(Health).current = 500
    tank.transform.position = drum.transform.position + vec3(4, 0, 0)
    player.get(Rigidbody).teleport(drum.transform.position + vec3(-6, 2, 0))
    await game.advance(frames=2)
    hull = player.get(Health).current
    shell_burst(game.ctx, drum.transform.position + vec3(1, 0, 0), source=player)
    await game.advance(frames=2)
    assert not drum.alive
    assert tank.get(Health).current == 500 - 110
    assert player.get(Health).current == hull - 55


@playtest("losing the hull ends the run on the result screen; retry starts the campaign over")
async def defeat(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    await game.advance_until(lambda: game.get(BattleState).phase is Phase.FIGHTING)
    game.get(Campaign).score = 400
    game.world.query(tagged=PlayerTank).single().get(Health).damage(5000)
    await game.advance(frames=2)
    assert game.get(BattleState).phase is Phase.LOST
    assert game.is_open(ResultScreen)
    assert game.get(Career).best_score == 400
    await game.click(ResultScreen, "retry")
    await game.advance(frames=2)
    assert game.get(Campaign).score == 0
    assert game.get(BattleState).wave == 1


@playtest("firing empties the rack, then it reloads")
async def reload(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    player = game.world.query(tagged=PlayerTank).single()
    await game.hold(TankControls.fire, 9)
    assert player.get(Gunnery).reload_done_at >= 0
    await game.advance(seconds=3.5)
    assert player.get(Gunnery).ammo == player.get(Gunnery).capacity


@playtest("clearing a battlefield opens the workshop; the pick and the reward carry over as hull modifiers")
async def workshop(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    for _ in range(3):
        await game.advance_until(lambda: game.get(BattleState).phase is Phase.FIGHTING, timeout=10)
        for tank in game.world.query(EnemyTank).entities():
            tank.destroy()
        await game.advance(frames=1)
    await game.advance_until(lambda: game.is_open(Workshop), timeout=10)
    card = game.get(BattleState).offer[0]
    await game.click(Workshop, "pick", upgrade=card.id)
    await game.advance(frames=2)
    assert game.get(Campaign).battlefield == Content.battlefield.dust_bowl
    assert game.ctx.scenes.current_is(Scenes.dust_bowl)
    assert card in game.get(Loadout).picks
    assert Content.upgrade.ap_shell in game.get(Loadout).picks
    hull = game.world.query(tagged=PlayerTank).single()
    assert hull.get(Health).max == 250 + game.get(Loadout).max_health, "prefab base + the loadout modifier"
    assert hull.get(Vehicle).max_speed == 12 * game.get(Loadout).speed_mul
    assert game.get(Career).furthest == Content.battlefield.dust_bowl


@playtest("Continue on the title resumes the furthest battlefield with the build that got there")
async def continue_from_title(game: GameHarness):
    await game.start(scene=Scenes.title)
    career = game.get(Career)
    career.furthest = Content.battlefield.frostline
    career.build = [Content.upgrade.ap_shell, Content.upgrade.long_rod]
    await game.click(TitleScreen, "continue")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.frostline)
    assert game.get(Campaign).battlefield == Content.battlefield.frostline
    assert game.get(Loadout).damage == 8 + 18, f"{game.get(Loadout).picks} {game.get(Loadout).damage} {game.get(Career).build}"


@playtest("looking around turns the turret on its ring")
async def aim(game: GameHarness):
    await game.start(scene=Scenes.iron_valley)
    turret = game.world.query(tagged=PlayerTank).single().child("turret")
    before = turret.transform.local_euler.y
    await game.move(TankControls.look, vec2(1, 0), 1)
    assert turret.transform.local_euler.y != before
