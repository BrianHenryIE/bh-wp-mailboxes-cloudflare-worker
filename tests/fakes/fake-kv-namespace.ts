/**
 * Minimal in-memory fake of the subset of KVNamespace the worker uses.
 */
export class FakeKvNamespace {
  private readonly store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  asKvNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
