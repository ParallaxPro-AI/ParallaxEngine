from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("water_tower: the prefab spawns and its model's controls work")
async def test_water_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.water_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("roof_hatch", 55.0)
    assert abs(model.joint("roof_hatch") - 55.0) < 1e-3
    model.set_option("paint", "silver")
    assert model.option("paint") == "silver"
    assert model.socket_position("socket_beacon").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
