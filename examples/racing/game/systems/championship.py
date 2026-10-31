from parallax import System, on, system

from game.audio import Sounds, play
from game.components import PlayerCar, Racer, TrackScene
from game.config import RaceRules
from game.content import RoundDef
from game.events import RaceFinished
from game.resources import Career, Race, RaceResult, ResultRow, Season, StandingRow
from game.rules import standings_key


@system("championship", scenes=[TrackScene])
class Championship(System):
    """Scores a race the moment the player finishes: the purse and the lap-record bonus
    always; in a championship round also points for every car by finishing order (cars
    still out on track keep their live place) and — after the last round — the title or
    the defeat. The results screen follows the race phase by itself."""

    @on(RaceFinished)
    def score_race(self, ctx, event):
        race = ctx.get(Race)
        round_ = race.round.data if race.round is not None else None
        field = sorted(ctx.world.query(Racer), key=lambda row: row[1].place)

        rows = []
        for index, (car, racer) in enumerate(field):
            points = self.points_for(ctx, index) * round_.points_scale if round_ is not None else 0
            rows.append(ResultRow(car=racer.car, is_player=car.has(PlayerCar), finished=racer.finish_place > 0,
                                  time=racer.finish_time, points=points))

        _, racer = ctx.world.query(Racer, tagged=PlayerCar).single()
        result = ctx.get(RaceResult)
        result.place = racer.place
        result.rows = rows
        result.race_time = racer.finish_time
        result.best_lap = racer.best_lap
        result.lap_record = self.record_lap(ctx, race.track.id, racer.best_lap)
        result.credits_earned = self.pay_purse(ctx, racer.place, round_, result.lap_record)
        result.championship = round_ is not None
        result.season_over = result.champion = result.has_next_round = False
        result.standings = []
        if round_ is not None:
            self.score_round(ctx, field, rows, result)
        play(ctx, ctx.config(Sounds).finish)
        ctx.input.rumble(0.6, 0.4)

    def score_round(self, ctx, field, rows, result):
        season = ctx.get(Season)
        for index, (car, _) in enumerate(field):
            key = standings_key(car)
            season.points[key] = season.points.get(key, 0) + rows[index].points
        result.standings = self.standings(ctx, field)
        season.round += 1
        result.season_over = season.round == len(ctx.content(RoundDef))
        result.has_next_round = not result.season_over
        result.champion = result.season_over and result.standings[0].is_player
        if result.season_over:
            self.close_season(ctx, result.champion)

    def points_for(self, ctx, index):
        table = ctx.config(RaceRules).points_by_place
        return table[index] if index < len(table) else 0

    def record_lap(self, ctx, track_id, lap):
        best = ctx.get(Career).best_laps
        if lap <= 0 or (track_id in best and best[track_id] <= lap):
            return False
        best[track_id] = lap
        return True

    def pay_purse(self, ctx, place, round_: RoundDef | None, lap_record):
        career = ctx.get(Career)
        tuning = ctx.config(RaceRules)
        base = (tuning.purse[place - 1] if place <= len(tuning.purse) else 0) + tuning.finish_bonus
        scale = round_.purse_scale if round_ is not None else 1
        earned = int(base * career.difficulty.data.payout_scale * scale)
        if lap_record:
            earned += tuning.record_bonus
        career.credits += earned
        return earned

    def standings(self, ctx, field):
        points = ctx.get(Season).points
        rows = [StandingRow(car=racer.car, is_player=car.has(PlayerCar), points=points.get(standings_key(car), 0))
                for car, racer in field]
        return sorted(rows, key=lambda row: -row.points)

    def close_season(self, ctx, champion):
        career = ctx.get(Career)
        if champion:
            career.titles += 1
            career.credits += ctx.config(RaceRules).champion_prize
        ctx.reset(Season)
