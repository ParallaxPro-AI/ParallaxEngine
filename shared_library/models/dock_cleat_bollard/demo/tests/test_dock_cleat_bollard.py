from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dock_cleat_bollard: the prefab spawns and its model's controls work")
async def test_dock_cleat_bollard(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dock_cleat_bollard, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("style", "tee")
    assert model.option("style") == "tee"
    assert model.socket_position("line").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
