// Shared domain types for the Planfect backend.
// Kept to erasable TypeScript (types/interfaces + string-literal unions, no enums)
// so the same files run under Deno (Edge Functions) and Node --experimental-strip-types.

export type TransportMode = 'driving' | 'transit' | 'walking' | 'cycling';
export type BlockKind = 'task' | 'routine' | 'commute' | 'buffer';
export type TaskStatus = 'pending' | 'scheduled' | 'in_progress' | 'done' | 'cancelled';
export type RoutineKind = 'work' | 'sleep' | 'meal' | 'commute' | 'custom';
export type TaskSource = 'chat' | 'voice' | 'manual';

// ---- Clarifying questions (the multiple-choice cards the app renders) ----
export interface QuestionOption {
  label: string;
  description: string;
}
export interface Question {
  id: string;            // stable id to map the answer back
  header: string;        // short chip label, e.g. "Duration"
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
  // NOTE: the app always adds an "Other" free-text affordance; the model never emits it.
}

// ---- Scheduling receipt (what the assistant confirms after acting) ----
export interface ReceiptCommute {
  mode: TransportMode;
  leaveAt: string;       // ISO-8601
  durationMin: number;
}
export interface ReceiptItem {
  title: string;
  start: string;         // ISO-8601
  end: string;           // ISO-8601
  commute?: ReceiptCommute;
}
export interface Receipt {
  summary: string;
  items: ReceiptItem[];
  assumptions: string[];
}
