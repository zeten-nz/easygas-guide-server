import { env } from '../config/env';
import type { StorageProvider } from './storage.provider';
import { LocalStorageProvider } from './local.provider';

let provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (provider) return provider;
  switch (env.STORAGE_PROVIDER) {
    case 'local':
      provider = new LocalStorageProvider(env.STORAGE_LOCAL_DIR);
      return provider;
    default:
      throw new Error(`Unknown storage provider: ${env.STORAGE_PROVIDER}`);
  }
}
