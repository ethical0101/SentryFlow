import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Minimal FIFO async mutex. All state mutations and executions run under it. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * JSON document store with atomic writes (write temp file, then rename). Single-process only.
 * `path === null` keeps everything in memory (used by tests).
 */
export class JsonStore<T> {
  private data: T;
  readonly lock = new Mutex();

  constructor(
    private readonly path: string | null,
    initial: () => T,
    validate: (raw: unknown) => T = (raw) => raw as T,
  ) {
    if (path && existsSync(path)) {
      this.data = validate(JSON.parse(readFileSync(path, "utf8")));
    } else {
      this.data = initial();
      this.flush();
    }
  }

  /** Read-only snapshot (deep copy) so callers cannot mutate state outside the lock. */
  snapshot(): T {
    return structuredClone(this.data);
  }

  /** Mutate under the lock; the change is persisted before the promise resolves. */
  update<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    return this.lock.run(async () => {
      const draft = structuredClone(this.data);
      const out = await fn(draft);
      this.data = draft;
      this.flush();
      return out;
    });
  }

  private flush() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
