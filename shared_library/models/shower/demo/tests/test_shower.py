from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shower: the prefab spawns and its model's controls work")
async def test_shower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 0.395)
    assert abs(model.joint("door") - 0.395) < 1e-3
    model.set_option("install", "over_bath")
    assert model.option("install") == "over_bath"
    assert model.socket_position("socket_floor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
