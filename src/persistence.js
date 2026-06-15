'use strict';

const fs = require('fs');
const path = require('path');
const { createSupabaseClient } = require('./supabase');
const { computeCarryYards } = require('./ballistic');

const SHOTS_FILE = 'shots.jsonl';

// Maps the unified VIEW shot record (produced by src/view-parser.js) onto the
// Supabase `shots` columns. Naming convention is whatever was already there
// from the original GS Pro Connect schema — hla/vla/attack_angle/path/etc —
// even though the VIEW field names are different. Same physical quantities.
function flattenShot(shot) {
  const pick = (v) => (v === undefined ? null : v);
  if (!shot) return {};

  let carry = null;
  if (shot.ballSpeed != null && shot.vla != null && shot.backspin != null) {
    const c = computeCarryYards({
      ballSpeedMph: shot.ballSpeed,
      vlaDeg: shot.vla,
      backspinRpm: shot.backspin
    });
    if (c != null) carry = Math.round(c * 10) / 10;
  }

  return {
    shot_number:    pick(shot.shotNumber),
    ball_speed:     pick(shot.ballSpeed),
    spin_axis:      pick(shot.spinAxis),
    total_spin:     pick(shot.totalSpin),
    hla:            pick(shot.hla),
    vla:            pick(shot.vla),
    carry_distance: carry,
    club_speed:     pick(shot.clubSpeed),
    face_to_target: pick(shot.faceAngle),
    attack_angle:   pick(shot.attackAngle),
    path:           pick(shot.clubPath),
    club:           pick(shot.clubName),    // existing text column repurposed
    club_id:        pick(shot.clubId),
    hand:           pick(shot.hand),
    assurance:      pick(shot.assurance)
  };
}

function buildShotRow({ shot, bayNumber, tag }) {
  return {
    session_id: tag?.session_id || null,
    player_id:  tag?.player_id  || null,
    bay_number: bayNumber,
    ...flattenShot(shot),
    raw: (shot && shot.raw) ? shot.raw : shot,
    recorded_at: new Date().toISOString()
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
    supabaseEnabled: supa.enabled
  };
}

module.exports = { createPersistence, buildShotRow, flattenShot };
