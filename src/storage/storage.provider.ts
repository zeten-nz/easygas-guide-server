/**
 * Object-storage abstraction (loyiha.md §19/§40): business logic depends only
 * on this interface. Development uses the local provider; production moves to
 * S3/MinIO by adding a provider — no business-code changes.
 * Keys are always server-generated relative paths (never client input).
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
