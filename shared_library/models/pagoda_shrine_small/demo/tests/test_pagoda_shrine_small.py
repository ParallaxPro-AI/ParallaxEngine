from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pagoda_shrine_small: the prefab spawns and its model's controls work")
async def test_pagoda_shrine_small(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pagoda_shrine_small, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    model.set_option("lacquer", "green")
    assert model.option("lacquer") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
