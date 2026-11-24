/** Success payload merged with `ok: true`, or a failure with a readable reason. */
export type Result<Success extends object> =
  | ({ readonly ok: true } & Success)
  | { readonly ok: false; readonly error: string };
