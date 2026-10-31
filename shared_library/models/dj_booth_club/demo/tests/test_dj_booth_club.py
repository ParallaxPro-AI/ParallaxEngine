from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dj_booth_club: the prefab spawns and its model's controls work")
async def test_dj_booth_club(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dj_booth_club, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cabinet_door", 52.5)
    assert abs(model.joint("cabinet_door") - 52.5) < 1e-3
    model.set_option("glow", "blue")
    assert model.option("glow") == "blue"
    assert model.socket_position("dj").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
