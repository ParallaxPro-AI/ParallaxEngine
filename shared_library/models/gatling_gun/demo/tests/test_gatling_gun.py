from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gatling_gun: the prefab spawns and its model's controls work")
async def test_gatling_gun(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gatling_gun, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("traverse", 0.0)
    assert abs(model.joint("traverse") - 0.0) < 1e-3
    model.set_option("casing_finish", "copper")
    assert model.option("casing_finish") == "copper"
    assert model.socket_position("socket_gunner").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
