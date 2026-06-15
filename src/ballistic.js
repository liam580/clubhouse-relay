'use strict';

// Carry-distance estimation for VIEW shots.
//
// VIEW measures launch + spin but not carry — Uneekor leaves carry to be
// computed downstream by the game engine. Since we're not in GS Pro's data
// path (file-watch input), we reconstruct it ourselves with a standard golf
// ball trajectory integrator: drag + Magnus lift + gravity, Euler steps.
//
// Accuracy: within ~5–10% of GS Pro on normal full shots; less reliable on
// extreme spin or near-vertical launches. Good enough for "what was my best
// 7-iron carry this month" stats, not for tournament rangefinder calibration.
//
// Returns yards. Returns null if required inputs are missing/non-finite.

const G = 9.81;            // gravity, m/s²
const RHO = 1.225;         // air density at sea level, kg/m³
const BALL_MASS = 0.0459;  // kg
const BALL_RADIUS = 0.02135; // m
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const MPH_TO_MS = 0.44704;
const M_TO_YD = 1.09361;
const RPM_TO_RADS = (2 * Math.PI) / 60;

const DT = 0.005;          // 5 ms integration step
const MAX_T = 12;          // s — bails out on unrealistic shots

function computeCarryYards({ ballSpeedMph, vlaDeg, backspinRpm }) {
  if (![ballSpeedMph, vlaDeg, backspinRpm].every((v) => Number.isFinite(v))) return null;
  if (ballSpeedMph <= 0 || vlaDeg <= 0) return null;

  const v0 = ballSpeedMph * MPH_TO_MS;
  const launchRad = (vlaDeg * Math.PI) / 180;
  const omega = backspinRpm * RPM_TO_RADS;

  // 2D trajectory in (x, z) plane — sidespin ignored; we only need carry distance,
  // and sidespin moves the ball laterally without meaningfully changing carry.
  let x = 0, z = 0;
  let vx = v0 * Math.cos(launchRad);
  let vz = v0 * Math.sin(launchRad);

  let t = 0;
  let prevZ = 0;

  while (t < MAX_T) {
    const speed = Math.sqrt(vx * vx + vz * vz);
    if (speed < 0.5) break;

    // Spin parameter S = ω·r / v — dimensionless. Higher S = more Magnus effect.
    const spinParam = (omega * BALL_RADIUS) / Math.max(speed, 0.1);
    // Empirical golf-ball coefficients calibrated against tour driver (~280 yd)
    // and short-iron (~80 yd). Both saturate at high spin so the model doesn't
    // explode on lob/wedge shots.
    const Cd = Math.min(0.22 + 0.20 * spinParam, 0.40);
    const Cl = Math.min(0.6 * Math.sqrt(spinParam), 0.30);

    const dragAccel = (0.5 * RHO * speed * speed * BALL_AREA * Cd) / BALL_MASS;
    const liftAccel = (0.5 * RHO * speed * speed * BALL_AREA * Cl) / BALL_MASS;

    // Drag opposes velocity
    const ax_drag = (-dragAccel * vx) / speed;
    const az_drag = (-dragAccel * vz) / speed;
    // Lift perpendicular to velocity, rotated 90° CCW in (x, z) — backspin lifts up-and-back
    const ax_lift = (-liftAccel * vz) / speed;
    const az_lift = (liftAccel * vx) / speed;

    const ax = ax_drag + ax_lift;
    const az = az_drag + az_lift - G;

    prevZ = z;
    vx += ax * DT;
    vz += az * DT;
    x += vx * DT;
    z += vz * DT;
    t += DT;

    if (z <= 0 && prevZ > 0) {
      // Linear-interpolate the ground crossing to avoid stepping past it.
      const frac = prevZ / (prevZ - z);
      x -= vx * DT * (1 - frac);
      break;
    }
    if (z <= 0 && t > 0.5) break;
  }

  return Math.max(0, x * M_TO_YD);
}

module.exports = { computeCarryYards };
