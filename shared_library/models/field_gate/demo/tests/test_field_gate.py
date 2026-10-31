from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("field_gate: the prefab spawns and its model's controls work")
async def test_field_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.field_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf", 50.0)
    assert abs(model.joint("leaf") - 50.0) < 1e-3
    model.set_option("style", "hurdle")
    assert model.option("style") == "hurdle"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
