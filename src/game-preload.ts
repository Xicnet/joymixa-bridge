import { contextBridge } from 'electron';

// The game's PlatformService reads `window.__jmNative === true` to detect the native
// shell (it gates the Bridge/Link UI). contextBridge is required: with contextIsolation
// enabled the preload's `window` is not the page's main world, so a plain assignment
// would never reach the app.
contextBridge.exposeInMainWorld('__jmNative', true);
