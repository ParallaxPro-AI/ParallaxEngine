from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("junk_ship: the prefab spawns and its model's controls work")
async def test_junk_ship(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.junk_ship, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rudder", 0.0)
    assert abs(model.joint("rudder") - 0.0) < 1e-3
    assert model.socket_position("waterline").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
