export class ApiFailure extends Error {
  constructor(public status: number, public detail: string, public extra: Record<string, unknown> = {}) { super(detail); }
}
