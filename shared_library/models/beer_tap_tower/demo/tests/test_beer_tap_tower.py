from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("beer_tap_tower: the prefab spawns and its model's controls work")
async def test_beer_tap_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.beer_tap_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tap_1", 16.0)
    assert abs(model.joint("tap_1") - 16.0) < 1e-3
    model.set_option("handles", "wood")
    assert model.option("handles") == "wood"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
