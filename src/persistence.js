'use strict';

const fs = require('fs');
const path = require('path');
const { createSupabaseClient } = require('./supabase');

const SHOTS_FILE = 'shots.jsonl';

function flattenShot(rawShot) {
  const ball = (rawShot && rawShot.BallData) || {};
  const club = (rawShot && rawShot.ClubData) || {};
  const pick = (v) => (v === undefined ? null : v);
  return {
    shot_number:    pick(rawShot && rawShot.ShotNumber),
    ball_speed:     pick(ball.Speed),
    spin_axis:      pick(ball.SpinAxis),
    total_spin:     pick(ball.TotalSpin),
    hla:            pick(ball.HLA),
    vla:            pick(ball.VLA),
    carry_distance: pick(ball.CarryDistance),
    club_speed:     pick(club.Speed),
    attack_angle:   pick(club.AngleOfAttack),
    face_to_target: pick(club.FaceToTarget),
    path:           pick(club.Path),
    club:           pick(rawShot && rawShot.Club)
  };
}

function buildShotRow({ rawShot, bayNumber, tag }) {
  return {
    session_id: tag?.session_id || null,
    player_id: tag?.player_id || null,
    bay_number: bayNumber,
    ...flattenShot(rawShot),
    raw: rawShot,
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

  function saveShot(rawShot) {
    let tag = null;
    try {
      tag = tagFn() || null;
    } catch (err) {
      logger.error({ err: err.message }, 'getTag callback threw — saving shot untagged');
    }
    const row = buildShotRow({ rawShot, bayNumber: config.bay.number, tag });

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
