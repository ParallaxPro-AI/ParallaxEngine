from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("base_wall_wood: the prefab spawns and its model's controls work")
async def test_base_wall_wood(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.base_wall_wood, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("tier", "stone")
    assert model.option("tier") == "stone"
    assert model.socket_position("socket_join_left").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
