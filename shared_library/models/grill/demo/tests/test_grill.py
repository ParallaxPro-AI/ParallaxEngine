from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grill: the prefab spawns and its model's controls work")
async def test_grill(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grill, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 50.0)
    assert abs(model.joint("lid") - 50.0) < 1e-3
    model.set_option("fuel", "gas")
    assert model.option("fuel") == "gas"
    assert model.socket_position("socket_grate").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
