import { createFileStore } from './file-store.js';

export function createStore(config) {
  if (config.stateStore !== 'file') {
    throw new Error(`Unsupported STATE_STORE: ${config.stateStore}`);
  }
  return createFileStore({ path: config.stateFile });
}
