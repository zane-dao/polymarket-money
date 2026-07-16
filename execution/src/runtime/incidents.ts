import { validateReceiveStamp, type ReceiveStamp } from "../domain/receive-time.js";

export const RUNTIME_INCIDENT_SCHEMA_VERSION = "runtime-incident-v1" as const;
export const TERMINAL_FAILURE_SCHEMA_VERSION = "terminal-failure-v1" as const;

export type ConnectionRole = "external" | "polymarket" | "session" | "storage";
export type IncidentAction = "QUARANTINE" | "RECONNECT" | "CENSOR_PENDING" | "TERMINATE_SESSION";

export interface RawReference {
  readonly eventId?: string;
  readonly sha256: string;
}

export interface RuntimeIncidentV1 {
  readonly schemaVersion: typeof RUNTIME_INCIDENT_SCHEMA_VERSION;
  readonly errorClass: string;
  readonly message: string;
  readonly stream: string;
  readonly connectionRole: ConnectionRole;
  readonly connectionId: string;
  readonly receiveStamp: ReceiveStamp;
  readonly rawReference: Readonly<RawReference> | null;
  readonly actionTaken: IncidentAction;
  readonly stopReason: string;
}

export interface CreateRuntimeIncidentInput extends Omit<RuntimeIncidentV1, "schemaVersion"> {}

export interface RuntimeIncidentWriter {
  write(incident: RuntimeIncidentV1): Promise<void>;
}

export interface EmergencyTerminalReceipt {
  readonly schemaVersion: typeof TERMINAL_FAILURE_SCHEMA_VERSION;
  readonly stopReason: string;
  readonly errorClass: string;
  readonly message: string;
  readonly incidentWriterError: string;
  readonly receiveStamp: ReceiveStamp;
  readonly graceful: false;
  readonly exitCode: 1;
}

export interface EmergencyTerminalSink {
  write(receipt: EmergencyTerminalReceipt): Promise<void>;
}

export interface RuntimeTermination {
  readonly stopReason: string;
  readonly graceful: false;
  readonly exitCode: 1;
  readonly incidentPersisted: boolean;
  readonly emergencyReceiptPersisted: boolean;
}

export interface FailClosedRuntimeOptions {
  readonly incidentWriter: RuntimeIncidentWriter;
  readonly emergencySink: EmergencyTerminalSink;
  readonly writeStderr?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createRuntimeIncident(input: CreateRuntimeIncidentInput): RuntimeIncidentV1 {
  const rawReference = input.rawReference === null
    ? null
    : Object.freeze({
        ...(input.rawReference.eventId === undefined
          ? {}
          : { eventId: text(input.rawReference.eventId, "rawReference.eventId") }),
        sha256: text(input.rawReference.sha256, "rawReference.sha256"),
      });
  return Object.freeze({
    schemaVersion: RUNTIME_INCIDENT_SCHEMA_VERSION,
    errorClass: text(input.errorClass, "errorClass"),
    message: text(input.message, "message"),
    stream: text(input.stream, "stream"),
    connectionRole: input.connectionRole,
    connectionId: text(input.connectionId, "connectionId"),
    receiveStamp: validateReceiveStamp(input.receiveStamp),
    rawReference,
    actionTaken: input.actionTaken,
    stopReason: text(input.stopReason, "stopReason"),
  });
}

/**
 * Owns the irreversible transition from RUNNING to TERMINATED. The incident
 * writer is attempted at most once. Its failure switches to a one-shot terminal
 * receipt path and never recurses through the failed writer.
 */
export class FailClosedRuntime {
  readonly #incidentWriter: RuntimeIncidentWriter;
  readonly #emergencySink: EmergencyTerminalSink;
  readonly #writeStderr: (line: string) => void;
  readonly #setExitCode: (code: number) => void;
  #state: "RUNNING" | "TERMINATING" | "TERMINATED" = "RUNNING";
  #termination: RuntimeTermination | null = null;
  #observationCount = 0;

  constructor(options: FailClosedRuntimeOptions) {
    this.#incidentWriter = options.incidentWriter;
    this.#emergencySink = options.emergencySink;
    this.#writeStderr = options.writeStderr ?? ((line) => process.stderr.write(`${line}\n`));
    this.#setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  }

  get observationCount(): number {
    return this.#observationCount;
  }

  get terminated(): boolean {
    return this.#state !== "RUNNING";
  }

  noteObservation(): void {
    if (this.#state !== "RUNNING") throw new Error("runtime is terminated; observation is forbidden");
    this.#observationCount += 1;
  }

  async terminate(incidentValue: RuntimeIncidentV1): Promise<RuntimeTermination> {
    if (this.#termination !== null) return this.#termination;
    if (this.#state !== "RUNNING") throw new Error("runtime termination is already in progress");
    const incident = createRuntimeIncident(incidentValue);
    this.#state = "TERMINATING";
    this.#setExitCode(1);

    let incidentPersisted = false;
    let emergencyReceiptPersisted = false;
    try {
      await this.#incidentWriter.write(incident);
      incidentPersisted = true;
    } catch (writerError) {
      const writerMessage = errorText(writerError);
      this.#writeStderr(`terminal incident writer failure: ${writerMessage}`);
      const receipt: EmergencyTerminalReceipt = Object.freeze({
        schemaVersion: TERMINAL_FAILURE_SCHEMA_VERSION,
        stopReason: incident.stopReason,
        errorClass: incident.errorClass,
        message: incident.message,
        incidentWriterError: writerMessage,
        receiveStamp: incident.receiveStamp,
        graceful: false,
        exitCode: 1,
      });
      try {
        await this.#emergencySink.write(receipt);
        emergencyReceiptPersisted = true;
      } catch (receiptError) {
        this.#writeStderr(`terminal failure receipt failed: ${errorText(receiptError)}`);
      }
    }
    this.#termination = Object.freeze({
      stopReason: incident.stopReason,
      graceful: false,
      exitCode: 1,
      incidentPersisted,
      emergencyReceiptPersisted,
    });
    this.#state = "TERMINATED";
    return this.#termination;
  }
}
