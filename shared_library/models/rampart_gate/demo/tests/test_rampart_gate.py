from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rampart_gate: the prefab spawns and its model's controls work")
async def test_rampart_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rampart_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate_lift", 2.3)
    assert abs(model.joint("gate_lift") - 2.3) < 1e-3
    model.set_option("team", "blue")
    assert model.option("team") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
