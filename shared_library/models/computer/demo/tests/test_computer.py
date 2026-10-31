from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("computer: the prefab spawns and its model's controls work")
async def test_computer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.computer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tower_door", 50.0)
    assert abs(model.joint("tower_door") - 50.0) < 1e-3
    model.set_option("form", "all_in_one")
    assert model.option("form") == "all_in_one"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
