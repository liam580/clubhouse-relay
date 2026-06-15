'use strict';

// Convert a merged GS Pro Open Connect envelope (ball half + club half
// combined for one ShotNumber) into the relay's unified shot record.
//
// Values arrive ALREADY in display units (mph, yards, deg, rpm) — Connect
// did the translation upstream. The relay's job is direct field copy + a
// small amount of defensive math for known Connect quirks. No ballistic
// model, no unit conversion.

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Connect occasionally emits SpinAxis: 0 or TotalSpin: 0 while BackSpin
// and SideSpin are populated (EYE XO2 spin-estimate quirk per Bay 2 audit).
// Derive both from the raw spin axes when that happens.
function deriveTotalSpin(backSpin, sideSpin) {
  if (backSpin == null || sideSpin == null) return null;
  return Math.hypot(backSpin, sideSpin);
}

function deriveSpinAxis(backSpin, sideSpin) {
  if (backSpin == null || sideSpin == null) return null;
  if (backSpin === 0 && sideSpin === 0) return null;
  return (Math.atan2(sideSpin, backSpin) * 180) / Math.PI;
}

// Convert one merged envelope to a relay shot record.
//   env          — the merged envelope (with BallData + ClubData both set)
//   sideContext  — latest ProShotInfo.json content, or null if cache empty
function envelopeToShot(env, sideContext) {
  const b = (env && env.BallData) || {};
  const c = (env && env.ClubData) || {};

  const backSpin = num(b.BackSpin);
  const sideSpin = num(b.SideSpin);
  let totalSpin = num(b.TotalSpin);
  let spinAxis = num(b.SpinAxis);
  if ((totalSpin == null || totalSpin === 0) && backSpin != null && sideSpin != null) {
    totalSpin = deriveTotalSpin(backSpin, sideSpin);
  }
  if ((spinAxis == null || spinAxis === 0) && backSpin != null && sideSpin != null) {
    spinAxis = deriveSpinAxis(backSpin, sideSpin);
  }

  const ctx = sideContext || {};

  return {
    shotNumber: env && env.ShotNumber != null ? env.ShotNumber : null,
    // Ball kinematics (mph + yards + deg + rpm, direct passthrough)
    ballSpeed:      num(b.Speed),
    hla:            num(b.HLA),
    vla:            num(b.VLA),
    backSpin,
    sideSpin,
    totalSpin,
    spinAxis,
    carryDistance:  num(b.CarryDistance),
    // Club kinematics (mph + deg, direct passthrough)
    clubSpeed:            num(c.Speed),
    speedAtImpact:        num(c.SpeedAtImpact),
    attackAngle:          num(c.AngleOfAttack),
    faceAngle:            num(c.FaceToTarget),
    clubPath:             num(c.Path),
    clubLoft:             num(c.Loft),
    clubLie:              num(c.Lie),
    horizontalFaceImpact: num(c.HorizontalFaceImpact),
    verticalFaceImpact:   num(c.VerticalFaceImpact),
    // Envelope metadata
    deviceId:   (env && env.DeviceID) || null,
    units:      (env && env.Units) || null,
    apiVersion: (env && env.APIversion) || null,
    // Player + club context from ProShotInfo side-watcher cache. Connect's
    // envelope doesn't carry player identity; ProShotInfo is the only source.
    playerName: ctx.Name || null,
    clubId:     Number.isInteger(ctx.Club) ? ctx.Club : null,
    clubName:   ctx.ClubName || null,
    hand:       Number.isInteger(ctx.Hand) ? ctx.Hand : null,
    // Raw merged envelope preserved verbatim for the `raw` jsonb column.
    raw: env || null,
  };
}

module.exports = { envelopeToShot, deriveTotalSpin, deriveSpinAxis };
