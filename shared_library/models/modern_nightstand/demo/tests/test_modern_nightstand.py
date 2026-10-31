from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("modern_nightstand: the prefab spawns and its model's controls work")
async def test_modern_nightstand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.modern_nightstand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_0", 0.13)
    assert abs(model.joint("drawer_0") - 0.13) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    assert model.socket_position("top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
