from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mannequin: the prefab spawns and its model's controls work")
async def test_mannequin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mannequin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("grip_r").distance_to(thing.transform.position) < 50.0
    # The right hand is on the right (+x, the canonical humanoid rig's side), so humanoid
    # clips pose the arm they name (a left/right swap raised both arms in the standing idle).
    assert model.socket_position("grip_r").x > 0.3
    assert model.socket_position("grip_l").x < -0.3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
