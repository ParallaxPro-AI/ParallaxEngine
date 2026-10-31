from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("red_lacquer_cabinet: the prefab spawns and its model's controls work")
async def test_red_lacquer_cabinet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.red_lacquer_cabinet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 57.5)
    assert abs(model.joint("door_l") - 57.5) < 1e-3
    model.set_option("lacquer", "black")
    assert model.option("lacquer") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
