export class ApiFailure extends Error {
  constructor(public status: number, public detail: string) { super(detail); }
}

