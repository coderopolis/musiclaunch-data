// ---------------------------------------------------------------------------
// Collaborator Resource Updater — uses Claude API with web search to
// verify/update collaborator resource pricing and details quarterly.
//
// Two-phase approach:
//   Phase 1: Research — Claude uses web search to check each resource
//   Phase 2: Generate — Claude produces clean JSON from the research
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const RESOURCE_FILE = path.join(__dirname, '..', 'collaborator-resources.json');

// -- Helpers ------------------------------------------------------------------

async function callClaude({ model = 'claude-sonnet-4-6', messages, system, tools, maxTokens = 16000 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages
  };

  if (tools) body.tools = tools;

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
  const texts = [];
  for (const block of response.content) {
    if (block.type === 'text') texts.push(block.text);
  }
  return texts.join('\n');
}

function extractJSON(text) {
  // Try parsing the whole thing first
  try {
    return JSON.parse(text.trim());
  } catch { /* continue */ }

  // Strip markdown code fences
  const stripped = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  try {
    return JSON.parse(stripped);
  } catch { /* continue */ }

  // Try to find JSON object in the text
  const match = text.match(/\{[\s\S]*"resources"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* continue */ }
  }

  return null;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('Reading current collaborator-resources.json...');
  const current = JSON.parse(fs.readFileSync(RESOURCE_FILE, 'utf-8'));
  const resourceCount = current.resources.length;
  console.log(`Found ${resourceCount} resources (version ${current.version})`);

  // Build a compact summary for research phase
  const resourceSummary = current.resources.map((r, i) => (
    `${i + 1}. ${r.name} | ${r.url} | Cost: ${r.cost}`
  )).join('\n');

  // ── Phase 1: Research with web search ──────────────────────────────────────

  console.log('\n--- Phase 1: Researching resources with web search ---');
  console.log('This may take 2-3 minutes...\n');

  const researchResponse = await callClaude({
    model: 'claude-sonnet-4-6',  // Sonnet supports web search
    messages: [
      {
        role: 'user',
        content: `You are verifying collaborator and music production platform resources for an indie music app. Search the web to check each of these ${resourceCount} resources for current pricing, availability, and whether they're still active.

RESOURCES TO VERIFY:
${resourceSummary}

For each resource, briefly note:
- Is the website still active?
- Has the pricing changed from what's listed?
- Are they still accepting new users/signups?
- Any important changes (new features, acquisitions, shutdowns)?

Also note if you discover 1-3 NEW noteworthy collaborator platforms, session musician marketplaces, or music production services that independent musicians should know about.

Be concise — just the facts for each resource.`
      }
    ],
    system: 'You are a music industry research assistant. Use web search to verify each resource. Be concise and factual.',
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 50
      }
    ],
    maxTokens: 8000
  });

  const research = extractText(researchResponse);
  console.log(`Phase 1 complete. Usage: ${researchResponse.usage.input_tokens} input, ${researchResponse.usage.output_tokens} output tokens`);
  console.log(`Research findings (first 300 chars): ${research.substring(0, 300)}...\n`);

  if (!research || research.length < 100) {
    console.error('Research phase returned insufficient data');
    process.exit(1);
  }

  // ── Phase 2: Generate updated JSON (no web search needed) ──────────────────

  console.log('--- Phase 2: Generating updated JSON ---\n');

  const today = new Date().toISOString().split('T')[0];

  const jsonResponse = await callClaude({
    model: 'claude-haiku-4-5-20251001',  // Haiku for cheaper JSON generation (no web search needed)
    messages: [
      {
        role: 'user',
        content: `Based on the research findings below, produce an updated version of the collaborator resources JSON.

RESEARCH FINDINGS:
${research}

CURRENT JSON:
${JSON.stringify(current, null, 2)}

INSTRUCTIONS:
1. Update any resources where the research found changes (pricing, status, features, etc.)
2. If a service has shut down, update its description to note this
3. Add any new resources discovered in the research
4. Remove any that have completely shut down
5. Set "version" to ${current.version + 1}
6. Set "lastUpdated" to "${today}"
7. If no changes were found for a resource, keep it exactly as-is

VALID CATEGORIES: session_musicians, producer_beats, mixing_mastering, vocalist_songwriter, collaboration_networking, pro_rights, education

YOUR RESPONSE MUST BE ONLY THE JSON OBJECT. No text before it. No text after it. No markdown fences. Start with { and end with }. This is critical — the output will be parsed directly by JSON.parse().`
      }
    ],
    system: 'You are a JSON generator. Output ONLY valid JSON. No explanations, no markdown, no text outside the JSON object. Your entire response must be parseable by JSON.parse().',
    maxTokens: 16000
  });

  console.log(`Phase 2 complete. Usage: ${jsonResponse.usage.input_tokens} input, ${jsonResponse.usage.output_tokens} output tokens`);

  const text = extractText(jsonResponse);
  const updated = extractJSON(text);

  if (!updated) {
    console.error('Failed to parse JSON from Claude response');
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
