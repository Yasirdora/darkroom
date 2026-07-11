export class History<T> {
  private readonly limit: number;
  private past: T[] = [];
  private future: T[] = [];

  constructor(limit = 40) {
    this.limit = limit;
  }

  push(state: T): void {
    this.past.push(state);
    if (this.past.length > this.limit) {
      this.past.shift();
    }
    this.future = [];
  }

  undo(current: T): T | null {
    if (this.past.length === 0) {
      return null;
    }
    const previous = this.past.pop();
    if (!previous) {
      return null;
    }
    this.future.push(current);
    return previous;
  }

  redo(current: T): T | null {
    if (this.future.length === 0) {
      return null;
    }
    const next = this.future.pop();
    if (!next) {
      return null;
    }
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}