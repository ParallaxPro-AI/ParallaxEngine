from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cottage_peasant: the prefab spawns and its model's controls work")
async def test_cottage_peasant(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cottage_peasant, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 47.5)
    assert abs(model.joint("door") - 47.5) < 1e-3
    assert model.socket_position("socket_door_outside").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
