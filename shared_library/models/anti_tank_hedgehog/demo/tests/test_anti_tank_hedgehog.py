from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("anti_tank_hedgehog: the prefab spawns and its model's controls work")
async def test_anti_tank_hedgehog(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.anti_tank_hedgehog, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "olive")
    assert model.option("finish") == "olive"
    assert model.socket_position("top_tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
