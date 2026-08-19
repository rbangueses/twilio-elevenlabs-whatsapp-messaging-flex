import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const DEFAULT_NAME = 'Twilio WhatsApp Flex Relay';
const DEFAULT_LLM = 'gemini-2.0-flash';
const DEFAULT_PROMPT_PATH = 'examples/elevenlabs/agent-prompt-whatsapp.md';
const DEFAULT_TOOL_PATH = 'examples/elevenlabs/escalate-to-flex-tool.example.json';
const RELAY_HOST_LABEL = 'relay_host';
const RELAY_AUTHORIZATION_LABEL = 'relay_authorization';

export function buildAgentCreatePayload({ name, prompt, toolId, llm = DEFAULT_LLM }) {
  return {
    name,
    tags: ['twilio', 'whatsapp', 'flex'],
    conversation_config: {
      agent: {
        prompt: {
          prompt,
          llm,
          tool_ids: [toolId],
        },
      },
    },
  };
}

export function resolveRelayHost({ relayHost, env = process.env } = {}) {
  return normalizeHost(relayHost ?? env.RELAY_HOST ?? env.PUBLIC_BASE_URL ?? '');
}

export async function runCreateWhatsAppAgent({
  apiKey,
  handoffToken,
  relayHost,
  promptPath = DEFAULT_PROMPT_PATH,
  toolPath = DEFAULT_TOOL_PATH,
  name = DEFAULT_NAME,
  llm = DEFAULT_LLM,
  fetchImpl = globalThis.fetch,
  log = console.log,
  env = process.env,
} = {}) {
  const resolvedApiKey = apiKey ?? env.ELEVENLABS_API_KEY;
  const resolvedHandoffToken = handoffToken ?? env.HANDOFF_TOKEN;
  const resolvedRelayHost = resolveRelayHost({ relayHost, env });

  assertPresent('ELEVENLABS_API_KEY', resolvedApiKey);
  assertPresent('HANDOFF_TOKEN', resolvedHandoffToken);
  assertPresent('RELAY_HOST or PUBLIC_BASE_URL', resolvedRelayHost);
  if (!fetchImpl) throw new Error('fetch is not available. Use Node.js 20+ or pass fetchImpl.');

  const existingEnvVars = await listEnvironmentVariables({ apiKey: resolvedApiKey, fetchImpl });
  const existingLabels = new Set(existingEnvVars.map((item) => item.label).filter(Boolean));

  let createdRelayHostEnv = false;
  if (!existingLabels.has(RELAY_HOST_LABEL)) {
    await createEnvironmentVariable({
      apiKey: resolvedApiKey,
      fetchImpl,
      payload: {
        label: RELAY_HOST_LABEL,
        type: 'string',
        values: { production: resolvedRelayHost },
      },
    });
    createdRelayHostEnv = true;
    log(`Created ElevenLabs environment variable: ${RELAY_HOST_LABEL}`);
  } else {
    log(`Found ElevenLabs environment variable: ${RELAY_HOST_LABEL}`);
  }

  let createdRelayAuthorizationEnv = false;
  if (!existingLabels.has(RELAY_AUTHORIZATION_LABEL)) {
    const secret = await elevenLabsRequest({
      apiKey: resolvedApiKey,
      fetchImpl,
      path: '/v1/convai/secrets',
      method: 'POST',
      body: {
        type: 'new',
        name: RELAY_AUTHORIZATION_LABEL,
        value: `Bearer ${resolvedHandoffToken}`,
      },
    });
    const secretId = secret.secret_id ?? secret.id;
    if (!secretId) throw new Error('ElevenLabs did not return a secret_id for relay_authorization.');

    await createEnvironmentVariable({
      apiKey: resolvedApiKey,
      fetchImpl,
      payload: {
        label: RELAY_AUTHORIZATION_LABEL,
        type: 'secret',
        values: { production: { secret_id: secretId } },
      },
    });
    createdRelayAuthorizationEnv = true;
    log(`Created ElevenLabs secret-backed environment variable: ${RELAY_AUTHORIZATION_LABEL}`);
  } else {
    log(`Found ElevenLabs environment variable: ${RELAY_AUTHORIZATION_LABEL}`);
  }

  const toolConfig = readJson(toolPath);
  const tool = await elevenLabsRequest({
    apiKey: resolvedApiKey,
    fetchImpl,
    path: '/v1/convai/tools',
    method: 'POST',
    body: { tool_config: toolConfig },
  });
  const toolId = tool.id ?? tool.tool_id ?? tool.tool_config?.id;
  if (!toolId) throw new Error('ElevenLabs did not return a tool id.');
  log(`Created ElevenLabs tool: ${toolId}`);

  const prompt = readFileSync(resolve(process.cwd(), promptPath), 'utf8').trim();
  const agent = await elevenLabsRequest({
    apiKey: resolvedApiKey,
    fetchImpl,
    path: '/v1/convai/agents/create',
    method: 'POST',
    body: buildAgentCreatePayload({ name, prompt, toolId, llm }),
  });
  const agentId = agent.agent_id ?? agent.id;
  if (!agentId) throw new Error('ElevenLabs did not return an agent_id.');
  log(`Created ElevenLabs WhatsApp agent: ${agentId}`);

  return {
    agentId,
    toolId,
    createdRelayHostEnv,
    createdRelayAuthorizationEnv,
  };
}

async function listEnvironmentVariables({ apiKey, fetchImpl }) {
  const body = await elevenLabsRequest({
    apiKey,
    fetchImpl,
    path: '/v1/convai/environment-variables',
  });
  if (Array.isArray(body.environment_variables)) return body.environment_variables;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body)) return body;
  return [];
}

async function createEnvironmentVariable({ apiKey, fetchImpl, payload }) {
  return elevenLabsRequest({
    apiKey,
    fetchImpl,
    path: '/v1/convai/environment-variables',
    method: 'POST',
    body: payload,
  });
}

async function elevenLabsRequest({ apiKey, fetchImpl, path, method = 'GET', body }) {
  const headers = { 'xi-api-key': apiKey };
  const options = { headers };
  if (method !== 'GET') options.method = method;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetchImpl(new URL(path, ELEVENLABS_API_BASE), options);
  const text = response.text ? await response.text() : '';
  const payload = parseResponseText(text);
  if (!response.ok) {
    const detail = text || JSON.stringify(payload);
    throw new Error(`ElevenLabs ${method} ${path} failed with ${response.status}: ${detail}`);
  }
  return payload;
}

function normalizeHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.host;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
}

function parseResponseText(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertPresent(label, value) {
  if (!value) throw new Error(`Missing required value: ${label}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function runCli() {
  await import('../src/env.js');
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npm run elevenlabs:create-whatsapp-agent -- [options]

Options:
  --name <name>           Agent name. Default: "${DEFAULT_NAME}"
  --relay-host <host>     Host only or URL. Falls back to RELAY_HOST or PUBLIC_BASE_URL.
  --llm <model>           ElevenLabs prompt LLM. Default: ${DEFAULT_LLM}
  --prompt-path <path>    Prompt markdown file. Default: ${DEFAULT_PROMPT_PATH}
  --tool-path <path>      Tool JSON file. Default: ${DEFAULT_TOOL_PATH}
`);
    return;
  }

  const result = await runCreateWhatsAppAgent({
    name: args.name ?? DEFAULT_NAME,
    relayHost: args['relay-host'],
    llm: args.llm ?? DEFAULT_LLM,
    promptPath: args['prompt-path'] ?? DEFAULT_PROMPT_PATH,
    toolPath: args['tool-path'] ?? DEFAULT_TOOL_PATH,
  });

  console.log('');
  console.log('Add this to .env:');
  console.log(`ELEVENLABS_AGENT_ID=${result.agentId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
