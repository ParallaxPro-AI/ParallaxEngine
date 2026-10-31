from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("vinyl_record_shelf: the prefab spawns and its model's controls work")
async def test_vinyl_record_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.vinyl_record_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cover", 37.5)
    assert abs(model.joint("cover") - 37.5) < 1e-3
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
