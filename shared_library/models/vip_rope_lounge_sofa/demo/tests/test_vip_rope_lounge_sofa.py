from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("vip_rope_lounge_sofa: the prefab spawns and its model's controls work")
async def test_vip_rope_lounge_sofa(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.vip_rope_lounge_sofa, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rope", 50.0)
    assert abs(model.joint("rope") - 50.0) < 1e-3
    model.set_option("velvet", "emerald")
    assert model.option("velvet") == "emerald"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
