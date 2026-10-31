from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rowing_shell: the prefab spawns and its model's controls work")
async def test_rowing_shell(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rowing_shell, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat", 0.36)
    assert abs(model.joint("seat") - 0.36) < 1e-3
    model.set_option("hull", "white")
    assert model.option("hull") == "white"
    assert model.socket_position("seat_rower").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
