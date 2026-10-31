from parallax import Context, Entity, System, system, vec3
from parallax.characters import Character
from project import Text

from game.audio import Sounds, play
from game.actions import Controls
from game.components import Away, Ball, Effort, Footballer, Home, Stamina
from game.content import CupRules
from game.events import Strike
from game.resources import Match, playing
from game.rules import goal_defended_by, outfield, shirt
from game.strikes import strike


@system("human_control", when=playing)
class HumanControl(System):
    """Your input, applied to whichever home outfielder you control.

    Move and sprint run the body; shoot and pass strike the ball when it's within
    kick range; switch hands control to the teammate nearest the ball. A pass hands
    control to its receiver a moment later, so you can play a one-two."""

    def update(self, ctx, dt):
        match = ctx.get(Match)
        player = match.controlled
        self.run(ctx, player)

        ball_entity, ball = ctx.world.query(Ball).single()
        ball_at = ball_entity.transform.position
        if ctx.input.pressed(Controls.switch):
            match.controlled = outfield(ctx, Home).where(lambda mate: mate != player).nearest(ball_at)
            return
        if ball.kick_cooldown > 0 or player.transform.position.distance_to(ball_at) >= ball.kick_range:
            return
        if ctx.input.pressed(Controls.shoot):
            self.shoot(ctx, player, ball_entity)
        elif ctx.input.pressed(Controls.pass_ball):
            self.pass_ball(ctx, player, ball_entity)

    def run(self, ctx: Context, player: Entity) -> None:
        stamina = player.get(Stamina)
        stick = ctx.input.axis(Controls.move)
        moving = stick.length() > 0
        sprinting = moving and ctx.input.held(Controls.sprint) and not stamina.blown
        stamina.effort = Effort.SPRINT if sprinting else Effort.RUN if moving else Effort.REST
        pace = stamina.blown_pace if stamina.blown else 1.0
        player.get(Character).move(ctx.camera.main.relative(stick) * pace, run=sprinting)

    def shoot(self, ctx: Context, player: Entity, ball_entity: Entity) -> None:
        """Strike where you face. In the opponent's half the shot bends toward goal:
        facing roughly the right way is rewarded, a back-pass never becomes a goal."""
        cup = ctx.config(CupRules)
        ball_at = ball_entity.transform.position
        goal_at = goal_defended_by(ctx, Away).transform.position
        direction = player.transform.forward.flat().normalized()
        if ball_at.x * goal_at.x > 0:
            to_goal = (goal_at - ball_at).flat().normalized()
            direction = direction.lerp(to_goal, cup.shot_assist).normalized()
        power = player.get(Footballer).kick_power
        if ctx.input.held(Controls.sprint):
            power *= cup.sprint_shot_boost
        strike(ctx, ball_entity, player, direction * power, Strike.SHOT)

    def pass_ball(self, ctx: Context, player: Entity, ball_entity: Entity) -> None:
        """Pass to the best teammate in range and play it into their stride."""
        footballer = player.get(Footballer)
        receiver = self.pass_target(ctx, player, footballer)
        if receiver is None:
            play(ctx, ctx.config(Sounds).denied)
            ctx.ui.toast(Text.nobody_open)
            return
        cup = ctx.config(CupRules)
        target = receiver.transform.position + vec3(cup.pass_lead, 0, 0)
        distance = player.transform.position.distance_to(receiver.transform.position)
        power = footballer.pass_power * (0.75 + distance / footballer.pass_range)
        direction = (target - ball_entity.transform.position).flat().normalized()
        strike(ctx, ball_entity, player, direction * power, Strike.PASS)
        ctx.ui.toast(ctx.text(Text.pass_to, player=shirt(ctx, receiver)))
        ctx.time.after(cup.switch_after_pass, lambda: self.hand_control(ctx, receiver))

    def pass_target(self, ctx: Context, passer: Entity, footballer: Footballer) -> Entity | None:
        """The nearest teammate in range; one behind you only if nobody ahead is on."""
        cup = ctx.config(CupRules)
        at = passer.transform.position

        def cost(mate: Entity) -> float:
            behind = cup.backward_pass_penalty if mate.transform.position.x < at.x else 0
            return at.distance_to(mate.transform.position) + behind

        in_range = outfield(ctx, Home).where(
            lambda mate: mate != passer
            and cup.min_pass_distance <= at.distance_to(mate.transform.position) <= footballer.pass_range
        )
        return min(in_range, key=cost, default=None)

    def hand_control(self, ctx: Context, receiver: Entity) -> None:
        """The delayed half of a pass. `when=playing` gates update hooks, not the
        timers a system owns, so a goal in the meantime is checked for here."""
        if playing(ctx):
            ctx.get(Match).controlled = receiver
