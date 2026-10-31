from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tesla_tower: the prefab spawns and its model's controls work")
async def test_tesla_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tesla_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("tier", "2")
    assert model.option("tier") == "2"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
