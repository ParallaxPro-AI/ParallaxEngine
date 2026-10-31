from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dino_egg_nest: the prefab spawns and its model's controls work")
async def test_dino_egg_nest(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dino_egg_nest, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("clutch", "hatching")
    assert model.option("clutch") == "hatching"
    assert model.socket_position("centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
