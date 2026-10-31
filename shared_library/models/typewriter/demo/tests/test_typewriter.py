from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("typewriter: the prefab spawns and its model's controls work")
async def test_typewriter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.typewriter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carriage", 0.0)
    assert abs(model.joint("carriage") - 0.0) < 1e-3
    model.set_option("paper", "empty")
    assert model.option("paper") == "empty"
    assert model.socket_position("socket_paper").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
