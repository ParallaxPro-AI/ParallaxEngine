from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("generator: the prefab spawns and its model's controls work")
async def test_generator(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.generator, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("control_panel", 52.5)
    assert abs(model.joint("control_panel") - 52.5) < 1e-3
    model.set_option("config", "industrial")
    assert model.option("config") == "industrial"
    assert model.socket_position("socket_outlet").distance_to(thing.transform.position) < 2.03
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
