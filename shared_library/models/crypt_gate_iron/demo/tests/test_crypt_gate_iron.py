from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crypt_gate_iron: the prefab spawns and its model's controls work")
async def test_crypt_gate_iron(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crypt_gate_iron, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_l", 45.0)
    assert abs(model.joint("leaf_l") - 45.0) < 1e-3
    model.set_option("lock", "open")
    assert model.option("lock") == "open"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
