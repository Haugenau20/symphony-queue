export type CliCommand = 'start'

export interface CliArgs {
  command: CliCommand
  workflowPath: string | null
  logsRoot: string | null
  acknowledged: boolean
  /** Flags we do not recognise. Non-empty means refuse to start rather than guess. */
  unknownFlags: string[]
}

const GUARDRAILS_FLAG = '--i-understand-that-this-will-be-running-without-the-usual-guardrails'

const COMMANDS: CliCommand[] = ['start']

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'start',
    workflowPath: null,
    logsRoot: null,
    acknowledged: false,
    unknownFlags: [],
  }

  const positionals: string[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === GUARDRAILS_FLAG) {
      args.acknowledged = true
      i++
    } else if (arg === '--logs-root' && i + 1 < argv.length) {
      args.logsRoot = argv[i + 1]!
      i += 2
    } else if (arg.startsWith('--')) {
      // An unrecognised flag may or may not take a value, and guessing wrong
      // would silently turn its value into the workflow path. Refuse instead.
      args.unknownFlags.push(arg)
      i++
    } else {
      positionals.push(arg)
      i++
    }
  }

  // `start` is the only command, so it may be given explicitly or omitted entirely.
  const rest = COMMANDS.includes(positionals[0] as CliCommand) ? positionals.slice(1) : positionals
  args.workflowPath = rest[0] ?? null

  return args
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`
}

function bright(s: string): string {
  return `\x1b[1m${s}\x1b[0m`
}

export function guardrailsBanner(): string {
  const lines = [
    'symphony-queue dispatches autonomous coding-agent runs.',
    'The agent runs with edit, bash, webfetch and external-directory',
    'permissions granted, without the usual interactive approvals.',
    'Run it only inside an isolated harness you control.',
    '',
    `To proceed, start with the \`${GUARDRAILS_FLAG}\` CLI argument`,
  ]
  const width = Math.max(...lines.map((l) => l.length))
  const border = '─'.repeat(width + 2)
  const content = lines.map((l) => `│ ${l.padEnd(width)} │`)
  return red(bright([
    `╭${border}╮`,
    `│ ${''.padEnd(width)} │`,
    ...content,
    `│ ${''.padEnd(width)} │`,
    `╰${border}╯`,
  ].join('\n')))
}

export function usageMessage(): string {
  return [
    'Usage: symphony-queue [start] [options] [path-to-WORKFLOW.md]',
    '',
    'Commands:',
    '  start                 Run the orchestrator (default, and the only command)',
    '',
    'Options:',
    '  --logs-root <path>    Log file directory',
    `  ${GUARDRAILS_FLAG}  Required acknowledgement`,
    '',
    'Queue state is the filesystem: `ls <queue-root>/*` is the status surface.',
  ].join('\n')
}
