import { env, isProduction } from '../config/env';
import type { StorageProvider } from './storage.provider';
import { LocalStorageProvider } from './local.provider';
import { S3StorageProvider } from './s3.provider';

let provider: StorageProvider | null = null;

/**
 * Builds the configured storage provider. Production refuses the local
 * provider unless ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true (an explicit,
 * documented emergency override) — evidence must live in durable object
 * storage in production.
 */
export function buildStorageProvider(): StorageProvider {
  if (env.STORAGE_PROVIDER === 'local') {
    if (isProduction && !env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
      throw new Error(
        'STORAGE_PROVIDER=local is not allowed in production. Configure STORAGE_PROVIDER=s3, ' +
          'or set ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true only as a documented emergency override.',
      );
    }
    return new LocalStorageProvider(env.STORAGE_LOCAL_DIR);
  }

  // s3
  if (!env.S3_BUCKET || !env.S3_REGION) {
    throw new Error('STORAGE_PROVIDER=s3 requires S3_BUCKET and S3_REGION');
  }
  return new S3StorageProvider({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    serverSideEncryption: env.S3_SERVER_SIDE_ENCRYPTION,
  });
}

export function getStorageProvider(): StorageProvider {
  if (!provider) provider = buildStorageProvider();
  return provider;
}

/** Test-only injection point for a controllable/mock provider. */
export function setStorageProviderForTesting(p: StorageProvider): void {
  if (isProduction) throw new Error('setStorageProviderForTesting is not available in production');
  provider = p;
}
