import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { StorageError, type ObjectStat, type PutOptions, type StorageProvider } from './storage.provider';

export interface S3ProviderConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Server-side encryption algorithm, e.g. 'AES256' or 'aws:kms'. */
  serverSideEncryption?: string;
  /** Injected S3 client for tests (a mocked/in-memory implementation). */
  client?: Pick<S3Client, 'send'>;
}

/**
 * Production S3-compatible provider (AWS S3, MinIO, etc.) via AWS SDK v3.
 * The bucket MUST be private — evidence is served only through the authorized
 * backend endpoint. Object keys are server-generated; traversal is impossible
 * because keys never contain "..". Native SDK errors are normalized to
 * StorageError so no AWS detail leaks to the app or clients.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: Pick<S3Client, 'send'>;
  private readonly bucket: string;
  private readonly sse?: string;

  constructor(config: S3ProviderConfig) {
    this.bucket = config.bucket;
    this.sse = config.serverSideEncryption;
    if (config.client) {
      this.client = config.client;
    } else {
      const clientConfig: S3ClientConfig = {
        region: config.region,
        forcePathStyle: config.forcePathStyle ?? false,
      };
      if (config.endpoint) clientConfig.endpoint = config.endpoint;
      if (config.accessKeyId && config.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        };
      }
      this.client = new S3Client(clientConfig);
    }
  }

  private assertKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0 || key.startsWith('/') || key.includes('..')) {
      throw new StorageError('INVALID_KEY', 'Invalid storage key');
    }
  }

  private normalize(err: unknown): StorageError {
    const name = (err as { name?: string })?.name;
    const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || httpStatus === 404) {
      return new StorageError('NOT_FOUND', 'Object not found', err);
    }
    if (name === 'TimeoutError' || name === 'RequestTimeout' || (err as { code?: string })?.code === 'ETIMEDOUT') {
      return new StorageError('TIMEOUT', 'Storage request timed out', err);
    }
    if (name === 'AccessDenied' || httpStatus === 403) {
      return new StorageError('ACCESS_DENIED', 'Storage access denied', err);
    }
    return new StorageError('IO', 'Storage operation failed', err);
  }

  async put(key: string, data: Buffer, options?: PutOptions): Promise<ObjectStat> {
    this.assertKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: options?.contentType,
          ...(this.sse ? { ServerSideEncryption: this.sse as never } : {}),
          ...(options?.sha256 ? { Metadata: { sha256: options.sha256 } } : {}),
        }),
      );
    } catch (err) {
      throw this.normalize(err);
    }
    const stat = await this.stat(key);
    if (!stat) throw new StorageError('IO', 'Object missing immediately after write');
    return stat;
  }

  async getStream(key: string): Promise<Readable> {
    this.assertKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = res.Body;
      if (!body) throw new StorageError('NOT_FOUND', 'Object body missing');
      // Node runtime: Body is a Readable.
      return body as Readable;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw this.normalize(err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    this.assertKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType ?? null,
        checksum: res.ETag ? res.ETag.replaceAll('"', '') : null,
      };
    } catch (err) {
      const norm = this.normalize(err);
      if (norm.kind === 'NOT_FOUND') return null;
      throw norm;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      const norm = this.normalize(err);
      if (norm.kind === 'NOT_FOUND') return;
      throw norm;
    }
  }
}
