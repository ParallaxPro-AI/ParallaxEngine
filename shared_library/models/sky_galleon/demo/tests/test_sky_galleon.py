from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sky_galleon: the prefab spawns and its model's controls work")
async def test_sky_galleon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sky_galleon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wing_l", 25.0)
    assert abs(model.joint("wing_l") - 25.0) < 1e-3
    model.set_option("paint", "red")
    assert model.option("paint") == "red"
    assert model.socket_position("helm").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
