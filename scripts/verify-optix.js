'use strict';

// Standalone live-verification harness for the relay's Optix integration.
//
// Why this exists: the relay's server-side auth model (static org-token Bearer)
// and its CURRENT_BOOKING_QUERY shape were written without an attested source.
// Our only Optix reference (optixcontext.txt) documents the *client-side* canvas
// token flow and the booking-CREATION mutations (bookingsDraft/bookingsCommit) —
// not a server-side poll for the currently in-progress booking. This script
// turns those guesses into facts: given a server-usable Bearer token it
// introspects the real `bookings` query field (exact arg names + types, which
// settles [ID] vs ID!) and then runs the exact query the relay uses against a
// real resource id, printing the raw response.
//
// Usage:
//   OPTIX_TOKEN=xxxx node scripts/verify-optix.js [resourceId]
//   OPTIX_TOKEN=xxxx OPTIX_RESOURCE_ID=619992 node scripts/verify-optix.js
//
// Exits 0 if the real query executed without GraphQL errors, 1 otherwise.

const { CURRENT_BOOKING_QUERY } = require('../src/optix-client');

const ENDPOINT = process.env.OPTIX_GRAPHQL_URL || 'https://api.optixapp.com/graphql';
const TOKEN = process.env.OPTIX_TOKEN;
const RESOURCE_ID = process.argv[2] || process.env.OPTIX_RESOURCE_ID || '609902';

if (!TOKEN) {
  console.error(
    [
      'Missing OPTIX_TOKEN.',
      '',
      'Provide a server-usable Bearer token, then re-run:',
      '  OPTIX_TOKEN=<token> node scripts/verify-optix.js [resourceId]',
      '',
      'Where to get a token (one of):',
      '  (a) Optix admin -> Develop -> your app -> organization token (server-side, suffix "o")',
      '  (b) OAuth2 client-credentials grant using client_id e50412bbbbeb3ca3e19158663b6651248a50ba4f',
      '  (c) one-off check only: copy a {token} canvas-macro value from a live Optix canvas',
      ''
    ].join('\n')
  );
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null; caller inspects raw text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// Render an introspection type ref as a readable signature, e.g. [ID], ID!, [ID!]!
function renderType(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${renderType(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${renderType(t.ofType)}]`;
  return t.name || t.kind;
}

const QUERY_FIELDS_INTROSPECTION = `
  query IntrospectQueryFields {
    __type(name: "Query") {
      fields {
        name
        args {
          name
          type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
        }
      }
    }
  }
`;

async function main() {
  console.log('Optix live verification');
  console.log('  endpoint :', ENDPOINT);
  console.log('  resource :', RESOURCE_ID);
  console.log(
    '  token    :',
    `${TOKEN.slice(0, 4)}…${TOKEN.slice(-2)} (len ${TOKEN.length}, ends "${TOKEN.slice(-1)}")`
  );
  console.log('');

  // 1) Auth probe + introspection of the bookings query field.
  console.log('[1] Introspecting Query.bookings ...');
  const intro = await gql(QUERY_FIELDS_INTROSPECTION);
  console.log('    HTTP', intro.status);
  if (intro.json && intro.json.errors) {
    console.log('    GraphQL errors:', intro.json.errors.map((e) => e.message).join('; '));
  }
  const fields = intro.json && intro.json.data && intro.json.data.__type && intro.json.data.__type.fields;
  if (!fields) {
    console.log('    introspection unavailable (disabled on server, or auth rejected).');
    console.log('    raw:', intro.text.slice(0, 300));
  } else {
    const bookings = fields.find((f) => f.name === 'bookings');
    if (!bookings) {
      console.log(
        '    NO `bookings` field on Query. Sample of available fields:',
        fields.slice(0, 40).map((f) => f.name).join(', ')
      );
    } else {
      console.log('    Query.bookings args:');
      for (const a of bookings.args) console.log(`      ${a.name}: ${renderType(a.type)}`);
      const rid = bookings.args.find((a) => a.name === 'resource_id');
      if (rid) {
        console.log(`    -> resource_id is ${renderType(rid.type)}  (relay assumes [ID])`);
      } else {
        console.log('    -> no `resource_id` arg found; relay filter assumption is wrong');
      }
    }
  }
  console.log('');

  // 2) The exact query the relay polls with.
  console.log('[2] Running relay CURRENT_BOOKING_QUERY for resource', RESOURCE_ID, '...');
  const real = await gql(CURRENT_BOOKING_QUERY, { resource_id: [String(RESOURCE_ID)] });
  console.log('    HTTP', real.status);
  if (real.json && real.json.errors) {
    console.log('    GraphQL errors:');
    for (const e of real.json.errors) console.log('      -', e.message);
  }
  if (real.json && real.json.data) {
    console.log('    data:', JSON.stringify(real.json.data, null, 2));
  } else if (!real.json) {
    console.log('    non-JSON response:', real.text.slice(0, 300));
  }
  console.log('');

  const success = Boolean(real.ok && real.json && !real.json.errors);
  console.log(success ? 'RESULT: query executed cleanly' : 'RESULT: query did NOT execute cleanly');
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-optix crashed:', err.stack || err.message);
  process.exit(1);
});
