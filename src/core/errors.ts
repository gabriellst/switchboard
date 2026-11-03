export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1,
  INVALID_CONFIG: 2,
  USAGE: 3,
  CLAUDE: 4,
  LOCKED: 5,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export class SbError extends Error {
  constructor(
    message: string,
    readonly exit: ExitCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'SbError'
  }
}
