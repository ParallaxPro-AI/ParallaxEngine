from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_cruiser_capital: the prefab spawns and its model's controls work")
async def test_space_cruiser_capital(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_cruiser_capital, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("turret_fore_a", 0.0)
    assert abs(model.joint("turret_fore_a") - 0.0) < 1e-3
    model.set_option("hull", "grey")
    assert model.option("hull") == "grey"
    assert model.socket_position("engine_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
