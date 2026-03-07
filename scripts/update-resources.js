// ---------------------------------------------------------------------------
// Sync Resource Updater — uses Claude API with web search to verify/update
// resource pricing and details quarterly.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const RESOURCE_FILE = path.join(__dirname, '..', 'sync-resources.json');

// -- Helpers ------------------------------------------------------------------

async function callClaude(messages, system) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system,
    messages,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 60
      }
    ]
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  return res.json();
}

function extractText(response) {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('Reading current sync-resources.json...');
  const current = JSON.parse(fs.readFileSync(RESOURCE_FILE, 'utf-8'));
  const resourceCount = current.resources.length;
  console.log(`Found ${resourceCount} resources (version ${current.version})`);

  // Build a compact summary for Claude to verify
  const resourceSummary = current.resources.map((r, i) => (
    `${i + 1}. ${r.name} | ${r.url} | Cost: ${r.cost} | Category: ${r.category} | Accepts unsolicited: ${r.acceptsUnsolicited}`
  )).join('\n');

  const system = `You are a music industry research assistant. Your job is to verify and update a JSON file containing sync licensing resources for independent musicians.

IMPORTANT RULES:
1. Use web search to check each resource's website for current pricing, submission status, and whether the service is still active.
2. Only change fields where you find CONCRETE evidence of a change. Do not guess or assume.
3. If a website is down or you can't verify info, leave it unchanged and note it.
4. If you discover a notable NEW sync licensing resource that independent musicians should know about, add it.
5. If a service has shut down or is no longer accepting submissions, update its description to note this.
6. Keep descriptions concise (1-3 sentences).
7. Preserve the exact JSON schema — do not add or remove fields.

VALID CATEGORIES: library_free, library_paid, library_selective, marketplace, pitching_service, supervisor_directory, educational, blog, tool, community

RESOURCE SCHEMA (each object in the "resources" array):
{
  "name": string,
  "url": string,
  "description": string,
  "category": string (one of the valid categories above),
  "cost": string,
  "acceptsUnsolicited": boolean,
  "highlights": string[] (optional, 1-3 short bullet points)
}`;

  const userMessage = `Here are the current ${resourceCount} sync licensing resources. Please use web search to verify each one and return an UPDATED version of the full JSON.

CURRENT RESOURCES:
${resourceSummary}

FULL CURRENT JSON:
${JSON.stringify(current, null, 2)}

Please:
1. Search the web to verify pricing and submission status for each resource
2. Update any that have changed
3. Add 1-3 new noteworthy resources if you find any (don't force it — only add genuinely useful ones)
4. Remove any that have completely shut down
5. Increment the "version" number by 1
6. Set "lastUpdated" to today's date (YYYY-MM-DD format)

Return ONLY the complete updated JSON object — no markdown fences, no explanation before or after. Just the raw JSON.`;

  console.log('Calling Claude API with web search (this may take a few minutes)...');

  const response = await callClaude(
    [{ role: 'user', content: userMessage }],
    system
  );

  console.log(`API response received. Stop reason: ${response.stop_reason}`);
  console.log(`Usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

  const text = extractText(response);

  if (!text) {
    console.error('No text content in response');
    process.exit(1);
  }

  // Try to parse the JSON from the response
  let updated;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    updated = JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse JSON from Claude response:', err.message);
    console.error('Raw response (first 500 chars):', text.substring(0, 500));
    process.exit(1);
  }

  // Validate structure
  if (!updated.resources || !Array.isArray(updated.resources)) {
    console.error('Invalid JSON structure — missing resources array');
    process.exit(1);
  }

  if (updated.resources.length < resourceCount * 0.5) {
    console.error(`Suspiciously few resources (${updated.resources.length} vs original ${resourceCount}). Aborting.`);
    process.exit(1);
  }

  // Write updated file
  fs.writeFileSync(RESOURCE_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

  console.log(`\nUpdate complete!`);
  console.log(`  Version: ${current.version} → ${updated.version}`);
  console.log(`  Resources: ${resourceCount} → ${updated.resources.length}`);
  console.log(`  Last updated: ${updated.lastUpdated}`);

  // Log changes
  const oldNames = new Set(current.resources.map(r => r.name));
  const newNames = new Set(updated.resources.map(r => r.name));
  const added = [...newNames].filter(n => !oldNames.has(n));
  const removed = [...oldNames].filter(n => !newNames.has(n));

  if (added.length) console.log(`  Added: ${added.join(', ')}`);
  if (removed.length) console.log(`  Removed: ${removed.join(', ')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
