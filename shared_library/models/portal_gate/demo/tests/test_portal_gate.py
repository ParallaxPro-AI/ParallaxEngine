from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("portal_gate: the prefab spawns and its model's controls work")
async def test_portal_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.portal_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("portal_field", 0.51)
    assert abs(model.joint("portal_field") - 0.51) < 1e-3
    model.set_option("energy", "azure")
    assert model.option("energy") == "azure"
    assert model.socket_position("socket_portal").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
