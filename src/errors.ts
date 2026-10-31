export class ApiError extends Error {
  constructor(public readonly status: 409 | 400 | 401 | 403 | 404 | 422 | 502 | 503 | 504,
    public readonly code: string, message: string) {
    super(message);
  }
}
