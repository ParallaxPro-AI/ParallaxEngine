from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("nail_gun: the prefab spawns and its model's controls work")
async def test_nail_gun(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.nail_gun, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 8.0)
    assert abs(model.joint("trigger") - 8.0) < 1e-3
    model.set_option("accent", "red")
    assert model.option("accent") == "red"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
