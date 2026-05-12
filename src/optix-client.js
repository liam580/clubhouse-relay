'use strict';

// Note: Optix's `bookings(resource_id: ...)` argument is `[ID]` (a list),
// not a single ID. We pass a one-element array so the filter matches one bay.
const CURRENT_BOOKING_QUERY = `
  query CurrentBooking($resource_id: [ID]) {
    bookings(
      resource_id: $resource_id
      in_progress: true
      include_approved: true
      include_new: true
      limit: 1
    ) {
      total
      data {
        booking_id
        start_timestamp
        end_timestamp
        is_canceled
        account { account_id }
        user    { user_id email fullname }
        resource { resource_id }
      }
    }
  }
`.trim();

function createOptixClient({ config, logger }) {
  const optix = config.optix || {};
  const enabled = Boolean(optix.orgToken && optix.graphqlUrl);
  const url = optix.graphqlUrl;
  const token = optix.orgToken;
  const timeoutMs = optix.fetchTimeoutMs || 5000;

  if (!enabled) {
    logger.info('optix client disabled — leave optix.orgToken empty to skip session polling');
    return {
      enabled: false,
      async getCurrentBooking() { return null; }
    };
  }

  async function gql(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`optix HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      if (json.errors && json.errors.length) {
        throw new Error(`optix GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled: true,

    async getCurrentBooking(resourceId) {
      const data = await gql(CURRENT_BOOKING_QUERY, { resource_id: [String(resourceId)] });
      const rows = data?.bookings?.data || [];
      if (rows.length === 0) return null;
      const b = rows[0];
      // Defensive: in_progress should already exclude canceled, but double-check.
      if (b.is_canceled) return null;
      return {
        booking_id:      String(b.booking_id),
        start_timestamp: b.start_timestamp,                // Unix epoch seconds
        end_timestamp:   b.end_timestamp,
        account_id:      b.account?.account_id ? String(b.account.account_id) : null,
        user_id:         b.user?.user_id ? String(b.user.user_id) : null,
        email:           b.user?.email || null,
        fullname:        b.user?.fullname || null,
        resource_id:     b.resource?.resource_id ? String(b.resource.resource_id) : null
      };
    }
  };
}

module.exports = { createOptixClient, CURRENT_BOOKING_QUERY };
