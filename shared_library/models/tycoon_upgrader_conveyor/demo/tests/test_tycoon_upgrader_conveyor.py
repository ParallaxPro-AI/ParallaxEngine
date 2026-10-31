from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tycoon_upgrader_conveyor: the prefab spawns and its model's controls work")
async def test_tycoon_upgrader_conveyor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tycoon_upgrader_conveyor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("belt", 0.15)
    assert abs(model.joint("belt") - 0.15) < 1e-3
    assert model.socket_position("socket_infeed").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
