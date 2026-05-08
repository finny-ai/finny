export class BackgroundTaskBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackgroundTaskBlockedError"
  }
}
