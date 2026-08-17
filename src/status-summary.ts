import { TOOL_LABELS } from './constants.js';

type ToolArguments = Record<string, unknown> | undefined;

interface AssistantPlanToolRequestLike {
  name?: string;
  arguments?: ToolArguments;
}

export interface AssistantPlanSummary {
  intentText?: string;
  activeToolStatus?: string;
}

export interface ToolStatusSummary {
  label: string;
  detail?: string;
  statusLine: string;
}

export interface SubagentStatusSummary {
  statusLine: string;
}

function getString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clip(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  // Drop a dangling high surrogate: slicing UTF-16 code units can split an
  // emoji, and Telegram rejects the whole message as invalid UTF-8.
  const head = normalized.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
  return head + '…';
}

function toInlineCode(text: string, max = 80): string {
  const safe = clip(text.replace(/`/g, ''), max);
  return safe ? `\`${safe}\`` : '';
}

function humanizeAgentName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function formatToolStatus(toolName: string, args?: ToolArguments): ToolStatusSummary {
  const description = getString(args?.description);
  const command = getString(args?.command);
  const url = getString(args?.url);
  const filePath = getString(args?.file_path) ?? getString(args?.path);
  const pattern = getString(args?.pattern) ?? getString(args?.query);
  const agentType = getString(args?.agent_type);
  const prompt = getString(args?.prompt);

  const label = TOOL_LABELS[toolName] ?? (toolName === 'task' ? '🤖 Agent' : '🔧 ' + toolName);

  let detail: string | undefined;
  switch (toolName) {
    case 'task':
      detail =
        description ??
        (agentType ? `\`${clip(agentType, 48)}\` agent` : undefined) ??
        (prompt ? clip(prompt, 96) : undefined);
      break;
    case 'bash':
    case 'run_bash':
      detail = description ?? (command ? toInlineCode(command, 96) : undefined);
      break;
    case 'web_fetch':
    case 'web_search':
      detail =
        description ?? (url ? toInlineCode(url, 96) : undefined) ?? (pattern ? toInlineCode(pattern, 72) : undefined);
      break;
    case 'view':
    case 'read_file':
    case 'edit_file':
    case 'create_file':
    case 'write_file':
    case 'delete_file':
    case 'list_dir':
      detail = description ?? (filePath ? toInlineCode(filePath, 88) : undefined);
      break;
    case 'grep_search':
    case 'search':
    case 'glob':
      detail =
        description ??
        (pattern ? toInlineCode(pattern, 72) : undefined) ??
        (filePath ? toInlineCode(filePath, 72) : undefined);
      break;
    default:
      detail =
        description ??
        (command ? toInlineCode(command, 88) : undefined) ??
        (filePath ? toInlineCode(filePath, 88) : undefined) ??
        (url ? toInlineCode(url, 88) : undefined) ??
        (pattern ? toInlineCode(pattern, 72) : undefined) ??
        (agentType ? `\`${clip(agentType, 48)}\`` : undefined) ??
        (prompt ? clip(prompt, 96) : undefined);
      break;
  }

  return {
    label,
    detail,
    statusLine: detail ? `${label} ${detail}` : label,
  };
}

export function extractAssistantPlan(input: {
  content?: string;
  reasoningText?: string;
  toolRequests?: AssistantPlanToolRequestLike[];
}): AssistantPlanSummary {
  const toolRequests = (input.toolRequests ?? []).filter(
    (toolRequest): toolRequest is AssistantPlanToolRequestLike & { name: string } =>
      typeof toolRequest?.name === 'string',
  );
  const intentRequest = toolRequests.find((toolRequest) => toolRequest.name === 'report_intent');
  const actionableRequest = toolRequests.find((toolRequest) => toolRequest.name !== 'report_intent');
  const intentText = getString(intentRequest?.arguments?.intent) ?? getString(intentRequest?.arguments?.message);

  return {
    intentText,
    activeToolStatus: actionableRequest
      ? formatToolStatus(actionableRequest.name, actionableRequest.arguments).statusLine
      : undefined,
  };
}

export function formatSubagentStatus(input: {
  agentName?: string;
  agentDisplayName?: string;
  agentDescription?: string;
}): SubagentStatusSummary {
  const displayName =
    getString(input.agentDisplayName) ??
    (getString(input.agentName) ? humanizeAgentName(getString(input.agentName)!) : undefined) ??
    'Agent';
  return {
    statusLine: `🤖 Starting ${clip(displayName, 72)}`,
  };
}

/**
 * Tail of streamed reasoning, bounded for the progress bubble. Sliced from the
 * end so it tracks current activity, never starting on a lone low surrogate
 * (invalid UTF-8 would make Telegram reject the whole message).
 */
export function reasoningTail(text: string, max = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  let tail = normalized.slice(-max);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return '…' + tail;
}
