from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("popcorn_machine: the prefab spawns and its model's controls work")
async def test_popcorn_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.popcorn_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("base_door", 50.0)
    assert abs(model.joint("base_door") - 50.0) < 1e-3
    model.set_option("body", "blue")
    assert model.option("body") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
