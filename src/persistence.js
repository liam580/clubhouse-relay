'use strict';

const fs = require('fs');
const path = require('path');
const { createSupabaseClient } = require('./supabase');

const SHOTS_FILE = 'shots.jsonl';

// Maps the unified shot record (produced by src/gspro-parser.js from a
// merged Connect envelope) onto the Supabase `shots` columns. All values
// arrive already in display units (mph, yards, deg, rpm) — Connect did the
// translation. The relay does direct field copies; no unit conversion, no
// ballistic compute.
function flattenShot(shot) {
  const pick = (v) => (v === undefined ? null : v);
  if (!shot) return {};

  return {
    shot_number:    pick(shot.shotNumber),
    // Ball kinematics
    ball_speed:     pick(shot.ballSpeed),
    spin_axis:      pick(shot.spinAxis),
    total_spin:     pick(shot.totalSpin),
    back_spin:      pick(shot.backSpin),
    side_spin:      pick(shot.sideSpin),
    hla:            pick(shot.hla),
    vla:            pick(shot.vla),
    carry_distance: pick(shot.carryDistance),       // direct from Connect, no ballistic
    // Club kinematics
    club_speed:        pick(shot.clubSpeed),
    speed_at_impact:   pick(shot.speedAtImpact),
    face_to_target:    pick(shot.faceAngle),
    attack_angle:      pick(shot.attackAngle),
    path:              pick(shot.clubPath),
    // Club + player context (from ProShotInfo side-watcher cache)
    club:           pick(shot.clubName),
    club_id:        pick(shot.clubId),
    hand:           pick(shot.hand),
  };
}

function buildShotRow({ shot, bayNumber, tag }) {
  return {
    session_id: tag?.session_id || null,
    player_id:  tag?.player_id  || null,
    bay_number: bayNumber,
    ...flattenShot(shot),
    raw: (shot && shot.raw) ? shot.raw : shot,
    recorded_at: new Date().toISOString(),
  };
}

function createPersistence({ config, logger, dataDir, supabase, getTag }) {
  const resolvedDir = path.resolve(__dirname, '..', dataDir || 'data');
  fs.mkdirSync(resolvedDir, { recursive: true });
  const shotsPath = path.join(resolvedDir, SHOTS_FILE);

  const stream = fs.createWriteStream(shotsPath, { flags: 'a' });
  stream.on('error', (err) => {
    logger.error({ err: err.message }, 'shots jsonl write stream error');
  });

  const supa = supabase || createSupabaseClient({ config, logger });
  const tagFn = typeof getTag === 'function' ? getTag : () => null;

  function saveShot(shot) {
    let tag = null;
    try {
      tag = tagFn() || null;
    } catch (err) {
      logger.error({ err: err.message }, 'getTag callback threw — saving shot untagged');
    }
    const row = buildShotRow({ shot, bayNumber: config.bay.number, tag });

    let line;
    try {
      line = JSON.stringify(row) + '\n';
    } catch (err) {
      logger.error({ err: err.message }, 'failed to stringify shot record');
      return;
    }

    try {
      stream.write(line);
    } catch (err) {
      logger.error({ err: err.message }, 'failed to append to shots.jsonl');
    }

    logger.info(
      {
        shotNumber: row.shot_number,
        sessionId:  row.session_id,
        playerId:   row.player_id,
        club:       row.club,
        ballSpeed:  row.ball_speed,
        carry:      row.carry_distance,
      },
      'shot saved'
    );

    supa.insertShot(row).catch((err) => {
      logger.error({ err: err.message }, 'supabase insertShot failed');
    });
  }

  async function close() {
    await new Promise((resolve) => stream.end(resolve));
  }

  return {
    saveShot,
    close,
    shotsPath,
    healthCheck: supa.healthCheck.bind(supa),
    supabaseEnabled: supa.enabled,
  };
}

module.exports = { createPersistence, buildShotRow, flattenShot };
