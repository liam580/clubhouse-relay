'use strict';

const DEFAULT_TIMEOUT_MS = 5000;

function createSupabaseClient({ config, logger, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { url, serviceKey, shotsTable } = config.supabase || {};
  const enabled = Boolean(url && serviceKey);

  if (!enabled) {
    logger.info('supabase disabled — leave url/serviceKey empty in config.json to skip Supabase writes');
    return disabledClient();
  }

  const baseUrl = url.replace(/\/$/, '');
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`
  };
  logger.info({ baseUrl }, 'supabase enabled');

  async function fetchWithTimeout(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // query is an array of [key, value] tuples so a single key can appear twice
  // (e.g. `recorded_at=gte.X` AND `recorded_at=lt.Y` for range filters).
  // Plain objects also accepted — converted to tuples.
  function toTuples(query) {
    if (!query) return [];
    if (Array.isArray(query)) return query;
    return Object.entries(query);
  }

  async function request(path, { method = 'GET', body, prefer, query } = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of toTuples(query)) params.append(k, v);
    const qs = params.toString();
    const target = `${baseUrl}/rest/v1/${path}` + (qs ? `?${qs}` : '');

    const reqHeaders = { ...headers };
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
    if (prefer) reqHeaders['Prefer'] = prefer;

    const res = await fetchWithTimeout(target, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`supabase ${method} ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return res;
  }

  async function readJson(res) {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }

  return {
    enabled: true,

    async healthCheck() {
      try {
        const res = await fetchWithTimeout(`${baseUrl}/rest/v1/${shotsTable}?select=id&limit=1`, {
          headers
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, status: res.status, body: body.slice(0, 200) };
        }
        return { ok: true, status: res.status };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async insertShot(row) {
      await request(shotsTable, {
        method: 'POST',
        body: row,
        prefer: 'return=minimal'
      });
    },

    async upsertPlayer({ optix_user_id, optix_member_id, email, display_name }) {
      const res = await request('players', {
        method: 'POST',
        body: [{ optix_user_id, optix_member_id, email, display_name }],
        prefer: 'resolution=merge-duplicates,return=representation',
        query: { on_conflict: 'optix_user_id' }
      });
      const rows = await readJson(res);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('supabase upsertPlayer returned no row');
      }
      return rows[0];
    },

    async findOpenSessionByBooking({ optixBookingId, bayNumber }) {
      const res = await request('sessions', {
        method: 'GET',
        query: {
          optix_booking_id: `eq.${optixBookingId}`,
          bay_number: `eq.${bayNumber}`,
          ended_at: 'is.null',
          select: '*',
          limit: '1'
        }
      });
      const rows = await readJson(res);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    async createSession({ player_id, bay_number, optix_booking_id, started_at }) {
      const res = await request('sessions', {
        method: 'POST',
        body: [{ player_id, bay_number, optix_booking_id, started_at }],
        prefer: 'return=representation'
      });
      const rows = await readJson(res);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('supabase createSession returned no row');
      }
      return rows[0];
    },

    async closeSession({ session_id, ended_at, shot_count }) {
      await request('sessions', {
        method: 'PATCH',
        body: { ended_at, shot_count },
        prefer: 'return=minimal',
        query: { id: `eq.${session_id}` }
      });
    },

    async countShotsForSession(session_id) {
      const res = await fetchWithTimeout(
        `${baseUrl}/rest/v1/${shotsTable}?session_id=eq.${session_id}&select=id&limit=0`,
        { headers: { ...headers, 'Prefer': 'count=exact' } }
      );
      if (!res.ok) {
        throw new Error(`supabase countShotsForSession HTTP ${res.status}`);
      }
      const range = res.headers.get('content-range');
      // Format: "0-/N" or "*/N" — N is total count
      const match = range && range.match(/\/(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    },

    async backfillNullShots({ bayNumber, sessionId, playerId, sinceIso, beforeIso }) {
      const query = [
        ['bay_number', `eq.${bayNumber}`],
        ['session_id', 'is.null'],
        ['recorded_at', `gte.${sinceIso}`]
      ];
      if (beforeIso) query.push(['recorded_at', `lt.${beforeIso}`]);
      const res = await request(shotsTable, {
        method: 'PATCH',
        body: { session_id: sessionId, player_id: playerId },
        prefer: 'return=representation',
        query
      });
      const rows = await readJson(res);
      return Array.isArray(rows) ? rows.length : 0;
    }
  };
}

function disabledClient() {
  const noop = async () => {};
  return {
    enabled: false,
    healthCheck: async () => ({ ok: true, skipped: true }),
    insertShot: noop,
    upsertPlayer: noop,
    findOpenSessionByBooking: async () => null,
    createSession: noop,
    closeSession: noop,
    countShotsForSession: async () => 0,
    backfillNullShots: async () => 0
  };
}

module.exports = { createSupabaseClient };
