from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bb_player_ship: the prefab spawns and its model's controls work")
async def test_bb_player_ship(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bb_player_ship, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hoist_0", 0.52)
    assert abs(model.joint("hoist_0") - 0.52) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
