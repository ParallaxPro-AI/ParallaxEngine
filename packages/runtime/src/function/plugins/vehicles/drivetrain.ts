/**
 * The drivetrain (the `drivetrain` component, sdk/parallax/vehicles.pyi): engine torque
 * curve → clutch → gearbox → final drive → the driven wheels.
 *
 * Engine speed is derived, never invented: with the clutch engaged the engine turns with
 * the wheels, `rpm = wheel rpm × gear ratio × final drive`, so an upshift drops the revs
 * and a climb lugs the engine. Below LAUNCH_RPM the clutch slips: the engine holds
 * between idle and LAUNCH_RPM by throttle while the car pulls away, and `clutch` (0..1)
 * says how far it has engaged. At `redline_rpm` the limiter cuts torque.
 *
 * Torque at the crank is a smooth curve through three points the author gives: 55% of
 * `peak_torque` at idle, `peak_torque` at `peak_rpm`, 70% at the redline. Wheel force is
 * `torque × ratio × final_drive × EFFICIENCY / wheel radius`. Closed throttle in gear is
 * engine braking (`engine_braking` × peak torque, scaled by rpm / redline).
 *
 * The gearbox is automatic. Shifting takes `shift_time` seconds with no drive; it upshifts
 * at `upshift` × the redline and downshifts when a lower gear would still be below it (and
 * the revs fall under `downshift` × redline); a negative throttle at a standstill selects
 * reverse, a positive one first gear.
 *
 * Pure: state in, state and force out.
 */

export const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** The clutch is fully engaged from these revs (never below idle). */
export const LAUNCH_RPM = 2600;
/** Fraction of crank torque that reaches the wheels. */
export const EFFICIENCY = 0.85;

export interface DrivetrainFields {
  readonly gears: readonly number[];
  readonly reverse_ratio: number;
  readonly final_drive: number;
  readonly idle_rpm: number;
  readonly peak_rpm: number;
  readonly redline_rpm: number;
  readonly peak_torque: number;
  readonly engine_braking: number;
  readonly shift_time: number;
  readonly upshift: number;
  readonly downshift: number;
}

/** -1 reverse, 0 neutral, 1.. forward gears. */
export interface DrivetrainState {
  gear: number;
  rpm: number;
  clutch: number;
  /** Seconds left in a shift under way (no drive meanwhile). */
  shifting: number;
}

export function freshDrivetrain(d: DrivetrainFields): DrivetrainState {
  return { gear: d.gears.length > 0 ? 1 : 0, rpm: d.idle_rpm, clutch: 0, shifting: 0 };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Crank torque (N·m) at full throttle and `rpm`; 0 at and above the redline (the limiter). */
export function torqueAt(d: DrivetrainFields, rpm: number): number {
  if (rpm >= d.redline_rpm) return 0;
  const r = Math.max(rpm, d.idle_rpm);
  // Two quadratic halves meeting at the peak with zero slope.
  if (r <= d.peak_rpm) {
    const u = (d.peak_rpm - r) / Math.max(d.peak_rpm - d.idle_rpm, 1);
    return d.peak_torque * (1 - 0.45 * u * u);
  }
  const u = (r - d.peak_rpm) / Math.max(d.redline_rpm - d.peak_rpm, 1);
  return d.peak_torque * (1 - 0.3 * u * u);
}

/** The overall ratio of `gear` (gearbox × final drive); 0 in neutral. */
export function ratioOf(d: DrivetrainFields, gear: number): number {
  if (gear === 0) return 0;
  if (gear < 0) return d.reverse_ratio * d.final_drive;
  return (d.gears[gear - 1] ?? 0) * d.final_drive;
}

/** Engine rpm with the clutch engaged at forward speed `speed` (m/s) on wheels of `radius`. */
export function engagedRpm(d: DrivetrainFields, gear: number, speed: number, radius: number): number {
  return (Math.abs(speed) / radius) * RPM_PER_RAD_S * ratioOf(d, gear);
}

export interface DriveDemand {
  /** -1..1 as `drive(throttle=)` gave it. */
  readonly throttle: number;
  /** Forward speed (m/s, negative backing up). */
  readonly speed: number;
  readonly radius: number;
  readonly dt: number;
}

export interface DriveOutput {
  /** Newtons at the driven wheels along the chassis' forward axis (negative: backwards). */
  readonly force: number;
  /** 0..1 of braking the drivetrain asks for (a negative throttle in a forward gear, or a standstill direction change). */
  readonly brake: number;
}

/** Automatic gear selection for this step (mutates `s`). */
function autoShift(d: DrivetrainFields, s: DrivetrainState, demand: DriveDemand): void {
  const top = d.gears.length;
  if (top === 0) return;
  const { throttle, speed, radius } = demand;
  const still = Math.abs(speed) < 0.5;
  if (s.gear <= 0 && throttle > 0 && (still || speed > 0)) begin(d, s, 1);
  else if (s.gear >= 0 && throttle < 0 && still) begin(d, s, -1);
  if (s.gear <= 0 || s.shifting > 0) return;
  const rpm = engagedRpm(d, s.gear, speed, radius);
  if (s.gear < top && rpm >= d.upshift * d.redline_rpm) begin(d, s, s.gear + 1);
  else if (s.gear > 1 && rpm < d.downshift * d.redline_rpm
    && engagedRpm(d, s.gear - 1, speed, radius) < d.upshift * d.redline_rpm * 0.9) begin(d, s, s.gear - 1);
}

function begin(d: DrivetrainFields, s: DrivetrainState, gear: number): void {
  if (gear === s.gear) return;
  s.gear = gear;
  s.shifting = d.shift_time;
}

/** One fixed step: updates `s` (gear, rpm, clutch, shift timer) and returns the wheel force. */
export function stepDrivetrain(d: DrivetrainFields, s: DrivetrainState, demand: DriveDemand): DriveOutput {
  const { speed, radius, dt } = demand;
  autoShift(d, s, demand);
  s.shifting = Math.max(0, s.shifting - dt);
  const reverse = s.gear < 0;
  // What the driver's foot asks of the engine, and what it asks of the brakes.
  const pedal = reverse ? Math.max(0, -demand.throttle) : Math.max(0, demand.throttle);
  const against = reverse ? demand.throttle > 0 : demand.throttle < 0;
  const brake = against ? Math.abs(demand.throttle) : 0;
  const ratio = ratioOf(d, s.gear);
  const engaged = ratio === 0 ? 0 : engagedRpm(d, s.gear, speed, radius);
  // Moving against the selected gear (rolling back in first): the clutch is in, no drive.
  const wrongWay = ratio !== 0 && (reverse ? speed > 0.5 : speed < -0.5);
  if (ratio === 0 || s.shifting > 0 || wrongWay) {
    s.clutch = 0;
    s.rpm = d.idle_rpm + pedal * (d.redline_rpm - d.idle_rpm) * 0.9;
    return { force: 0, brake: wrongWay ? Math.max(brake, pedal) : brake };
  }
  const launch = Math.max(LAUNCH_RPM, d.idle_rpm);
  const slipRpm = d.idle_rpm + pedal * (launch - d.idle_rpm);
  s.clutch = clamp(engaged / launch, 0, 1);
  s.rpm = Math.min(Math.max(engaged, s.clutch < 1 ? slipRpm : engaged), d.redline_rpm);
  const atWheels = (ratio * EFFICIENCY) / radius;
  let torque = pedal * torqueAt(d, s.rpm);
  if (pedal === 0) torque = -d.engine_braking * d.peak_torque * clamp(engaged / d.redline_rpm, 0, 1);
  const direction = reverse ? -1 : 1;
  return { force: direction * torque * atWheels, brake };
}
