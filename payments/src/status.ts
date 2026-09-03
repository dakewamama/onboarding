// Two status vocabularies exist across Paj surfaces:
//   REST/webhook (v2 payment): INIT/AWAITING/PROCESSING/SUCCESSFUL/EXPIRED/ERROR
//   REST/webhook (v1 offramp):  INIT/PAID/COMPLETED/FAILED/CANCELLED
//   Socket.IO (onramp only):    lowercase pending/processing/completed/failed/...
// Never do a strict enum switch. Normalise and match against sets, treating
// anything unknown as non-terminal (i.e. wait for a clearer signal).

const SUCCESS = new Set(["SUCCESSFUL", "COMPLETED"]);
const FAILURE = new Set(["FAILED", "CANCELLED", "CANCELED", "EXPIRED", "ERROR"]);

function normalize(status: string): string {
  return status.trim().toUpperCase();
}

export function isSuccess(status: string): boolean {
  return SUCCESS.has(normalize(status));
}

export function isFailure(status: string): boolean {
  return FAILURE.has(normalize(status));
}

export function isTerminal(status: string): boolean {
  return isSuccess(status) || isFailure(status);
}
