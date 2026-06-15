'use strict';

// Parses one shot-directory written by Uneekor VIEW.
//
// Each shot lives at <ShotData>/<n>/ and contains:
//   shotinfo.json     — measurements (ball + club kinematics)
//   ProShotInfo.json  — player + club context, plus Star flag (true for
//                       VIEW's bundled "pro reference shots" — filter out)
//   imageinfo.xml     — JPG manifest (ignored)
//   ~25 .jpg          — high-speed-camera frames (ignored)
//
// VIEW writes numeric fields as space-padded strings like "   45.0800" —
// every value goes through `num()` which strips and float-casts.
//
// Returns:
//   { ok: true,  value: <unified shot record> }
//   { ok: false, filtered: true, reason: 'reference_demo' }   — Star: true
//   { ok: false, reason, error? }                              — read/parse failure

const fs = require('fs');
const path = require('path');

function num(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s.length === 0) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// VIEW writes ball + club velocities in m/s regardless of the user's "mph
// vs km/h" preference in HKCU. The downstream schema, ballistic model, and
// app UI all use mph, so we convert at the parser boundary and surface mph
// to everything else. Sanity check: a 7-iron ball speed of 50.4 m/s is
// 112.7 mph, which matches what GS Pro / VIEW displays on screen.
const MPH_PER_MS = 2.23694;
function msToMph(ms) {
  return ms == null ? null : ms * MPH_PER_MS;
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function readShotDir({ dir, shotNumber }) {
  const shotinfoPath = path.join(dir, 'shotinfo.json');
  const proInfoPath  = path.join(dir, 'ProShotInfo.json');

  let shotinfo;
  try { shotinfo = readJson(shotinfoPath); }
  catch (err) { return { ok: false, reason: 'shotinfo_unreadable', error: err.message }; }

  let proInfo;
  try { proInfo = readJson(proInfoPath); }
  catch (err) { return { ok: false, reason: 'proshotinfo_unreadable', error: err.message }; }

  if (proInfo && proInfo.Star === true) {
    return { ok: false, filtered: true, reason: 'reference_demo' };
  }

  const data = (shotinfo && shotinfo.DATA) || {};

  const assurance = {
    clubSpeed:   num(data.Assurance_clubspeed),
    clubPath:    num(data.Assurance_clubpath),
    faceAngle:   num(data.Assurance_clubfaceangle),
    attackAngle: num(data.Assurance_clubattackangle)
  };

  return {
    ok: true,
    value: {
      shotNumber,
      // Ball kinematics — velocities converted m/s → mph at the boundary.
      ballSpeed: msToMph(num(data.ballspeed)),   // mph (converted from m/s)
      vla:       num(data.incline),              // vertical launch angle (deg)
      hla:       num(data.azimuth),              // horizontal launch angle (deg)
      backspin:  num(data.backspin),             // rpm
      sidespin:  num(data.sidespin),             // rpm
      totalSpin: num(data.spinmag2d),            // rpm
      spinAxis:  num(data.spinaxis2d),           // deg
      // Club kinematics
      clubSpeed:      msToMph(num(data.clubspeed)), // mph (converted from m/s)
      clubPath:       num(data.clubpath),
      faceAngle:      num(data.clubfaceangle),
      attackAngle:    num(data.clubattackangle),
      clubLoft:       num(data.clubloftangle),
      clubLie:        num(data.clublieangle),
      impactLateral:  num(data.clubfaceimpactLateral),
      impactVertical: num(data.clubfaceimpactVertical),
      assurance,
      // Player + club context from ProShotInfo
      playerName: (proInfo && proInfo.Name) || null,
      clubId:     Number.isInteger(proInfo && proInfo.Club) ? proInfo.Club : null,
      clubName:   (proInfo && proInfo.ClubName) || null,
      hand:       Number.isInteger(proInfo && proInfo.Hand) ? proInfo.Hand : null,
      // Source artifacts preserved verbatim for the `raw` jsonb column.
      raw: { shotinfo, proShotInfo: proInfo }
    }
  };
}

module.exports = { readShotDir, num };
