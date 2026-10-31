import random

from parallax import Context, Entity, System, Tag, clamp, system, vec3
from parallax.characters import Character
from parallax.physics import Rigidbody

from game.components import Away, Ball, Footballer, Goal, Goalkeeper, Home
from game.content import CupRules
from game.events import KeeperSaved, Strike
from game.resources import Match, playing
from game.rules import goal_defended_by, opponent, rival, run_toward, team_of
from game.strikes import strike


@system("team_tactics", when=playing)
class TeamTactics(System):
    """The AI for the nine players you aren't controlling.

    Per side, only the two outfielders nearest the ball go to it, and only while
    the other side has it or it's loose: the nearest chases, the second presses
    if the ball is within the round's press radius. Everyone else holds a
    formation slot that slides with the ball, so the shape stays spread instead
    of swarming. The man on the ball dribbles at goal and shoots for a corner
    once in range. Keepers guard their line and sweep up balls in their box."""

    def update(self, ctx, dt):
        ball_entity, ball = ctx.world.query(Ball).single()
        for team in (Home, Away):
            self.outfield(ctx, team, ball_entity, ball)
            self.keeper(ctx, team, ball_entity, ball)

    def outfield(self, ctx: Context, team: Tag, ball_entity: Entity, ball: Ball) -> None:
        cup, foe = ctx.config(CupRules), opponent(ctx)
        controlled = ctx.get(Match).controlled
        ball_at = ball_entity.transform.position
        holder_team = team_of(ball.holder) if ball.holder is not None else None
        players = (ctx.world.query(Footballer, Character, tagged=team, without=[Goalkeeper])
                   .where(lambda player, footballer, character: player != controlled)
                   .by_distance(ball_at))
        for rank, (player, footballer, character) in enumerate(players):
            speed = footballer.ai_speed * (foe.speed_mul if team is Away else 1)
            chasing = rank == 0 or (rank == 1 and player.transform.position.distance_to(ball_at) < foe.press_radius)
            if player == ball.holder:
                self.attack(ctx, team, player, character, ball_entity, ball, speed)
            elif holder_team is not team and chasing:
                pace = cup.chase_pace if rank == 0 else cup.press_pace
                run_toward(ctx, character, ball_at, speed * pace)
            else:
                slot = footballer.kickoff
                spot = vec3(
                    slot.x + ball_at.x * cup.formation_push,
                    0,
                    slot.z + (ball_at.z - slot.z) * cup.formation_lane,
                )
                run_toward(ctx, character, spot, speed * cup.hold_pace)

    def attack(self, ctx: Context, team: Tag, player: Entity, character: Character,
               ball_entity: Entity, ball: Ball, speed: float) -> None:
        """Dribble at the goal; shoot once inside range and near the middle."""
        cup = ctx.config(CupRules)
        goal = goal_defended_by(ctx, rival(team))
        goal_at, at = goal.transform.position, player.transform.position
        shooting_range = ball.kick_range + opponent(ctx).shot_range_bonus + cup.shot_distance
        if abs(goal_at.x - at.x) < shooting_range and abs(at.z) < cup.shooting_lane:
            self.shoot(ctx, team, player, ball_entity, goal)
        else:
            lane = ball_entity.transform.position.z * cup.carry_drift
            run_toward(ctx, character, vec3(goal_at.x, 0, lane), speed * cup.carry_pace)

    def shoot(self, ctx: Context, team: Tag, player: Entity, ball_entity: Entity, goal: Entity) -> None:
        """Aim inside a post. Accuracy is how close the shot gets to that corner: a
        wild striker sprays it, a good one beats the keeper standing in the middle."""
        cup, foe = ctx.config(CupRules), opponent(ctx)
        accuracy = foe.accuracy if team is Away else cup.mate_accuracy
        mouth = goal.get(Goal).mouth_half_width
        aim = random.choice((-1, 1)) * mouth * cup.corner_aim
        error = random.uniform(-1, 1) * (1 - accuracy) * cup.shot_spray
        target = goal.transform.position + vec3(0, 0, aim + error)
        direction = (target - ball_entity.transform.position).flat().normalized()
        power = player.get(Footballer).kick_power * (foe.kick_mul if team is Away else 1)
        strike(ctx, ball_entity, player, direction * power, Strike.SHOT)

    def keeper(self, ctx: Context, team: Tag, ball_entity: Entity, ball: Ball) -> None:
        """Shadow the ball across the goal mouth; rush and clear it inside the box."""
        keeper, footballer, gloves, character = ctx.world.query(
            Footballer, Goalkeeper, Character, tagged=team).single()
        goal = goal_defended_by(ctx, team)
        line, at = goal.transform.position, keeper.transform.position
        ball_at = ball_entity.transform.position
        inward = -1 if line.x > 0 else 1
        speed = footballer.ai_speed * (opponent(ctx).keeper_speed_mul if team is Away else 1)

        in_box = abs(ball_at.x - line.x) < gloves.box_depth
        if in_box and at.distance_to(ball_at) < gloves.reach:
            run_toward(ctx, character, ball_at, speed)
            if at.distance_to(ball_at) < ball.dribble_range and ball.kick_cooldown == 0:
                self.clear(ctx, keeper, footballer, gloves, ball_entity, inward)
            return
        cover = goal.get(Goal).mouth_half_width + gloves.line_offset
        guard = vec3(line.x + inward * gloves.line_offset, 0, clamp(ball_at.z, -cover, cover))
        run_toward(ctx, character, guard, speed)

    def clear(self, ctx: Context, keeper: Entity, footballer: Footballer, gloves: Goalkeeper,
              ball_entity: Entity, inward: int) -> None:
        if ball_entity.get(Rigidbody).speed > gloves.save_speed:
            ctx.emit(KeeperSaved(keeper=keeper))
        touchline = 1 if ball_entity.transform.position.z > 0 else -1
        direction = vec3(inward, 0, touchline * gloves.clear_spread)
        strike(ctx, ball_entity, keeper, direction * footballer.kick_power, Strike.CLEARANCE)
