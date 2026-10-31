from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scooter_share_dock: the prefab spawns and its model's controls work")
async def test_scooter_share_dock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scooter_share_dock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("brand", "teal")
    assert model.option("brand") == "teal"
    assert model.socket_position("bay_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
