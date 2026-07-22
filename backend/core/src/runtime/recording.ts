export const GIB = 1024 ** 3;
export const MAX_LOCAL_RAW_MILLISECONDS = 60 * 60 * 1_000;
export const MAX_LOCAL_RAW_BYTES = 2 * GIB;
export const MIN_FREE_BYTES = 10 * GIB;

export class SharedByteBudget {
  readonly #maximum: number;
  #used = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("byte budget maximum must be a positive safe integer");
    }
    this.#maximum = maximum;
  }

  reserve = (byteCount: number): boolean => {
    if (!Number.isSafeInteger(byteCount) || byteCount <= 0) {
      throw new Error("reserved byte count must be a positive safe integer");
    }
    if (this.#used + byteCount > this.#maximum) return false;
    this.#used += byteCount;
    return true;
  };

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return this.#maximum - this.#used;
  }
}

export type RecordMode = "none" | "metrics" | "raw";

interface CommonOptions {
  readonly mode: RecordMode;
}

export interface RawRecordingInput extends CommonOptions {
  readonly mode: "raw";
  readonly durationMilliseconds: number;
  readonly maxBytes: number;
  readonly outputPath: string;
  readonly filesystemType: string;
  readonly freeBytes: number;
}

export type NonRawRecordingInput = { readonly mode: "none" } | { readonly mode: "metrics" };

export type RecordingInput = RawRecordingInput | NonRawRecordingInput;

export type RecordingOptions =
  | { readonly mode: "none"; readonly writesMetrics: false; readonly writesRaw: false }
  | { readonly mode: "metrics"; readonly writesMetrics: true; readonly writesRaw: false }
  | (RawRecordingInput & { readonly writesMetrics: true; readonly writesRaw: true });

export function validateRecordingOptions(input: RecordingInput): RecordingOptions {
  if (input.mode === "none") return Object.freeze({ mode: "none", writesMetrics: false, writesRaw: false });
  if (input.mode === "metrics") return Object.freeze({ mode: "metrics", writesMetrics: true, writesRaw: false });
  if (!Number.isSafeInteger(input.durationMilliseconds) || input.durationMilliseconds <= 0 || input.durationMilliseconds > MAX_LOCAL_RAW_MILLISECONDS) {
    throw new Error("local raw duration must be positive and no more than 60 minutes");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > MAX_LOCAL_RAW_BYTES) {
    throw new Error("local raw maxBytes must be positive and no more than 2 GiB");
  }
  if (!input.outputPath.startsWith("/")) throw new Error("raw outputPath must be absolute");
  if (["9p", "drvfs", "ntfs", "ntfs3", "fuseblk"].includes(input.filesystemType.toLowerCase())) {
    throw new Error("trusted raw output requires a Linux-native filesystem");
  }
  if (!Number.isSafeInteger(input.freeBytes) || input.freeBytes - input.maxBytes < MIN_FREE_BYTES) {
    throw new Error("raw allocation would cross the 10 GiB safety reserve");
  }
  return Object.freeze({
    ...input,
    writesMetrics: true,
    writesRaw: true,
  });
}
